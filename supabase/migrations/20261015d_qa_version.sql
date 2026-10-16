-- Phones can't read the questions table (so they never see others' phone IDs or
-- unapproved questions), which means they get no live events for it. Instead the
-- owner bumps this counter when moderating; phones see the stage change and refetch.

alter table public.soh_stage add column qa_version int not null default 0;
