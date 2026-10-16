export type PollStatus = 'draft' | 'open' | 'closed' | 'revealed';

export interface Poll {
  id: string;
  title: string;
  status: PollStatus;
  blind_mode: boolean;
  winner_option_id: string | null;
  /** Countdown deadline (server time). The database rejects votes after it. */
  closes_at: string | null;
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
  /** Goes up when the admin page asks the projector to reveal. */
  reveal_requests: number;
  /** Goes up when the owner moderates questions, so phones refetch. */
  qa_version: number;
}

export interface Result {
  option_id: string;
  real_votes: number;
  simulated_votes: number;
  manual_votes: number;
  total: number;
}

export type QuestionStatus = 'pending' | 'approved' | 'hidden' | 'answered';

/** A question as the owner sees it (no phone IDs). */
export interface Question {
  id: string;
  body: string;
  status: QuestionStatus;
  upvotes: number;
  created_at: string;
}

/** A question as a phone sees it. */
export interface PublicQuestion extends Question {
  upvoted: boolean;
  mine: boolean;
}

/** Everything the projector shows, loaded in one go. */
export interface Snapshot {
  stage: Stage | null;
  poll: Poll | null;
  options: Option[];
  results: Result[];
  questions: Question[];
}

/** Where the projector reads and writes. Real = Supabase; demo = in-memory (dev only). */
export interface PresenterApi {
  load(): Promise<Snapshot>;
  /** Each returns an error message, or null on success. */
  /** onlyIfStatus: skip the write unless the poll is still in that status. */
  updatePoll(id: string, patch: Partial<Poll>, onlyIfStatus?: PollStatus): Promise<string | null>;
  updateStage(patch: Partial<Stage>): Promise<string | null>;
  resetVotes(pollId: string): Promise<string | null>;
  startCountdown(pollId: string, seconds: number): Promise<string | null>;
  updateQuestion(id: string, patch: Partial<Question>): Promise<string | null>;
  /** Milliseconds to add to Date.now() to get server time. */
  clockOffset(): Promise<number>;
  watch(refresh: () => Promise<void>, onLive: (live: boolean) => void): void;
}
