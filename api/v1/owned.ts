import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate, type AuthContext } from '../_lib/auth.js';
import { triggerOnDemandIngest } from '../_lib/dispatch.js';
import { sendJson } from '../_lib/http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OwnedCard {
  cardId: string;
  quantity: number;
}

/**
 * /v1/owned — the user's collection lives on the backend (authoritative).
 *   GET: return my owned list — the app restores its collection from this.
 *   PUT: replace my entire owned list (atomic).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET') return handleGet(auth, res);
  if (req.method === 'PUT') return handlePut(auth, req, res);

  res.setHeader('Allow', 'GET, PUT');
  sendJson(res, 405, { error: 'method_not_allowed', allow: 'GET, PUT' });
}

/** GET /v1/owned — the caller's full owned list, paged under RLS. */
async function handleGet(auth: AuthContext, res: VercelResponse): Promise<void> {
  const cards: OwnedCard[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await auth.db
      .from('owned')
      .select('card_id, quantity')
      .order('card_id')
      .range(from, from + pageSize - 1);
    if (error) {
      sendJson(res, 500, { error: 'db_error', detail: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      cards.push({ cardId: String(row.card_id), quantity: Number(row.quantity) });
    }
    if (data.length < pageSize) break;
  }
  sendJson(res, 200, { cards, count: cards.length });
}

/** PUT /v1/owned — replace the authenticated user's entire owned list. */
async function handlePut(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const cards = parseCards(req.body);
  if (!cards) {
    sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'expected { cards: [{ cardId: <scryfall uuid>, quantity: int >= 1 }] }'
    });
    return;
  }

  const { error } = await auth.db.rpc('replace_owned', { p_cards: cards });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  // The insert trigger (0005) enqueues any of these cards that have no price
  // yet. If the queue is now non-empty, kick the on-demand ingest so prices
  // show ASAP instead of at the next daily cron. Best-effort: a failed check or
  // dispatch never fails the save (the daily cron is the backstop).
  let dispatched = false;
  try {
    const { data: pending } = await auth.db.rpc('price_queue_size');
    if (typeof pending === 'number' && pending > 0) {
      dispatched = await triggerOnDemandIngest();
    }
  } catch {
    // ignore — prices will still arrive via the daily cron
  }

  sendJson(res, 200, { ok: true, count: cards.length, dispatched });
}

/** Validates + de-duplicates the request body. Returns null if malformed. */
function parseCards(body: unknown): OwnedCard[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { cards?: unknown }).cards;
  if (!Array.isArray(raw)) return null;

  const byId = new Map<string, OwnedCard>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const cardId = (item as { cardId?: unknown }).cardId;
    if (typeof cardId !== 'string' || !UUID_RE.test(cardId)) return null;

    const rawQty = (item as { quantity?: unknown }).quantity ?? 1;
    const quantity = Number(rawQty);
    if (!Number.isInteger(quantity) || quantity < 1) return null;

    // Last write wins on duplicate ids (avoids ON CONFLICT double-hit in SQL).
    byId.set(cardId.toLowerCase(), { cardId: cardId.toLowerCase(), quantity });
  }
  return [...byId.values()];
}
