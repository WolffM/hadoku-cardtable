/*
 * `mix.ts`'s own planner mechanics (the `plan` describe block this file used
 * to carry) moved to `@hadoku/ui-shell/sound`'s `mix.test.ts` (w92-C), proved
 * there against a synthetic registry — no Magic role or cell needed to pin
 * them. What stays here is specific to cardtable's actual role registry and
 * the scenario data nothing but this game holds: that every scripted beat
 * names a role `@hadoku/shared`'s `SOUND_ROLES` really has, and a real cell
 * grammar.
 */
import { describe, expect, it } from 'vitest';

import { isCellId, REVERSED_ROLES, SOUND_ROLES } from '@hadoku/shared';

import { capturedGameScenario } from './captured.ts';
import { beatEvent, SCENARIOS } from './scenarios.ts';

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
