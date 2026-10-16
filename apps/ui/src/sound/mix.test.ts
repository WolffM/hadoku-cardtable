import { describe, expect, it } from 'vitest';

import { isCellId, REVERSED_ROLES, SOUND_ROLES } from '@hadoku/shared';

import { createMixPlanner, DEFAULT_MIX, type MixSettings } from './mix.ts';
import { capturedGameScenario } from './captured.ts';
import { beatEvent, SCENARIOS } from './scenarios.ts';

const MIX: MixSettings = { bus: { ui: 0.5, game: 1, colour: 0.8, music: 0.35 }, opponent: 0.6, collapseMs: 80 };

function planner(cells: Record<string, string[]>, gains: Record<string, number> = {}) {
  const p = createMixPlanner(() => 0);
  p.setAssignments(cells, gains);
  return p;
}

describe('plan', () => {
  it('plays the role and layers the colour cell on top, each on its own bus', () => {
    const p = planner({ 'g.creature|play': ['a/take-1.ogg'], 'RG|creature': ['b/take-1.ogg'] }, { 'RG|creature': 1.5 });
    const r = p.plan({ role: 'g.creature', colourCell: 'RG|creature' }, 0, MIX);
    expect(r.voices).toEqual([
      { cell: 'g.creature|play', file: 'a/take-1.ogg', bus: 'game', gain: 1, duck: false },
      { cell: 'RG|creature', file: 'b/take-1.ogg', bus: 'colour', gain: 1.5 * 0.8, duck: false },
    ]);
  });

  it('a heavier hit is louder and lower: a point is quieter and a touch high, ten points a quarter louder and lower; no intensity, as recorded', () => {
    const p = planner({ 'g.damage|play': ['a/take-1.ogg'] });
    const light = p.plan({ role: 'g.damage', intensity: 0 }, 0, MIX).voices[0]!;
    const heavy = p.plan({ role: 'g.damage', intensity: 1 }, 1000, MIX).voices[0]!;
    const plain = p.plan({ role: 'g.damage' }, 2000, MIX).voices[0]!;
    expect([light.gain, light.rate]).toEqual([0.8, 1.06]);
    expect(heavy.gain).toBeCloseTo(1.25);
    expect(heavy.rate).toBeCloseTo(0.9);
    expect([plain.gain, plain.rate]).toEqual([1, undefined]);
  });

  it('an empty layer is reported and the other still plays', () => {
    const p = planner({ 'RG|creature': ['b/take-1.ogg'] });
    const r = p.plan({ role: 'g.creature', colourCell: 'RG|creature' }, 0, MIX);
    expect(r.voices.map((v) => v.cell)).toEqual(['RG|creature']);
    expect(r.skipped).toEqual([{ cell: 'g.creature|play', reason: 'empty' }]);
  });

  it("never plays the opponent's interface sounds, and plays their game sounds quieter", () => {
    const p = planner({ 'ui.hover-card|play': ['a/take-1.ogg'], 'g.draw|play': ['a/take-2.ogg'] });
    expect(p.plan({ role: 'ui.hover-card', seat: 'opp' }, 0, MIX)).toEqual({
      voices: [],
      skipped: [{ cell: 'ui.hover-card|play', reason: 'opponent-ui' }],
    });
    expect(p.plan({ role: 'g.draw', seat: 'opp' }, 0, MIX).voices[0]?.gain).toBeCloseTo(0.6);
  });

  it('collapses the same cell from the same seat inside the window, but not across seats', () => {
    const p = planner({ 'g.dies|play': ['a/take-1.ogg'] });
    expect(p.plan({ role: 'g.dies' }, 0, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'g.dies' }, 40, MIX).skipped).toEqual([{ cell: 'g.dies|play', reason: 'collapsed' }]);
    expect(p.plan({ role: 'g.dies', seat: 'opp' }, 40, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'g.dies' }, 90, MIX).voices).toHaveLength(1);
  });

  it('does not repeat the last take when a cell has several', () => {
    const p = planner({ 'g.draw|play': ['a/take-1.ogg', 'a/take-2.ogg'] });
    const files = [0, 100, 200, 300].map((t) => p.plan({ role: 'g.draw' }, t, DEFAULT_MIX).voices[0]?.file);
    for (let i = 1; i < files.length; i++) expect(files[i]).not.toBe(files[i - 1]);
  });

  it('plays Untap as the Tap cell backwards, collapsing only with another Untap', () => {
    const p = planner({ 'g.tap|play': ['a/take-1.ogg'] }, { 'g.tap|play': 0.5 });
    expect(p.plan({ role: 'g.tap' }, 0, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'g.untap' }, 10, MIX).voices).toEqual([
      { cell: 'g.tap|play', file: 'a/take-1.ogg', bus: 'game', gain: 0.5, duck: false, reverse: true },
    ]);
    expect(p.plan({ role: 'g.untap' }, 20, MIX).skipped).toEqual([{ cell: 'g.tap|play', reason: 'collapsed' }]);
  });

  it('plays a music role on the music bus', () => {
    const p = planner({ 'music.match|play': ['music-x/take-1.ogg'] });
    expect(p.plan({ role: 'music.match' }, 0, { ...MIX, bus: { ...MIX.bus, music: 0.3 } }).voices).toEqual([
      { cell: 'music.match|play', file: 'music-x/take-1.ogg', bus: 'music', gain: 0.3, duck: false },
    ]);
  });

  it('marks ducking roles', () => {
    const p = planner({ 'g.win|play': ['a/take-1.ogg'] });
    expect(p.plan({ role: 'g.win' }, 0, MIX).voices[0]?.duck).toBe(true);
  });
});

