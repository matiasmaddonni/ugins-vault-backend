import { createClient } from '@supabase/supabase-js';
import { SERVICE_ROLE_KEY, SUPABASE_URL } from './config';

// Service-role client. BYPASSRLS: reads every user's owned rows (the union) and
// writes the global prices/fx tables. Server-side only.
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

/** The owned-union: distinct Scryfall card ids across ALL users. */
export async function distinctOwnedCardIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('owned')
      .select('card_id')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`owned read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(String(row.card_id).toLowerCase());
    if (data.length < pageSize) break;
  }
  return ids;
}

/** Upserts price rows in chunks. Returns the number of rows written. */
export async function upsertPrices(rows: PriceUpsertRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const chunkSize = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
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

export async function upsertFx(rows: { quote: string; rate: number }[]): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ quote: r.quote, rate: r.rate, fetched_at: now }));
  const { error } = await db.from('fx').upsert(payload, { onConflict: 'quote' });
  if (error) throw new Error(`fx upsert failed: ${error.message}`);
}
