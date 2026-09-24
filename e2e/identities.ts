/**
 * Who the stand-in edge believes each browser context is.
 *
 * In production the edge resolves a caller from their session, and stamps the
 * request with the tier and the friend key before it reaches the app. Here the
 * session is a cookie naming one of these entries, and `edge.ts` does the
 * stamping. The friend keys are test-only strings; they grant nothing anywhere
 * but a server that was started with this harness's one-run secret.
 */

export const SESSION_COOKIE = 'cardtable_e2e_session';

export interface Friend {
  /** `X-User-Key` — the friend key. Must be ≥ 5 chars to mint an `fk:` id. */
  key: string;
  /** `X-User-Id` — the opaque registry identifier. */
  userId: string;
  /** `X-User-Name` — the registry display name. Not equal to the id. */
  name: string;
}

export const FRIENDS: Readonly<Record<string, Friend>> = {
  // `name` is the registry DISPLAY NAME the edge injects as X-User-Name;
  // deliberately not equal to the id, so a roster showing ids where names
  // belong cannot pass by accident.
  alice: { key: 'e2e-friend-key-alice-7f3a', userId: 'e2e-alice-id', name: 'e2e-alice' },
  bob: { key: 'e2e-friend-key-bob-91c2', userId: 'e2e-bob-id', name: 'e2e-bob' },
};

/** Ports. Overridable so a runner with something on these can move them. */
export const EDGE_PORT = Number(process.env.CARDTABLE_E2E_EDGE_PORT ?? '19108');
export const SERVER_PORT = Number(process.env.CARDTABLE_E2E_SERVER_PORT ?? '19008');

/** The public prefix the browser sees, as on hadoku.me. */
export const PREFIX = '/cardtable';

export const EDGE_ORIGIN = `http://127.0.0.1:${EDGE_PORT}`;
