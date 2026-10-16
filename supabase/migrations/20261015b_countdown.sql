-- Countdown close: the presenter starts a timer, and the database stops accepting
-- votes at the deadline even if the presenter's laptop hiccups.

begin;

alter table public.soh_polls add column closes_at timestamptz;

-- Same as before, plus: no votes at or after the deadline.
create or replace function public.soh_cast_vote(p_poll_id uuid, p_option_id uuid, p_voter_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if char_length(coalesce(p_voter_id, '')) not between 16 and 64 then
    raise exception 'invalid voter id';
  end if;
  if not exists (
    select 1 from soh_polls
    where id = p_poll_id and status = 'open' and (closes_at is null or closes_at > now())
  ) then
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

-- Server clock, so phones and the projector count down to the same moment.
create function public.soh_now() returns timestamptz
language sql stable as $$ select now() $$;

-- Owner only: set the deadline from the server's clock.
create function public.soh_start_countdown(p_poll_id uuid, p_seconds int)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  deadline timestamptz;
begin
  if not soh_is_owner() then
    raise exception 'owner only';
  end if;
  if p_seconds not between 5 and 600 then
    raise exception 'countdown must be 5 to 600 seconds';
  end if;
  update soh_polls set closes_at = now() + make_interval(secs => p_seconds)
  where id = p_poll_id and status = 'open'
  returning closes_at into deadline;
  if deadline is null then
    raise exception 'voting is not open';
  end if;
  return deadline;
end;
$$;

revoke execute on function public.soh_now(), public.soh_start_countdown(uuid, int) from public, anon, authenticated;
grant execute on function public.soh_now() to anon, authenticated;
grant execute on function public.soh_start_countdown(uuid, int) to authenticated;

commit;