describe('SCENARIOS', () => {
  it('every beat names a real role, and its colour layer is a real cell', () => {
    for (const s of [...SCENARIOS, capturedGameScenario()]) {
      for (const b of s.beats) {
        expect(SOUND_ROLES.has(REVERSED_ROLES[b.role] ?? b.role), `${s.id}: ${b.role}`).toBe(true);
        const cell = beatEvent(b, { me: 'RG', opp: 'UB' }).colourCell;
        if (cell != null) expect(isCellId(cell), `${s.id}: ${cell}`).toBe(true);
      }
    }
  });

  it('the captured game plays a real stream: a creature resolving into its voice, a land with its type', () => {
    const beats = capturedGameScenario().beats;
    expect(beats.length).toBeGreaterThan(50);
    expect(beats).toContainEqual(expect.objectContaining({ role: 'g.creature', colourCell: 'R|creature' }));
    expect(beats).toContainEqual(expect.objectContaining({ role: 'g.land', colourCell: 'R|land' }));
  });

  it('a land beat is a mono seat’s basic land, and any other seat’s land', () => {
    const land = { at: 0, role: 'g.land', label: 'Land', layer: 'basic' as const };
    expect(beatEvent(land, { me: 'R', opp: 'UB' }).colourCell).toBe('R|basic');
    expect(beatEvent({ ...land, seat: 'opp' }, { me: 'R', opp: 'UB' }).colourCell).toBe('UB|land');
    expect(beatEvent(land, { me: 'C', opp: 'UB' }).colourCell).toBe('C|land');
  });

  it('an artifact beat is the colourless cell whatever the seat’s colours', () => {
    expect(beatEvent({ at: 0, role: 'g.enter', label: 'Artifact', layer: 'artifact' }, { me: 'RG', opp: 'UB' }).colourCell).toBe('C|artifact');
  });

  it('beats are in time order and ids are unique', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      for (let i = 1; i < s.beats.length; i++) expect(s.beats[i]!.at).toBeGreaterThanOrEqual(s.beats[i - 1]!.at);
    }
  });
});
