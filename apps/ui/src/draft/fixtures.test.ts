/**
 * The fixtures are a contract with the draft engine, so they get tested like
 * one: every committed payload must satisfy the §B.5 envelope, and the checker
 * that says so must be able to fail.
 *
 * The second half matters more than the first. A validator that accepts
 * everything also accepts every fixture, and the repo has already been bitten
 * once by a gate that reported success while doing nothing. So each rule below
 * is mutation-tested — the fixture is broken on purpose and the checker is
 * required to notice, at the right JSON path.
 */

import { describe, expect, it } from 'vitest';

import { FIXTURES, loadFixtures, openingStream } from './fixtures.ts';
import { parseDraftView } from './validate.ts';
import type { DraftView } from './types.ts';

/** A deep copy, so a mutation in one test cannot reach another. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function errorsFor(mutate: (v: Record<string, unknown>) => void): string[] {
  const payload = clone(FIXTURES[0].raw) as Record<string, unknown>;
  mutate(payload);
  const result = parseDraftView(payload);
  if (result.ok) return [];
  return result.errors.map((e) => `${e.path}: ${e.message}`);
}

describe('committed fixtures', () => {
  it('there are five, and each names a real file', () => {
    expect(FIXTURES).toHaveLength(5);
    for (const f of FIXTURES) expect(f.file).toMatch(/^[a-z0-9-]+\.json$/);
  });

  it('every fixture satisfies the §B.5 envelope', () => {
    for (const fixture of FIXTURES) {
      const result = parseDraftView(fixture.raw);
      if (!result.ok) {
        throw new Error(
          `${fixture.file}:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });

  it('covers both viewer arms', () => {
    const kinds = loadFixtures().map((v) => v.viewer.kind);
    expect(kinds).toContain('seat');
    expect(kinds).toContain('spectator');
  });

  it('opens a full 15-card pack at pack 1 pick 1', () => {
    const [first] = openingStream();
    expect(first.packNumber).toBe(1);
    expect(first.pickNumber).toBe(1);
    expect(first.packSize).toBe(15);
    if (first.viewer.kind !== 'seat') throw new Error('fixture 1 must be a seat payload');
    expect(first.viewer.pack).toHaveLength(15);
    expect(first.viewer.pool).toHaveLength(0);
  });

  it('the opening stream is monotonic in seq and grows the pool by one a pick', () => {
    const stream = openingStream();
    expect(stream).toHaveLength(3);
    for (let i = 1; i < stream.length; i += 1) {
      expect(stream[i].seq).toBeGreaterThan(stream[i - 1].seq);
      expect(stream[i].pickNumber).toBe(stream[i - 1].pickNumber + 1);
    }
    const poolSizes = stream.map((v) => (v.viewer.kind === 'seat' ? v.viewer.pool.length : -1));
    expect(poolSizes).toEqual([0, 1, 2]);
  });

  it('a pack shrinks by one card per pick taken out of it', () => {
    const packs = openingStream().map((v) => (v.viewer.kind === 'seat' ? v.viewer.pack.length : -1));
    expect(packs).toEqual([15, 14, 13]);
  });

  it('models the second pack passing the other way', () => {
    const mid = loadFixtures().filter((v) => v.draftId === 'draft:fx-mid');
    expect(mid.length).toBeGreaterThan(0);
    for (const v of mid) {
      expect(v.packNumber).toBe(2);
      expect(v.passDirection).toBe('right');
    }
  });

  it('seats follow rooms-protocol: index is the SeatId, bot ids are positional', () => {
    for (const view of loadFixtures()) {
      view.seats.forEach((seat, i) => {
        expect(seat.id).toBe(i);
        if (seat.occupant?.kind === 'bot') expect(seat.occupant.botId).toBe(`bot:${i}`);
      });
      expect(view.seats.length).toBe(view.capacity);
    }
  });

  it('human participant ids carry a rooms-protocol tier prefix', () => {
    for (const view of loadFixtures()) {
      for (const seat of view.seats) {
        if (seat.occupant?.kind === 'human') {
          expect(seat.occupant.participantId).toMatch(/^(fk|dev|eph):/);
        }
      }
    }
  });

  it('no fixture contains an image reference of any kind (D13)', () => {
    const text = JSON.stringify(FIXTURES.map((f) => f.raw));
    expect(text).not.toMatch(/image|scryfall\.io|\.jpg|\.png/i);
  });
});

describe('the envelope checker actually bites', () => {
  it('rejects a card carrying an image field', () => {
    const errors = errorsFor((v) => {
      const viewer = v.viewer as { pack: Array<Record<string, unknown>> };
      viewer.pack[0].image_uris = { normal: 'https://cards.scryfall.io/normal/x.jpg' };
    });
    expect(errors.join('\n')).toMatch(/image reference \(D13\)/);
  });

  it('rejects a seat summary that carries cards', () => {
    const errors = errorsFor((v) => {
      const seats = v.seats as Array<Record<string, unknown>>;
      seats[4].pool = [{ cardId: 'x', name: 'Ancestral Recall' }];
    });
    expect(errors.join('\n')).toMatch(/\$\.seats\[4\]\.pool: a seat summary carries a count/);
  });

  it('rejects a spectator payload that grew a pack', () => {
    const errors = errorsFor((v) => {
      v.viewer = { kind: 'spectator', pack: [] };
    });
    expect(errors.join('\n')).toMatch(/\$\.viewer\.pack: a spectator payload carries no "pack"/);
  });

  it('rejects a bot id that is not positional', () => {
    const errors = errorsFor((v) => {
      const seats = v.seats as Array<{ occupant: { kind: string; botId: string } }>;
      seats[7].occupant = { kind: 'bot', botId: 'bot:lefty' };
    });
    expect(errors.join('\n')).toMatch(/bot ids are positional: expected bot:7/);
  });

  it('rejects seats[] whose index disagrees with its SeatId', () => {
    const errors = errorsFor((v) => {
      const seats = v.seats as Array<Record<string, unknown>>;
      seats[3].id = 5;
    });
    expect(errors.join('\n')).toMatch(/seats\[\] index IS the SeatId: expected 3, got 5/);
  });

  it('rejects a pool that disagrees with its own pickedCount', () => {
    const errors = errorsFor((v) => {
      const seats = v.seats as Array<Record<string, unknown>>;
      seats[0].pickedCount = 9;
    });
    expect(errors.join('\n')).toMatch(/pool has 0 cards but seats\[0\]\.pickedCount is 9/);
  });

  it('rejects the same physical card appearing twice', () => {
    const errors = errorsFor((v) => {
      const viewer = v.viewer as { pack: Array<Record<string, unknown>> };
      viewer.pack[1].cardId = viewer.pack[0].cardId;
    });
    expect(errors.join('\n')).toMatch(/duplicate cardId/);
  });

  it('rejects waitingOn naming a seat that does not exist', () => {
    const errors = errorsFor((v) => {
      (v.waitingOn as number[]).push(99);
    });
    expect(errors.join('\n')).toMatch(/seat 99 does not exist/);
  });

  it('rejects a non-monotonic seq floor and a zero pick number', () => {
    expect(errorsFor((v) => { v.seq = 0; }).join('\n')).toMatch(/\$\.seq: expected >= 1/);
    expect(errorsFor((v) => { v.pickNumber = 0; }).join('\n')).toMatch(/\$\.pickNumber: expected >= 1/);
  });

  it('reports every problem in one pass, not just the first', () => {
    const errors = errorsFor((v) => {
      v.seq = 0;
      v.pickNumber = 0;
      v.passDirection = 'sideways';
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts an unchanged fixture, so the mutations above are what failed', () => {
    const result = parseDraftView(clone(FIXTURES[0].raw) as DraftView);
    expect(result.ok).toBe(true);
  });
});
