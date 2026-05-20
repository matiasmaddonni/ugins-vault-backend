// Ingest configuration. Reads service-role credentials from the environment
// (GitHub Actions secrets / local .env). The service-role key bypasses RLS — it
// must NEVER reach the iOS app or the read API.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const SUPABASE_URL = required('SUPABASE_URL');
export const SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

// Treat an unset OR empty value (CI passes "" when a repo var is undefined) as
// "use the default" — otherwise an empty string would yield zero sources.
export const PRICE_SOURCES = ((process.env.PRICE_SOURCES ?? '').trim() || 'cardkingdom,tcgplayer,cardmarket')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const FINISHES = ['normal', 'foil', 'etched'] as const;

/** Rolling history window we keep in the DB; older rows are pruned. */
export const KEEP_DAYS = 90;

/** Backfill seeds at most this many days back (defaults to KEEP_DAYS). */
const parsedBackfillDays = Number.parseInt((process.env.BACKFILL_DAYS ?? '').trim(), 10);
export const BACKFILL_DAYS =
  Number.isFinite(parsedBackfillDays) && parsedBackfillDays > 0 ? parsedBackfillDays : KEEP_DAYS;

// MTGJSON v5 endpoints. We always pull the gzipped variants and gunzip while
// streaming, so the full file never lands on disk uncompressed or in memory.
export const MTGJSON = {
  pricesToday: 'https://mtgjson.com/api/v5/AllPricesToday.json.gz',
  allPrices: 'https://mtgjson.com/api/v5/AllPrices.json.gz',
  identifiers: 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz'
} as const;

/** MTGJSON usually states currency per source; this is the fallback. */
export function defaultCurrency(source: string): string {
  return source === 'cardmarket' ? 'EUR' : 'USD';
}
