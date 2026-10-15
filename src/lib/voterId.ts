const KEY = 'soh_voter_id';

/**
 * A random ID that stands in for "this phone". No personal data.
 * Clearing browser data or using a private window gives a new ID (and a second vote);
 * that's an accepted limit for a room vote.
 */
export function getVoterId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && existing.length >= 16) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: the vote still works for this page visit.
    return (window as unknown as { __sohId?: string }).__sohId ??= crypto.randomUUID();
  }
}
