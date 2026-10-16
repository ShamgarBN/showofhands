/**
 * DEV ONLY: fake data so the projector can be tested and rehearsed without signing in.
 * Open present.html?demo (or ?demo=tie to force a tie). Never included in the production build.
 */
import type { Option, Poll, PresenterApi, Result, Stage } from './types';

export function demoApi(): PresenterApi {
  const forceTie = new URLSearchParams(location.search).get('demo') === 'tie';
  const poll: Poll = { id: 'demo-poll', title: 'What should I build live?', status: 'draft', blind_mode: false, winner_option_id: null, closes_at: null };
  const options: Option[] = [
    ['Walk-in waitlist board', 'A live list of who\'s waiting and how long, for a host stand or front counter.'],
    ['Staff shift scheduler', 'Build the week\'s shifts and let staff check them from their phones.'],
    ['Fundraiser thermometer', 'A big live progress bar toward a donation goal.'],
    ['Plate cost calculator', 'Enter ingredient costs and get the true cost and a suggested price per dish.'],
  ].map(([label, description], i) => ({ id: `demo-${i}`, poll_id: poll.id, label, description, sort_order: i + 1, manual_count: 0 }));
  const stage: Stage = {
    id: 1, poll_id: poll.id, mode: 'poll', qa_open: true, onscreen_question_id: null, show_built_with_ai: false, reveal_requests: 0,
    built_stats: [
      { label: 'Time to build', value: '3.5 hrs' },
      { label: 'Prompts', value: '42' },
      { label: 'Lines of code I wrote', value: '0' },
    ],
  };
  const votes = new Map(options.map(o => [o.id, 0]));
  const weights = [0.3, 0.2, 0.35, 0.15];
  let notify: () => void = () => {};

  // Votes trickle in while voting is open, like a real room.
  setInterval(() => {
    if (poll.status !== 'open' || (poll.closes_at && Date.parse(poll.closes_at) <= Date.now())) return;
    if (forceTie) {
      for (const id of ['demo-1', 'demo-2']) votes.set(id, votes.get(id)! + 1);
      if (Math.random() < 0.3) votes.set('demo-0', votes.get('demo-0')! + 1);
    } else {
      let r = Math.random();
      const i = weights.findIndex(w => (r -= w) < 0);
      const id = options[i === -1 ? 0 : i].id;
      votes.set(id, votes.get(id)! + 1);
    }
    notify();
  }, 700);

  const results = (): Result[] => options.map(o => ({
    option_id: o.id, real_votes: votes.get(o.id)!, simulated_votes: 0, manual_votes: 0, total: votes.get(o.id)!,
  }));

  return {
    async load() {
      return { stage: structuredClone(stage), poll: structuredClone(poll), options: structuredClone(options), results: results() };
    },
    async updatePoll(_id, patch) { Object.assign(poll, patch); notify(); return null; },
    async updateStage(patch) { Object.assign(stage, patch); notify(); return null; },
    async startCountdown(_id, seconds) {
      poll.closes_at = new Date(Date.now() + seconds * 1000).toISOString();
      notify();
      return null;
    },
    async clockOffset() { return 0; },
    async resetVotes() { votes.forEach((_, k) => votes.set(k, 0)); notify(); return null; },
    watch(refresh, onLive) {
      notify = () => void refresh();
      onLive(true);
      void refresh();
    },
  };
}
