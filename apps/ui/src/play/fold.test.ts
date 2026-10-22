/**
 * The fold and the adapter, against the spike's COMMITTED captures.
 *
 * `scripts/spike/tierc/out/sample-newobjects.json` and `sample-delta.json` are
 * the two packets Wave 7 committed: the opening sync (truncated to 3 objects,
 * with `"_omitted": 240`) and the first small mid-game delta of the same run.
 * They are not a contiguous stream — seq 1 then seq 8 — so this file uses them
 * for what they are good for: proving the reader accepts the shape exactly as
 * committed, and exercising Forge's fold rules on real values.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';

import { manaCostTokens, toBoardView } from './adapter.ts';
import { foldPackets, type FoldablePacket } from './fold.ts';
import { expectWirePackets } from './wire.ts';
import { loadPackets, PLAY_FIXTURES } from './fixtures.ts';

/** The spike writes a `// DeltaPacket[...]` header line above the JSON. */
function committedSample(name: string): unknown {
  const text = readFileSync(new URL(`../../../../scripts/spike/tierc/out/${name}`, import.meta.url), 'utf8');
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
}

const [opening, delta] = expectWirePackets(
  [committedSample('sample-newobjects.json'), committedSample('sample-delta.json')],
  'committed samples',
);

describe('the committed opening sync', () => {
  it('folds into two players at 20 life, hands and libraries as dealt', () => {
    const { state, seq } = foldPackets([opening!]);
    const view = toBoardView(state, seq, { viewerPlayerId: 0 });
    expect(seq).toBe(1);
    expect(view.players.map((p) => [p.name, p.life, p.handCount, p.libraryCount])).toEqual([
      ['Bob (Capturing)', 20, 7, 53],
      // Alice's opening hand is 2 with 58 in library in this sample — as
      // captured; read off the file, not assumed to be seven.
      ['Alice (Host AI)', 20, 2, 58],
    ]);
    expect(view.phase).toBeNull();
    expect(view.phaseLabel).toBe('Not started');
    // The sample kept 3 objects of 243, so the viewer's hand ids name cards
    // that never arrived — reported, not invented.
    expect(view.missingCardIds).toHaveLength(7);
  });
});

describe("Forge's fold rules, on the committed delta", () => {
  const { state, skippedDeltas } = foldPackets([opening!, delta!]);
  const game = state.get(deltaKey(DELTA_TYPE.game, 1))!;
  const bob = state.get(deltaKey(DELTA_TYPE.player, 0))!;
  const alice = state.get(deltaKey(DELTA_TYPE.player, 1))!;

  it('merges a delta into an existing object', () => {
    expect(game.Turn).toEqual({ t: 'int', v: 4 });
    expect(game.PlayerTurn).toEqual({ t: 'int', v: 0 });
    // Untouched by the delta, so still the opening sync's value.
    expect(game.Title).toEqual({ t: 'str', v: 'Bob (Capturing) vs Alice (Host AI) (0-0)' });
    expect(alice.HasPriority).toEqual({ t: 'bool', v: true });
  });

  it('treats null as "back to the default" and removes the property', () => {
    // The delta carries `"CombatView": null` and `"HasPriority": null`.
    expect('CombatView' in game).toBe(false);
    expect('HasPriority' in bob).toBe(false);
  });

  it('skips a delta for an object it never saw, and counts it', () => {
    // Card 3's `Sickness: null` — card 3 is one of the 240 omitted objects.
    expect(state.has(deltaKey(DELTA_TYPE.card, 3))).toBe(false);
    expect(skippedDeltas).toBe(1);
  });

  it('adapts the phase through our own label', () => {
    const view = toBoardView(state, 8, { viewerPlayerId: 0 });
    expect(view.phase).toBe('DRAW');
    expect(view.phaseLabel).toBe('Draw');
    expect(view.turn).toBe(4);
    expect(view.players.find((p) => p.id === 1)!.hasPriority).toBe(true);
    expect(view.players.find((p) => p.id === 0)!.hasPriority).toBe(false);
  });
});

describe('newObjects replace rather than merge', () => {
  it('drops properties an earlier sync set and a later one did not', () => {
    // Real objects from the committed fixture: the opening sync's Bob, then
    // the same player re-sent with a smaller bag.
    const [first] = loadPackets(PLAY_FIXTURES[0]!);
    const key = deltaKey(DELTA_TYPE.player, 0);
    const bob = first!.newObjects[key]!;
    const resent = { ...first!, seq: 2, newObjects: { [key]: { _type: bob._type, _id: bob._id, Life: bob.Life! } }, objectDeltas: {} };
    const { state } = foldPackets([first!, resent]);
    expect(Object.keys(state.get(key)!).sort()).toEqual(['Life', '_id', '_type']);
  });
});

describe('the committed fixture', () => {
  it('folds cleanly: every delta lands on an object the stream created', () => {
    const { seq, skippedDeltas } = foldPackets(loadPackets(PLAY_FIXTURES[0]!));
    expect(seq).toBe(27);
    expect(skippedDeltas).toBe(0);
  });

  it('refuses an object whose _type/_id do not match its delta key, naming the path', () => {
    const packets = structuredClone(PLAY_FIXTURES[0]!.raw) as { newObjects: Record<string, { _id: number }> }[];
    packets[0]!.newObjects[deltaKey(DELTA_TYPE.game, 1)]!._id = 2;
    expect(() => expectWirePackets(packets, 'mutated')).toThrow(
      'mutated[0].newObjects["805306369"]: _type 3 / _id 2 do not encode to this delta key',
    );
  });
});

