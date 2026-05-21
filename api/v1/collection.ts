import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate, type AuthContext } from '../_lib/auth.js';
import { triggerOnDemandIngest } from '../_lib/dispatch.js';
import { sendJson } from '../_lib/http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wire DTOs (camelCase). The backend is a thin id+ownership store: it keeps NO
// card metadata (the app re-hydrates from Scryfall by id), and every enum-ish
// field here (kind, finish, condition, format, colors, language) is an OPAQUE
// string the app owns — stored and returned verbatim, never validated.
interface Stack {
  id: string;
  name: string;
  kind: string;
  sortOrder: number;
  createdAt: string;
  format: string | null;
  colors: string[];
  commander: string | null;
  commanderCardId: string | null;
  person: string | null;
  since: string | null;
}

interface CollectionItem {
  id: string;
  cardId: string;
  stackId: string;
  quantity: number;
  finish: string;
  condition: string;
  language: string;
  acquiredAt: string | null;
  notes: string | null;
}

// Raw DB row shapes (snake_case columns).
interface StackRow {
  id: string;
  name: string;
  kind: string;
  sort_order: number;
  created_at: string;
  format: string | null;
  colors: string[] | null;
  commander: string | null;
  commander_card_id: string | null;
  person: string | null;
  since: string | null;
}

interface ItemRow {
  id: string;
  card_id: string;
  stack_id: string;
  quantity: number;
  finish: string;
  condition: string;
  language: string;
  acquired_at: string | null;
  notes: string | null;
}

/**
 * /v1/collection — the user's collection lives on the backend (source of truth).
 *   GET: return my whole collection ({ stacks, items }) — the app restores it on
 *        a fresh install.
 *   PUT: replace my whole collection (atomic).
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

/** GET /v1/collection — the caller's stacks + items, paged under RLS. */
async function handleGet(auth: AuthContext, res: VercelResponse): Promise<void> {
  const pageSize = 1000;

  const stacks: Stack[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await auth.db
      .from('stacks')
      .select('id, name, kind, sort_order, created_at, format, colors, commander, commander_card_id, person, since')
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) {
      sendJson(res, 500, { error: 'db_error', detail: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data as StackRow[]) stacks.push(mapStack(row));
    if (data.length < pageSize) break;
  }

  const items: CollectionItem[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await auth.db
      .from('collection_items')
      .select('id, card_id, stack_id, quantity, finish, condition, language, acquired_at, notes')
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) {
      sendJson(res, 500, { error: 'db_error', detail: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data as ItemRow[]) items.push(mapItem(row));
    if (data.length < pageSize) break;
  }

  sendJson(res, 200, { stacks, items });
}

/** PUT /v1/collection — replace the authenticated user's entire collection. */
async function handlePut(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = parseBody(req.body);
  if (!body) {
    sendJson(res, 400, {
      error: 'invalid_body',
      detail:
        'expected { stacks: [{ id: uuid, ... }], items: [{ id: uuid, cardId: uuid, stackId: uuid (in stacks), quantity: int >= 1, ... }] }'
    });
    return;
  }

  // Opaque fields are passed through verbatim; replace_collection extracts the
  // known keys and ignores any user_id in the payload.
  const { data, error } = await auth.db.rpc('replace_collection', {
    p_stacks: body.stacks,
    p_items: body.items
  });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  // The collection_items insert trigger (0007) enqueues any card with no price
  // yet. If the queue is now non-empty, kick the on-demand ingest so prices show
  // ASAP. Best-effort: a failed check or dispatch never fails the save (the
  // daily cron is the backstop).
  let dispatched = false;
  try {
    const { data: pending } = await auth.db.rpc('price_queue_size');
    if (typeof pending === 'number' && pending > 0) {
      dispatched = await triggerOnDemandIngest();
    }
  } catch {
    // ignore — prices will still arrive via the daily cron
  }

  const counts = (data ?? {}) as { stacks?: number; items?: number };
  sendJson(res, 200, {
    ok: true,
    stacks: counts.stacks ?? body.stacks.length,
    items: counts.items ?? body.items.length,
    dispatched
  });
}

function mapStack(row: StackRow): Stack {
  return {
    id: String(row.id),
    name: row.name,
    kind: row.kind,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    format: row.format ?? null,
    colors: Array.isArray(row.colors) ? row.colors : [],
    commander: row.commander ?? null,
    commanderCardId: row.commander_card_id ?? null,
    person: row.person ?? null,
    since: row.since ?? null
  };
}

function mapItem(row: ItemRow): CollectionItem {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    stackId: String(row.stack_id),
    quantity: Number(row.quantity),
    finish: row.finish,
    condition: row.condition,
    language: row.language,
    acquiredAt: row.acquired_at ?? null,
    notes: row.notes ?? null
  };
}

/**
 * Minimal validation — ids are UUIDs, quantity is an int >= 1, and every
 * item.stackId points at a stack in the same payload. Returns the original
 * (verbatim) arrays so opaque fields round-trip untouched, or null if malformed.
 */
function parseBody(body: unknown): { stacks: unknown[]; items: unknown[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const rawStacks = (body as { stacks?: unknown }).stacks;
  const rawItems = (body as { items?: unknown }).items;
  if (!Array.isArray(rawStacks) || !Array.isArray(rawItems)) return null;

  const stackIds = new Set<string>();
  for (const s of rawStacks) {
    if (typeof s !== 'object' || s === null) return null;
    const id = (s as { id?: unknown }).id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    stackIds.add(id.toLowerCase());
  }

  for (const it of rawItems) {
    if (typeof it !== 'object' || it === null) return null;
    const id = (it as { id?: unknown }).id;
    const cardId = (it as { cardId?: unknown }).cardId;
    const stackId = (it as { stackId?: unknown }).stackId;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    if (typeof cardId !== 'string' || !UUID_RE.test(cardId)) return null;
    if (typeof stackId !== 'string' || !UUID_RE.test(stackId)) return null;
    if (!stackIds.has(stackId.toLowerCase())) return null;

    const quantity = (it as { quantity?: unknown }).quantity;
    if (!Number.isInteger(quantity) || (quantity as number) < 1) return null;
  }

  return { stacks: rawStacks, items: rawItems };
}
