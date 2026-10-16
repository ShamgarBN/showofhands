import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/** Milliseconds to add to Date.now() to match the database clock (so countdowns agree). */
export async function serverClockOffset(db: SupabaseClient): Promise<number> {
  const sent = Date.now();
  const { data, error } = await db.rpc('soh_now');
  if (error || !data) return 0;
  return offsetFrom(data as string, sent, Date.now());
}

/** Clock offset from a server timestamp, assuming it was taken halfway through the request. */
export function offsetFrom(serverIso: string, sent: number, received: number) {
  return new Date(serverIso).getTime() - (sent + received) / 2;
}

/** Runs refresh once at a time; extra calls while one is running are merged into one more run. */
function serialized(refresh: () => Promise<void>) {
  let running = false;
  let queued = false;
  const run = async (): Promise<void> => {
    if (running) { queued = true; return; }
    running = true;
    try { await refresh(); } catch (err) { console.warn('refresh failed', err); }
    running = false;
    if (queued) { queued = false; return run(); }
  };
  return run;
}

/**
 * Phones: a plain timer instead of a Realtime connection (see migration
 * 20261015g_phone_state.sql for why). Pauses while the tab is hidden and
 * catches up immediately when it comes back or the network returns.
 */
export function pollEvery(refresh: () => Promise<void>, everyMs: number) {
  const run = serialized(refresh);
  setInterval(() => { if (!document.hidden) void run(); }, everyMs);
  window.addEventListener('online', () => void run());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void run(); });
  void run();
  return { refreshNow: run };
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
  /** Rebuild the realtime channel if it has been down this long. */
  repairMs?: number;
  onStatus?: (status: LiveStatus) => void;
}

/**
 * Presenter, admin and moderator screens: Realtime first, polling as a fallback.
 * Recovers on its own after a network blip: Supabase reconnects the socket, we
 * refresh on reconnect, on 'online' and when the tab is visible again, and if the
 * channel stays down anyway we tear it down and subscribe again.
 */
export function watchTables({ client, tables, refresh, fallbackMs = 4000, safetyMs = 30000, repairMs = 20000, onStatus }: WatchOptions) {
  let status: LiveStatus = 'polling';
  let downSince = Date.now();
  let timer: number | undefined;
  const run = serialized(refresh);

  let debounce: number | undefined;
  const soon = () => { clearTimeout(debounce); debounce = window.setTimeout(run, 150); };

  const schedule = () => {
    clearInterval(timer);
    timer = window.setInterval(run, status === 'live' ? safetyMs : fallbackMs);
  };

  const setStatus = (next: LiveStatus) => {
    if (next === status) return;
    status = next;
    if (next === 'polling') downSince = Date.now();
    onStatus?.(status);
    schedule();
    if (next === 'live') soon(); // catch up on anything missed while disconnected
  };

  let channel: RealtimeChannel | null = null;
  const subscribe = () => {
    if (channel) void client.removeChannel(channel);
    let ch = client.channel(`soh-${Math.random().toString(36).slice(2)}`);
    for (const table of tables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, soon);
    }
    ch.subscribe(state => {
      if (ch !== channel) return; // an older channel we already replaced
      setStatus(state === 'SUBSCRIBED' ? 'live' : 'polling');
    });
    channel = ch;
    downSince = Date.now();
  };
  subscribe();

  // Self-repair: if realtime has been down too long, start over with a fresh channel.
  setInterval(() => {
    if (status === 'polling' && !document.hidden && Date.now() - downSince > repairMs) {
      console.info('realtime down too long; resubscribing');
      subscribe();
    }
  }, 5000);

  window.addEventListener('online', soon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });

  onStatus?.(status);
  schedule();
  void run();

  // Dev-only hook so the fallback and repair can be tested by breaking realtime on purpose.
  if (import.meta.env.DEV) (window as unknown as { __sohRealtime?: unknown }).__sohRealtime = client.realtime;

  return { refreshNow: soon };
}
