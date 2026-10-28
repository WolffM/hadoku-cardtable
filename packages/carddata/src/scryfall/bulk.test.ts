/*
 * `sync()`'s download, against a stubbed fetch: a download that dies part way (undici's
 * "terminated", which the catalog refresh met on 2026-10-28) must reject `sync()` and leave no
 * cache behind — never take the process down with it.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sync } from './bulk.ts';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const LISTING = { data: [{ type: 'default_cards', name: 'Default Cards', updated_at: '2026-10-28T00:00:00Z', download_uri: 'https://data.scryfall.io/default-cards.json' }] };

/** Enough cards that the cache file is still being written when the body breaks. */
function gzippedCards(count: number): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ id: `id-${i}`, oracle_id: `o-${i}`, name: `Card ${i} ${'x'.repeat(200)}`, set: 'tst', collector_number: String(i), rarity: 'common', oracle_text: 'y'.repeat(400) }));
  }
  return gzipSync(lines.join('\n'));
}

/** A body that hands over `bytes` in pieces, then fails the way a dropped connection does. */
function breakingBody(bytes: Uint8Array, breakAfter: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= breakAfter) {
        controller.error(new TypeError('terminated'));
        return;
      }
      const end = Math.min(sent + 4096, breakAfter);
      controller.enqueue(bytes.slice(sent, end));
      sent = end;
    },
  });
}

describe('sync', () => {
  it('rejects, and writes no cache, when the download dies part way', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'carddata-bulk-'));
    dirs.push(outDir);
    const bytes = gzippedCards(20_000);
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/bulk-data') ? new Response(JSON.stringify(LISTING), { headers: { 'content-type': 'application/json' } }) : new Response(breakingBody(bytes, Math.floor(bytes.length / 2))),
    );
    await expect(sync({ outDir })).rejects.toThrow('terminated');
    expect(existsSync(join(outDir, 'cards.jsonl'))).toBe(false);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(false);
  });
});
