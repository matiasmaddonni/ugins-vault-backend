// One-time backfill. Streams the full AllPrices (~1.2 GB / ~135 MB gz, ~90 days)
// to seed history for the owned-union. Run manually (GitHub Action dispatch or
// `npm run ingest:backfill`). NEVER run on Vercel.

import { BACKFILL_DAYS, KEEP_DAYS, MTGJSON, PRICE_SOURCES } from './lib/config';
import { distinctOwnedCardIds, prunePrices, upsertPrices } from './lib/db';
import { cleanup, downloadToTemp } from './lib/download';
import { buildOwnedUuidMap, streamPrices } from './lib/mtgjson';

function minDateISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log('[backfill] start', new Date().toISOString(), `(seeding ${BACKFILL_DAYS}d)`);

  const owned = await distinctOwnedCardIds();
  console.log(`[backfill] owned-union: ${owned.size} scryfall ids`);
  if (owned.size === 0) {
    console.log('[backfill] no owned cards — nothing to seed');
    return;
  }

  const identifiersPath = await downloadToTemp(MTGJSON.identifiers, 'AllIdentifiers.json.gz');
  const uuidMap = await buildOwnedUuidMap(identifiersPath, owned);
  await cleanup(identifiersPath);
  console.log(`[backfill] mapped ${uuidMap.size} MTGJSON uuids -> scryfall (owned-union)`);

  const minDate = minDateISO(BACKFILL_DAYS);
  const pricesPath = await downloadToTemp(MTGJSON.allPrices, 'AllPrices.json.gz');
  let written = 0;
  await streamPrices(
    pricesPath,
    uuidMap,
    PRICE_SOURCES,
    async (rows) => {
      written += await upsertPrices(rows);
      if (written % 50_000 < rows.length) console.log(`[backfill] ... ${written} rows`);
    },
    { minDate }
  );
  await cleanup(pricesPath);
  console.log(`[backfill] upserted ${written} price rows (since ${minDate})`);

  await prunePrices(KEEP_DAYS);
  console.log(`[backfill] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[backfill] FAILED:', err);
  process.exit(1);
});
