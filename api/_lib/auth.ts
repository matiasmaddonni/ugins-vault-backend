import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest } from '@vercel/node';
import { bearer } from './http.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function env(): { url: string; anon: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY environment variables');
  }
  return { url: SUPABASE_URL, anon: SUPABASE_ANON_KEY };
}

export interface AuthContext {
  /** The authenticated user's id (the JWT `sub` claim). */
  userId: string;
  /**
   * A request-scoped Supabase client that forwards the caller's JWT, so every
   * query runs under that user's RLS policies. Use this for ALL data access —
   * never the service-role key from the API.
   */
  db: SupabaseClient;
}

/**
 * Verifies the incoming Supabase JWT and returns a user-scoped client.
 *
 * Uses `auth.getClaims()` which, for projects on asymmetric signing keys
 * (ES256 — the default for projects created since Oct 2025), verifies the
 * signature locally against the cached JWKS with no round-trip to the Auth
 * server. The publishable/anon key is sufficient and correct here; the
 * service-role key must never gate auth (it bypasses RLS).
 *
 * Returns `null` when the token is missing or invalid — callers map that to 401.
 */
export async function authenticate(req: VercelRequest): Promise<AuthContext | null> {
  const token = bearer(req);
  if (!token) return null;

  const { url, anon } = env();

  const verifier = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let userId: string | undefined;
  try {
    const { data, error } = await verifier.auth.getClaims(token);
    if (error) return null;
    userId = data?.claims?.sub;
  } catch {
    // Unverifiable token (bad signature, JWKS hiccup) → treat as unauthorized.
    return null;
  }
  if (!userId) return null;

  const db = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return { userId, db };
}
