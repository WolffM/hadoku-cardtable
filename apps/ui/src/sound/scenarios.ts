/*
 * The sandbox's scripted scenarios: short stretches of a game, as beats.
 *
 * A beat is a role at a time, from a seat, optionally layered with that seat's
 * colour identity in one paradigm column. The sandbox picks the identities, so
 * one scenario auditions every colour. Times are milliseconds at speed 1.
 *
 * This file is data. Adding a scenario is adding an entry; nothing else needs
 * to know.
 */

import { rowHasParadigm, type ParadigmId } from '@hadoku/shared';

import type { Seat, SoundEvent } from './mix.ts';

export interface Beat {
  at: number;
  role: string;
  label: string;
  seat?: Seat;
  /** Layer the seat's colour identity in this column on top of the role. */
  layer?: ParadigmId;
  /** An exact colour cell instead, as a real card names one (`./captured.ts`). Wins over `layer`. */
  colourCell?: string | null;
}

export interface Scenario {
  id: string;
  name: string;
  beats: readonly Beat[];
}

export interface Identities {
  me: string;
  opp: string;
}

export function beatEvent(beat: Beat, identities: Identities): SoundEvent {
  const seat = beat.seat ?? 'me';
  const layer = beat.layer === 'basic' && !rowHasParadigm(identities[seat], 'basic') ? 'land' : beat.layer;
  // A land beat is the seat's basic land, which only a mono row has: any other row plays its `land`.
  // An artifact sounds the colourless row's whatever the seat's colours, as in a game (`play/live/sound-events.ts`).
  const row = layer !== undefined && !rowHasParadigm(identities[seat], layer) ? 'C' : identities[seat];
  const colourCell = beat.colourCell !== undefined ? beat.colourCell : layer === undefined ? null : `${row}|${layer}`;
  return { role: beat.role, colourCell, seat };
}

/** `n` beats of one role, `gap` ms apart, starting at `at`. */
function run(at: number, n: number, gap: number, beat: Omit<Beat, 'at'>): Beat[] {
  return Array.from({ length: n }, (_, i) => ({ ...beat, at: at + i * gap }));
}

/** Cast a creature: the quiet cast, the resolve, the creature's voice, then it lands. */
function creature(at: number, seat: Seat, name: string): Beat[] {
  return [
    { at, role: 'g.cast.creature', label: `Cast ${name}`, seat },
    { at: at + 800, role: 'g.resolve', label: 'Resolves', seat },
    { at: at + 860, role: 'g.creature', label: `${name} voice`, seat, layer: 'creature' },
    { at: at + 1250, role: 'g.enter', label: `${name} lands`, seat },
  ];
}

