import { createClient } from '@supabase/supabase-js';
import { PRICE_RETRY_COOLDOWN_DAYS, SERVICE_ROLE_KEY, SUPABASE_URL } from './config';

// Service-role client. BYPASSRLS: reads every user's collection rows (the union)
// and writes the global prices table. Server-side only.
export const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

export interface PriceUpsertRow {
  card_id: string;
  source: string;
  finish: string;
  date: string;
  retail: number;
  currency: string;
}

/** The collection-union: distinct Scryfall card ids across ALL users' items. */
export async function distinctCollectionCardIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('collection_items')
      .select('card_id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`collection read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(String(row.card_id).toLowerCase());
    if (data.length < pageSize) break;
  }
  return ids;
}

/** Upserts price rows in chunks. Returns the number of rows written. */
export async function upsertPrices(rows: PriceUpsertRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // Collapse duplicate conflict keys within the batch (last wins). The
  // uuid->scryfallId map is many-to-one — multiple MTGJSON uuids share one
  // scryfallId for multi-faced cards — so two source uuids can emit the same
  // (card_id, source, finish, date) row. Postgres ON CONFLICT DO UPDATE cannot
  // affect the same row twice in one statement, so without this dedupe the whole
  // upsert aborts ("command cannot affect row a second time"). Faces share a
  // price, so collapsing to the last value is correct.
  const byKey = new Map<string, PriceUpsertRow>();
  for (const row of rows) {
    byKey.set(`${row.card_id}|${row.source}|${row.finish}|${row.date}`, row);
  }
  const deduped = [...byKey.values()];

  const chunkSize = 1000;
  let written = 0;
  for (let i = 0; i < deduped.length; i += chunkSize) {
    const slice = deduped.slice(i, i + chunkSize);
    const { error } = await db
      .from('prices')
      .upsert(slice, { onConflict: 'card_id,source,finish,date' });
    if (error) throw new Error(`prices upsert failed: ${error.message}`);
    written += slice.length;
  }
  return written;
}

/** Deletes price rows older than `keepDays` from today (UTC). */
export async function prunePrices(keepDays: number): Promise<void> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const iso = cutoff.toISOString().slice(0, 10);
  const { error } = await db.from('prices').delete().lt('date', iso);
  if (error) throw new Error(`prune failed: ${error.message}`);
}

/**
 * Reads the on-demand price queue and returns the *claimable* card ids: never
 * attempted, or past the retry cooldown. The caller resolves them when done
 * (prunePricedQueue drops the now-priced, markPriceQueueAttempted cools down the
 * rest), so cards enqueued mid-run survive for the next dispatch.
 */
export async function claimPriceQueue(): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - PRICE_RETRY_COOLDOWN_DAYS);
  const staleOrNull = `last_attempt_at.is.null,last_attempt_at.lt.${cutoff.toISOString()}`;

  const ids: string[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('price_backfill_queue')
      .select('card_id')
      .or(staleOrNull)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`price queue read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) ids.push(String(row.card_id).toLowerCase());
    if (data.length < pageSize) break;
  }
  return ids;
}

/**
 * Stamps last_attempt_at on queued cards we tried but found no price for, so
 * they sit out the retry cooldown instead of re-firing a job on every save.
 */
export async function markPriceQueueAttempted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const chunkSize = 1000;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const { error } = await db
      .from('price_backfill_queue')
      .update({ last_attempt_at: now })
      .in('card_id', slice);
    if (error) throw new Error(`price queue mark failed: ${error.message}`);
  }
}

/**
 * Drops queue rows for cards that now have a price (via the prune_priced_queue
 * RPC). Keeps the queue scoped to genuinely unpriced cards so price_status never
 * reports a priced card as pending/noData. Returns rows removed.
 */
export async function prunePricedQueue(): Promise<number> {
  const { data, error } = await db.rpc('prune_priced_queue');
  if (error) throw new Error(`prune priced queue failed: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}
