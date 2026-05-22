// ───────────────────────────────────────────────────────────────────────────
// pricing.ts — finish-merge, price series, and the movers algorithm.
//
// This is a faithful TypeScript port of the iOS app's price logic so the two
// agree on numbers:
//   - finish merge  -> MTGJSONPriceParser.mergedFinishMap   (etched > foil > normal)
//   - movers/spark   -> RealDashboardRepository.computeHistory
//
// The app feeds /v1/prices snapshots into its OWN computeHistory; /v1/movers is
// the server-side mirror for clients that want it precomputed. Perfect parity
// is only possible for cards the backend has data for — the app additionally
// has on-device Scryfall fallback prices the backend does not. Documented.
// ───────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

export const ALLOWED_SOURCES = ['cardkingdom', 'tcgplayer', 'cardmarket'] as const;
export type Source = (typeof ALLOWED_SOURCES)[number];

// Lower index = lower priority. Later finishes overwrite earlier ones on a day,
// exactly like the iOS merge loop's `["normal","foil","etched"]` order.
export const FINISH_PRIORITY = ['normal', 'foil', 'etched'] as const;

export const DEFAULT_SOURCE: Source = 'tcgplayer';
export const DEFAULT_WINDOW = 35;
export const DEFAULT_THRESHOLD = 1;
const SPARKLINE_MAX_POINTS = 24;
const TOP_N = 5;

/** Row shape returned by the `owned_prices` RPC. numeric arrives as a string. */
export interface PriceRow {
  card_id: string;
  quantity: number;
  finish: string;
  date: string; // 'YYYY-MM-DD'
  retail: number | string;
  currency: string;
}

export interface PricePoint {
  date: string;
  price: number;
}

export interface CardPrices {
  cardId: string;
  source: Source;
  currency: string;
  current: number | null;
  history: PricePoint[];
}

export interface Mover {
  cardId: string;
  deltaUSD: number;
  pct: number;
}

export interface MoversResult {
  source: Source;
  currency: string;
  days: number;
  weekDeltaUSD: number;
  weekDeltaPct: number;
  monthSparkline: number[];
  gainers: Mover[];
  losers: Mover[];
}

// ── small parsing/util helpers ───────────────────────────────────────────────

