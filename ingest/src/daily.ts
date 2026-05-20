// Daily ingest. Pulls AllPricesToday (one day), restricted to the owned-union,
// upserts today's prices, refreshes FX, and prunes > KEEP_DAYS. No serverless
// time limit here — this runs on GitHub Actions.

import { KEEP_DAYS, MTGJSON, PRICE_SOURCES } from './lib/config';
import { distinctOwnedCardIds, prunePrices, upsertPrices } from './lib/db';
import { cleanup, downloadToTemp } from './lib/download';
import { runFx } from './lib/fx';
import { buildOwnedUuidMap, streamPrices } from './lib/mtgjson';

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log('[daily] start', new Date().toISOString());

  // FX first: also the keep-alive write, so the project stays awake even on a
  // day with no owned cards.
  await runFx();

  const owned = await distinctOwnedCardIds();
  console.log(`[daily] owned-union: ${owned.size} scryfall ids`);
  if (owned.size === 0) {
    console.log('[daily] no owned cards — FX written, skipping price ingest');
    return;
  }

  const identifiersPath = await downloadToTemp(MTGJSON.identifiers, 'AllIdentifiers.json.gz');
  const uuidMap = await buildOwnedUuidMap(identifiersPath, owned);
  await cleanup(identifiersPath);
  console.log(`[daily] mapped ${uuidMap.size} MTGJSON uuids -> scryfall (owned-union)`);

  const pricesPath = await downloadToTemp(MTGJSON.pricesToday, 'AllPricesToday.json.gz');
  let written = 0;
  await streamPrices(pricesPath, uuidMap, PRICE_SOURCES, async (rows) => {
    written += await upsertPrices(rows);
  });
  await cleanup(pricesPath);
  console.log(`[daily] upserted ${written} price rows`);

  await prunePrices(KEEP_DAYS);
  console.log(`[daily] pruned > ${KEEP_DAYS}d — done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[daily] FAILED:', err);
  process.exit(1);
});
