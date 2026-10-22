/*
 * The watchparty avatar seam, tested against the bundle it was derived from.
 *
 * Everything in `avatar.ts` is a fact about `@wolffm/watchparty-ui@0.39.8`'s
 * shipped `dist/room-chrome.js` rather than a contract — their `.d.ts` files
 * mention no avatar at all, which is what `docs/requests/
 * WATCHPARTY_AVATAR_ACCESSOR.md` asks them to fix. So these tests do two jobs:
 * they pin our own rules (an empty id is never a URL; the anonymous prefs row is
 * never read mid-sign-in), and they write the derivation down as executable
 * assertions so a package bump that moves the key or the path fails here rather
 * than silently drawing nobody's face.
 *
 * No jsdom: `selectedAvatarId` takes its store, and the one test that needs an
 * origin passes one.
 */

import { describe, expect, it } from 'vitest';

import { AVATAR_ID_MAX } from '@hadoku/shared';
import {
  avatarSquareUrl,
  normalizeAvatarId,
  selectedAvatarId,
  watchpartyPrefsCacheKey,
  type AvatarStore,
} from './avatar.ts';

/** A `localStorage` stand-in over a plain object. */
function store(entries: Record<string, string>): AvatarStore {
  return { getItem: (key) => entries[key] ?? null };
}

/** The row shape the prefs SDK write-throughs: `{ blob, userVersion, … }`. */
function prefsRow(blob: Record<string, unknown>): string {
  return JSON.stringify({ blob, userVersion: 3, deviceVersion: 0, cachedAt: 1_759_000_000_000 });
}

const ORIGIN = 'http://127.0.0.1:19008/watchparty';

describe('reading an avatar id', () => {
  it('folds every blank and over-long spelling to null, so `""` can never become a request', () => {
    expect(normalizeAvatarId('wanderer')).toBe('wanderer');
    expect(normalizeAvatarId('  cleric  ')).toBe('cleric');
    for (const blank of ['', '   ', '\t\n', null, undefined, 7, {}, ['mage']]) {
      expect(normalizeAvatarId(blank)).toBeNull();
    }
    // Watchparty's own bound: `sprite: z.string().min(1).max(32)`.
    expect(normalizeAvatarId('x'.repeat(AVATAR_ID_MAX))).toBe('x'.repeat(AVATAR_ID_MAX));
    expect(normalizeAvatarId('x'.repeat(AVATAR_ID_MAX + 1))).toBeNull();
  });

  it('does not check the id against watchparty’s eight characters', () => {
    // Their schema is a string, not an enum, and the eight in the comment are
    // what their picker offers today. A ninth must reach our seats.
    expect(normalizeAvatarId('necromancer')).toBe('necromancer');
  });
});

describe('the sprite URL', () => {
  /*
   * `Ee()` in `dist/room-chrome.js` (0.39.8), verbatim:
   *
   *     function Ee(e) {
   *       return `${de().serverOrigin.replace(/\/$/, "")}/media/sprites/square_${e}.png`;
   *     }
   */
  it('is watchparty’s own square_<id>.png under the origin their chrome is given', () => {
    expect(avatarSquareUrl('wanderer', ORIGIN)).toBe(`${ORIGIN}/media/sprites/square_wanderer.png`);
    // A trailing slash on the origin does not double up — their own `replace`.
    expect(avatarSquareUrl('mage', `${ORIGIN}/`)).toBe(`${ORIGIN}/media/sprites/square_mage.png`);
  });

  it('is null rather than a URL ending square_.png when there is nothing to draw', () => {
    for (const nothing of [null, undefined, '', '   ', 'x'.repeat(AVATAR_ID_MAX + 1)]) {
      expect(avatarSquareUrl(nothing, ORIGIN)).toBeNull();
    }
  });

  it('reads no origin when there is nothing to draw, so a face renders where there is no page', () => {
    expect(globalThis.location).toBeUndefined();
    expect(avatarSquareUrl(undefined)).toBeNull();
  });

  it('escapes the id, so a value from another app’s storage cannot build a path', () => {
    expect(avatarSquareUrl('../../secret', ORIGIN)).toBe(`${ORIGIN}/media/sprites/square_..%2F..%2Fsecret.png`);
  });
});

