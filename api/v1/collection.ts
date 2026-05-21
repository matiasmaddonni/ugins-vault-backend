import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate, type AuthContext } from '../_lib/auth.js';
import {
  ITEM_COLUMNS,
  STACK_COLUMNS,
  mapItem,
  mapStack,
  validateItems,
  validateStacks,
  type CollectionItem,
  type Stack
} from '../_lib/collection.js';
import { maybeDispatchAfterWrite } from '../_lib/dispatch.js';
import { sendJson } from '../_lib/http.js';

/**
 * /v1/collection — the user's whole collection (source of truth).
 *   GET: { stacks, items } — the app restores everything on a fresh install.
 *   PUT: replace the entire collection (atomic). For incremental add/remove use
 *        POST/DELETE /v1/collection/items and /v1/collection/stacks.
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
    const { data, error } = await auth.db.from('stacks').select(STACK_COLUMNS).order('id').range(from, from + pageSize - 1);
    if (error) {
      sendJson(res, 500, { error: 'db_error', detail: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data) stacks.push(mapStack(row as never));
    if (data.length < pageSize) break;
  }

  const items: CollectionItem[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await auth.db.from('collection_items').select(ITEM_COLUMNS).order('id').range(from, from + pageSize - 1);
    if (error) {
      sendJson(res, 500, { error: 'db_error', detail: error.message });
      return;
    }
    if (!data || data.length === 0) break;
    for (const row of data) items.push(mapItem(row as never));
    if (data.length < pageSize) break;
  }

  sendJson(res, 200, { stacks, items });
}

/** PUT /v1/collection — replace the authenticated user's entire collection. */
async function handlePut(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = (req.body ?? {}) as { stacks?: unknown; items?: unknown };
  const stacks = validateStacks(body.stacks);
  if (!stacks) {
    sendJson(res, 400, { error: 'invalid_body', detail: 'stacks must be an array of { id: uuid, ... }' });
    return;
  }
  const stackIds = new Set(stacks.map((s) => String((s as { id: string }).id).toLowerCase()));
  const items = validateItems(body.items, stackIds);
  if (!items) {
    sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'items must be [{ id: uuid, cardId: uuid, stackId: uuid (in stacks), quantity: int >= 1, ... }]'
    });
    return;
  }

  const { data, error } = await auth.db.rpc('replace_collection', { p_stacks: stacks, p_items: items });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  const dispatched = await maybeDispatchAfterWrite(auth);
  const counts = (data ?? {}) as { stacks?: number; items?: number };
  sendJson(res, 200, {
    ok: true,
    stacks: counts.stacks ?? stacks.length,
    items: counts.items ?? items.length,
    dispatched
  });
}
