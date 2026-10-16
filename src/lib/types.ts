export type PollStatus = 'draft' | 'open' | 'closed' | 'revealed';

export interface Poll {
  id: string;
  title: string;
  status: PollStatus;
  blind_mode: boolean;
  winner_option_id: string | null;
}

export interface Option {
  id: string;
  poll_id: string;
  label: string;
  description: string;
  sort_order: number;
  manual_count: number;
}

export interface Stage {
  id: 1;
  poll_id: string | null;
  mode: 'poll' | 'qa';
  qa_open: boolean;
  onscreen_question_id: string | null;
  show_built_with_ai: boolean;
  built_stats: { label: string; value: string }[];
}

export interface Result {
  option_id: string;
  real_votes: number;
  simulated_votes: number;
  manual_votes: number;
  total: number;
}

/** Everything the projector shows, loaded in one go. */
export interface Snapshot {
  stage: Stage | null;
  poll: Poll | null;
  options: Option[];
  results: Result[];
}

/** Where the projector reads and writes. Real = Supabase; demo = in-memory (dev only). */
export interface PresenterApi {
  load(): Promise<Snapshot>;
  /** Each returns an error message, or null on success. */
  updatePoll(id: string, patch: Partial<Poll>): Promise<string | null>;
  updateStage(patch: Partial<Stage>): Promise<string | null>;
  resetVotes(pollId: string): Promise<string | null>;
  watch(refresh: () => Promise<void>, onLive: (live: boolean) => void): void;
}
