/**
 * What `POST /api/play/matches` accepts. Every refusal's text lives on the
 * schema that raises it, and the server answers the first one: a field nobody
 * named, then each field in the order this shape lists them.
 */

import { z } from 'zod';

import { MAX_DCK_BYTES } from './draft.ts';

/** A puzzle `[state]` section is bounded like a deck. */
export const SCENARIO_MAX = 64 * 1024;
export const FORMAT_ID_MAX = 200;

const DECK_ERROR = 'each deck is .dck text (at most 64 KiB) or null';
const SCENARIO_ERROR = 'scenario is the text of a puzzle [state] section (at most 64 KiB)';
const FORMAT_ERROR = 'format is a format id';

const deck = z.string({ error: DECK_ERROR }).min(1, { error: DECK_ERROR }).max(MAX_DCK_BYTES, { error: DECK_ERROR }).nullable();

/**
 * `{ opponent?, decks?, names?, scenario?, format?, handSmoothing?, chooser? }`.
 * No body, a `null` opponent and `null` decks read as a human opponent and two
 * precon seats. `names` are taken as sent; the server cleans them.
 */
export const StartMatchBodySchema = z.preprocess(
  (body) => body ?? {},
  z.strictObject(
    {
      opponent: z
        .enum(['human', 'ai'], { error: "opponent is 'human' or 'ai'" })
        .nullish()
        .transform((v) => v ?? 'human'),
      decks: z
        .tuple([deck, deck], { error: 'decks is a two-element array' })
        .nullish()
        .transform((v) => v ?? [null, null]),
      names: z.tuple([z.unknown(), z.unknown()], { error: 'names is a two-element array' }).optional(),
      scenario: z.string({ error: SCENARIO_ERROR }).min(1, { error: SCENARIO_ERROR }).max(SCENARIO_MAX, { error: SCENARIO_ERROR }).optional(),
      format: z.string({ error: FORMAT_ERROR }).min(1, { error: FORMAT_ERROR }).max(FORMAT_ID_MAX, { error: FORMAT_ERROR }).optional(),
      handSmoothing: z.boolean({ error: 'handSmoothing is a boolean' }).optional(),
      chooser: z.union([z.literal(0), z.literal(1)], { error: 'chooser is 0 or 1' }).optional(),
    },
    { error: (iss) => (iss.code === 'unrecognized_keys' ? `unknown field ${iss.keys[0]}` : 'body must be an object') },
  ),
);
export type StartMatchBody = z.output<typeof StartMatchBodySchema>;
