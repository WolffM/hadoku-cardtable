/*
 * The viewer's watchparty avatar: where the id comes from, and what draws it.
 *
 * The operator: *"i noticed you're still not pulling in the watchparty selected
 * avatars. why not?"* Because the last hop was never wired. `avatarId` is on
 * `@wolffm/rooms-protocol`'s `RosterIdentity` and `LocalIdentity`, and
 * `packages/room-store`'s `SerializedMember` has persisted it through our own
 * room snapshot since it was written — but nothing in `apps/server/src` or
 * `apps/ui/src` had ever read it, so it reached our room store and was dropped
 * before it reached a seat.
 *
 * This file is the client half: it answers "which character did this viewer
 * pick" and "what URL draws it", and it is the ONLY place either answer is
 * spelled. `room/RoomShell.tsx` asserts the id to our own room API; the server
 * carries it to the table view (`apps/server/src/http/routes.ts`).
 *
 * ## There is no typed accessor, and that is an upstream gap, not a guess
 *
 * `@wolffm/watchparty-ui@0.39.8` ships two `.d.ts` files and NEITHER mentions
 * an avatar: `RoomChromeProps` takes `roomKey`, `serverOrigin`, `userType`,
 * `userId`, `sessionId`, `theme`, `onLeave`, `debug` and `children`, and that is
 * the whole public surface. The value exists only inside the bundle. So both
 * answers below are derived from the shipped `dist/room-chrome.js`, quoted where
 * they are derived, and `docs/requests/WATCHPARTY_AVATAR_ACCESSOR.md` is the ask
 * that would replace them with an import. Until that lands, every constant here
 * is a fact about a bundle rather than a contract, which is exactly why they are
 * in ONE file with the evidence beside them.
 *
 * ## What the value is
 *
 * Watchparty calls it `sprite` and the fleet calls it `avatarId`. They are the
 * same string: `resolveIdentityReassert` is called as
 * `bn({ name: n.name, avatarId: n.sprite }, a ? { name: a.name, avatarId: a.sprite } : void 0, J)`
 * and the result is emitted as `{ ...{ sprite: i.avatarId } }` on
 * `IDENTITY_UPDATE`. We carry the fleet's spelling everywhere except the two
 * constants below, because that is the name room-store and rooms-protocol
 * already use.
 *
 * Their schema is `sprite: z.string().min(1).max(32)`, with a comment naming the
 * eight characters their picker offers — `sage`, `herald`, `cleric`, `knight`,
 * `mage`, `brawler`, `wanderer`, `rogue` — and adding that clients "fall back to
 * a colored square when missing". Nothing here validates against those eight on
 * purpose: a ninth character they add must reach our seats, not be dropped by a
 * list we forgot to update. The bound IS enforced, because our own room API
 * refuses a longer value.
 */

import { createPrefsClient, type PrefsClient } from '@wolffm/prefs-client';
import { SeqCursorSchema } from '@hadoku/shared';
import { CallIdSchema } from '@hadoku/forge-wire';

/** Watchparty's bound on the id: `sprite: z.string().min(1).max(32)`. */
export const AVATAR_ID_MAX = 32;

/**
 * Watchparty's server, on whatever origin serves this page. In production that
 * is `https://hadoku.me/watchparty` — both apps sit behind the same edge — and
 * their chrome talks to their server. It is derived rather than hardcoded so a
 * page served from anywhere else never reaches production: the draft e2e runs
 * against a local server, and the hardcoded origin sent its browsers to
 * hadoku.me for sprites, whoami and client-log (8d71303, caught by that spec's
 * off-host guard).
 */
export function watchpartyOrigin(): string {
  return `${globalThis.location.origin}/watchparty`;
}

/**
 * The image that draws one avatar, or null when there is nothing to draw.
 *
 * `Ee()` in `dist/room-chrome.js` (0.39.8) is the whole derivation:
 *
 *     function Ee(e) {
 *       return `${de().serverOrigin.replace(/\/$/, "")}/media/sprites/square_${e}.png`;
 *     }
 *
 * `serverOrigin` there is the prop `RoomShell` already passes the chrome, so
 * this resolves against the same origin the chrome's own faces do — same-origin
 * by construction, no host written down, and a local e2e stays local.
 *
 * Null for an absent, blank or over-long id rather than a URL ending
 * `square_.png`, which is a 404 drawn as a broken image where the caller wanted
 * a fallback. That is the client half of the rule the server states in
 * `room/lobby.ts`'s `avatarIdOf`: an empty string must never become a request.
 */
export function avatarSquareUrl(avatarId: string | null | undefined, origin: string = watchpartyOrigin()): string | null {
  const id = normalizeAvatarId(avatarId);
  if (id === null) return null;
  return `${origin.replace(/\/$/, '')}/media/sprites/square_${encodeURIComponent(id)}.png`;
}

/** The same two-state reading the server does, so a client cannot send what it would refuse. */
export function normalizeAvatarId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const id = v.trim();
  return id === '' || id.length > AVATAR_ID_MAX ? null : id;
}

/** Just enough of `localStorage` to read one key, so a test needs no jsdom. */
export interface AvatarStore {
  getItem(key: string): string | null;
}

function browserStore(): AvatarStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A blocked-storage browser is not an error here: it is a viewer with no
    // readable avatar, which is the same answer as a viewer with no avatar.
    return null;
  }
}

