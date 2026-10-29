/*
 * The Discord chat's pure layout (`./discordChat.ts`).
 */
import { describe, expect, it } from 'vitest';

import { AVATAR_COLOURS, avatarColour, avatarInitial, discordTime, groupMessages } from './discordChat.ts';

describe('groupMessages', () => {
  it('runs of one author within seven minutes share a header', () => {
    const groups = groupMessages([
      { author: 'alice', text: 'a', at: '2026-10-28T12:00:00Z' },
      { author: 'alice', text: 'b', at: '2026-10-28T12:06:00Z' },
      { author: 'bob', text: 'c', at: '2026-10-28T12:07:00Z' },
      { author: 'bob', text: 'd', at: '2026-10-28T12:20:00Z' },
    ]);
    expect(groups).toEqual([
      { author: 'alice', at: '2026-10-28T12:00:00Z', texts: ['a', 'b'] },
      { author: 'bob', at: '2026-10-28T12:07:00Z', texts: ['c'] },
      { author: 'bob', at: '2026-10-28T12:20:00Z', texts: ['d'] },
    ]);
  });
});

describe('discordTime', () => {
  const now = new Date(2026, 9, 28, 18, 0);
  it('words today, yesterday and older the way Discord does', () => {
    expect(discordTime(new Date(2026, 9, 28, 15, 14).toISOString(), now, 'en-US')).toBe('Today at 3:14 PM');
    expect(discordTime(new Date(2026, 9, 27, 23, 5).toISOString(), now, 'en-US')).toBe('Yesterday at 11:05 PM');
    expect(discordTime(new Date(2026, 9, 20, 9, 0).toISOString(), now, 'en-US')).toBe('10/20/2026 9:00 AM');
  });
  it('a malformed time shows nothing', () => {
    expect(discordTime('not a time', now)).toBe('');
  });
});

describe('avatars', () => {
  it('one author always gets the same colour, inside the palette', () => {
    expect(avatarColour('Hadoku')).toBe(avatarColour('Hadoku'));
    for (const name of ['a', 'Hadoku', 'someone else', '']) {
      expect(avatarColour(name)).toBeGreaterThanOrEqual(0);
      expect(avatarColour(name)).toBeLessThan(AVATAR_COLOURS);
    }
  });
  it('the initial is the first letter or digit', () => {
    expect(avatarInitial('hadoku')).toBe('H');
    expect(avatarInitial('_.9lives')).toBe('9');
    expect(avatarInitial('***')).toBe('?');
  });
});
