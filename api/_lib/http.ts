import type { VercelRequest, VercelResponse } from '@vercel/node';

/** Extracts the raw bearer token from the Authorization header, or null. */
export function bearer(req: VercelRequest): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
}

export function sendJson(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

/** Returns true if the method matches; otherwise writes a 405 and returns false. */
export function requireMethod(req: VercelRequest, res: VercelResponse, method: string): boolean {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  sendJson(res, 405, { error: 'method_not_allowed', allow: method });
  return false;
}

/** First value of a query param that may arrive as string | string[]. */
export function firstStr(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
