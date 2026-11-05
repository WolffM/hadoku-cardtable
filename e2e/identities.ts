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
  /**
   * `X-Hadoku-Tier`. Absent for a player: `edge.ts` stamps `identity.tier ?? 'member'`,
   * the tier anyone who signs up on hadoku.me has (D24). The real edge resolves a tier
   * from the caller's account, and this is the test-only stand-in for that resolution.
   */
  tier?: string;
  /**
   * A member the operator verifies (the registry's flag). Every tier above member is verified
   * anyway; `edge.ts` stamps `X-Hadoku-Verified: 1` by the same rule as the real edge's `isVerified`.
   */
  verified?: true;
}

export const FRIENDS: Readonly<Record<string, Friend>> = {
  // `name` is the registry DISPLAY NAME the edge injects as X-User-Name;
  // deliberately not equal to the id, so a roster showing ids where names
  // belong cannot pass by accident.
  alice: { key: 'e2e-friend-key-alice-7f3a', userId: 'e2e-alice-id', name: 'e2e-alice' },
  bob: { key: 'e2e-friend-key-bob-91c2', userId: 'e2e-bob-id', name: 'e2e-bob' },
  // A third person in a two-seat room: the one the seats and watcher specs leave standing.
  carol: { key: 'e2e-friend-key-carol-3e5d', userId: 'e2e-carol-id', name: 'e2e-carol' },
  // A member the operator verifies: a friend in everything cardtable lets a friend do.
  erin: { key: 'e2e-friend-key-erin-6c1f', userId: 'e2e-erin-id', name: 'e2e-erin', verified: true },
  // The music review only: it is friend tier, above the member floor every player is at.
  dana: { key: 'e2e-friend-key-dana-5b8e', userId: 'e2e-dana-id', name: 'e2e-dana', tier: 'friend' },
  // wave 50 §U only: the sound builder's write half needs an admin identity.
  admin: {
    key: 'e2e-friend-key-admin-a4d1',
    userId: 'e2e-admin-id',
    name: 'e2e-admin',
    tier: 'admin',
  },
  // wave 84 §w84b only: a room of more than 8 drafters, seven of whom join, sit and ready over HTTP alone.
  ...Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`drafter${i + 3}`, { key: `e2e-friend-key-drafter-${i + 3}`, userId: `e2e-drafter${i + 3}-id`, name: `e2e-drafter${i + 3}` }]),
  ),
};

/** Ports. Overridable so a runner with something on these can move them. */
export const EDGE_PORT = Number(process.env.CARDTABLE_E2E_EDGE_PORT ?? '19108');
export const SERVER_PORT = Number(process.env.CARDTABLE_E2E_SERVER_PORT ?? '19008');

/** The public prefix the browser sees, as on hadoku.me. */
export const PREFIX = '/cardtable';

export const EDGE_ORIGIN = `http://127.0.0.1:${EDGE_PORT}`;
