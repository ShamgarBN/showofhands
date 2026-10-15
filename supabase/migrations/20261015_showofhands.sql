-- Show of Hands: live audience voting and Q&A.
--
-- Shares a Supabase project with another app, so:
--   * every object is prefixed soh_ and nothing existing is touched
--   * anonymous sign-ins stay OFF; phones identify themselves with a random
--     browser ID and can only write through the soh_ functions below
--   * the owner (presenter) is a normal signed-in user listed in soh_admins
--
-- Grant admin once, outside this file (keeps personal data out of the repo):
--   insert into public.soh_admins (user_id) values ('<your auth user id>');

begin;

-- ---------------------------------------------------------------- tables

create table public.soh_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.soh_polls (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  status text not null default 'draft'
    check (status in ('draft', 'open', 'closed', 'revealed')),
  blind_mode boolean not null default true,
  winner_option_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.soh_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.soh_polls (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  description text not null default '' check (char_length(description) <= 200),
  sort_order int not null default 0,
  -- show-of-hands fallback: votes you add by hand from the admin page
  manual_count int not null default 0 check (manual_count >= 0),
  unique (id, poll_id)
);

alter table public.soh_polls
  add constraint soh_polls_winner_fk
  foreign key (winner_option_id) references public.soh_options (id) on delete set null;

create table public.soh_votes (
  poll_id uuid not null references public.soh_polls (id) on delete cascade,
  voter_id text not null check (char_length(voter_id) between 16 and 64),
  option_id uuid not null,
  is_simulated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (poll_id, voter_id),  -- one vote per phone per poll
  -- the option must belong to the same poll
  foreign key (option_id, poll_id) references public.soh_options (id, poll_id) on delete cascade
);

create table public.soh_questions (
  id uuid primary key default gen_random_uuid(),
  voter_id text not null check (char_length(voter_id) between 16 and 64),
  body text not null check (char_length(btrim(body)) between 1 and 280),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'hidden', 'answered')),
  created_at timestamptz not null default now()
);

create table public.soh_question_upvotes (
  question_id uuid not null references public.soh_questions (id) on delete cascade,
  voter_id text not null check (char_length(voter_id) between 16 and 64),
  created_at timestamptz not null default now(),
  primary key (question_id, voter_id)  -- one upvote per phone per question
);

-- Single row that drives what the projector and phones show.
create table public.soh_stage (
  id int primary key default 1 check (id = 1),
  poll_id uuid references public.soh_polls (id) on delete set null,
  mode text not null default 'poll' check (mode in ('poll', 'qa')),
  qa_open boolean not null default true,
  onscreen_question_id uuid references public.soh_questions (id) on delete set null,
  show_built_with_ai boolean not null default false,
  built_stats jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index soh_options_poll_idx on public.soh_options (poll_id, sort_order);
create index soh_votes_option_idx on public.soh_votes (option_id);
create index soh_questions_status_idx on public.soh_questions (status, created_at);

-- ---------------------------------------------------------------- helpers

create function public.soh_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.soh_admins where user_id = auth.uid());
$$;

create function public.soh_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger soh_polls_touch before update on public.soh_polls
  for each row execute function public.soh_touch();
create trigger soh_votes_touch before update on public.soh_votes
  for each row execute function public.soh_touch();
create trigger soh_stage_touch before update on public.soh_stage
  for each row execute function public.soh_touch();

-- ---------------------------------------------------------------- row level security
-- Deny by default: RLS on everywhere, then explicit policies only.

alter table public.soh_admins enable row level security;
alter table public.soh_polls enable row level security;
alter table public.soh_options enable row level security;
alter table public.soh_votes enable row level security;
alter table public.soh_questions enable row level security;
alter table public.soh_question_upvotes enable row level security;
alter table public.soh_stage enable row level security;

-- soh_admins: no policies; only soh_is_owner() (security definer) reads it.

-- Polls, options and the stage contain nothing private: anyone may read them.
create policy soh_polls_read on public.soh_polls for select to anon, authenticated using (true);
create policy soh_options_read on public.soh_options for select to anon, authenticated using (true);
create policy soh_stage_read on public.soh_stage for select to anon, authenticated using (true);

-- Only the owner may change them.
create policy soh_polls_owner on public.soh_polls for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());
create policy soh_options_owner on public.soh_options for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());
create policy soh_stage_owner on public.soh_stage for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());

-- Votes, questions and upvotes: owner only. Phones go through the functions below.
create policy soh_votes_owner on public.soh_votes for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());
create policy soh_questions_owner on public.soh_questions for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());
create policy soh_question_upvotes_owner on public.soh_question_upvotes for all to authenticated
  using (public.soh_is_owner()) with check (public.soh_is_owner());

-- ---------------------------------------------------------------- phone functions
-- Security definer: they run with table access, but each one checks its own rules.

