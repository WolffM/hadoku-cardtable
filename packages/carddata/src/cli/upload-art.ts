/*
 * Move a pool's card art onto `cdn.hadoku.me`, one card at a time.
 *
 *   pnpm --filter @hadoku/carddata upload-art -- --dry-run
 *   pnpm --filter @hadoku/carddata upload-art -- --limit 25
 *   pnpm --filter @hadoku/carddata upload-art -- --manifest /tmp/scratch.json
 *
 * Reads `apps/ui/src/draft/pool.json`, fetches each card's art from Scryfall,
 * uploads the bytes to the CDN, and records the returned key in the art
 * manifest that `@hadoku/carddata/art` resolves against. The pool is read-only
 * here; the manifest is the only file this writes.
 *
 * ## We host card art now, and that is deliberate
 *
 * This repo used to say "never host card images". The operator reversed that
 * explicitly — `docs/LICENSING.md` and `docs/DECISIONS.md` carry the new rule
 * and the reasoning trail. Do not re-derive the old posture from a stale
 * comment somewhere; this one is current. What did NOT change: our own origin
 * never serves an image, and WotC art is treated as a placeholder, which is the
 * whole reason the manifest is an indirection instead of a list of URLs.
 *
 * ## Three properties this file exists to guarantee
 *
 * **Paced.** Every Scryfall request in the process queues through one gate with
 * a real delay (`paced`, below). 534 cards at ~10/s is about a minute; 534
 * parallel requests is how a project gets blocked, and being blocked is how the
 * whole feature fails at the worst moment. The delay is a flag with a FLOOR, so
 * no one can set it to zero by accident, and the gate serialises regardless of
 * how the caller loops — a future refactor to `Promise.all` would still trickle.
 *
 * **Idempotent.** A card whose manifest row already names a CDN object is
 * skipped without a fetch, so a second run uploads zero. The CDN is
 * content-addressed by SHA-256, so even a forced re-upload converges on the
 * same object — `UploadResult.deduplicated` reports that, and per the client's
 * own docs it is a complete success, not a warning.
 *
 * **Resumable.** The manifest is rewritten after every successful upload, not
 * once at the end, so an interrupted run loses at most the card in flight.
 * Ctrl-C finishes the current card, flushes, prints the summary and exits.
 *
 * ## Credentials
 *
 * The upload route is friend+ and answers 401 to an anonymous POST. This CLI
 * does not invent an auth path: it forwards a credential the operator puts in
 * the environment (see `CREDENTIAL_ENV`) and refuses to run otherwise. It never
 * prints the value, and never writes one anywhere.
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdnClient, CdnError, MAX_BYTES, ACCEPTED_IMAGE_TYPES } from '@wolffm/cdn-client';
import type { UploadResult } from '@wolffm/cdn-client';
import {
  CDN_BASE,
  isCdnKey,
  resolveArtUrl,
  type ArtEntry,
  type ArtImageSize,
  type ArtManifest,
  type ArtManifestFile,
} from '../art/index.ts';
import { userAgent } from '../scryfall/client.ts';

/** The friend+ upload route. Same-site with the app; `cdn.hadoku.me` serves reads. */
const UPLOAD_URL = 'https://hadoku.me/cdn/api/upload';

/**
 * Minimum spacing between Scryfall requests, in ms.
 *
 * Scryfall asks for 50-100 ms between requests and documents 10/second for
 * everything outside `/cards/search` and friends
 * (https://scryfall.com/docs/api/rate-limits, quoted in
 * `../scryfall/client.ts`). 100 ms is the polite end of their own range, and it
 * is a FLOOR rather than a default: `--delay-ms 0` clamps up to it. A constant
 * someone can zero out is not a rate limit.
 */
const MIN_DELAY_MS = 100;

/** Default spacing. A shade over the floor, because their limit is a limit. */
const DEFAULT_DELAY_MS = 120;

