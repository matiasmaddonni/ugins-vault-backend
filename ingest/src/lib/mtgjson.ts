import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { defaultCurrency, FINISHES } from './config';
import type { PriceUpsertRow } from './db';

// stream-json is CommonJS and attaches its exports as properties on
// module.exports, which Node's ESM named-import interop (cjs-module-lexer)
// fails to detect ("does not provide an export named 'parser'"). Load it via
// createRequire to get the documented named exports reliably under tsx/Node ESM.
const require = createRequire(import.meta.url);
const { parser } = require('stream-json') as typeof import('stream-json');
const { pick } = require('stream-json/filters/Pick') as typeof import('stream-json/filters/Pick');
const { streamObject } = require('stream-json/streamers/StreamObject') as typeof import('stream-json/streamers/StreamObject');

// ───────────────────────────────────────────────────────────────────────────
// Streaming MTGJSON readers.
//
// Both files are `{ meta, data: { "<mtgjson-uuid>": {...} } }`. We pick the
// `data` subtree and emit one (key,value) per card, so peak memory is one
// card object — never the whole 0.6–1.2 GB file. Gzip is inflated inline.
//
// CRITICAL ID MAPPING: MTGJSON keys by its own uuid; the app speaks Scryfall
// printing ids. We first build a uuid->scryfallId map (restricted to the
// collection-union) from AllIdentifiers, then key every price row by scryfallId.
// Note: scryfallId is NOT unique across multi-faced cards (multiple MTGJSON
// uuids share one scryfallId) — those collapse onto the same price PK, which is
// fine (faces share a price); last write wins on upsert.
// ───────────────────────────────────────────────────────────────────────────

/** A node.js object-mode sink that runs `onItem` for each {key,value}. */
function eachEntry(onItem: (key: string, value: unknown) => void | Promise<void>): Writable {
  return new Writable({
    objectMode: true,
    async write(chunk: { key: string; value: unknown }, _enc, cb) {
      try {
        await onItem(chunk.key, chunk.value);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    }
  });
}

function dataStream(filePath: string) {
  return [
    createReadStream(filePath),
    createGunzip(),
    parser(),
    pick({ filter: 'data' }),
    streamObject()
  ] as const;
}

/**
 * Streams AllIdentifiers and returns a `mtgjsonUuid -> scryfallId` map limited
 * to MTGJSON cards whose scryfallId is in the collection-union.
 */
export async function buildOwnedUuidMap(
  identifiersPath: string,
  ownedScryfallIds: Set<string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await pipeline(
    ...dataStream(identifiersPath),
    eachEntry((uuid, value) => {
      const scry = (value as { identifiers?: { scryfallId?: unknown } } | null)?.identifiers?.scryfallId;
      if (typeof scry === 'string' && ownedScryfallIds.has(scry.toLowerCase())) {
        map.set(uuid, scry.toLowerCase());
      }
    })
  );
  return map;
}

/** Per-card price node: { currency, retail: { finish: { date: price } } }. */
interface SourceNode {
  currency?: unknown;
  retail?: Record<string, Record<string, unknown>>;
}

/**
 * Streams an AllPrices / AllPricesToday file, extracts retail prices for the
 * given sources and the mapped cards, and flushes them to `sink` in batches.
 * Returns the total number of rows produced.
 *
 * @param minDate  optional 'YYYY-MM-DD' floor; older dates are skipped (backfill).
 */
export async function streamPrices(
  pricesPath: string,
  uuidToScryfall: Map<string, string>,
  sources: string[],
  sink: (rows: PriceUpsertRow[]) => Promise<void>,
  options: { minDate?: string; batchSize?: number } = {}
): Promise<number> {
  const { minDate, batchSize = 5000 } = options;
  let buffer: PriceUpsertRow[] = [];
  let total = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    total += batch.length;
    await sink(batch);
  };

  await pipeline(
    ...dataStream(pricesPath),
    eachEntry(async (uuid, value) => {
      const scryfallId = uuidToScryfall.get(uuid);
      if (!scryfallId) return;

      const paper = (value as { paper?: Record<string, SourceNode> } | null)?.paper;
      if (!paper) return;

      for (const source of sources) {
        const node = paper[source];
        const retail = node?.retail;
        if (!retail) continue;

        const currency = typeof node.currency === 'string' ? node.currency : defaultCurrency(source);

        for (const finish of FINISHES) {
          const byDate = retail[finish];
          if (!byDate) continue;
          for (const date in byDate) {
            if (minDate && date < minDate) continue;
            const raw = byDate[date];
            const price = typeof raw === 'number' ? raw : Number(raw);
            if (price > 0) {
              buffer.push({ card_id: scryfallId, source, finish, date, retail: price, currency });
            }
          }
        }
      }

      if (buffer.length >= batchSize) await flush();
    })
  );

  await flush();
  return total;
}
