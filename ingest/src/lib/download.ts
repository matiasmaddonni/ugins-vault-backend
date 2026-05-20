import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Streams `url` to a temp file and returns its path. The body is piped straight
 * to disk (never buffered whole in memory). Caller cleans up via `cleanup()`.
 */
export async function downloadToTemp(url: string, filename: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uv-ingest-'));
  const dest = join(dir, filename);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  return dest;
}

/** Removes the temp directory that holds a downloaded file. */
export async function cleanup(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true });
}
