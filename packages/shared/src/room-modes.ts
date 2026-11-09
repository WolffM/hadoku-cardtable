/*
 * Room modes — what kind of game a room plays, and for a Constructed room,
 * which of its three modes and that mode's options.
 *
 * `docs/planning/constructed-modes-plan.md` ("Room model"): a room's
 * `gameType` is `constructed-1v1` or `draft` (the UI labels them Constructed /
 * Draft; the wire ids stay so no stored room migrates for a label). A
 * Constructed room's `mode` is `null` until the leader chooses one, and each
 * mode carries its own options:
 *
 *   classic   {}                          format tabs + era, as rooms always were
 *   gauntlet  { family?, era? }           both left out = a random era
 *   random    { pool }                    `full` draws from every family
 *
 * The server (`apps/server/src/room/lobby.ts`) stores the pair and the UI
 * (`apps/ui/src/rooms/api.ts`) reads it; both bind to THIS file, so the shape
 * is stated once.
 */

import { z } from 'zod';
import type { FormatFamily } from '@hadoku/carddata/formats';

import { isRegisteredGameType, registerGameType } from './game-type-spec.ts';
import { POD_MAX_SEATS } from './pod.ts';

/** Magic's own two game types — still a closed list for `isMagicGameType` and the HTTP create/patch gate, which stay Magic-only. */
export const GAME_TYPES = ['constructed-1v1', 'draft'] as const;
/**
 * Any game type a `GameTypeSpec` has registered (`game-type-spec.ts`) —
 * open, not a closed union. Magic's own two are registered immediately
 * below, in THIS file rather than a Magic one: `game-type-spec.ts`'s
 * registry is a plain module-level `Map`, populated only by whatever
 * imports actually ran, so registering here — the one file every reader of
 * `GameTypeSchema` necessarily imports — means the registration has always
 * run before anything can call `.safeParse` on it. Registering from
 * `magic-room.ts` instead left the registry empty for a caller that
 * imports some other file in this package directly, bypassing the
 * `index.ts` barrel that happens to import everything (`platform-split.test.ts`
 * caught this as a round-trip failure).
 */
export const GameTypeSchema = z.string().refine(isRegisteredGameType, { error: 'not a registered game type' });
export type GameType = string;

/**
 * Magic's two `GameTypeSpec`s — the facts true of each on their own, with
 * no running server behind them. `canStart` mirrors
 * `apps/server/src/room/lobby.ts`'s own `POD_MIN_OPEN` (2): the fewest
 * seats either one is ever started with. Magic's deeper rules (deck
 * legality, a draft's own completion, locked decks, bot play, …) are
 * `GameHooks` in that same file, built in `http/routes.ts` and wired in
 * per game type through `Lobby.useGameType`.
 */
registerGameType({
  id: 'constructed-1v1',
  // A Forge match is two seats, win or lose; `apps/server/src/http/routes.ts`'s
  // table routes read this one.
  seats: { min: 2, max: 2 },
  ready: true,
  series: { length: 1 },
  canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
});
registerGameType({
  id: 'draft',
  // The pod's own seats (`POD_SEATS`/`POD_MAX_SEATS`), not a table's: a
  // draft's ROUNDS still pair two at a table (the 'constructed-1v1' spec's
  // own seats), but the pod itself grows one seat at a time past its first
  // eight (`apps/server/src/room/lobby.ts`'s `grownSeats`).
  seats: { min: 2, max: POD_MAX_SEATS },
  ready: true,
  series: { length: 3 },
  canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
});
/**
 * Kept as the literal `'constructed-1v1'`, not widened to `GameType`: it is
 * a valid default for `room-requests.ts`'s own closed `z.enum(GAME_TYPES)`
 * field (the HTTP create/patch gate, still Magic-only), and a literal is a
 * `GameType` everywhere one is wanted, so nothing else narrows.
 */
export const DEFAULT_GAME_TYPE = 'constructed-1v1' as const;

