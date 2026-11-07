// @vitest-environment jsdom
/*
 * The planner's mechanics, against a synthetic registry — no real role or
 * cell grammar needed to pin them. A game's own role names and layer cells
 * (Magic's colour matrix, say) are proved by that game's own tests against
 * its own registry (cardtable's: `apps/ui/src/sound/mix.test.ts`'s
 * `SCENARIOS` block, which checks every scripted beat against the real
 * role registry).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureSoundRoles, createMixPlanner, DEFAULT_MIX, type MixSettings, type RoleRegistry } from './mix.ts';

const MIX: MixSettings = { bus: { ui: 0.5, game: 1, colour: 0.8, music: 0.35 }, opponent: 0.6, collapseMs: 80 };

/** A small synthetic registry covering every mechanic the planner has to get right. */
const REGISTRY: RoleRegistry = {
  roles: new Map([
    ['cue.ui', { bus: 'ui' as const }],
    ['cue.a', { bus: 'game' as const }],
    ['cue.b', { bus: 'game' as const }],
    ['cue.tap', { bus: 'game' as const }],
    ['cue.win', { bus: 'game' as const, duck: true }],
    ['cue.music', { bus: 'music' as const }],
    ['cue.tier-1', { bus: 'game' as const }],
    ['cue.tier-2', { bus: 'game' as const }],
    ['cue.tier-3', { bus: 'game' as const }],
  ]),
  fallback: { 'cue.tier-3': 'cue.tier-2', 'cue.tier-2': 'cue.tier-1' },
  reversed: { 'cue.untap': 'cue.tap' },
};

function planner(cells: Record<string, string[]>, gains: Record<string, number> = {}) {
  configureSoundRoles(REGISTRY);
  const p = createMixPlanner(() => 0);
  p.setAssignments(cells, gains);
  return p;
}

afterEach(() => {
  configureSoundRoles({ roles: new Map(), fallback: {}, reversed: {} });
});

