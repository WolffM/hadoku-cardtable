import { ROOM_NAME_MAX } from '@hadoku/shared';
import { describe, expect, it } from 'vitest';

import { defaultRoomName, ROOM_WORDS } from './roomName.ts';

describe('defaultRoomName', () => {
  it('is "<name>\'s <word>", the word picked by the random draw', () => {
    expect(defaultRoomName('Alice', () => 0)).toBe(`Alice's ${ROOM_WORDS[0]}`);
    expect(defaultRoomName('Alice', () => 0.999_999)).toBe(`Alice's ${ROOM_WORDS.at(-1)}`);
    const mid = defaultRoomName('Bo', () => 0.5);
    expect(ROOM_WORDS.map((w) => `Bo's ${w}`)).toContain(mid);
  });

  it("adds 's to a name ending in s like any other", () => {
    expect(defaultRoomName('James', () => 0)).toBe(`James's ${ROOM_WORDS[0]}`);
  });

  it('is just the word when no name is known', () => {
    for (const none of [null, undefined, '', '   ']) expect(defaultRoomName(none, () => 0)).toBe(ROOM_WORDS[0]);
  });

  it('never runs past the room name limit', () => {
    expect(defaultRoomName('x'.repeat(ROOM_NAME_MAX), () => 0)).toHaveLength(ROOM_NAME_MAX);
  });

  it('draws from about fifty single Title Case words, none repeated', () => {
    expect(ROOM_WORDS.length).toBeGreaterThanOrEqual(45);
    expect(ROOM_WORDS.length).toBeLessThanOrEqual(55);
    expect(new Set(ROOM_WORDS).size).toBe(ROOM_WORDS.length);
    for (const w of ROOM_WORDS) expect(w).toMatch(/^[A-Z][a-z]+$/);
  });
});
