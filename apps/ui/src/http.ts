/*
 * The app's one HTTP client: where `/api/` is, and how a request goes out and a
 * reply is read. Every call sends the session cookie (`credentials:
 * 'same-origin'`), because every `/api` route is friend-gated at the edge.
 */

/** `fetch`, narrowed to what the clients call, so a test can pass a stub. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: Fetch = (input, init) => fetch(input, init);

/** Where this build is served from: `/cardtable/` in production, `/` in a test. */
function appBase(): string {
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
export function getJson(url: string, fetchImpl: Fetch = defaultFetch): Promise<Response> {
  return fetchImpl(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
}

/** A JSON body to an `/api` URL. `init` adds to the request, never replaces the cookie or the content type. */
export function sendJson(url: string, method: string, body: unknown, fetchImpl: Fetch = defaultFetch, init: RequestInit = {}): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
}
