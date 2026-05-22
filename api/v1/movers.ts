import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../_lib/auth.js';
import { firstStr, requireMethod, sendJson } from '../_lib/http.js';
import {
  addDaysISO,
  clampFloat,
  clampInt,
  computeMovers,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW,
  fetchOwnedPrices,
  pickSource,
  todayISO
} from '../_lib/pricing.js';

/**
 * GET /v1/movers?source=tcgplayer&window=35&threshold=1
 *
 * Server-side mirror of RealDashboardRepository.computeHistory for the
 * authenticated user's collection cards. Returns gainers/losers (top 5 each, by
 * per-unit 7-day delta), monthSparkline (portfolio value per sampled day),
 * weekDeltaUSD and weekDeltaPct. `cardId` is the Scryfall id — the client
 * resolves name/setCode from its on-device catalogue.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const source = pickSource(firstStr(req.query.source));
  const window = clampInt(firstStr(req.query.window), DEFAULT_WINDOW, 8, 365);
  const threshold = clampFloat(firstStr(req.query.threshold), DEFAULT_THRESHOLD, 0, 1_000_000);
  const since = addDaysISO(todayISO(), -window);

  let rows;
  try {
    rows = await fetchOwnedPrices(auth.db, source, since);
  } catch (e) {
    sendJson(res, 500, { error: 'db_error', detail: e instanceof Error ? e.message : String(e) });
    return;
  }

  const result = computeMovers(rows, source, threshold);
  sendJson(res, 200, result);
}
