import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/** Milliseconds to add to Date.now() to match the database clock (so countdowns agree). */
export async function serverClockOffset(db: SupabaseClient): Promise<number> {
  const sent = Date.now();
  const { data, error } = await db.rpc('soh_now');
  if (error || !data) return 0;
  const received = Date.now();
  return new Date(data as string).getTime() - (sent + received) / 2;
}

export type LiveStatus = 'live' | 'polling';

interface WatchOptions {
  client: SupabaseClient;
  tables: string[];
  /** Reload whatever the page shows. Called on any change, and on a timer while realtime is down. */
  refresh: () => Promise<void>;
  /** How often to check while realtime is down. */
  fallbackMs?: number;
  /** Slow safety-net check even while realtime is up, in case an event is missed. */
  safetyMs?: number;
  onStatus?: (status: LiveStatus) => void;
}

/**
 * Realtime first, polling as a fallback. Recovers on its own after a network blip:
 * Supabase reconnects the socket, and we refresh on reconnect, on 'online',
 * and when the tab becomes visible again.
 */
export function watchTables({ client, tables, refresh, fallbackMs = 4000, safetyMs = 30000, onStatus }: WatchOptions) {
  let status: LiveStatus = 'polling';
  let timer: number | undefined;
  let running = false;
  let queued = false;

  const run = async () => {
    if (running) { queued = true; return; }
    running = true;
    try { await refresh(); } catch (err) { console.warn('refresh failed', err); }
    running = false;
    if (queued) { queued = false; void run(); }
  };

  let debounce: number | undefined;
  const soon = () => { clearTimeout(debounce); debounce = window.setTimeout(run, 150); };

  const schedule = () => {
    clearInterval(timer);
    timer = window.setInterval(run, status === 'live' ? safetyMs : fallbackMs);
  };

  const setStatus = (next: LiveStatus) => {
    if (next === status) return;
    status = next;
    onStatus?.(status);
    schedule();
    if (next === 'live') soon(); // catch up on anything missed while disconnected
  };

  let channel: RealtimeChannel = client.channel(`soh-${tables.join('-')}-${Math.random().toString(36).slice(2)}`);
  for (const table of tables) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, soon);
  }
  channel.subscribe(state => setStatus(state === 'SUBSCRIBED' ? 'live' : 'polling'));

  window.addEventListener('online', soon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });

  onStatus?.(status);
  schedule();
  void run();

  return { refreshNow: soon };
}