-- Cast or change a vote. Only while the poll is open, only for that poll's options.
create function public.soh_cast_vote(p_poll_id uuid, p_option_id uuid, p_voter_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if char_length(coalesce(p_voter_id, '')) not between 16 and 64 then
    raise exception 'invalid voter id';
  end if;
  if not exists (select 1 from soh_polls where id = p_poll_id and status = 'open') then
    raise exception 'voting is not open';
  end if;
  if not exists (select 1 from soh_options where id = p_option_id and poll_id = p_poll_id) then
    raise exception 'option does not belong to this poll';
  end if;
  insert into soh_votes (poll_id, voter_id, option_id)
  values (p_poll_id, p_voter_id, p_option_id)
  on conflict (poll_id, voter_id) do update set option_id = excluded.option_id;
end;
$$;

-- Which option this phone picked (to restore the selected state after a reload).
create function public.soh_my_vote(p_poll_id uuid, p_voter_id text)
returns uuid
language sql stable security definer set search_path = public as $$
  select option_id from soh_votes where poll_id = p_poll_id and voter_id = p_voter_id;
$$;

-- Submit a question. Unlimited per phone, held for the owner's approval.
create function public.soh_ask(p_body text, p_voter_id text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if char_length(coalesce(p_voter_id, '')) not between 16 and 64 then
    raise exception 'invalid voter id';
  end if;
  if not (select qa_open from soh_stage where id = 1) then
    raise exception 'questions are closed';
  end if;
  insert into soh_questions (voter_id, body) values (p_voter_id, btrim(p_body))
  returning id into new_id;
  return new_id;
end;
$$;

-- Upvote or un-upvote an approved question.
create function public.soh_toggle_upvote(p_question_id uuid, p_voter_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if char_length(coalesce(p_voter_id, '')) not between 16 and 64 then
    raise exception 'invalid voter id';
  end if;
  if not exists (select 1 from soh_questions where id = p_question_id and status = 'approved') then
    raise exception 'question not available';
  end if;
  delete from soh_question_upvotes where question_id = p_question_id and voter_id = p_voter_id;
  if found then
    return false;
  end if;
  insert into soh_question_upvotes (question_id, voter_id) values (p_question_id, p_voter_id);
  return true;
end;
$$;

-- What a phone sees: approved questions with upvote counts, plus its own pending ones.
-- Never returns other phones' IDs or unapproved questions from other phones.
create function public.soh_public_questions(p_voter_id text)
returns table (id uuid, body text, status text, upvotes bigint, upvoted boolean, mine boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select q.id, q.body, q.status,
         (select count(*) from soh_question_upvotes u where u.question_id = q.id),
         exists (select 1 from soh_question_upvotes u where u.question_id = q.id and u.voter_id = p_voter_id),
         q.voter_id = p_voter_id,
         q.created_at
  from soh_questions q
  where q.status = 'approved'
     or (q.voter_id = p_voter_id and q.status = 'pending')
  order by 4 desc, q.created_at;
$$;

-- ---------------------------------------------------------------- owner functions

-- Live counts per option. Owner only.
create function public.soh_results(p_poll_id uuid)
returns table (option_id uuid, real_votes bigint, simulated_votes bigint, manual_votes int, total bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  return query
  select o.id,
         count(v.*) filter (where not v.is_simulated),
         count(v.*) filter (where v.is_simulated),
         o.manual_count,
         count(v.*) + o.manual_count
  from soh_options o
  left join soh_votes v on v.option_id = o.id
  where o.poll_id = p_poll_id
  group by o.id, o.manual_count, o.sort_order
  order by o.sort_order;
end;
$$;

-- Questions with upvote counts for the admin queue and projector. Owner only.
create function public.soh_all_questions()
returns table (id uuid, body text, status text, upvotes bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  return query
  select q.id, q.body, q.status,
         (select count(*) from soh_question_upvotes u where u.question_id = q.id),
         q.created_at
  from soh_questions q
  order by q.created_at;
end;
$$;

-- ---------------------------------------------------------------- function access
-- Postgres lets everyone execute new functions by default; be explicit instead.

revoke execute on function
  public.soh_is_owner(), public.soh_touch(),
  public.soh_cast_vote(uuid, uuid, text), public.soh_my_vote(uuid, text),
  public.soh_ask(text, text), public.soh_toggle_upvote(uuid, text),
  public.soh_public_questions(text), public.soh_results(uuid), public.soh_all_questions()
from public, anon, authenticated;

grant execute on function
  public.soh_cast_vote(uuid, uuid, text), public.soh_my_vote(uuid, text),
  public.soh_ask(text, text), public.soh_toggle_upvote(uuid, text),
  public.soh_public_questions(text)
to anon, authenticated;

grant execute on function
  public.soh_is_owner(), public.soh_results(uuid), public.soh_all_questions()
to authenticated;

-- ---------------------------------------------------------------- realtime
-- Phones only receive changes to rows they're allowed to read (polls, options, stage).

alter publication supabase_realtime add table
  public.soh_polls, public.soh_options, public.soh_stage,
  public.soh_votes, public.soh_questions, public.soh_question_upvotes;

-- ---------------------------------------------------------------- first ballot

with poll as (
  insert into public.soh_polls (title) values ('What should I build live?') returning id
)
insert into public.soh_options (poll_id, label, description, sort_order)
select poll.id, o.label, o.description, o.sort_order
from poll, (values
  ('Walk-in waitlist board', 'A live list of who''s waiting and how long, for a host stand or front counter.', 1),
  ('Staff shift scheduler', 'Build the week''s shifts and let staff check them from their phones.', 2),
  ('Fundraiser thermometer', 'A big live progress bar toward a donation goal.', 3),
  ('Plate cost calculator', 'Enter ingredient costs and get the true cost and a suggested price per dish.', 4)
) as o (label, description, sort_order);

insert into public.soh_stage (id, poll_id)
select 1, id from public.soh_polls limit 1;

commit;
