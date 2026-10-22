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

/** Every game type a room may be set to. */
export const GAME_TYPES = ['constructed-1v1', 'draft'] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);
export type GameType = z.infer<typeof GameTypeSchema>;
export const DEFAULT_GAME_TYPE: GameType = 'constructed-1v1';

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
 * `lock` (off by default): every game of an All Random table plays the decks its first deal gave
 * it. Off, each game deals fresh (the operator, 2026-10-22: "i would not expect it to lock the deck
 * by default … that should be a toggle").
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
