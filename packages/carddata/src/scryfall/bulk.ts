/*
 * Scheduled bulk-data ingest.
 *
 * Scryfall's own instruction (https://scryfall.com/docs/api/rate-limits, read
 * 2026-09-11): "We encourage you to cache the data you download from Scryfall
 * or process it locally in your own system, at least for 24 hours" and "If you
 * need to rapidly look up card names, prices, or resolve a large number of card
 * images, you must use the bulk data files." So: one download on a schedule,
 * never a per-request call to their API.
 *
 * The file is streamed and projected line by line — a gzipped JSONL archive is
 * decompressed on the fly, so peak memory is one card object regardless of
 * whether the source is the 23 MB oracle file or the 375 MB all-languages one.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { getJson, userAgent } from './client.ts';
import { projectCard, type RawCard } from './project.ts';

/**
 * The bulk file types Scryfall publishes that carry card objects.
 *
 * `oracle_cards` is our default: one object per distinct Oracle ID, which is
 * exactly the granularity a rules engine and a cube list need, at a sixth of
 * the size of `default_cards`. Take `default_cards` when you need every
 * printing (e.g. resolving a cube's `Name|SET|artIndex` to a specific one).
 */
export const BULK_TYPES = ['oracle_cards', 'default_cards', 'unique_artwork', 'all_cards'] as const;
export type BulkType = (typeof BULK_TYPES)[number];

/** One entry of Scryfall's `/bulk-data` listing, narrowed to what we use. */
export interface BulkDataEntry {
  readonly type: string;
  readonly name: string;
  readonly updated_at: string;
  readonly compressed_size?: number;
  readonly jsonl_download_uri?: string;
  readonly download_uri?: string;
}

/** What a completed sync wrote, and what it was built from. */
export interface SyncManifest {
  readonly bulkType: string;
  /** Scryfall's own timestamp for the source file — the freshness key. */
  readonly sourceUpdatedAt: string;
  readonly ingestedAt: string;
  readonly cardCount: number;
  /** Non-null only when `--limit` bounded the run, so a partial cache is obvious. */
  readonly limit: number | null;
  readonly skippedLines: number;
}

const MANIFEST_FILE = 'manifest.json';
const CARDS_FILE = 'cards.jsonl';

/** Fetch the bulk-data listing. One paced request to `/bulk-data`. */
export async function fetchBulkListing(): Promise<readonly BulkDataEntry[]> {
  const body = await getJson<{ data?: readonly BulkDataEntry[] }>('/bulk-data');
  return body.data ?? [];
}

/** Find one bulk type in the listing. */
export function selectBulkEntry(
  listing: readonly BulkDataEntry[],
  bulkType: string,
): BulkDataEntry {
  const entry = listing.find((e) => e.type === bulkType);
  if (entry === undefined) {
    const available = listing.map((e) => e.type).join(', ');
    throw new Error(`No '${bulkType}' entry in Scryfall's bulk-data listing. Available: ${available}`);
  }
  return entry;
}

/**
 * The archive URL for an entry.
 *
 * Scryfall serves these from a dedicated file origin that, per their docs, has
 * no rate limit — which is why this download is not routed through the pacer in
 * `client.ts`. We take the URL from their listing response rather than
 * hardcoding a host, so a change on their side does not need a release here.
 * We do insist on HTTPS: their API is HTTPS-only and a plaintext URL in that
 * field would mean something is wrong.
 */
export function downloadUrl(entry: BulkDataEntry): string {
  const url = entry.jsonl_download_uri ?? entry.download_uri;
  if (url === undefined) {
    throw new Error(`Bulk entry '${entry.type}' carries no download URL`);
  }
  if (!url.startsWith('https://')) {
    throw new Error(`Refusing non-HTTPS bulk download URL for '${entry.type}'`);
  }
  return url;
}

/** Read the manifest of a previous sync, or `null` if there is no usable one. */
export async function readManifest(outDir: string): Promise<SyncManifest | null> {
  try {
    return JSON.parse(await readFile(join(outDir, MANIFEST_FILE), 'utf8')) as SyncManifest;
  } catch {
    // Absent or unreadable manifest just means "no cache yet"; the caller's
    // next step is a full sync either way.
    return null;
  }
}

export interface SyncOptions {
  readonly bulkType?: BulkType | string;
  /** Directory the cache is written to. */
  readonly outDir: string;
  /** Re-download even when the local cache already matches Scryfall's timestamp. */
  readonly force?: boolean;
  /** Stop after this many cards. For smoke tests and CI, never for a real cache. */
  readonly limit?: number | null;
  readonly onProgress?: (message: string) => void;
}

export interface SyncResult {
  readonly manifest: SyncManifest;
  /** True when the download was skipped because the cache was already current. */
  readonly upToDate: boolean;
  readonly outDir: string;
}

