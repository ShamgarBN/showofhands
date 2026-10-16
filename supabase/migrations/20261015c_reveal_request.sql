-- Lets the admin page ask the projector window to run its reveal animation.
-- The projector watches this counter and reveals when it goes up.

alter table public.soh_stage add column reveal_requests int not null default 0;
