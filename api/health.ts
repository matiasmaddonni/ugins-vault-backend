import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendJson } from './_lib/http';

/** GET /api/health — unauthenticated liveness check. */
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  sendJson(res, 200, { ok: true, service: 'ugins-vault-backend', time: new Date().toISOString() });
}
