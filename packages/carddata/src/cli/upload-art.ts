/*
 * Copy every card image we can show onto `cdn.hadoku.me`.
 *
 *   pnpm --filter @hadoku/carddata upload-art -- --dry-run
 *   pnpm --filter @hadoku/carddata upload-art -- --limit 25
 *   HADOKU_CDN_KEY=… pnpm --filter @hadoku/carddata upload-art
 *
 * The source is the server's card catalog (`~/.local/share/cardtable/catalog/cards.json`):
 * every printing's front, the back of every printing whose card has one, and the token
 * images `art-ids.json` names. Each image is fetched from Scryfall's image CDN, uploaded,
 * and its key appended to the mirror log (`../art/mirror.ts` has the format and why it is
 * a log). An id already in the log is skipped without a fetch, so a rerun resumes, and a
 * new set in tomorrow's catalog is a rerun that copies only its cards.
 *
 * ## We host card art, deliberately
 *
 * D15 (`docs/DECISIONS.md`, `docs/LICENSING.md` §3.1) allows hosting art on the CDN;
 * image bytes still never enter the repo or the bundle. Scryfall's image rules (whole,
 * unaltered faces) apply to how the art is shown, and the copy is byte-for-byte.
 *
 * ## Paced
 *
 * Every Scryfall request queues through one gate (`paced`) with a floor of 100 ms, the
 * polite end of the 50–100 ms Scryfall asks for. Uploads to our own CDN overlap with the
 * next fetch (`--uploads N` in flight), which is what makes ~110k images a few hours
 * rather than half a day. A 429 from Scryfall stops the run; a rate-limited CDN pauses
 * for its Retry-After and carries on.
 *
 * ## Credentials
 *
 * The upload route is friend+. The credential comes from the environment or
 * `~/.config/hadoku/standing.env` (`CREDENTIAL_ENV`) and is never printed.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdnClient, CdnError, MAX_BYTES, ACCEPTED_IMAGE_TYPES } from '@wolffm/cdn-client';
import { CDN_BASE, isCdnKey, resolveArtUrl } from '../art/index.ts';
import { mirrorLine, parseMirrorLog } from '../art/mirror.ts';
import { userAgent } from '../scryfall/client.ts';

const UPLOAD_URL = 'https://hadoku.me/cdn/api/upload';
const MIN_DELAY_MS = 100;
const DEFAULT_DELAY_MS = 110;
const DEFAULT_UPLOADS = 4;
/** Scryfall answers 400, not 403, without both headers (`docs/LICENSING.md` §3). */
const IMAGE_ACCEPT = 'image/jpeg,image/*;q=0.8';

const CREDENTIAL_ENV = [
  { name: 'HADOKU_CDN_KEY', header: 'X-User-Key', render: (v: string): string => v },
  { name: 'HADOKU_CDN_COOKIE', header: 'Cookie', render: (v: string): string => v },
] as const;
const CREDENTIAL_FILE = join(homedir(), '.config', 'hadoku', 'standing.env');

const DATA_DIR = join(homedir(), '.local', 'share', 'cardtable');
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(#back)?$/;

function repoRoot(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
}

const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

/** The Scryfall rate limit, and the only place it lives: one chain, `delayMs` between starts. */
let gate: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
function paced<T>(delayMs: number, run: () => Promise<T>): Promise<T> {
  const next = gate.then(async () => {
    const since = Date.now() - lastRequestAt;
    if (since < delayMs) await sleep(delayMs - since);
    lastRequestAt = Date.now();
    return run();
  });
  gate = next.catch(() => undefined);
  return next;
}

interface Options {
  catalogPath: string;
  artIdsPath: string;
  logPath: string;
  uploadUrl: string;
  delayMs: number;
  uploads: number;
  limit: number;
  dryRun: boolean;
}

const USAGE = `upload-art — copy every printing's card image to cdn.hadoku.me

  pnpm --filter @hadoku/carddata upload-art -- [flags]

  --dry-run            fetch nothing, upload nothing, print the plan
  --limit N            stop after N uploads (default: all)
  --catalog <path>     card catalog (default: ${join(DATA_DIR, 'catalog', 'cards.json')})
  --art-ids <path>     token rows to include (default: apps/server/src/play/art-ids.json)
  --log <path>         mirror log to read and append (default: ${join(DATA_DIR, 'art', 'mirror.jsonl')})
  --upload-url <url>   where to POST the bytes (default: ${UPLOAD_URL})
  --delay-ms N         ms between Scryfall requests (default ${DEFAULT_DELAY_MS}, floor ${MIN_DELAY_MS})
  --uploads N          uploads in flight while the next image downloads (default ${DEFAULT_UPLOADS})
  --help
`;

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  return n;
}

