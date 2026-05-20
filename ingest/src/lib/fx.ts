import { upsertFx } from './db';

// USD->ARS "blue" (informal) rate, Argentina. Returns { compra, venta, ... }.
const DOLAR_BLUE_URL = 'https://dolarapi.com/v1/dolares/blue';
// USD->EUR. Returns { amount, base, date, rates: { EUR } }.
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD&to=EUR';

/**
 * Fetches USD->ARS and USD->EUR and upserts the global `fx` table. Failures on
 * one provider don't block the other. This write also doubles as the daily
 * keep-alive that prevents the free Supabase project from pausing.
 */
export async function runFx(): Promise<void> {
  const rows: { quote: string; rate: number }[] = [];

  try {
    const res = await fetch(DOLAR_BLUE_URL);
    if (res.ok) {
      const json = (await res.json()) as { venta?: number; compra?: number };
      const rate = json.venta ?? json.compra;
      if (typeof rate === 'number' && rate > 0) rows.push({ quote: 'ARS', rate });
      else console.warn('[fx] dolarapi returned no usable rate');
    } else {
      console.warn(`[fx] dolarapi HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[fx] dolarapi fetch failed:', err);
  }

  try {
    const res = await fetch(FRANKFURTER_URL);
    if (res.ok) {
      const json = (await res.json()) as { rates?: { EUR?: number } };
      const rate = json.rates?.EUR;
      if (typeof rate === 'number' && rate > 0) rows.push({ quote: 'EUR', rate });
      else console.warn('[fx] frankfurter returned no usable rate');
    } else {
      console.warn(`[fx] frankfurter HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[fx] frankfurter fetch failed:', err);
  }

  if (rows.length > 0) {
    await upsertFx(rows);
    console.log(`[fx] upserted: ${rows.map((r) => `${r.quote}=${r.rate}`).join(', ')}`);
  } else {
    console.warn('[fx] nothing to upsert');
  }
}