/**
 * The cache row watchparty's own boot read uses, for `userId`.
 *
 * `Vt()` in `dist/room-chrome.js` (0.39.8):
 *
 *     function Vt(e) {
 *       const t = Z();
 *       return `prefs-cache:${!t || t === "public" ? "anon" : t}:${e}`;
 *     }
 *
 * `Z()` returns the `userId` the host handed the chrome — which for this app is
 * `whoami()`'s `userId`, the same value `RoomShell` passes as the `userId` prop.
 * `public` and empty both key the shared anonymous row.
 */
export function watchpartyPrefsCacheKey(userId: string | null | undefined): string {
  const uid = userId === null || userId === undefined || userId === '' || userId === 'public' ? 'anon' : userId;
  return `prefs-cache:${uid}:watchparty`;
}

/**
 * Which character this viewer picked, or null.
 *
 * Read out of the prefs SDK's write-through cache, because that is where the
 * value lives and there is no accessor that will hand it over. The chain, all of
 * it quoted from the shipped 0.39.8 bundle:
 *
 *   - the picker calls `setIdentity`, which does `H("sprite", o)`;
 *   - `H` is `se.save({ sprite: o })` where `se = fn({ appId: "watchparty",
 *     schema: Or })` and `fn` is `createPrefsClient` from `@wolffm/prefs-client`
 *     — so the value is a field of watchparty's own prefs blob, and `Or` declares
 *     it `sprite: z.string().optional()`;
 *   - the SDK write-throughs that blob to `localStorage` under
 *     `watchpartyPrefsCacheKey(userId)` as `{ blob, userVersion, deviceVersion,
 *     cachedAt }`;
 *   - watchparty's OWN synchronous boot read is `nt("watchparty")`, which is
 *     `JSON.parse($(Vt(e)))?.blob ?? {}` — byte for byte what this does.
 *
 * **Why the `hadoku_session_id` guard.** `Yt()` in the same bundle refuses the
 * read when a session cookie exists but the userId is still `public`: the
 * anonymous row is SHARED by every user of the browser, so reading it mid-
 * sign-in hands one person the last person's choices. Mirrored here rather than
 * skipped, because we do not read it to theme a panel — we POST it to a room,
 * where wearing a housemate's face is a visible wrong answer.
 *
 * This is a read, never a write. We do not save into watchparty's prefs row, and
 * a viewer who has never opened the chrome on this browser has an empty cache
 * and no avatar — which is the honest answer and the strongest argument in the
 * request doc.
 */
export function selectedAvatarId(userId: string | null | undefined, store: AvatarStore | null = browserStore()): string | null {
  if (store === null) return null;
  try {
    const signedInButUnnamed =
      store.getItem('hadoku_session_id') !== null &&
      (userId === null || userId === undefined || userId === '' || userId === 'public');
    if (signedInButUnnamed) return null;
    const raw = store.getItem(watchpartyPrefsCacheKey(userId));
    if (raw === null) return null;
    const row = JSON.parse(raw) as unknown;
    if (typeof row !== 'object' || row === null) return null;
    const blob = (row as { blob?: unknown }).blob;
    if (typeof blob !== 'object' || blob === null) return null;
    return normalizeAvatarId((blob as { sprite?: unknown }).sprite);
  } catch {
    // Malformed JSON in somebody else's cache row is not our failure to report:
    // it means we do not know this viewer's avatar, which is `null`.
    return null;
  }
}

/*
 * ## The account's copy, not just this browser's
 *
 * `selectedAvatarId` above reads the prefs SDK's write-through CACHE, which only
 * exists on a browser that has already opened watchparty's chrome. A fresh
 * browser has no cache row and so asserted nothing (wave 31 P3b). The value
 * itself lives in the account: watchparty's prefs row (app `watchparty`, `user`
 * scope), which is what `createPrefsClient(...).read()` returns. We only ever
 * read it, never save, so asking for the same app id cannot change what the
 * chrome stores. The schema is loose on purpose: the row holds every one of
 * watchparty's own fields and we want one.
 *
 * `apiBase` is this page's origin for the reason `watchpartyOrigin` gives: the
 * SDK's default is a hardcoded `https://hadoku.me/prefs`, which a local e2e
 * would reach off-host.
 */

/** Only `sprite` is read. `.loose()` keeps the rest of watchparty's fields from failing validation. */
const WatchpartyPrefsSchema = SeqCursorSchema.pick({}).extend({ sprite: CallIdSchema.optional() }).loose();

interface WatchpartyPrefs {
  [key: string]: unknown;
  sprite?: string;
}

let accountClient: PrefsClient<WatchpartyPrefs> | null = null;

function watchpartyPrefsClient(): PrefsClient<WatchpartyPrefs> {
  accountClient ??= createPrefsClient({
    appId: 'watchparty',
    // Two zod copies in one lockfile make the schema types nominally different;
    // `play/live/prefs.ts` explains the same cast at length.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see play/live/prefs.ts
    schema: WatchpartyPrefsSchema as any,
    apiBase: `${globalThis.location.origin}/prefs`,
  }) as unknown as PrefsClient<WatchpartyPrefs>;
  return accountClient;
}

/**
 * This viewer's chosen avatar from their ACCOUNT, falling back to this browser's
 * cache when the account cannot be read (offline, signed out, a host without the
 * prefs route). Null when neither knows: that is the unset case (D2), which only
 * watchparty's own auto-assigned sprite could fill and nothing readable to us
 * carries.
 */
export async function accountAvatarId(userId: string | null | undefined): Promise<string | null> {
  try {
    const prefs = await watchpartyPrefsClient().read();
    const id = normalizeAvatarId(prefs.sprite);
    if (id !== null) return id;
  } catch {
    // Unreadable account is not an error to show anybody: the cache read below
    // is the same answer a browser that has used the chrome would give.
  }
  return selectedAvatarId(userId);
}
