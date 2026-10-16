-- Moderator: a third role, reached by a private link instead of an account.
--
-- Why not an account: this project's other app lets ANY signed-in user read and
-- delete its tables, so a moderator account would get that too. A link keeps the
-- moderator on the public (anon) key, with access only through the soh_mod_* functions.
--
-- The database keeps only a SHA-256 hash of the link's key. The owner can replace
-- the key (which kills the old link) or turn moderation off at any time.

begin;

create table public.soh_mod_key (
  id int primary key default 1 check (id = 1),  -- one active link at a time
  key_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.soh_mod_key enable row level security;
-- no policies: only the functions below touch it

create function public.soh_mod_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select char_length(coalesce(p_key, '')) >= 32
     and exists (select 1 from soh_mod_key where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'));
$$;

-- ---------------------------------------------------------------- owner: manage the link

-- Make a new moderator key (replacing any old one) and return it once.
create function public.soh_new_mod_key() returns text
language plpgsql security definer set search_path = public as $$
declare
  k text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');  -- 244 random bits
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  insert into soh_mod_key (id, key_hash, created_at)
  values (1, encode(sha256(convert_to(k, 'UTF8')), 'hex'), now())
  on conflict (id) do update set key_hash = excluded.key_hash, created_at = excluded.created_at;
  return k;
end;
$$;

create function public.soh_revoke_mod_key() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  delete from soh_mod_key;
end;
$$;

-- When the current link was made (null = no link).
create function public.soh_mod_key_created_at() returns timestamptz
language plpgsql stable security definer set search_path = public as $$
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  return (select created_at from soh_mod_key where id = 1);
end;
$$;

-- ---------------------------------------------------------------- moderator actions

create function public.soh_mod_check(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select soh_mod_ok(p_key);
$$;

-- Every question (text only, never phone IDs) plus whether it's on screen.
create function public.soh_mod_questions(p_key text)
returns table (id uuid, body text, status text, upvotes bigint, created_at timestamptz, on_screen boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not soh_mod_ok(p_key) then
    raise exception 'invalid moderator link';
  end if;
  return query
  select q.id, q.body, q.status,
         (select count(*) from soh_question_upvotes u where u.question_id = q.id),
         q.created_at,
         q.id = (select s.onscreen_question_id from soh_stage s where s.id = 1)
  from soh_questions q
  order by q.created_at;
end;
$$;

-- Approve, hide or mark answered. Taking a question out of 'approved' also takes it off screen.
create function public.soh_mod_set_status(p_key text, p_question_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not soh_mod_ok(p_key) then
    raise exception 'invalid moderator link';
  end if;
  if p_status not in ('approved', 'hidden', 'answered') then
    raise exception 'invalid status';
  end if;
  update soh_questions set status = p_status where id = p_question_id;
  if p_status <> 'approved' then
    update soh_stage set onscreen_question_id = null where id = 1 and onscreen_question_id = p_question_id;
  end if;
end;
$$;

-- Put an approved question on the projector, or clear it (null).
create function public.soh_mod_set_onscreen(p_key text, p_question_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not soh_mod_ok(p_key) then
    raise exception 'invalid moderator link';
  end if;
  if p_question_id is not null
     and not exists (select 1 from soh_questions where id = p_question_id and status = 'approved') then
    raise exception 'only approved questions can go on screen';
  end if;
  update soh_stage set onscreen_question_id = p_question_id where id = 1;
end;
$$;

-- ---------------------------------------------------------------- access

revoke execute on function
  public.soh_mod_ok(text), public.soh_new_mod_key(), public.soh_revoke_mod_key(), public.soh_mod_key_created_at(),
  public.soh_mod_check(text), public.soh_mod_questions(text), public.soh_mod_set_status(text, uuid, text),
  public.soh_mod_set_onscreen(text, uuid)
from public, anon, authenticated;

grant execute on function public.soh_new_mod_key(), public.soh_revoke_mod_key(), public.soh_mod_key_created_at()
to authenticated;

grant execute on function
  public.soh_mod_check(text), public.soh_mod_questions(text), public.soh_mod_set_status(text, uuid, text),
  public.soh_mod_set_onscreen(text, uuid)
to anon, authenticated;

commit;
