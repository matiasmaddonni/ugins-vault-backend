import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate } from '../_lib/auth';
import { requireMethod, sendJson } from '../_lib/http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OwnedCard {
  cardId: string;
  quantity: number;
}

/** PUT /v1/owned — replace the authenticated user's entire owned list. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireMethod(req, res, 'PUT')) return;

  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

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

  sendJson(res, 200, { ok: true, count: cards.length });
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