export function num(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseFloat(value);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ISO dates are 'YYYY-MM-DD'; lexicographic order == chronological order. */
export function addDaysISO(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function pickSource(value: string | undefined): Source {
  if (value && (ALLOWED_SOURCES as readonly string[]).includes(value)) return value as Source;
  return DEFAULT_SOURCE;
}

export function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat(value ?? '');
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── per-card series (finish-merged, day-keyed) ───────────────────────────────

export interface CardSeries {
  cardId: string;
  quantity: number;
  currency: string;
  byDay: Map<string, number>;
  days: string[]; // sorted ascending
}

/**
 * Groups raw rows by card and folds finishes into a single price per day
 * (etched > foil > normal, ignoring non-positive prices) — mirrors
 * MTGJSONPriceParser.mergedFinishMap.
 */
export function groupSeries(rows: PriceRow[]): Map<string, CardSeries> {
  interface Acc {
    quantity: number;
    currency: string;
    best: Map<string, { price: number; rank: number }>;
  }
  const raw = new Map<string, Acc>();

  for (const row of rows) {
    const price = num(row.retail);
    if (!(price > 0)) continue;
    const rank = (FINISH_PRIORITY as readonly string[]).indexOf(row.finish);
    if (rank < 0) continue;

    let acc = raw.get(row.card_id);
    if (!acc) {
      acc = { quantity: row.quantity, currency: row.currency, best: new Map() };
      raw.set(row.card_id, acc);
    }
    const existing = acc.best.get(row.date);
    if (!existing || rank >= existing.rank) {
      acc.best.set(row.date, { price, rank });
    }
  }

  const out = new Map<string, CardSeries>();
  for (const [cardId, acc] of raw) {
    const byDay = new Map<string, number>();
    for (const [date, v] of acc.best) byDay.set(date, v.price);
    const days = [...byDay.keys()].sort();
    out.set(cardId, { cardId, quantity: acc.quantity, currency: acc.currency, byDay, days });
  }
  return out;
}

/** Last known price on/before `target` (carry-forward). Mirrors priceOnDay. */
export function priceOnDay(series: CardSeries, target: string): number | null {
  let result: number | null = null;
  for (const day of series.days) {
    if (day <= target) result = series.byDay.get(day)!;
    else break;
  }
  return result;
}

// ── /v1/prices shaping ───────────────────────────────────────────────────────

export function toCardPrices(rows: PriceRow[], source: Source): CardPrices[] {
  const series = groupSeries(rows);
  const out: CardPrices[] = [];
  for (const s of series.values()) {
    const history = s.days.map((d) => ({ date: d, price: s.byDay.get(d)! }));
    const current = history.length ? history[history.length - 1]!.price : null;
    out.push({ cardId: s.cardId, source, currency: s.currency, current, history });
  }
  return out;
}

// ── /v1/movers (port of computeHistory) ──────────────────────────────────────

export function computeMovers(rows: PriceRow[], source: Source, threshold: number): MoversResult {
  const series = groupSeries(rows);

  let currency = 'USD';
  const daySet = new Set<string>();
  for (const s of series.values()) {
    if (s.currency) currency = s.currency;
    for (const d of s.days) daySet.add(d);
  }

  const empty: MoversResult = {
    source,
    currency,
    days: daySet.size,
    weekDeltaUSD: 0,
    weekDeltaPct: 0,
    monthSparkline: [],
    gainers: [],
    losers: []
  };

  const days = [...daySet].sort();
  if (days.length < 2) return empty;

  const latestDay = days[days.length - 1]!;
  const weekAgoDay = addDaysISO(latestDay, -7);

  // Fallback used by `portfolio` for days before a card's first data point —
  // the app falls back to the resolver's latest price; here that is the card's
  // carry-forward price at the latest day.
  const latestByCard = new Map<string, number>();
  for (const [id, s] of series) {
    const p = priceOnDay(s, latestDay);
    if (p != null) latestByCard.set(id, p);
  }

  const portfolio = (target: string): number => {
    let total = 0;
    for (const [id, s] of series) {
      const onDay = priceOnDay(s, target);
      const unit = onDay != null ? onDay : (latestByCard.get(id) ?? 0);
      total += unit * s.quantity;
    }
    return total;
  };

  // Sparkline — sample down to <= SPARKLINE_MAX_POINTS, same formula as iOS.
  let sampledDays: string[];
  if (days.length <= SPARKLINE_MAX_POINTS) {
    sampledDays = days;
  } else {
    const step = (days.length - 1) / (SPARKLINE_MAX_POINTS - 1);
    sampledDays = Array.from({ length: SPARKLINE_MAX_POINTS }, (_, i) =>
      days[Math.min(days.length - 1, Math.round(i * step))]!
    );
  }
  const monthSparkline = sampledDays.map(portfolio);

  const todayValue = portfolio(latestDay);
  const weekAgoValue = portfolio(weekAgoDay);
  const weekDeltaUSD = todayValue - weekAgoValue;
  const weekDeltaPct = weekAgoValue > 0 ? (weekDeltaUSD / weekAgoValue) * 100 : 0;

  const movers: Mover[] = [];
  for (const [id, s] of series) {
    const today = priceOnDay(s, latestDay);
    const weekAgo = priceOnDay(s, weekAgoDay);
    if (today == null || weekAgo == null || !(weekAgo > 0)) continue;
    const delta = today - weekAgo;
    if (delta === 0 || Math.abs(delta) < threshold) continue;
    movers.push({ cardId: id, deltaUSD: delta, pct: (delta / weekAgo) * 100 });
  }

  const gainers = movers.filter((m) => m.deltaUSD > 0).sort((a, b) => b.pct - a.pct).slice(0, TOP_N);
  const losers = movers.filter((m) => m.deltaUSD < 0).sort((a, b) => a.pct - b.pct).slice(0, TOP_N);

  return { source, currency, days: days.length, weekDeltaUSD, weekDeltaPct, monthSparkline, gainers, losers };
}

// ── owned_prices RPC reader (paginated) ──────────────────────────────────────
// PostgREST caps a response at 1000 rows. owned_prices returns one row per
// (card, finish, day) for the window, which for a real collection is many
// thousands — a single call silently truncates and the app shows "searching"
// for every card past the cut. Page through with Range until exhausted.
export async function fetchOwnedPrices(db: SupabaseClient, source: Source, since: string): Promise<PriceRow[]> {
  const rows: PriceRow[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await db.rpc('owned_prices', { p_source: source, p_since: since }).range(from, from + size - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as PriceRow[]));
    if (data.length < size) break;
  }
  return rows;
}
