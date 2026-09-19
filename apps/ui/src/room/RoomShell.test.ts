/*
 * The room wrapper's refusals.
 *
 * The interesting cases are all the ones where the room does NOT appear: a
 * table that will not draw because chat is unavailable is an outage, and a
 * room key we guessed is two unrelated groups sharing a chat.
 */
import { describe, expect, it } from 'vitest';

import { roomKeyFor } from './RoomShell.tsx';

describe('the room key for a pod or match', () => {
  it('prefixes ids watchparty will accept without provisioning', () => {
    expect(roomKeyFor('m-090bf01ba811')).toBe('cardtable-m-090bf01ba811');
    expect(roomKeyFor('e2e-two-friends')).toBe('cardtable-e2e-two-friends');
  });

  it('refuses rather than coerces, so two ids cannot collapse into one room', () => {
    // Uppercase is the live hazard: lowercasing "AB" and "ab" would put two
    // unrelated groups in one room, each reading the other's chat.
    expect(roomKeyFor('M-090BF01BA811')).toBeNull();
    expect(roomKeyFor('pod_1')).toBeNull();
    expect(roomKeyFor('pod 1')).toBeNull();
    expect(roomKeyFor('')).toBeNull();
  });

  it('refuses an id past watchparty\'s 40-character bound', () => {
    expect(roomKeyFor('a'.repeat(40))).toBe(`cardtable-${'a'.repeat(40)}`);
    expect(roomKeyFor('a'.repeat(41))).toBeNull();
  });
});
