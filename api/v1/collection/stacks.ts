import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticate, type AuthContext } from '../../_lib/auth.js';
import { parseIdList, validateStacks } from '../../_lib/collection.js';
import { sendJson } from '../../_lib/http.js';

/**
 * /v1/collection/stacks — incremental stack ops on MY collection.
 *   POST   { stacks: [...] } — upsert a batch (insert-or-update by id).
 *   DELETE { ids: [uuid] }   — remove stacks AND their items (no orphans).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const auth = await authenticate(req);
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST') return postStacks(auth, req, res);
  if (req.method === 'DELETE') return deleteStacks(auth, req, res);

  res.setHeader('Allow', 'POST, DELETE');
  sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST, DELETE' });
}

async function postStacks(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const stacks = validateStacks((req.body as { stacks?: unknown })?.stacks);
  if (!stacks) {
    sendJson(res, 400, { error: 'invalid_body', detail: 'expected { stacks: [{ id: uuid, ... }] }' });
    return;
  }

  const { data, error } = await auth.db.rpc('upsert_collection_stacks', { p_stacks: stacks });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  sendJson(res, 200, { ok: true, upserted: typeof data === 'number' ? data : stacks.length });
}

async function deleteStacks(auth: AuthContext, req: VercelRequest, res: VercelResponse): Promise<void> {
  const ids = parseIdList(req.body);
  if (!ids) {
    sendJson(res, 400, { error: 'invalid_body', detail: 'expected { ids: [uuid, ...] }' });
    return;
  }

  const { data, error } = await auth.db.rpc('delete_collection_stacks', { p_ids: ids });
  if (error) {
    sendJson(res, 500, { error: 'db_error', detail: error.message });
    return;
  }

  sendJson(res, 200, { ok: true, deleted: typeof data === 'number' ? data : 0 });
}
