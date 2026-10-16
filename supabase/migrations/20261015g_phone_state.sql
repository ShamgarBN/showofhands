-- Phones poll this one function instead of holding a Realtime connection.
--
-- Why: Supabase's free plan allows 100 Realtime messages per second, counted per
-- client. One poll change pushed to 150 phones is 150 messages at once, and going
-- over disconnects clients. One small request per phone every few seconds avoids
-- that limit entirely, and returns everything a phone needs in a single round trip.

create function public.soh_phone_state(p_voter_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'stage', (select jsonb_build_object('poll_id', s.poll_id, 'mode', s.mode, 'qa_open', s.qa_open, 'qa_version', s.qa_version)
              from soh_stage s where s.id = 1),
    'poll', (select jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status, 'blind_mode', p.blind_mode,
                                       'winner_option_id', p.winner_option_id, 'closes_at', p.closes_at)
             from soh_polls p join soh_stage s on s.poll_id = p.id where s.id = 1),
    'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'poll_id', o.poll_id, 'label', o.label,
                                                             'description', o.description, 'sort_order', o.sort_order)
                                          order by o.sort_order)
                         from soh_options o join soh_stage s on s.poll_id = o.poll_id where s.id = 1), '[]'::jsonb),
    'my_vote', (select v.option_id from soh_votes v join soh_stage s on s.poll_id = v.poll_id
                where s.id = 1 and v.voter_id = p_voter_id)
  );
$$;

revoke execute on function public.soh_phone_state(text) from public, anon, authenticated;
grant execute on function public.soh_phone_state(text) to anon, authenticated;

-- Make the API see the new function right away.
notify pgrst, 'reload schema';
