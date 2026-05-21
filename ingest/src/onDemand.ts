// On-demand ingest. Drains the price_backfill_queue (cards a user just added
// that have no price yet) and fetches their MTGJSON prices NOW, instead of
// waiting for the daily cron. Triggered by GitHub repository_dispatch from
// PUT /v1/collection. Runs on GitHub Actions (no serverless time limit).
//
// MTGJSON has no per-card endpoint, so we still stream the dumps — but scoped
// to the queued ids. Order matters for "see prices ASAP": AllPricesToday is the
// smaller file and lands today's price first; AllPrices then fills ~90d history.

import { BACKFILL_DAYS, KEEP_DAYS, MTGJSON, PRICE_SOURCES } from './lib/config';
import { claimPriceQueue, markPriceQueueAttempted, prunePricedQueue, prunePrices, upsertPrices } from './lib/db';
import { cleanup, downloadToTemp } from './lib/download';
import { buildOwnedUuidMap, streamPrices } from './lib/mtgjson';

function minDateISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function streamFile(
  url: string,
  filename: string,
  uuidMap: Map<string, string>,
  options: { minDate?: string } = {}
): Promise<number> {
  const path = await downloadToTemp(url, filename);
  let written = 0;
  try {
    await streamPrices(path, uuidMap, PRICE_SOURCES, async (rows) => {
      written += await upsertPrices(rows);
    }, options);
  } finally {
    await cleanup(path);
  }
  return written;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log('[on-demand] start', new Date().toISOString());

  // Snapshot the claimable ids. We only resolve exactly these at the end, so a
  // card enqueued while we run is left for the next dispatch.
  const claimed = await claimPriceQueue();
  console.log(`[on-demand] queued: ${claimed.length} scryfall ids`);
  if (claimed.length === 0) {
    console.log('[on-demand] queue empty — nothing to do');
    return;
  }

  const cards = new Set(claimed);
  const identifiersPath = await downloadToTemp(MTGJSON.identifiers, 'AllIdentifiers.json.gz');
  const uuidMap = await buildOwnedUuidMap(identifiersPath, cards);
  await cleanup(identifiersPath);
  console.log(`[on-demand] mapped ${uuidMap.size} MTGJSON uuids -> scryfall`);

  if (uuidMap.size > 0) {
    const todayRows = await streamFile(MTGJSON.pricesToday, 'AllPricesToday.json.gz', uuidMap);
    console.log(`[on-demand] upserted ${todayRows} rows from AllPricesToday`);
    const histRows = await streamFile(MTGJSON.allPrices, 'AllPrices.json.gz', uuidMap, {
      minDate: minDateISO(BACKFILL_DAYS)
    });
    console.log(`[on-demand] upserted ${histRows} rows from AllPrices`);
    await prunePrices(KEEP_DAYS);
  } else {
    // None of the queued ids matched an MTGJSON paper card this run (tokens, or
    // a transient identifiers miss). No upserts; the prune+stamp below still
    // keeps the queue honest.
    console.log('[on-demand] no MTGJSON matches this run');
  }

  // Reconcile the queue against ACTUAL prices: drop every card that now has a
  // price (so price_status never reports a priced card), then cool down the
  // claimed ids that remain unpriced. markPriceQueueAttempted updates by id, so
  // ids already pruned (priced) are no-ops — only genuinely-unpriced cards get
  // stamped.
  const cleared = await prunePricedQueue();
  await markPriceQueueAttempted(claimed);

  console.log(
    `[on-demand] cleared ${cleared} now-priced from queue, cooled down the rest — done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error('[on-demand] FAILED:', err);
  process.exit(1);
});