function parseArgs(args: readonly string[]): Options {
  const path = (flag: string, fallback: string): string => resolve(flagValue(args, flag) ?? fallback);
  return {
    catalogPath: path('--catalog', process.env.CARDTABLE_CATALOG ?? join(DATA_DIR, 'catalog', 'cards.json')),
    artIdsPath: path('--art-ids', join(repoRoot(), 'apps', 'server', 'src', 'play', 'art-ids.json')),
    logPath: path('--log', process.env.CARDTABLE_ART_MIRROR ?? join(DATA_DIR, 'art', 'mirror.jsonl')),
    uploadUrl: flagValue(args, '--upload-url') ?? UPLOAD_URL,
    delayMs: Math.max(MIN_DELAY_MS, positiveInt(flagValue(args, '--delay-ms'), DEFAULT_DELAY_MS, '--delay-ms')),
    uploads: Math.max(1, positiveInt(flagValue(args, '--uploads'), DEFAULT_UPLOADS, '--uploads')),
    limit: positiveInt(flagValue(args, '--limit'), Number.POSITIVE_INFINITY, '--limit'),
    dryRun: args.includes('--dry-run'),
  };
}

interface CatalogFile {
  cards: Record<string, { faces?: { scryfallId?: string }[] }>;
  printings: Record<string, { key: string; scryfallId: string }>;
}

/**
 * Every image id to copy, in a stable order: each printing's front, then its back when
 * its card has a back face (`<id>#back`, the resolver's own spelling), then the tokens.
 */
export function imageIds(catalog: CatalogFile, tokenIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const printing of Object.values(catalog.printings)) {
    ids.add(printing.scryfallId);
    const faces = catalog.cards[printing.key]?.faces ?? [];
    if (faces.some((f) => f.scryfallId?.endsWith('#back') === true)) ids.add(`${printing.scryfallId}#back`);
  }
  for (const id of tokenIds) ids.add(id);
  return [...ids].filter((id) => UUID_ID.test(id));
}

/** The token ids `art-ids.json` names (`t:` rows). A missing table is an error, not "no tokens". */
async function tokenIds(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  const table = (JSON.parse(raw) as { ids?: Record<string, string> }).ids ?? {};
  return Object.entries(table)
    .filter(([key]) => key.startsWith('t:'))
    .map(([, id]) => id);
}

