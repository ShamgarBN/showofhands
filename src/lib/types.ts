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