/** A Constructed room's three modes. */
export const CONSTRUCTED_MODES = ['classic', 'gauntlet', 'random'] as const;
export const ConstructedModeSchema = z.enum(CONSTRUCTED_MODES);
export type ConstructedMode = z.infer<typeof ConstructedModeSchema>;

/**
 * The format families a Gauntlet or an All Random draw may be limited to —
 * `@hadoku/carddata/formats`' `FormatFamily`, restated as values for zod. The
 * `satisfies` pair below refuses to compile if the two ever differ.
 */
export const FORMAT_FAMILIES = ['standard', 'modern', 'legacy'] as const;
export const FormatFamilySchema = z.enum(FORMAT_FAMILIES);
type SameFamilies = [FormatFamily] extends [(typeof FORMAT_FAMILIES)[number]]
  ? [(typeof FORMAT_FAMILIES)[number]] extends [FormatFamily]
    ? true
    : never
  : never;
const familiesAgree: SameFamilies = true;
void familiesAgree;

/**
 * The pool that is no pool: any library deck against any other, whatever era
 * each was built for. Neither a date nor `draft:`-prefixed, so it can never be
 * mistaken for an era or a pod. Its `/formats` row has `source: 'free'`.
 */
export const FREE_PICK = 'free';

/**
 * The newest era whose `family` is `'standard'`, or null when the catalog has
 * none. Compared by `id` as a string, which is safe: a Standard era's id IS its
 * bare `YYYY-MM-DD` date, so lexicographic order is chronological. Never just
 * the last era, because Modern and Legacy eras share the list.
 */
export function newestStandardEra(formats: readonly { readonly id: string; readonly family?: string }[]): string | null {
  let newest: string | null = null;
  for (const f of formats) {
    if (f.id !== FREE_PICK && f.family === 'standard' && (newest === null || f.id > newest)) newest = f.id;
  }
  return newest;
}

/** All Random's pools: one family, or `full` for any of them. */
export const RANDOM_POOLS = ['full', ...FORMAT_FAMILIES] as const;
export const RandomPoolSchema = z.enum(RANDOM_POOLS);
export type RandomPool = z.infer<typeof RandomPoolSchema>;

/** Classic has no options of its own: its format is the room's `format`. */
export const ClassicOptionsSchema = z.object({}).strict();
export type ClassicOptions = z.infer<typeof ClassicOptionsSchema>;

/**
 * A Gauntlet's options. `era` is a room format id (a frozen era's date, the
 * server's `FormatId`); leaving both out means the server draws the era.
 */
export const GauntletOptionsSchema = z
  .object({
    family: FormatFamilySchema.optional(),
    era: z.string().min(1).max(64).optional(),
  })
  .strict();
export type GauntletOptions = z.infer<typeof GauntletOptionsSchema>;

/**
 * `lock` (off by default): every series of an All Random table plays the decks its first deal gave
 * it. Off, each new series deals fresh (the operator, 2026-10-22: "i would not expect it to lock the
 * deck by default … that should be a toggle"); the games of one series always keep their deal.
 */
export const RandomOptionsSchema = z.object({ pool: RandomPoolSchema, lock: z.boolean().optional() }).strict();
export type RandomOptions = z.infer<typeof RandomOptionsSchema>;

/** Each mode's options, by mode. */
export interface ModeOptionsByMode {
  classic: ClassicOptions;
  gauntlet: GauntletOptions;
  random: RandomOptions;
}
export type ModeOptions = ModeOptionsByMode[ConstructedMode];

/**
 * A mode together with its own options — what `POST /api/rooms` and
 * `PATCH /api/rooms/:id` accept, so options that belong to another mode are
 * refused rather than stored.
 */
export const RoomModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('classic'), modeOptions: ClassicOptionsSchema.default({}) }),
  z.object({ mode: z.literal('gauntlet'), modeOptions: GauntletOptionsSchema.default({}) }),
  z.object({ mode: z.literal('random'), modeOptions: RandomOptionsSchema }),
]);
export type RoomMode = z.infer<typeof RoomModeSchema>;

/** A room's stored pair: no mode chosen yet, or a mode with its options. */
export type RoomModeState = { mode: null; modeOptions: null } | RoomMode;
