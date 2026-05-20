import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../_lib/auth';
import { firstStr, requireMethod, sendJson } from '../_lib/http';
import {
  addDaysISO,
  clampInt,
  DEFAULT_WINDOW,
  pickSource,
  toCardPrices,
  todayISO,
  type PriceRow
} from '../_lib/pricing';

/**
 * GET /v1/prices?window=35&source=tcgplayer
 *
 * Per owned card with data in the window: { cardId, source, currency, current,
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

  const { data, error } = await auth.db.rpc('owned_prices', { p_source: source, p_since: since });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  const cards = toCardPrices((data ?? []) as PriceRow[], source);
  sendJson(res, 200, { source, window, cards });
}
