/*
 * The watchparty avatar seam.
 *
 * `avatarSquareUrl`'s convention (`square_<id>.png` under the chrome's own
 * `serverOrigin`) is watchparty's media layout, not a typed contract —
 * `docs/requests/WATCHPARTY_AVATAR_ACCESSOR.md` is the standing ask for one —
 * so this pins our own rules (an empty id is never a URL) and the derivation,
 * so a change to the convention fails here rather than silently drawing
 * nobody's face.
 */

import { describe, expect, it } from 'vitest';

import { AVATAR_ID_MAX } from '@hadoku/shared';
import { avatarSquareUrl, normalizeAvatarId } from './avatar.ts';

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
  it('is watchparty’s own square_<id>.png under the origin their chrome is given', () => {
    expect(avatarSquareUrl('wanderer', ORIGIN)).toBe(`${ORIGIN}/media/sprites/square_wanderer.png`);
    // A trailing slash on the origin does not double up.
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
