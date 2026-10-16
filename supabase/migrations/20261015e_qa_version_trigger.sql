-- Bump soh_stage.qa_version whenever a question is moderated (approved, hidden,
-- answered, deleted), so phones refetch no matter which screen made the change.
-- Not on insert: a new question is pending and invisible to other phones anyway.

create function public.soh_bump_qa_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update soh_stage set qa_version = qa_version + 1 where id = 1;
  return null;
end;
$$;

revoke execute on function public.soh_bump_qa_version() from public, anon, authenticated;

create trigger soh_questions_bump_qa
  after update or delete on public.soh_questions
  for each statement execute function public.soh_bump_qa_version();