async function readLog(path: string): Promise<Map<string, string>> {
  try {
    return parseMirrorLog(await readFile(path, 'utf8')).keys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
}

interface Credential {
  readonly source: string;
  readonly header: string;
  readonly value: string;
}

/** Environment first, then the standing env file. Never prints a value. */
async function findCredential(): Promise<Credential | null> {
  for (const slot of CREDENTIAL_ENV) {
    const raw = process.env[slot.name]?.trim();
    if (raw) return { source: `env ${slot.name}`, header: slot.header, value: slot.render(raw) };
  }
  let fileRaw: string;
  try {
    fileRaw = await readFile(CREDENTIAL_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  for (const slot of CREDENTIAL_ENV) {
    const value = new RegExp(`^(?:export\\s+)?${slot.name}=(.*)$`, 'm').exec(fileRaw)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (value) return { source: `${CREDENTIAL_FILE} (${slot.name})`, header: slot.header, value: slot.render(value) };
  }
  return null;
}

/** Scryfall rate limited us: stop, the log resumes. Longhand fields: Node strips types, and a parameter property is not erasable. */
class ScryfallRateLimited extends Error {
  constructor(retryAfter: string | null) {
    super(`Scryfall returned HTTP 429${retryAfter === null ? '' : `; Retry-After ${retryAfter}`}. Stopping — rerun later and the log resumes.`);
    this.name = 'ScryfallRateLimited';
  }
}

async function fetchImage(url: string, delayMs: number): Promise<Blob> {
  return paced(delayMs, async () => {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: IMAGE_ACCEPT } });
    if (response.status === 429) throw new ScryfallRateLimited(response.headers.get('retry-after'));
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES.image) throw new Error(`${url}: ${bytes.byteLength} bytes`);
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)) throw new Error(`${url}: content-type ${type || '(none)'}`);
    return new Blob([bytes], { type });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const options = parseArgs(args);

  const catalog = JSON.parse(await readFile(options.catalogPath, 'utf8')) as CatalogFile;
  const tokens = await tokenIds(options.artIdsPath);
  const all = imageIds(catalog, tokens);
  const done = await readLog(options.logPath);
  const todo = all.filter((id) => !done.has(id)).slice(0, options.limit);
  console.log(`catalog:   ${options.catalogPath} (${Object.keys(catalog.printings).length} printings)`);
  console.log(`tokens:    ${tokens.length} from ${options.artIdsPath}`);
  console.log(`log:       ${options.logPath} (${done.size} already copied)`);
  console.log(`to copy:   ${todo.length} of ${all.length} images; ${options.delayMs} ms between fetches, ${options.uploads} uploads in flight`);
  if (options.dryRun || todo.length === 0) return;

  const credential = await findCredential();
  if (credential === null) {
    console.error(`No credential: set ${CREDENTIAL_ENV.map((c) => `$${c.name}`).join(' or ')} (or put one in ${CREDENTIAL_FILE}). Nothing uploaded.`);
    process.exit(1);
  }
  console.log(`credential: ${credential.source} -> ${credential.header}`);

  const authedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(credential.header, credential.value);
    headers.set('User-Agent', 'Mozilla/5.0 hadoku-agent');
    return fetch(input, { ...init, headers });
  };
  const client = createCdnClient({ cdnBase: CDN_BASE, uploadPath: options.uploadUrl, fetch: authedFetch });
  await mkdir(dirname(options.logPath), { recursive: true });

  let stopping = false;
  let fatal: Error | null = null;
  const onSignal = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\ninterrupted — finishing the uploads in flight.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const counts = { copied: 0, deduplicated: 0, failed: 0, bytes: 0 };
  const failures: string[] = [];
  const started = Date.now();

  /** Upload with the CDN's own back-off; refusals of the credential stop the run. */
  const upload = async (id: string, blob: Blob): Promise<void> => {
    for (;;) {
      try {
        const result = await client.upload(blob);
        if (!isCdnKey(result.key)) throw new Error(`upload returned ${JSON.stringify(result.key)}, not a CDN key`);
        await appendFile(options.logPath, mirrorLine({ id, key: result.key }));
        counts.copied++;
        counts.bytes += result.bytes;
        if (result.deduplicated) counts.deduplicated++;
        if (counts.copied % 500 === 0) {
          const rate = counts.copied / ((Date.now() - started) / 1000);
          console.log(`copied ${counts.copied}/${todo.length} (${(counts.bytes / 1e9).toFixed(2)} GB, ${rate.toFixed(1)}/s, ~${Math.round((todo.length - counts.copied) / rate / 60)} min left)`);
        }
        return;
      } catch (err) {
        if (err instanceof CdnError && err.reason === 'rate-limited') {
          await sleep(((err as CdnError & { retryAfterSeconds?: number | null }).retryAfterSeconds ?? 30) * 1000);
          continue;
        }
        if (err instanceof CdnError && (err.reason === 'unauthenticated' || err.reason === 'forbidden')) {
          fatal = new Error(`upload refused (${err.reason}) — stopping.`);
          stopping = true;
        }
        counts.failed++;
        failures.push(`${id}: ${err instanceof CdnError ? `${err.reason} — ` : ''}${(err as Error).message}`);
        return;
      }
    }
  };

  const inFlight = new Set<Promise<void>>();
  try {
    for (const id of todo) {
      if (stopping) break;
      const url = resolveArtUrl(id, {});
      if (url === null) {
        counts.failed++;
        failures.push(`${id}: no Scryfall URL`);
        continue;
      }
      let blob: Blob;
      try {
        blob = await fetchImage(url, options.delayMs);
      } catch (err) {
        if (err instanceof ScryfallRateLimited) {
          fatal = err;
          break;
        }
        counts.failed++;
        failures.push(`${id}: ${(err as Error).message}`);
        continue;
      }
      const job = upload(id, blob).finally(() => inFlight.delete(job));
      inFlight.add(job);
      if (inFlight.size >= options.uploads) await Promise.race(inFlight);
    }
  } finally {
    await Promise.all(inFlight);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  console.log(`\ncopied ${counts.copied} (${counts.deduplicated} already stored), failed ${counts.failed}, ${(counts.bytes / 1e9).toFixed(2)} GB in ${Math.round((Date.now() - started) / 60000)} min`);
  for (const line of failures.slice(0, 20)) console.log(`  ${line}`);
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  if (fatal !== null) {
    console.error((fatal as Error).message);
    process.exit(1);
  }
  if (counts.failed > 0) process.exit(1);
}

if (import.meta.main) await main();