describe('stackTargetSpells (wave 49 §A)', () => {
  it('is empty before any packet carries it', () => {
    const { stackTargetSpells } = foldPackets([opening!]);
    expect(stackTargetSpells.size).toBe(0);
  });

  it('replaces the snapshot on each packet that carries it, never merges', () => {
    const first = { ...opening!, stackTargetSpells: [[50, 49]] } satisfies FoldablePacket;
    const second = { ...delta!, stackTargetSpells: [[12, 7]] } satisfies FoldablePacket;
    const { stackTargetSpells } = foldPackets([first, second]);
    expect([...stackTargetSpells]).toEqual([[12, 7]]);
  });

  it('a packet that does not carry the field leaves the last snapshot untouched', () => {
    const first = { ...opening!, stackTargetSpells: [[50, 49]] } satisfies FoldablePacket;
    // `delta` itself carries no `stackTargetSpells` at all (every packet
    // before wave 49, and the committed spike samples among them).
    const { stackTargetSpells } = foldPackets([first, delta!]);
    expect([...stackTargetSpells]).toEqual([[50, 49]]);
  });

  it('an explicit empty array clears it, same as `newObjects` replacing a bag', () => {
    const first = { ...opening!, stackTargetSpells: [[50, 49]] } satisfies FoldablePacket;
    const cleared = { ...delta!, stackTargetSpells: [] } satisfies FoldablePacket;
    const { stackTargetSpells } = foldPackets([first, cleared]);
    expect(stackTargetSpells.size).toBe(0);
  });
});

describe('cantBlock', () => {
  it('is empty before any packet carries it, replaced by each that does, kept by one that does not', () => {
    expect(foldPackets([opening!]).cantBlock.size).toBe(0);
    const first = { ...opening!, cantBlock: [87, 88] };
    expect([...foldPackets([first, { ...delta!, cantBlock: [91] }]).cantBlock]).toEqual([91]);
    expect([...foldPackets([first, delta!]).cantBlock]).toEqual([87, 88]);
    expect(foldPackets([first, { ...delta!, cantBlock: [] }]).cantBlock.size).toBe(0);
  });
});

describe('printedTypes', () => {
  it('is empty before any packet carries it, replaced by each that does, kept by one that does not', () => {
    const land = { t: 'cardtype' as const, sup: [], core: ['Land'], sub: [], all: false, exc: [] };
    expect(foldPackets([opening!]).printedTypes.size).toBe(0);
    const first = { ...opening!, printedTypes: [[87, land, false]] } satisfies FoldablePacket;
    expect([...foldPackets([first, { ...delta!, printedTypes: [[91, land, true]] } satisfies FoldablePacket]).printedTypes.keys()]).toEqual([91]);
    expect(foldPackets([first, delta!]).printedTypes.get(87)).toEqual({ type: land, token: false });
    expect(foldPackets([first, { ...delta!, printedTypes: [] }]).printedTypes.size).toBe(0);
  });
});

describe('printedPT', () => {
  it('is empty before any packet carries it, replaced by each that does, kept by one that does not', () => {
    expect(foldPackets([opening!]).printedPT.size).toBe(0);
    const first = { ...opening!, printedPT: [[87, 2, 2]] } satisfies FoldablePacket;
    expect([...foldPackets([first, { ...delta!, printedPT: [[91, 1, 1]] } satisfies FoldablePacket]).printedPT.keys()]).toEqual([91]);
    expect(foldPackets([first, delta!]).printedPT.get(87)).toEqual({ power: 2, toughness: 2 });
    expect(foldPackets([first, { ...delta!, printedPT: [] }]).printedPT.size).toBe(0);
  });
});

describe('conditionMet', () => {
  it('is empty before any packet carries it, replaced by each that does, kept by one that does not', () => {
    expect(foldPackets([opening!]).conditionMet.size).toBe(0);
    const first = { ...opening!, conditionMet: [87, 88] };
    expect([...foldPackets([first, { ...delta!, conditionMet: [91] }]).conditionMet]).toEqual([91]);
    expect([...foldPackets([first, delta!]).conditionMet]).toEqual([87, 88]);
    expect(foldPackets([first, { ...delta!, conditionMet: [] }]).conditionMet.size).toBe(0);
  });
});

describe('mana costs', () => {
  it('reads ManaCost.serialize output into our pip tokens', () => {
    expect(manaCostTokens('3\u0006BLUE\u0006BLUE\u0006BLACK\u0006BLACK')).toEqual({
      tokens: ['3', 'U', 'U', 'B', 'B'],
      manaValue: 7,
    });
    expect(manaCostTokens('0\u0006RED').tokens).toEqual(['R']);
    expect(manaCostTokens('4').tokens).toEqual(['4']);
    expect(manaCostTokens('0').tokens).toEqual(['0']);
    expect(manaCostTokens('-1').tokens).toEqual([]);
    expect(manaCostTokens('1\u0006W2\u0006BP\u0006X')).toEqual({ tokens: ['1', '2/W', 'B/P', 'X'], manaValue: 4 });
  });
});
