import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../../_lib/auth.js';
import { requireMethod, sendJson } from '../../_lib/http.js';

/**
 * GET /v1/prices/status — per-user price fetch state, so the app can show
 * "fetching" and poll instead of falling back to client-side prices.
 *
 *   { pending: [cardId...],  // enqueued, not yet fetched -> still "fetching"
 *     noData:  [cardId...],  // fetched but MTGJSON has no price -> stop fetching
 *     updatedAt: "YYYY-MM-DD" | null }  // latest price date across my cards
 *
 * A card with a price is in neither list (the ingest clears it from the queue).
 * The app derives: owned cards not priced and not in `noData` are still pending.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const { data, error } = await auth.db.rpc('price_status');
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  sendJson(res, 200, data ?? { pending: [], noData: [], updatedAt: null });
}
