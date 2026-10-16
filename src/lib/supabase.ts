import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY (see .env.example)');
}

/**
 * fetch with a time limit. On a flaky venue network a request can hang for minutes;
 * cutting it off lets the next check try again instead of the screen sitting frozen.
 */
function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    init?.signal?.addEventListener('abort', () => controller.abort());
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

const global = { fetch: fetchWithTimeout(8000) };

/** Phones never sign in, so they skip session storage entirely. */
export function phoneClient(): SupabaseClient {
  return createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global,
  });
}

/** Presenter and admin pages sign in with a magic link and stay signed in. */
export function ownerClient(): SupabaseClient {
  return createClient(url!, anonKey!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    global,
  });
}