/**
 * Download, project and cache one bulk file.
 *
 * Writes `cards.jsonl` (one projected card per line) and `manifest.json`. The
 * data file is written to a temporary name and renamed on success, so an
 * interrupted run cannot leave a half-written cache that looks complete.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  // `default_cards`, not `oracle_cards`. oracle_cards carries ONE printing per
  // card — Scryfall's chosen representative — and for 41 cards in our own cube
  // that representative is a digital-only (MTGO/Arena) printing. The resolver
  // correctly refuses digital-only printings, so those cards resolved to
  // nothing: Lion's Eye Diamond, Mox Diamond, Bazaar of Baghdad, Cabal Ritual
  // and 37 others, all of them ordinary paper cards.
  //
  // It read as a set-code mapping gap and it was not one — every failing card
  // had a known Forge code that translated fine. default_cards carries every
  // printing, so a paper one is there to find. 78 MB compressed rather than 24,
  // for a cache that is gitignored and pulled on a schedule.
  const bulkType = options.bulkType ?? 'default_cards';
  const { outDir } = options;
  const limit = options.limit ?? null;
  const report = options.onProgress ?? ((): void => {});

  const entry = selectBulkEntry(await fetchBulkListing(), bulkType);
  report(
    `Scryfall '${entry.name}' updated ${entry.updated_at}` +
      (entry.compressed_size === undefined
        ? ''
        : ` (${(entry.compressed_size / 1_000_000).toFixed(1)} MB compressed)`),
  );

  const existing = await readManifest(outDir);
  if (
    options.force !== true &&
    existing !== null &&
    existing.bulkType === bulkType &&
    existing.sourceUpdatedAt === entry.updated_at &&
    existing.limit === limit
  ) {
    report('Local cache already matches that timestamp; nothing to do.');
    return { manifest: existing, upToDate: true, outDir };
  }

  await mkdir(outDir, { recursive: true });
  const finalPath = join(outDir, CARDS_FILE);
  const tempPath = `${finalPath}.partial`;

  const url = downloadUrl(entry);
  report(`Downloading ${url}`);
  const response = await fetch(url, { headers: { 'User-Agent': userAgent() } });
  if (!response.ok) {
    throw new Error(`Bulk download returned HTTP ${response.status} ${response.statusText}`);
  }
  if (response.body === null) {
    throw new Error('Bulk download returned an empty body');
  }

  const out = createWriteStream(tempPath, { encoding: 'utf8' });
  // Listened to from the start, for the same reason as `decompressing` below: a download that dies
  // mid-stream destroys `out` with a write still in flight, and that write's ERR_STREAM_DESTROYED
  // on a stream nobody listens to was an uncaught 'error' that took the whole server down
  // (2026-10-28, the catalog refresh's "terminated"). The download's own error is what is thrown.
  let writeError: unknown = null;
  out.on('error', (error: unknown) => {
    writeError ??= error;
  });
  const gunzip = createGunzip();

  // Decompress in the background while we consume decoded lines off the other
  // end; `pipeline` owns error propagation and cleanup for the source side.
  //
  // The rejection handler is attached HERE, at construction, not after the
  // read loop. A bounded run destroys `gunzip` mid-stream, which rejects this
  // promise immediately — attaching the handler later loses that race and Node
  // kills the process with an unhandled rejection before the loop finishes.
  let downloadError: unknown = null;
  const decompressing = pipeline(Readable.fromWeb(response.body), gunzip).catch(
    (error: unknown) => {
      downloadError = error;
    },
  );

  let cardCount = 0;
  let skippedLines = 0;
  let reportedAt = 0;
  let aborted = false;
  try {
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;

      let raw: RawCard;
      try {
        raw = JSON.parse(line) as RawCard;
      } catch {
        // One malformed line should not throw away a 400 MB download; count it
        // so the manifest shows a nonzero value if this ever starts happening.
        skippedLines++;
        continue;
      }

      if (!out.write(`${JSON.stringify(projectCard(raw))}\n`)) {
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
      cardCount++;

      if (limit !== null && cardCount >= limit) {
        aborted = true;
        lines.close();
        // Stop pulling from the gzip stream; the download is abandoned on
        // purpose, which is the point of a bounded run.
        gunzip.destroy();
        break;
      }
      if (cardCount - reportedAt >= 20_000) {
        reportedAt = cardCount;
        report(`  ${cardCount} cards projected...`);
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(() => (writeError === null ? resolve() : reject(writeError as Error)));
    });
  } catch (error) {
    out.destroy();
    throw error;
  }

  await decompressing;
  // A deliberately aborted stream rejects with a premature-close error; that is
  // expected. Anything else means the download really did fail, and a truncated
  // cache must not be renamed into place and called complete.
  if (downloadError !== null && !aborted) throw downloadError;

  await rename(tempPath, finalPath);

  const manifest: SyncManifest = {
    bulkType,
    sourceUpdatedAt: entry.updated_at,
    ingestedAt: new Date().toISOString(),
    cardCount,
    limit,
    skippedLines,
  };
  await mkdir(dirname(join(outDir, MANIFEST_FILE)), { recursive: true });
  await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  report(`Wrote ${cardCount} cards to ${finalPath}`);
  return { manifest, upToDate: false, outDir };
}
