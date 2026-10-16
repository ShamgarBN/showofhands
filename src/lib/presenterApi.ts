import type { SupabaseClient } from '@supabase/supabase-js';
import { serverClockOffset, watchTables } from './live';
import type { Option, Poll, PresenterApi, Question, Result, Snapshot, Stage } from './types';

export function supabaseApi(db: SupabaseClient): PresenterApi {
  return {
    async load(): Promise<Snapshot> {
      const [st, q] = await Promise.all([
        db.from('soh_stage').select('*').eq('id', 1).maybeSingle<Stage>(),
        db.rpc('soh_all_questions'),
      ]);
      if (st.error || q.error) throw st.error ?? q.error;
      const stage = st.data;
      const questions = (q.data ?? []) as Question[];
      if (!stage?.poll_id) return { stage, poll: null, options: [], results: [], questions };
      const [p, o, r] = await Promise.all([
        db.from('soh_polls').select('id,title,status,blind_mode,winner_option_id,closes_at').eq('id', stage.poll_id).maybeSingle<Poll>(),
        db.from('soh_options').select('*').eq('poll_id', stage.poll_id).order('sort_order'),
        db.rpc('soh_results', { p_poll_id: stage.poll_id }),
      ]);
      if (p.error || o.error || r.error) throw p.error ?? o.error ?? r.error;
      return { stage, poll: p.data, options: (o.data ?? []) as Option[], results: (r.data ?? []) as Result[], questions };
    },

    async updatePoll(id, patch) {
      const { error } = await db.from('soh_polls').update(patch).eq('id', id);
      return error?.message ?? null;
    },

    async updateStage(patch) {
      const { error } = await db.from('soh_stage').update(patch).eq('id', 1);
      return error?.message ?? null;
    },

    async resetVotes(pollId) {
      const steps = await Promise.all([
        db.from('soh_votes').delete().eq('poll_id', pollId),
        db.from('soh_options').update({ manual_count: 0 }).eq('poll_id', pollId),
      ]);
      return steps.find(s => s.error)?.error?.message ?? null;
    },

    async startCountdown(pollId, seconds) {
      const { error } = await db.rpc('soh_start_countdown', { p_poll_id: pollId, p_seconds: seconds });
      return error?.message ?? null;
    },

    async updateQuestion(id, patch) {
      const { error } = await db.from('soh_questions').update(patch).eq('id', id);
      return error?.message ?? null;
    },

    clockOffset: () => serverClockOffset(db),

    watch(refresh, onLive) {
      watchTables({
        client: db,
        tables: ['soh_stage', 'soh_polls', 'soh_options', 'soh_votes', 'soh_questions', 'soh_question_upvotes'],
        refresh,
        fallbackMs: 3000,
        onStatus: s => onLive(s === 'live'),
      });
    },
  };
}
