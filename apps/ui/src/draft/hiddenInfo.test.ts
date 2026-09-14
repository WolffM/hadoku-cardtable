/**
 * The hidden-information split, asserted over whole serialised payloads.
 *
 * §B.5 says a spectator payload must never carry another seat's pool, and the
 * wave plan calls a fixture that leaks one a lane C bug "even though nothing
 * validates it yet". This is what validates it. It is a positional rule — the
 * only legal homes for a card are `viewer.pack` and `viewer.pool` — so it
 * catches a leak through a field nobody has thought of, which is the only kind
 * that ever actually happens.
 */

import { describe, expect, it } from 'vitest';

import { FIXTURES, loadFixtures } from './fixtures.ts';
import { assertNoLeakedCards, findCardPaths, findLeakedCardPaths } from './hiddenInfo.ts';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('no payload carries a seat another seat may not see', () => {
  it('every committed fixture is clean', () => {
    for (const fixture of FIXTURES) {
      expect(findLeakedCardPaths(fixture.raw), fixture.file).toEqual([]);
    }
  });

  it('the spectator payload carries no cards whatsoever', () => {
    const spectator = loadFixtures().find((v) => v.viewer.kind === 'spectator');
    if (!spectator) throw new Error('expected a spectator fixture');
    expect(findCardPaths(spectator)).toEqual([]);
    // It still carries the public counters — hiding cards must not hide the table.
    expect(spectator.seats).toHaveLength(8);
    expect(spectator.seats.every((s) => s.pickedCount === 19)).toBe(true);
  });

  it('the spectator and the seated payload agree on everything public', () => {
    const views = loadFixtures().filter((v) => v.draftId === 'draft:fx-mid');
    const seated = views.find((v) => v.viewer.kind === 'seat');
    const spectator = views.find((v) => v.viewer.kind === 'spectator');
    if (!seated || !spectator) throw new Error('fx-mid must ship both arms');

    expect(spectator.seq).toBe(seated.seq);
    expect(spectator.packNumber).toBe(seated.packNumber);
    expect(spectator.pickNumber).toBe(seated.pickNumber);
    expect(spectator.waitingOn).toEqual(seated.waitingOn);
    expect(spectator.seats).toEqual(seated.seats);
  });

  it('a seated payload holds cards only under viewer.pack and viewer.pool', () => {
    const seated = loadFixtures().find((v) => v.draftId === 'draft:fx-mid' && v.viewer.kind === 'seat');
    if (!seated) throw new Error('expected a seated fx-mid fixture');
    const paths = findCardPaths(seated);
    expect(paths).toHaveLength(30);
    for (const path of paths) {
      expect(path).toMatch(/^\$\.viewer\.(pack|pool)\[\d+\]$/);
    }
  });
});

describe('the leak detector actually bites', () => {
  it('catches a pool smuggled onto a seat summary', () => {
    const payload = clone(FIXTURES[0].raw) as { seats: Array<Record<string, unknown>> };
    payload.seats[2].pool = [{ cardId: 'leak-1', name: 'Ancestral Recall' }];
    expect(findLeakedCardPaths(payload)).toEqual(['$.seats[2].pool[0]']);
  });

  it('catches a card on a spectator payload', () => {
    const payload = clone(FIXTURES[4].raw) as Record<string, unknown>;
    payload.lastPick = { cardId: 'leak-2', name: 'Black Lotus' };
    expect(findLeakedCardPaths(payload)).toEqual(['$.lastPick']);
  });

  it('catches a leak nested arbitrarily deep, which is the point of walking', () => {
    const payload = clone(FIXTURES[0].raw) as Record<string, unknown>;
    payload.debug = { rooms: [{ pods: [{ opponentPools: [[{ cardId: 'x', name: 'Timetwister' }]] }] }] };
    expect(findLeakedCardPaths(payload)).toEqual([
      '$.debug.rooms[0].pods[0].opponentPools[0][0]',
    ]);
  });

  it('assertNoLeakedCards throws with the path, and stays quiet when clean', () => {
    const payload = clone(FIXTURES[0].raw) as { seats: Array<Record<string, unknown>> };
    payload.seats[6].picked = [{ cardId: 'leak-3', name: 'Mox Sapphire' }];
    expect(() => assertNoLeakedCards(payload, 'mutated')).toThrow(/\$\.seats\[6\]\.picked\[0\]/);
    expect(() => assertNoLeakedCards(FIXTURES[0].raw, 'seat0-pack1-pick1.json')).not.toThrow();
  });
});