/**
 * Accept for image bytes.
 *
 * Scryfall answers **400**, not 403, when `User-Agent` or `Accept` is missing —
 * which reads like a malformed request rather than a policy refusal and has
 * cost time before. `docs/LICENSING.md` §3 has the verified story. Both headers
 * go on every request this file makes.
 */
const IMAGE_ACCEPT = 'image/jpeg,image/*;q=0.8';

/**
 * Environment variables a credential may arrive in, and the header each becomes.
 *
 * The CDN worker reads an edge-stamped tier derived from the `.hadoku.me`
 * session cookie, so `Cookie` is the form that actually works today; the bearer
 * slot is here for the day a token path exists and costs nothing until then.
 * Deliberately a short, closed list: guessing at header shapes produces a
 * confusing 401 rather than an upload.
 */
const CREDENTIAL_ENV = [
  { name: 'HADOKU_CDN_COOKIE', header: 'Cookie', render: (v: string): string => v },
  {
    name: 'HADOKU_CDN_TOKEN',
    header: 'Authorization',
    render: (v: string): string => `Bearer ${v}`,
  },
] as const;

/** Where a credential may also be parked, outside the repo. Read, never written. */
const CREDENTIAL_FILE = join(homedir(), '.config', 'hadoku', 'standing.env');

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * The rate limit, and the only place it lives.
 *
 * One promise chain for the whole process: a call cannot start until the
 * previous one has returned AND `delayMs` has elapsed since the previous one
 * STARTED. Written as a gate rather than as a `sleep` in the loop on purpose —
 * a sleep in the loop is a convention, and this is a mechanism. Concurrency
 * cannot smuggle a burst past it.
 */
let gate: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function paced<T>(delayMs: number, run: () => Promise<T>): Promise<T> {
  const next = gate.then(async () => {
    const since = Date.now() - lastRequestAt;
    if (since < delayMs) await sleep(delayMs - since);
    lastRequestAt = Date.now();
    return run();
  });
  // Keep the chain alive when a link rejects, or one failure wedges every
  // later request behind an unhandled rejection.
  gate = next.catch(() => undefined);
  return next;
}

interface Options {
  readonly poolPath: string;
  readonly manifestPath: string;
  readonly uploadUrl: string;
  readonly delayMs: number;
  readonly limit: number;
  readonly size: ArtImageSize;
  readonly dryRun: boolean;
}

const USAGE = `upload-art — put a pool's card art on cdn.hadoku.me

  pnpm --filter @hadoku/carddata upload-art -- [flags]

  --dry-run            fetch nothing, upload nothing, print the plan
  --limit N            stop after N upload attempts (default: all)
  --manifest <path>    art manifest to read and write
                       (default: apps/ui/src/draft/art-manifest.json)
  --pool <path>        pool to read (default: apps/ui/src/draft/pool.json)
  --upload-url <url>   where to POST the bytes (default: ${UPLOAD_URL})
  --delay-ms N         ms between Scryfall requests (default ${DEFAULT_DELAY_MS}, floor ${MIN_DELAY_MS})
  --size <s>           small | normal | large (default: normal)
  --help

Credential: set ${CREDENTIAL_ENV.map((c) => c.name).join(' or ')} in the
environment. The upload route is friend+ and answers 401 without one.`;

