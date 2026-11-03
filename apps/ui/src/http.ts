/*
 * The app's one HTTP client: where `/api/` is, and how a request goes out and a
 * reply is read. Every call sends the session cookie (`credentials:
 * 'same-origin'`), because every `/api` route is friend-gated at the edge.
 */

/** `fetch`, narrowed to what the clients call, so a test can pass a stub. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The page's own transport: every client's default, and what a page-long read is kept for (`readOnce`). */
export const pageFetch: Fetch = (input, init) => fetch(input, init);

const pageReads = new WeakMap<Fetch, Map<string, Promise<unknown>>>();

/**
 * `read()`'s answer for `url`, read once for the page and shared by every caller, in flight or
 * landed: for what changes only with a deploy, or with a write this page makes (`forgetRead`). A
 * read that fails, or answers `null`, is not kept, so the next caller asks again. Kept per transport,
 * so a test's own stub keeps its own answers.
 */
export function readOnce<T>(fetchImpl: Fetch, url: string, read: () => Promise<T>): Promise<T> {
  const reads = pageReads.get(fetchImpl) ?? new Map<string, Promise<unknown>>();
  pageReads.set(fetchImpl, reads);
  const kept = reads.get(url);
  if (kept !== undefined) return kept as Promise<T>;
  const reading = read();
  reads.set(url, reading);
  const forget = (): void => {
    if (reads.get(url) === reading) reads.delete(url);
  };
  // The caller hears the failure; this only stops keeping it.
  reading.then((answer) => {
    if (answer === null) forget();
  }, forget);
  return reading;
}

/** What `url` reads has changed: the next `readOnce` of it asks the server. */
export function forgetRead(fetchImpl: Fetch, url: string): void {
  pageReads.get(fetchImpl)?.delete(url);
}

/** Where this build is served from: `/cardtable/` in production, `/` in a test. */
export function appBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' ? base : '/';
}

/** `/cardtable/` → `/cardtable/api/`. Same arithmetic as `socketPath`. */
export function apiBase(base: string = appBase()): string {
  const prefix = base === '' ? '/' : base;
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}api/`;
}

/** An `/api` path, `rooms/r-1`, under this build's base. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The reply's JSON, or null when it has none (a proxy's error page, a 204). */
export async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The server's own `{ error }`, or the status when the body has none. */
export function serverMessage(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string' && body.error !== '') return body.error;
  return `the server answered HTTP ${status}`;
}

/** A GET of an `/api` URL that wants JSON back. */
export function getJson(url: string, fetchImpl: Fetch = pageFetch): Promise<Response> {
  return fetchImpl(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
}

/** A JSON body to an `/api` URL. `init` adds to the request, never replaces the cookie or the content type. */
export function sendJson(url: string, method: string, body: unknown, fetchImpl: Fetch = pageFetch, init: RequestInit = {}): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
}
