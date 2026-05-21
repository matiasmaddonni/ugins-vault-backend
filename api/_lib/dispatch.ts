// Fires a GitHub repository_dispatch so the on-demand price ingest runs right
// after a user adds new cards (see .github/workflows/ingest-on-demand.yml).
//
// This is the ONLY GitHub credential the read API uses, and it is NOT the
// service-role key: a fine-grained PAT scoped to `Contents: read and write` on
// this repo (env GH_DISPATCH_TOKEN), plus the repo slug (env GH_REPO,
// "owner/name"). If either is unset, dispatch is skipped silently — prices then
// arrive via the daily cron instead, so the feature degrades gracefully.

import type { AuthContext } from './auth.js';

const EVENT_TYPE = 'new-cards';

/**
 * Triggers the on-demand ingest. Returns true if the dispatch was accepted.
 * Never throws — a failed dispatch must not fail the user's write; the daily
 * cron is the backstop.
 */
export async function triggerOnDemandIngest(): Promise<boolean> {
  const token = process.env.GH_DISPATCH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) return false;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ugins-vault-backend',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ event_type: EVENT_TYPE })
    });
    if (!res.ok) {
      console.error(`[dispatch] repository_dispatch failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[dispatch] repository_dispatch error:', err);
    return false;
  }
}

/**
 * After a write that may have enqueued new-to-price cards, kick the on-demand
 * ingest iff the price queue is non-empty. Best-effort — a failed check or
 * dispatch never fails the caller's write (daily cron backstops). Returns
 * whether a dispatch was fired.
 */
export async function maybeDispatchAfterWrite(auth: AuthContext): Promise<boolean> {
  try {
    const { data: pending } = await auth.db.rpc('price_queue_size');
    if (typeof pending === 'number' && pending > 0) {
      return await triggerOnDemandIngest();
    }
  } catch {
    // ignore — prices will still arrive via the daily cron
  }
  return false;
}
