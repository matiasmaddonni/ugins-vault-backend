// On-demand ingest. Drains the price_backfill_queue (cards a user just added
// that have no price yet) and fetches their MTGJSON prices NOW, instead of
// waiting for the daily cron. Triggered by GitHub repository_dispatch from
// PUT /v1/owned. Runs on GitHub Actions (no serverless time limit).
//
// MTGJSON has no per-card endpoint, so we still stream the dumps — but scoped
// to the queued ids. Order matters for "see prices ASAP": AllPricesToday is the
// smaller file and lands today's price first; AllPrices then fills ~90d history
// for the charts. Idempotent upserts make this safe alongside the daily job.

import { BACKFILL_DAYS, KEEP_DAYS, MTGJSON, PRICE_SOURCES } from './lib/config';
import {
  claimPriceQueue,
  clearPriceQueue,
  markPriceQueueAttempted,
  prunePrices,
  pricedCardIds,
  upsertPrices
} from './lib/db';
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
    await streamPrices(
      path,
      uuidMap,
      PRICE_SOURCES,
      async (rows) => {
        written += await upsertPrices(rows);
      },
      options
    );
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

  const owned = new Set(claimed);
  const identifiersPath = await downloadToTemp(MTGJSON.identifiers, 'AllIdentifiers.json.gz');
  const uuidMap = await buildOwnedUuidMap(identifiersPath, owned);
  await cleanup(identifiersPath);
  console.log(`[on-demand] mapped ${uuidMap.size} MTGJSON uuids -> scryfall`);

  if (uuidMap.size === 0) {
    // None of the queued ids are MTGJSON paper cards (e.g. tokens). Cooldown
    // them rather than delete — they'd re-enqueue immediately (no price row)
    // and re-fire a job on every save.
    console.log('[on-demand] no MTGJSON matches — cooling down queued ids');
    await markPriceQueueAttempted(claimed);
    return;
  }

  // Today's price first (smaller file) so the current value shows ASAP...
  const todayRows = await streamFile(MTGJSON.pricesToday, 'AllPricesToday.json.gz', uuidMap);
  console.log(`[on-demand] upserted ${todayRows} rows from AllPricesToday`);

  // ...then ~90d history for the charts.
  const histRows = await streamFile(MTGJSON.allPrices, 'AllPrices.json.gz', uuidMap, {
    minDate: minDateISO(BACKFILL_DAYS)
  });
  console.log(`[on-demand] upserted ${histRows} rows from AllPrices`);

  await prunePrices(KEEP_DAYS);

  // Resolve the queue: drop ids that now have a price; cooldown the rest (no
  // MTGJSON data) so they retry later instead of re-firing on every save.
  const priced = await pricedCardIds(claimed);
  const got = claimed.filter((id) => priced.has(id));
  const missed = claimed.filter((id) => !priced.has(id));
  await clearPriceQueue(got);
  await markPriceQueueAttempted(missed);

  console.log(
    `[on-demand] ${got.length} priced (cleared), ${missed.length} no-data (cooldown) — done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error('[on-demand] FAILED:', err);
  process.exit(1);
});
