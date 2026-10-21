/*
 * Gauntlet — the view of a Constructed room's Gauntlet that the server sends
 * and the room screen draws (`docs/planning/constructed-modes-plan.md`).
 *
 * A Gauntlet is a best-of-three over ten library decks of one era: the two
 * seats ban and pick from them in a fixed snake ({@link GAUNTLET_SNAKE}), then
 * before every game each secretly chooses one of their own unplayed picks and
 * both choices are revealed together. Each deck is played once; nothing is
 * sideboarded.
 *
 * The view is per viewer: `choice.mine` is the viewer's own pending choice and
 * nobody else's. Until both seats have chosen, the other seat's choice crosses
 * the wire only as `choice.chosen[seat] === true`; a watcher sees neither.
 *
 * Seats are the room table's seats, 0 and 1. P1 and P2 are the coin flip's:
 * `first` names the table seat that is P1, and every step already says which
 * table seat acts, so a reader never maps P1/P2 itself.
 */

import { z } from 'zod';

import { ManaColorSchema } from './draft.ts';

export const GAUNTLET_PHASES = ['options', 'reveal', 'banpick', 'choose', 'playing', 'done'] as const;
export const GauntletPhaseSchema = z.enum(GAUNTLET_PHASES);
export type GauntletPhase = z.infer<typeof GauntletPhaseSchema>;

/** How many decks a Gauntlet is drawn with, and the fewest an era must hold to be offered. */
export const GAUNTLET_DECKS = 10;

/**
 * How long the reveal plays, from `revealAt`: the server opens the first ban
 * this long after the draw, and the screen fits its animation inside it.
 */
export const GAUNTLET_REVEAL_MS = 6000;

export const GauntletSeatIndexSchema = z.union([z.literal(0), z.literal(1)]);
export type GauntletSeatIndex = z.infer<typeof GauntletSeatIndexSchema>;

export const GAUNTLET_ACTS = ['ban', 'pick'] as const;
export const GauntletActSchema = z.enum(GAUNTLET_ACTS);
export type GauntletAct = z.infer<typeof GauntletActSchema>;

/**
 * The ban/pick order, by coin-flip player: P1 ban, P2 ban · P1 picks 1, P2
 * picks 2 · P2 ban, P1 ban · P1 picks 2, P2 picks 1. Four bans and six picks,
 * three each.
 */
export const GAUNTLET_SNAKE: readonly { readonly player: 'p1' | 'p2'; readonly act: GauntletAct; readonly count: number }[] = [
  { player: 'p1', act: 'ban', count: 1 },
  { player: 'p2', act: 'ban', count: 1 },
  { player: 'p1', act: 'pick', count: 1 },
  { player: 'p2', act: 'pick', count: 2 },
  { player: 'p2', act: 'ban', count: 1 },
  { player: 'p1', act: 'ban', count: 1 },
  { player: 'p1', act: 'pick', count: 2 },
  { player: 'p2', act: 'pick', count: 1 },
];

/** One line of a deck's list, as `GET /api/tables/decks` sends it. */
export const GauntletDeckLineSchema = z.strictObject({
  count: z.number().int().min(1),
  name: z.string().min(1),
});
export type GauntletDeckLine = z.infer<typeof GauntletDeckLineSchema>;

export const GAUNTLET_DECK_STATUSES = ['open', 'banned', 'picked'] as const;
export const GauntletDeckStatusSchema = z.enum(GAUNTLET_DECK_STATUSES);
export type GauntletDeckStatus = z.infer<typeof GauntletDeckStatusSchema>;

/**
 * One of the ten decks: what the room's deck tile and its peek draw (the
 * library deck's own fields, colours folded on the server), and where it
 * stands. `by` is the seat that banned or picked it, `null` while open.
 * `played` is true once the deck has been revealed for a game.
 */
export const GauntletDeckSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  archetype: z.string(),
  pilot: z.string(),
  colors: z.array(ManaColorSchema).max(5),
  main: z.array(GauntletDeckLineSchema),
  sideboard: z.array(GauntletDeckLineSchema),
  status: GauntletDeckStatusSchema,
  by: GauntletSeatIndexSchema.nullable(),
  played: z.boolean(),
});
export type GauntletDeck = z.infer<typeof GauntletDeckSchema>;

/** The drawn era. `title` is what the reveal lands first ("Modern — 2022"). */
export const GauntletEraSchema = z.strictObject({
  id: z.string().min(1),
  family: z.string().min(1),
  title: z.string().min(1),
});
export type GauntletEra = z.infer<typeof GauntletEraSchema>;

/** A seat of the Gauntlet. `memberId` is null for the AI. */
export const GauntletPlayerSchema = z.strictObject({
  memberId: z.string().min(1).nullable(),
  name: z.string(),
});
export type GauntletPlayer = z.infer<typeof GauntletPlayerSchema>;

/**
 * The step under way in `banpick`: `index` into {@link GAUNTLET_SNAKE}, the
 * table seat that acts, what it does, how many decks the step takes, and how
 * many it has taken so far.
 */
export const GauntletStepSchema = z.strictObject({
  index: z.number().int().min(0),
  seat: GauntletSeatIndexSchema,
  act: GauntletActSchema,
  count: z.number().int().min(1),
  taken: z.number().int().min(0),
});
export type GauntletStep = z.infer<typeof GauntletStepSchema>;

/** A game whose decks have been revealed, by table seat, and the seat that won it once it is over. */
export const GauntletGameSchema = z.strictObject({
  decks: z.tuple([z.string().min(1), z.string().min(1)]),
  winner: GauntletSeatIndexSchema.nullable(),
});
export type GauntletGame = z.infer<typeof GauntletGameSchema>;

/**
 * The hidden choice before a game. `mine` is the viewer's own choice (null
 * when not yet made, and always null for a watcher); `chosen` says which seats
 * have chosen, and nothing more.
 */
export const GauntletChoiceSchema = z.strictObject({
  mine: z.string().min(1).nullable(),
  chosen: z.tuple([z.boolean(), z.boolean()]),
});
export type GauntletChoice = z.infer<typeof GauntletChoiceSchema>;

export const GauntletViewSchema = z.strictObject({
  phase: GauntletPhaseSchema,
  /** The viewer's table seat, or null for a watcher. */
  you: GauntletSeatIndexSchema.nullable(),
  /** Fixed at the draw; null in `options`, where the room table's seats are still open. */
  players: z.tuple([GauntletPlayerSchema, GauntletPlayerSchema]).nullable(),
  /** Which seats have readied in `options`. */
  ready: z.tuple([z.boolean(), z.boolean()]),
  era: GauntletEraSchema.nullable(),
  /** When the reveal started, server epoch ms; a screen that opens mid-reveal joins it there. Null before the draw. */
  revealAt: z.number().int().nullable(),
  /** The coin flip: the table seat that is P1. Null before the draw. */
  first: GauntletSeatIndexSchema.nullable(),
  /** The ten decks in the order they were drawn; empty before the draw. */
  decks: z.array(GauntletDeckSchema).max(GAUNTLET_DECKS),
  /** The ban/pick step under way; null outside `banpick`. */
  step: GauntletStepSchema.nullable(),
  /** Every game whose decks have been revealed, in order — the last is the one being played in `playing`. */
  games: z.array(GauntletGameSchema).max(3),
  /** The hidden choice under way; null outside `choose`. */
  choice: GauntletChoiceSchema.nullable(),
  /** The seat that won the series, once `done`. */
  winner: GauntletSeatIndexSchema.nullable(),
});
export type GauntletView = z.infer<typeof GauntletViewSchema>;
