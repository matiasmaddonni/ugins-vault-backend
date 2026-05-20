import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../_lib/auth.js';
import { requireMethod, sendJson } from '../_lib/http.js';
import { num } from '../_lib/pricing.js';

interface FxRow {
  quote: string;
  rate: number | string;
  fetched_at: string;
}

/** GET /v1/fx — global USD->ARS / USD->EUR rates: { ars, eur, fetchedAt }. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const { data, error } = await auth.db.from('fx').select('quote, rate, fetched_at');
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  let ars: number | null = null;
  let eur: number | null = null;
  let fetchedAt: string | null = null;

  for (const row of (data ?? []) as FxRow[]) {
    if (row.quote === 'ARS') ars = num(row.rate);
    else if (row.quote === 'EUR') eur = num(row.rate);
    if (!fetchedAt || row.fetched_at > fetchedAt) fetchedAt = row.fetched_at;
  }

  sendJson(res, 200, { ars, eur, fetchedAt });
}