describe('the prefs cache key', () => {
  /*
   * `Vt()` in `dist/room-chrome.js` (0.39.8), verbatim:
   *
   *     function Vt(e) {
   *       const t = Z();
   *       return `prefs-cache:${!t || t === "public" ? "anon" : t}:${e}`;
   *     }
   *
   * `Z()` is the `userId` the host handed the chrome — for this app, `whoami()`'s
   * `userId`, which is exactly what `RoomShell` passes as the `userId` prop.
   */
  it('keys on the userId the chrome was given, and on the shared anon row for nobody', () => {
    expect(watchpartyPrefsCacheKey('u-carol')).toBe('prefs-cache:u-carol:watchparty');
    for (const nobody of ['public', '', null, undefined]) {
      expect(watchpartyPrefsCacheKey(nobody)).toBe('prefs-cache:anon:watchparty');
    }
  });
});

describe('the viewer’s selected avatar', () => {
  it('is the `sprite` field of watchparty’s own prefs blob', () => {
    const s = store({ 'prefs-cache:u-carol:watchparty': prefsRow({ name: 'Carol', sprite: 'wanderer' }) });
    expect(selectedAvatarId('u-carol', s)).toBe('wanderer');
  });

  it('is null for every shape that is not one, rather than throwing', () => {
    // A viewer who has never opened the chrome on this browser: no row at all.
    expect(selectedAvatarId('u-carol', store({}))).toBeNull();
    // A row with no sprite in it — they picked a name and nothing else.
    expect(selectedAvatarId('u-x', store({ 'prefs-cache:u-x:watchparty': prefsRow({ name: 'X' }) }))).toBeNull();
    // Blank, which is the one value that must not reach a URL.
    expect(selectedAvatarId('u-x', store({ 'prefs-cache:u-x:watchparty': prefsRow({ sprite: '  ' }) }))).toBeNull();
    // Someone else's malformed row. Not our failure to report: it means we do
    // not know this viewer's avatar.
    expect(selectedAvatarId('u-x', store({ 'prefs-cache:u-x:watchparty': 'not json' }))).toBeNull();
    expect(selectedAvatarId('u-x', store({ 'prefs-cache:u-x:watchparty': JSON.stringify({ blob: 'nope' }) }))).toBeNull();
    // No storage at all — a private window, or a browser with site data blocked.
    expect(selectedAvatarId('u-x', null)).toBeNull();
  });

  it('refuses the shared anon row while a session exists but nobody is named yet', () => {
    /*
     * `Yt()` in the same bundle:
     *
     *     function Yt() {
     *       if (!Rr()) return !1;      // no `hadoku_session_id` → read freely
     *       const e = Z();
     *       return !e || e === "public";
     *     }
     *
     * The anon row is shared by every user of the browser, so reading it while
     * signed in but unidentified hands one person the last person's choices.
     * Skipping this guard would be worse for us than for watchparty: they theme
     * a panel with it, and we POST it to a room, where wearing a housemate's
     * face is something everybody sees.
     */
    const anonRow = { 'prefs-cache:anon:watchparty': prefsRow({ sprite: 'rogue' }) };
    // No session: the anon row is this browser's own answer and is read.
    expect(selectedAvatarId(null, store(anonRow))).toBe('rogue');
    // Session present, identity not resolved yet: refused.
    expect(selectedAvatarId(null, store({ ...anonRow, hadoku_session_id: 's-1' }))).toBeNull();
    expect(selectedAvatarId('public', store({ ...anonRow, hadoku_session_id: 's-1' }))).toBeNull();
    // Session present AND named: their own row, so no reason to refuse.
    expect(
      selectedAvatarId(
        'u-carol',
        store({ ...anonRow, hadoku_session_id: 's-1', 'prefs-cache:u-carol:watchparty': prefsRow({ sprite: 'knight' }) }),
      ),
    ).toBe('knight');
  });
});