describe('plan', () => {
  it('plays the role and layers the cell on top, each on its own bus', () => {
    const p = planner({ 'cue.a|play': ['a/take-1.ogg'], 'layer-x': ['b/take-1.ogg'] }, { 'layer-x': 1.5 });
    const r = p.plan({ role: 'cue.a', colourCell: 'layer-x' }, 0, MIX);
    expect(r.voices).toEqual([
      { cell: 'cue.a|play', file: 'a/take-1.ogg', bus: 'game', gain: 1, duck: false },
      { cell: 'layer-x', file: 'b/take-1.ogg', bus: 'colour', gain: 1.5 * 0.8, duck: false },
    ]);
  });

  it('a heavier hit is louder and lower; no intensity, as recorded', () => {
    const p = planner({ 'cue.a|play': ['a/take-1.ogg'] });
    const light = p.plan({ role: 'cue.a', intensity: 0 }, 0, MIX).voices[0]!;
    const heavy = p.plan({ role: 'cue.a', intensity: 1 }, 1000, MIX).voices[0]!;
    const plain = p.plan({ role: 'cue.a' }, 2000, MIX).voices[0]!;
    expect([light.gain, light.rate]).toEqual([0.8, 1.06]);
    expect(heavy.gain).toBeCloseTo(1.25);
    expect(heavy.rate).toBeCloseTo(0.9);
    expect([plain.gain, plain.rate]).toEqual([1, undefined]);
  });

  it('an empty layer is reported and the other still plays', () => {
    const p = planner({ 'layer-x': ['b/take-1.ogg'] });
    const r = p.plan({ role: 'cue.a', colourCell: 'layer-x' }, 0, MIX);
    expect(r.voices.map((v) => v.cell)).toEqual(['layer-x']);
    expect(r.skipped).toEqual([{ cell: 'cue.a|play', reason: 'empty' }]);
  });

  it("never plays the opponent's interface sounds, and plays their game sounds quieter", () => {
    const p = planner({ 'cue.ui|play': ['a/take-1.ogg'], 'cue.a|play': ['a/take-2.ogg'] });
    expect(p.plan({ role: 'cue.ui', seat: 'opp' }, 0, MIX)).toEqual({ voices: [], skipped: [{ cell: 'cue.ui|play', reason: 'opponent-ui' }] });
    expect(p.plan({ role: 'cue.a', seat: 'opp' }, 0, MIX).voices[0]?.gain).toBeCloseTo(0.6);
  });

  it('collapses the same cell from the same seat inside the window, but not across seats', () => {
    const p = planner({ 'cue.a|play': ['a/take-1.ogg'] });
    expect(p.plan({ role: 'cue.a' }, 0, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'cue.a' }, 40, MIX).skipped).toEqual([{ cell: 'cue.a|play', reason: 'collapsed' }]);
    expect(p.plan({ role: 'cue.a', seat: 'opp' }, 40, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'cue.a' }, 90, MIX).voices).toHaveLength(1);
  });

  it('does not repeat the last take when a cell has several', () => {
    const p = planner({ 'cue.a|play': ['a/take-1.ogg', 'a/take-2.ogg'] });
    const files = [0, 100, 200, 300].map((t) => p.plan({ role: 'cue.a' }, t, DEFAULT_MIX).voices[0]?.file);
    for (let i = 1; i < files.length; i++) expect(files[i]).not.toBe(files[i - 1]);
  });

  it("plays the registry's reversed role as the target role's cell backwards, collapsing only with another of itself", () => {
    const p = planner({ 'cue.tap|play': ['a/take-1.ogg'] }, { 'cue.tap|play': 0.5 });
    expect(p.plan({ role: 'cue.tap' }, 0, MIX).voices).toHaveLength(1);
    expect(p.plan({ role: 'cue.untap' }, 10, MIX).voices).toEqual([
      { cell: 'cue.tap|play', file: 'a/take-1.ogg', bus: 'game', gain: 0.5, duck: false, reverse: true },
    ]);
    expect(p.plan({ role: 'cue.untap' }, 20, MIX).skipped).toEqual([{ cell: 'cue.tap|play', reason: 'collapsed' }]);
  });

  it('an empty tier plays the nearest filled tier below it, down the fallback chain; each collapses as itself', () => {
    const p = planner({ 'cue.tier-1|play': ['t1/take-1.ogg'] });
    expect(p.plan({ role: 'cue.tier-3' }, 0, MIX).voices.map((v) => v.cell)).toEqual(['cue.tier-1|play']);
    expect(p.plan({ role: 'cue.tier-2' }, 0, MIX).voices.map((v) => v.cell)).toEqual(['cue.tier-1|play']);
    expect(planner({}).plan({ role: 'cue.tier-1' }, 0, MIX).skipped).toEqual([{ cell: 'cue.tier-1|play', reason: 'empty' }]);
  });

  it('plays a music role on the music bus', () => {
    const p = planner({ 'cue.music|play': ['music-x/take-1.ogg'] });
    expect(p.plan({ role: 'cue.music' }, 0, { ...MIX, bus: { ...MIX.bus, music: 0.3 } }).voices).toEqual([
      { cell: 'cue.music|play', file: 'music-x/take-1.ogg', bus: 'music', gain: 0.3, duck: false },
    ]);
  });

  it('marks ducking roles', () => {
    const p = planner({ 'cue.win|play': ['a/take-1.ogg'] });
    expect(p.plan({ role: 'cue.win' }, 0, MIX).voices[0]?.duck).toBe(true);
  });

  it('a role outside the registry is refused at runtime: no voice planned for it', () => {
    const p = planner({ 'cue.a|play': ['a/take-1.ogg'] });
    expect(p.plan({ role: 'never-registered' }, 0, MIX)).toEqual({ voices: [], skipped: [{ cell: 'never-registered|play', reason: 'unknown-role' }] });
  });
});

describe('createMixPlanner (the ambient/zero-argument form)', () => {
  it('plans nothing until something configures a registry, and the game’s own once it does', () => {
    configureSoundRoles({ roles: new Map(), fallback: {}, reversed: {} });
    const bare = createMixPlanner();
    bare.setAssignments({ 'cue.a|play': ['a/take-1.ogg'] }, {});
    expect(bare.plan({ role: 'cue.a' }, 0, DEFAULT_MIX).skipped).toEqual([{ cell: 'cue.a|play', reason: 'unknown-role' }]);

    configureSoundRoles(REGISTRY);
    const configured = createMixPlanner();
    configured.setAssignments({ 'cue.a|play': ['a/take-1.ogg'] }, {});
    expect(configured.plan({ role: 'cue.a' }, 0, DEFAULT_MIX).voices).toHaveLength(1);
  });
});

describe('a role outside the registry plays nothing: the runtime half, with no audio node ever built', () => {
  it('never reaches the AudioContext constructor', async () => {
    const { createMixer } = await import('./mixer.ts');
    configureSoundRoles(REGISTRY);
    const p = createMixPlanner(() => 0);
    p.setAssignments({ 'cue.a|play': ['a/take-1.ogg'] }, {});
    const ctorSpy = vi.fn();
    vi.stubGlobal('AudioContext', ctorSpy);
    const mixer = createMixer(() => '/x', p);
    const result = mixer.play({ role: 'not-a-real-role' });
    expect(result.voices).toEqual([]);
    expect(ctorSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
