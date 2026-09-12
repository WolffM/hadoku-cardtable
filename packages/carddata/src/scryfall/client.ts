/*
 * A small, polite HTTP client for api.scryfall.com.
 *
 * Every number and header rule in this file was read off Scryfall's live
 * documentation on 2026-09-11, not recalled — see `docs/CARD_DATA.md`, which
 * records the exact requests made and the exact responses. Do not "tidy" these
 * constants without re-reading https://scryfall.com/docs/api/rate-limits.
 *
 * There is deliberately no image code path anywhere in this package. Card art
 * is fetched by the browser, direct from upstream; our server never touches it
 * (D13, docs/LICENSING.md §2 rule 3).
 */

/** Scryfall's API origin. Everything else they serve is out of scope for us. */
export const SCRYFALL_API = 'https://api.scryfall.com';

/**
 * Scryfall requires a User-Agent "accurate to your usage context" and says
 * explicitly: "Do not allow HTTP libraries to choose the header for you."
 * Override with SCRYFALL_USER_AGENT if you fork this for something else.
 */
export function userAgent(): string {
  const override = process.env.SCRYFALL_USER_AGENT;
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return 'hadoku-cardtable/0.1 (+https://hadoku.me/cardtable/)';
}

/**
 * Scryfall requires an Accept header be present but permits a generic
 * preference; their docs give this exact string as an acceptable example.
 */
const ACCEPT = 'application/json;q=0.9,*/*;q=0.8';

/**
 * Hard rate limits, verbatim from https://scryfall.com/docs/api/rate-limits
 * (read 2026-09-11):
 *
 *   /cards/search      2/second   (500ms)
 *   /cards/named       2/second   (500ms)
 *   /cards/random      2/second   (500ms)
 *   /cards/collection  2/second   (500ms)
 *   /cards/manifest    10/minute  (6,000ms)
 *   all other methods  10/second  (100ms)
 *
 * The direct file origins have no rate limit, which is why the bulk download
 * itself is not paced — only the listing request that discovers it.
 */
const SLOW_PATHS = ['/cards/search', '/cards/named', '/cards/random', '/cards/collection'];
const SLOW_INTERVAL_MS = 500;
const MANIFEST_PATH = '/cards/manifest';
const MANIFEST_INTERVAL_MS = 6_000;
const DEFAULT_INTERVAL_MS = 100;

/**
 * "Recieving an HTTP 429 response will result in your access being limited for
 * 30 seconds" — their spelling, their number. Used only when the response
 * carries no Retry-After.
 */
const DEFAULT_COOLDOWN_MS = 30_000;

function intervalFor(path: string): number {
  if (path.startsWith(MANIFEST_PATH)) return MANIFEST_INTERVAL_MS;
  for (const slow of SLOW_PATHS) if (path.startsWith(slow)) return SLOW_INTERVAL_MS;
  return DEFAULT_INTERVAL_MS;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * Thrown when Scryfall rate limits us. Callers should stop, not retry harder.
 *
 * Written out longhand rather than as a parameter property: Node 24 runs the
 * `.ts` in this package directly by stripping types, and a parameter property
 * is not erasable syntax — it would throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at
 * load time. Bundler-backed test runs do not catch that; running the CLI does.
 */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Scryfall returned HTTP 429; backing off for ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Serialised pacer. Every api.scryfall.com request in the process queues here,
 * so concurrency cannot smuggle us past the documented rate.
 */
let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
let cooldownUntil = 0;

function paced<T>(intervalMs: number, run: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const now = Date.now();
    if (now < cooldownUntil) await sleep(cooldownUntil - now);
    const since = Date.now() - lastRequestAt;
    if (since < intervalMs) await sleep(intervalMs - since);
    lastRequestAt = Date.now();
    return run();
  });
  // Keep the chain alive even when a link rejects, or one failure wedges
  // every later request behind an unhandled rejection.
  chain = next.catch(() => undefined);
  return next;
}

function parseRetryAfterMs(header: string | null): number {
  if (header === null) return DEFAULT_COOLDOWN_MS;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
}

/**
 * GET a JSON document from api.scryfall.com, paced to the documented limit for
 * that path and with both required headers set.
 *
 * @param path an absolute path on the API origin, e.g. `/bulk-data`
 */
export async function getJson<T>(path: string): Promise<T> {
  return paced(intervalFor(path), async () => {
    const response = await fetch(`${SCRYFALL_API}${path}`, {
      headers: { 'User-Agent': userAgent(), Accept: ACCEPT },
    });

    if (response.status === 429) {
      const wait = parseRetryAfterMs(response.headers.get('retry-after'));
      cooldownUntil = Date.now() + wait;
      // Scryfall: "It is not acceptable to ignore HTTP 429 responses. You must
      // act to reduce your application's overages." So we surface it loudly
      // rather than silently retrying.
      throw new RateLimitedError(wait);
    }
    if (!response.ok) {
      throw new Error(`GET ${path} returned HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  });
}
