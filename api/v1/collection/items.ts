import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate, type AuthContext } from '../../_lib/auth.js';
import { parseIdList, validateItems } from '../../_lib/collection.js';
import { maybeDispatchAfterWrite } from '../../_lib/dispatch.js';
import { sendJson } from '../../_lib/http.js';

/**
 * /v1/collection/items — incremental item ops on MY collection.
 *   POST   { items: [...] } — upsert a batch (insert-or-update by id). New cards
 *           are enqueued for pricing and the on-demand ingest is kicked.
 *   DELETE { ids: [uuid] }  — remove items (e.g. cards I sold).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST') return postItems(auth, req, res);
  if (req.method === 'DELETE') return deleteItems(auth, req, res);

  res.setHeader('Allow', 'POST, DELETE');
  sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST, DELETE' });
}

async function postItems(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const items = validateItems((req.body as { items?: unknown })?.items);
  if (!items) {
    sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'expected { items: [{ id: uuid, cardId: uuid, stackId: uuid, quantity: int >= 1, ... }] }'
    });
    return;
  }

  const { data, error } = await auth.db.rpc('upsert_collection_items', { p_items: items });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  const dispatched = await maybeDispatchAfterWrite(auth);
  sendJson(res, 200, { ok: true, upserted: typeof data === 'number' ? data : items.length, dispatched });
}

async function deleteItems(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const ids = parseIdList(req.body);
  if (!ids) {
    sendJson(res, 400, { error: 'invalid_body', detail: 'expected { ids: [uuid, ...] }' });
    return;
  }

  const { data, error } = await auth.db.rpc('delete_collection_items', { p_ids: ids });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  sendJson(res, 200, { ok: true, deleted: typeof data === 'number' ? data : 0 });
}