/** Accept both `--flag value` and `--flag=value`; the repo's CLIs use each. */
function flagValue(args: readonly string[], name: string): string | undefined {
  const withEquals = args.find((a) => a.startsWith(`${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 1);
  const at = args.indexOf(name);
  if (at >= 0 && at + 1 < args.length) return args[at + 1];
  return undefined;
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseArgs(args: readonly string[]): Options {
  const sizeRaw = flagValue(args, '--size') ?? 'normal';
  if (sizeRaw !== 'small' && sizeRaw !== 'normal' && sizeRaw !== 'large') {
    throw new Error(`--size must be small, normal or large; got ${JSON.stringify(sizeRaw)}`);
  }

  const manifestRaw = flagValue(args, '--manifest');
  const poolRaw = flagValue(args, '--pool');
  const requestedDelay = positiveInt(flagValue(args, '--delay-ms'), DEFAULT_DELAY_MS, '--delay-ms');

  return {
    poolPath: poolRaw
      ? resolve(poolRaw)
      : resolve(repoRoot(), 'apps', 'ui', 'src', 'draft', 'pool.json'),
    manifestPath: manifestRaw
      ? resolve(manifestRaw)
      : resolve(repoRoot(), 'apps', 'ui', 'src', 'draft', 'art-manifest.json'),
    // Overridable for the same reason `CdnClientOptions.uploadPath` is: a
    // stand-in endpoint is how this loop gets exercised without the production
    // CDN. Every key that comes back is still validated before it is written,
    // so a wrong endpoint cannot quietly poison a committed manifest.
    uploadUrl: flagValue(args, '--upload-url') ?? UPLOAD_URL,
    // The clamp IS the floor. `--delay-ms 0` becomes MIN_DELAY_MS, loudly (the
    // effective value is printed in the header of every run).
    delayMs: Math.max(MIN_DELAY_MS, requestedDelay),
    limit: positiveInt(flagValue(args, '--limit'), Number.POSITIVE_INFINITY, '--limit'),
    size: sizeRaw,
    dryRun: args.includes('--dry-run'),
  };
}

interface PoolCard {
  readonly cardId: string;
  readonly name: string;
  readonly scryfallId?: string;
}

/** Distinct scryfall ids in pool order. A cube is singleton, but dedupe anyway. */
async function readPool(path: string): Promise<PoolCard[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { cards?: unknown };
  if (!Array.isArray(parsed.cards)) {
    throw new Error(`${path} has no "cards" array — is that a pool built by build-pool?`);
  }
  const seen = new Set<string>();
  const out: PoolCard[] = [];
  for (const card of parsed.cards as PoolCard[]) {
    const id = card.scryfallId;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(card);
  }
  return out;
}

/**
 * Read the manifest, tolerating its absence.
 *
 * A missing file is the ordinary first-run case, not an error. Everything other
 * than `entries` is carried through untouched, so the committed `note` survives
 * a run — losing a human explanation to a machine rewrite is exactly the quiet
 * loss this design is trying to avoid.
 */
async function readManifest(path: string): Promise<{ file: ArtManifestFile; existed: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { file: { version: 1, entries: {} }, existed: false };
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ArtManifestFile>;
  const entries = (parsed.entries ?? {}) as ArtManifest;
  return { file: { ...parsed, version: 1, entries }, existed: true };
}

/**
 * Write the manifest atomically, keys sorted.
 *
 * Temp-then-rename in the SAME directory: `rename` is atomic within a
 * filesystem, and a crash mid-write would otherwise leave a truncated manifest
 * — which for a resumable job is worse than losing the run, because the next
 * run would read the wreckage as data. Sorted keys keep the diff reviewable;
 * this file is committed and read by humans.
 */
async function writeManifest(path: string, file: ArtManifestFile): Promise<void> {
  const sorted: Record<string, ArtEntry> = {};
  for (const key of Object.keys(file.entries).sort()) {
    sorted[key] = file.entries[key] as ArtEntry;
  }
  const body = `${JSON.stringify({ ...file, entries: sorted }, null, 2)}\n`;
  const tmp = join(dirname(path), `.${process.pid}.art-manifest.tmp`);
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

interface Credential {
  readonly source: string;
  readonly header: string;
  readonly value: string;
}

/**
 * Find a credential, without ever revealing one.
 *
 * Environment first, then `~/.config/hadoku/standing.env` if it happens to
 * exist — the two places the operator said one might live. Nothing else is
 * searched and nothing is guessed: if neither has it, the honest outcome is to
 * say the upload did not run.
 */
async function findCredential(): Promise<Credential | null> {
  for (const slot of CREDENTIAL_ENV) {
    const raw = process.env[slot.name];
    if (raw !== undefined && raw.trim().length > 0) {
      return { source: `env ${slot.name}`, header: slot.header, value: slot.render(raw.trim()) };
    }
  }

  let fileRaw: string;
  try {
    fileRaw = await readFile(CREDENTIAL_FILE, 'utf8');
  } catch {
    return null;
  }
  for (const slot of CREDENTIAL_ENV) {
    // `NAME=value`, with an optional `export ` and optional quotes.
    const match = new RegExp(`^(?:export\\s+)?${slot.name}=(.*)$`, 'm').exec(fileRaw);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (value !== undefined && value.length > 0) {
      return {
        source: `${CREDENTIAL_FILE} (${slot.name})`,
        header: slot.header,
        value: slot.render(value),
      };
    }
  }
  return null;
}

/**
 * Raised when Scryfall rate limits us. Stop, do not retry harder.
 *
 * Longhand fields rather than parameter properties: Node runs these `.ts` files
 * by stripping types, and a parameter property is not erasable syntax — it
 * throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at load. A bundler-backed test run
 * does not catch that; running the CLI does. Same reasoning as
 * `RateLimitedError` in `../scryfall/client.ts`.
 */
class ScryfallRateLimited extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super(
      `Scryfall returned HTTP 429${
        retryAfterSeconds === null ? '' : `; Retry-After ${retryAfterSeconds}s`
      }. Stopping — rerun later and the manifest resumes where it stopped.`,
    );
    this.name = 'ScryfallRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Fetched {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Fetch one card's art, through the gate, with both required headers. */
async function fetchArt(url: string, delayMs: number): Promise<Fetched> {
  return paced(delayMs, async () => {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent(), Accept: IMAGE_ACCEPT },
    });
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header === null ? null : Number.parseInt(header, 10);
      throw new ScryfallRateLimited(Number.isFinite(seconds as number) ? seconds : null);
    }
    if (!response.ok) {
      throw new Error(`GET ${url} returned HTTP ${response.status} ${response.statusText}`);
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
  });
}

/**
 * Client-side refusals, before any bytes are sent.
 *
 * `MAX_BYTES.image` and `ACCEPTED_IMAGE_TYPES` are mirrored from the server for
 * exactly this. Scryfall's `normal` jpegs are ~100 KB so neither will bite
 * here, but a pre-check costs nothing and turns a future surprise (a 10 MB
 * `png` from some other source) into a named skip instead of a 413.
 */
function refuseUpload(fetched: Fetched): string | null {
  if (fetched.bytes.byteLength === 0) return 'empty response body';
  if (fetched.bytes.byteLength > MAX_BYTES.image) {
    return `${fetched.bytes.byteLength} bytes exceeds MAX_BYTES.image (${MAX_BYTES.image})`;
  }
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(fetched.contentType)) {
    return `content-type ${fetched.contentType || '(none)'} is not one of ${ACCEPTED_IMAGE_TYPES.join(', ')}`;
  }
  return null;
}

/** What a card's existing manifest row means for this run. */
type Disposition =
  | { readonly kind: 'upload' }
  | { readonly kind: 'skip'; readonly why: 'on-cdn' | 'pinned-to-scryfall' };

function disposition(entry: ArtEntry | undefined): Disposition {
  if (entry == null) return { kind: 'upload' };
  // `isCdnKey` is the resolver's own test, so "already resolves to the CDN"
  // means the same thing here as it does on the render path. A cdn row with a
  // junk key resolves to Scryfall, so it is not done and gets re-uploaded.
  if (entry.source === 'cdn' && isCdnKey(entry.key)) return { kind: 'skip', why: 'on-cdn' };
  // An explicit `scryfall` row is a decision someone made — do not overwrite
  // it. An absent row means "not done yet"; this means "leave it upstream".
  if (entry.source === 'scryfall') return { kind: 'skip', why: 'pinned-to-scryfall' };
  return { kind: 'upload' };
}

interface Counts {
  uploaded: number;
  deduplicated: number;
  skippedOnCdn: number;
  skippedPinned: number;
  failed: number;
  fetchedBytes: number;
  uploadedBytes: number;
}

function summarise(counts: Counts, total: number, dryRun: boolean, plannedBytes: number): string {
  const lines = [
    '',
    `── upload-art ${dryRun ? '(dry run — nothing fetched, nothing uploaded)' : 'summary'} ──`,
    `cards in pool (distinct ids): ${total}`,
    dryRun
      ? `would upload:                 ${plannedBytes}`
      : `uploaded:                     ${counts.uploaded}${
          counts.deduplicated > 0 ? ` (${counts.deduplicated} already stored, deduplicated)` : ''
        }`,
    `skipped (already on CDN):     ${counts.skippedOnCdn}`,
    `skipped (pinned to Scryfall): ${counts.skippedPinned}`,
    `failed:                       ${counts.failed}`,
  ];
  if (!dryRun) {
    lines.push(
      `bytes fetched from Scryfall:  ${counts.fetchedBytes}`,
      `bytes stored on the CDN:      ${counts.uploadedBytes}`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const options = parseArgs(args);

  const cards = await readPool(options.poolPath);
  const { file: manifestFile, existed } = await readManifest(options.manifestPath);
  const entries: Record<string, ArtEntry> = { ...manifestFile.entries };

  console.log(`pool:      ${options.poolPath} (${cards.length} distinct ids)`);
  console.log(
    `manifest:  ${options.manifestPath}${existed ? '' : ' (does not exist yet; will be created)'}` +
      ` — ${Object.keys(entries).length} existing rows`,
  );
  console.log(`pacing:    ${options.delayMs} ms between Scryfall requests (floor ${MIN_DELAY_MS})`);

  const counts: Counts = {
    uploaded: 0,
    deduplicated: 0,
    skippedOnCdn: 0,
    skippedPinned: 0,
    failed: 0,
    fetchedBytes: 0,
    uploadedBytes: 0,
  };

  // Decide the whole plan BEFORE touching the network. Two things fall out of
  // that: the skip counts are real even on a run that uploads nothing, and a
  // run with nothing left to do succeeds without a credential — which is the
  // ordinary second run, and demanding a token to do nothing would be absurd.
  const todo: PoolCard[] = [];
  for (const card of cards) {
    const what = disposition(entries[card.scryfallId as string]);
    if (what.kind === 'upload') {
      if (todo.length < options.limit) todo.push(card);
      continue;
    }
    if (what.why === 'on-cdn') counts.skippedOnCdn++;
    else counts.skippedPinned++;
  }
  console.log(`to do:     ${todo.length} card(s) need art uploaded`);

  const credential = options.dryRun || todo.length === 0 ? null : await findCredential();
  if (!options.dryRun && todo.length > 0 && credential === null) {
    console.error(
      [
        '',
        'No friend-tier credential found, so nothing was uploaded.',
        `Looked in: ${CREDENTIAL_ENV.map((c) => `$${c.name}`).join(', ')}, and ${CREDENTIAL_FILE}.`,
        `${UPLOAD_URL} is friend+ and answers 401 to an anonymous POST.`,
        'Set one of those variables and rerun; the manifest resumes where it stopped.',
        'Meanwhile `--dry-run` exercises everything except the fetch and the upload.',
      ].join('\n'),
    );
    process.exit(1);
    return;
  }
  if (credential !== null) {
    // The SOURCE, never the value. A token in a log is a token in a backup.
    console.log(`credential: ${credential.source} -> ${credential.header} header`);
  }

  // The client is written for a browser on hadoku.me, where the session cookie
  // rides along on `credentials: 'same-origin'`. From Node there is no cookie
  // jar, so the credential is attached here — the one seam the client exposes
  // for exactly this. `Headers` rather than an object spread because the
  // client's init shape is its business, not ours.
  const authedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (credential !== null) headers.set(credential.header, credential.value);
    headers.set('User-Agent', userAgent());
    return fetch(input, { ...init, headers });
  };

  if (options.uploadUrl !== UPLOAD_URL) {
    console.log(`upload:    ${options.uploadUrl}  (NOT the production CDN)`);
  }

  const client = createCdnClient({
    cdnBase: CDN_BASE,
    uploadPath: options.uploadUrl,
    fetch: authedFetch,
  });

  const failures: string[] = [];
  let planned = 0;

  // Ctrl-C finishes the card in flight and flushes, rather than dying between
  // the upload and the manifest write — the one window where work is lost.
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\ninterrupted — finishing the card in flight, then flushing the manifest.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (const card of todo) {
      if (stopping) break;
      const id = card.scryfallId as string;

      // Lane A's composition, not our own: one place derives a Scryfall path,
      // and an empty manifest is exactly "resolve this id upstream".
      const source = resolveArtUrl(id, {}, { size: options.size });
      if (source === null) {
        counts.failed++;
        failures.push(`${card.name} (${id}): no source URL — id is not a uuid`);
        continue;
      }

      if (options.dryRun) {
        planned++;
        console.log(`would upload  ${card.name} <- ${source}`);
        continue;
      }

      let result: UploadResult;
      try {
        const fetched = await fetchArt(source, options.delayMs);
        counts.fetchedBytes += fetched.bytes.byteLength;

        const refusal = refuseUpload(fetched);
        if (refusal !== null) {
          counts.failed++;
          failures.push(`${card.name} (${id}): ${refusal}`);
          continue;
        }

        result = await client.upload(new Blob([fetched.bytes], { type: fetched.contentType }));
      } catch (err) {
        if (err instanceof ScryfallRateLimited) throw err;
        counts.failed++;
        const detail =
          err instanceof CdnError ? `${err.reason}${err.status ? ` (${err.status})` : ''}` : '';
        failures.push(
          `${card.name} (${id}): ${detail ? `${detail} — ` : ''}${(err as Error).message}`,
        );
        // A 401/403 will not fix itself card by card; a whole run of them is a
        // pool's worth of pointless requests to Scryfall and to the CDN.
        if (
          err instanceof CdnError &&
          (err.reason === 'unauthenticated' || err.reason === 'forbidden')
        ) {
          const left = todo.length - counts.failed;
          console.error(
            `\nupload refused (${err.reason}) — stopping rather than repeating it on ${left} more card(s).`,
          );
          break;
        }
        continue;
      }

      // The manifest is committed data, and a row is only worth writing if the
      // render path can resolve it. `isCdnKey` is that render path's own test,
      // so anything it rejects would have silently fallen back to Scryfall
      // forever while the counts claimed success.
      if (!isCdnKey(result.key)) {
        counts.failed++;
        failures.push(`${card.name} (${id}): upload returned ${JSON.stringify(result.key)}, which is not a CDN key`);
        continue;
      }

      entries[id] = { source: 'cdn', key: result.key };
      counts.uploaded++;
      counts.uploadedBytes += result.bytes;
      if (result.deduplicated) counts.deduplicated++;

      // After EVERY success, not at the end: that is what makes the run
      // resumable. 534 small writes cost nothing next to 534 network round
      // trips, and the alternative loses the whole run to one Ctrl-C.
      await writeManifest(options.manifestPath, { ...manifestFile, entries });

      console.log(
        `uploaded ${counts.uploaded.toString().padStart(4)}  ${result.key}  ${card.name}` +
          (result.deduplicated ? '  (already stored)' : ''),
      );
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!options.dryRun && counts.uploaded > 0) {
      await writeManifest(options.manifestPath, { ...manifestFile, entries });
    }
  }

  console.log(summarise(counts, cards.length, options.dryRun, planned));
  if (failures.length > 0) {
    console.log(`\nfailures (${failures.length}):`);
    for (const line of failures.slice(0, 20)) console.log(`  ${line}`);
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  }
  if (counts.failed > 0) process.exit(1);
}

await main();
