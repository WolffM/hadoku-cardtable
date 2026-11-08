import { describe, expect, it } from 'vitest';

import { LookSchema, lookOrNone, sameLook } from './look.ts';
import { RoomMemberSchema } from './room-view.ts';
import { SeatIdentitySchema } from './match-wire.ts';

const PICTURE = 'https://cdn.discordapp.com/avatars/1/a.png';

describe('LookSchema', () => {
  it('keeps an https picture and well-formed cosmetics', () => {
    const look = { picture: PICTURE, cosmetics: { effect: 'effect.glint', overlay: 'overlay.crown', placement: { x: 1, y: 2, r: 3, s: 100, flip: false, back: true } } };
    expect(LookSchema.parse(look)).toEqual(look);
  });

  it('a bad field costs only itself', () => {
    expect(LookSchema.parse({ picture: 'http://cdn.hadoku.me/a.png', cosmetics: { effect: 'effect.glint' } })).toEqual({ cosmetics: { effect: 'effect.glint' } });
    expect(LookSchema.parse({ picture: PICTURE, cosmetics: { effect: '<script>', font: 'font.surf', placement: 'left' } })).toEqual({ picture: PICTURE, cosmetics: { font: 'font.surf' } });
    expect(LookSchema.parse({ picture: `https://x.test/${'a'.repeat(3000)}` })).toEqual({});
  });

  it('a member or a seat whose look does not read keeps everything else', () => {
    expect(RoomMemberSchema.parse({ id: 'fk:1', name: 'Ari', joinedAt: '', ready: true, avatarId: 'sage', look: 'nonsense' })).toEqual({ id: 'fk:1', name: 'Ari', joinedAt: '', ready: true, avatarId: 'sage' });
    expect(SeatIdentitySchema.parse({ seat: 0, claimed: true, playerId: 1, look: { picture: PICTURE } }).look).toEqual({ picture: PICTURE });
  });
});

describe('lookOrNone and sameLook', () => {
  it('an empty look is no look', () => {
    expect(lookOrNone({})).toBeUndefined();
    expect(lookOrNone({ cosmetics: {} })).toBeUndefined();
    expect(lookOrNone({ cosmetics: { effect: undefined } })).toBeUndefined();
    expect(lookOrNone(null)).toBeUndefined();
  });

  it('two copies of one look compare equal whatever their key order', () => {
    const placement = { x: 0, y: 0, r: 0, s: 100, flip: false, back: false };
    expect(sameLook({ picture: PICTURE, cosmetics: { overlay: 'overlay.halo', effect: 'effect.aura', placement } }, { cosmetics: { placement: { back: false, flip: false, s: 100, r: 0, y: 0, x: 0 }, effect: 'effect.aura', overlay: 'overlay.halo' }, picture: PICTURE })).toBe(true);
    expect(sameLook(undefined, {})).toBe(true);
    expect(sameLook({ picture: PICTURE }, undefined)).toBe(false);
  });
});
