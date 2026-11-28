/*
 * What every soak client shares: PPE behind the real edge, a browser's user
 * agent (the edge refuses a headless one), and a guest account's session.
 */
export const ORIGIN = 'https://hadoku.me';
export const PREFIX = '/cardtable-ppe';
export const PPE_DOOR = `${ORIGIN}${PREFIX}/`;
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export interface Account {
  name: string;
  userId: string;
  session: string;
}

export const cookieOf = (a: Account): string => `hadoku_session=${a.session}`;

/** A fetch as this account's browser tab makes it: same-origin, its cookie, a browser's agent. */
export function fetchAs(a: Account): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const absolute = url.startsWith('http') ? url : `${ORIGIN}${url}`;
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookieOf(a));
    headers.set('user-agent', UA);
    if (init?.method !== undefined && init.method !== 'GET') headers.set('origin', ORIGIN);
    return fetch(absolute, { ...init, headers });
  };
}