function sorted(beats: Beat[]): Beat[] {
  return beats.sort((a, b) => a.at - b.at);
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'opening',
    name: 'Opening hands',
    beats: sorted([
      { at: 0, role: 'g.match-start', label: 'Game start' },
      { at: 2000, role: 'g.game-start', label: 'Coin toss' },
      { at: 2900, role: 'g.shuffle', label: 'Shuffle' },
      { at: 3000, role: 'g.shuffle', label: 'Shuffle', seat: 'opp' },
      ...run(3700, 7, 120, { role: 'g.draw', label: 'Draw' }),
      ...run(3750, 7, 120, { role: 'g.draw', label: 'Draw', seat: 'opp' }),
      { at: 4900, role: 'ui.prompt', label: 'Keep or mulligan?' },
      { at: 5800, role: 'ui.select', label: 'Mulligan' },
      { at: 5850, role: 'g.mulligan', label: 'Mulligan' },
      { at: 6300, role: 'g.shuffle', label: 'Shuffle' },
      ...run(7000, 7, 120, { role: 'g.draw', label: 'Draw' }),
    ]),
  },
  {
    id: 'quiet-turn',
    name: 'A quiet turn',
    beats: sorted([
      { at: 0, role: 'g.turn-mine', label: 'Your turn' },
      ...run(600, 4, 90, { role: 'g.untap', label: 'Untap' }),
      { at: 1000, role: 'g.phase', label: 'Draw step' },
      { at: 1200, role: 'g.draw', label: 'Draw' },
      { at: 1700, role: 'g.phase', label: 'Main phase' },
      { at: 2100, role: 'ui.hover-card', label: 'Hover a land' },
      { at: 2400, role: 'ui.lift', label: 'Pick up the land' },
      { at: 2800, role: 'ui.place', label: 'Put it down' },
      { at: 2830, role: 'g.land', label: 'Play a land', layer: 'basic' },
      { at: 3400, role: 'g.tap', label: 'Tap a land' },
      { at: 3550, role: 'g.tap', label: 'Tap a land' },
      ...creature(3900, 'me', 'Creature'),
      { at: 6000, role: 'ui.pass', label: 'End turn' },
    ]),
  },
  {
    id: 'their-turn',
    name: 'Their turn',
    beats: sorted([
      ...run(600, 4, 90, { role: 'g.untap', label: 'Untap', seat: 'opp' }),
      { at: 1100, role: 'g.draw', label: 'Draw', seat: 'opp' },
      { at: 1900, role: 'g.land', label: 'Play a land', seat: 'opp', layer: 'basic' },
      ...creature(2600, 'opp', 'Creature'),
      { at: 4600, role: 'g.phase', label: 'Combat' },
      { at: 5000, role: 'g.attack', label: 'Attack', seat: 'opp' },
      { at: 5600, role: 'ui.prompt', label: 'Declare blockers?' },
      { at: 6400, role: 'ui.pass', label: 'No blocks' },
      { at: 6900, role: 'g.damage-player', label: 'You take damage', seat: 'opp' },
    ]),
  },
  {
    id: 'combat',
    name: 'Combat',
    beats: sorted([
      { at: 0, role: 'g.phase', label: 'Combat' },
      ...run(500, 3, 180, { role: 'g.attack', label: 'Attack' }),
      { at: 1500, role: 'g.block', label: 'Block', seat: 'opp' },
      { at: 1700, role: 'g.block', label: 'Block', seat: 'opp' },
      ...run(2500, 3, 20, { role: 'g.damage', label: 'Combat damage' }),
      ...run(2510, 2, 20, { role: 'g.damage', label: 'Combat damage', seat: 'opp' }),
      { at: 3000, role: 'g.dies', label: 'Their creature dies', seat: 'opp' },
      { at: 3050, role: 'g.dies', label: 'Your creature dies' },
      { at: 3400, role: 'g.damage-player', label: 'They take damage' },
      { at: 4100, role: 'g.phase', label: 'Second main' },
    ]),
  },
  {
    id: 'stack',
    name: 'Stack fight',
    beats: sorted([
      { at: 0, role: 'g.cast.sorcery', label: 'Cast a sorcery' },
      { at: 900, role: 'g.cast.instant', label: 'They respond', seat: 'opp' },
      { at: 1500, role: 'ui.prompt', label: 'Respond?' },
      { at: 2300, role: 'ui.target', label: 'Target their spell' },
      { at: 2400, role: 'g.cast.instant', label: 'Counterspell' },
      { at: 3200, role: 'g.ability', label: 'They activate', seat: 'opp' },
      { at: 4000, role: 'g.resolve', label: 'Ability resolves', seat: 'opp' },
      { at: 4700, role: 'g.resolve', label: 'Counterspell resolves' },
      { at: 4800, role: 'g.counter', label: 'Their instant is countered', seat: 'opp' },
      { at: 5600, role: 'g.resolve', label: 'Sorcery resolves', layer: 'spell' },
    ]),
  },
  {
    id: 'wipe',
    name: 'Board wipe',
    beats: sorted([
      { at: 0, role: 'g.cast.sorcery', label: 'They cast a wipe', seat: 'opp' },
      { at: 900, role: 'g.resolve', label: 'Resolves', seat: 'opp', layer: 'spell' },
      ...run(1000, 4, 15, { role: 'g.dies', label: 'Your creature dies' }),
      ...run(1010, 2, 15, { role: 'g.dies', label: 'Their creature dies', seat: 'opp' }),
      { at: 1050, role: 'g.destroy', label: 'Your artifact is destroyed' },
    ]),
  },
  {
    id: 'hover',
    name: 'Hover fatigue',
    beats: Array.from({ length: 70 }, (_, i) => ({
      at: i * 70 + Math.floor(i / 7) * 250,
      role: 'ui.hover-card',
      label: i % 7 === 6 ? 'Hover a button' : 'Hover a card',
    })),
  },
  {
    id: 'colour-tour',
    name: 'Colour tour',
    beats: sorted([
      { at: 0, role: 'g.land', label: 'Land', layer: 'basic' },
      ...creature(1000, 'me', 'Creature'),
      { at: 3200, role: 'g.cast.artifact', label: 'Cast an artifact' },
      { at: 4000, role: 'g.resolve', label: 'Resolves' },
      { at: 4060, role: 'g.enter', label: 'Artifact lands', layer: 'artifact' },
      { at: 5200, role: 'g.cast.artifact', label: 'Cast an artifact creature' },
      { at: 6000, role: 'g.resolve', label: 'Resolves' },
      { at: 6060, role: 'g.creature', label: 'Artifact creature voice', layer: 'artifact-creature' },
      { at: 6450, role: 'g.enter', label: 'It lands' },
      { at: 7600, role: 'g.cast.instant', label: 'Cast an instant' },
      { at: 8400, role: 'g.resolve', label: 'Instant resolves', layer: 'spell' },
    ]),
  },
  {
    id: 'endings',
    name: 'Endings',
    beats: [
      { at: 0, role: 'g.attack', label: 'Final attack' },
      { at: 700, role: 'g.damage-player', label: 'Lethal' },
      { at: 1300, role: 'g.win', label: 'Victory' },
      { at: 6000, role: 'g.damage-player', label: 'Lethal', seat: 'opp' },
      { at: 6600, role: 'g.lose', label: 'Defeat' },
    ],
  },
];
