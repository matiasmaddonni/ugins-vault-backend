import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../_lib/auth.js';
import { firstStr, requireMethod, sendJson } from '../_lib/http.js';
import {
  addDaysISO,
  clampInt,
  DEFAULT_WINDOW,
  fetchOwnedPrices,
  pickSource,
  toCardPrices,
  todayISO
} from '../_lib/pricing.js';

/**
 * GET /v1/prices?window=35&source=tcgplayer
 *
 * Per collection card with data in the window: { cardId, source, currency, current,
 * history:[{date,price}] }. The iOS app maps each `history` point to a
 * PriceSnapshot { cardID, source, date, currency, retail: price } and feeds its
 * existing computeHistory. Cards with no data for the chosen source are omitted
 * (the app falls back to on-device Scryfall prices).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const source = pickSource(firstStr(req.query.source));
  const window = clampInt(firstStr(req.query.window), DEFAULT_WINDOW, 1, 365);
  const since = addDaysISO(todayISO(), -window);

  let rows;
  try {
    rows = await fetchOwnedPrices(auth.db, source, since);
  } catch (e) {
    sendJson(res, 500, { error: 'db_error', detail: e instanceof Error ? e.message : String(e) });
    return;
  }

  const cards = toCardPrices(rows, source);
  sendJson(res, 200, { source, window, cards });
}
