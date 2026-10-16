const KEY = 'soh_voter_id';

/** crypto.randomUUID needs iOS 15.4+; build the same thing from random bytes on older phones. */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * A random ID that stands in for "this phone". No personal data.
 * Clearing browser data or using a private window gives a new ID (and a second vote);
 * that's an accepted limit for a room vote.
 */
export function getVoterId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 16) return existing;
    const fresh = randomId();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: the vote still works for this page visit.
    return (window as unknown as { __sohId?: string }).__sohId ??= randomId();
  }
}
