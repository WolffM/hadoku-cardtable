/*
 * `sideboard` — the one method in the required 38 that is not a reference.
 *
 * `List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message)`
 * (IGuiGame.java:250). Every other Tier B method passes a `CardView` or a
 * `PlayerView`, which is an object the client already holds from the state
 * channel and so crosses as an id. A `CardPool` is not: it is a quantity map
 * over `PaperCard` — cards the client has never seen, because sideboarding
 * happens between games and there is no board to reference them from.
 *
 * So it needs a projection, and this repo already has exactly one:
 * `@hadoku/deck` models a pool as `DeckEntry[]` (a count and a `CardRequest`)
 * and round-trips Forge's own `.dck` over all 95 bundled cubes. Inventing a
 * second pool model here would mean two spellings of "a card and how many of
 * it", and the UI would get to pick which one was wrong.
 *
 * The schemas below are therefore NOT a new model — they are the Zod surface of
 * `@hadoku/deck`'s, and `asDeckEntry` is the compile-time proof of that. If the
 * two ever drift, this file stops compiling, the same mechanism `@hadoku/shared`
 * uses to pin `SeqCursorSchema` to `@wolffm/rooms-protocol`'s `SeqCursor`
 * (`packages/shared/src/wire.ts`, `asSeqCursor`).
 *
 * ## The reply is the new MAINDECK, and null is meaningful
 *
 * `PlayerControllerHuman.java:275-276`:
 *
 *     List<PaperCard> resp = getGui().sideboard(sideboard, main, message);
 *     newMain = Objects.requireNonNullElse(resp, main.toFlatList());
 *
 * So the list coming back is the main deck the player settled on, not the
 * sideboard, and `null` means "I changed nothing — keep the main you had".
 * A schema that made the reply non-nullable would force a bridge to fabricate
 * the current maindeck in order to say "no change", which is the same list with
 * one more chance to be wrong.
 *
 * `List<PaperCard>` is flat, not a quantity map: four copies are four entries.
 * `DeckEntry` carries a count, which is the `.dck` spelling and what
 * `@hadoku/deck` works in; `flattenEntries` below is the conversion, and it is
 * the same expansion `toDeckFile` already performs on export.
 */

import { z } from 'zod';
import type { Deck } from '@hadoku/deck';

/**
 * Forge: `IPaperCard.DEFAULT_ART_INDEX` (IPaperCard.java:14), the same constant
 * `@hadoku/carddata`'s parser defaults to (`dck.ts:31-32`). Restated rather
 * than imported so this package depends on `@hadoku/deck` alone — `@hadoku/deck`
 * does not re-export it, and reaching past it to `@hadoku/carddata` for one
 * integer is the second dependency this file exists to avoid.
 */
const DEFAULT_ART_INDEX = 1;

/**
 * `CardRequest` (`@hadoku/carddata/dck`), as reached through `@hadoku/deck`'s
 * own `Deck` type so this package depends on one model and not two.
 */
type DeckEntryOfDeck = Deck['main'][number];
type CardRequestOfDeck = DeckEntryOfDeck['card'];

/**
 * Forge `CardDb.parseRequestFlags` builds a map (CardDb.java:289), so flags are
 * an unordered string→string bag or absent altogether.
 */
export const CardRequestSchema = z.strictObject({
  name: z.string().min(1),
  set: z.string().nullable(),
  artIndex: z.number().int().positive(),
  collectorNumber: z.string().nullable(),
  foil: z.boolean(),
  backFace: z.boolean(),
  flags: z.record(z.string(), z.string()).nullable(),
});

/** A card line: a count and the card it refers to. `@hadoku/deck`'s `DeckEntry`. */
export const DeckEntrySchema = z.strictObject({
  count: z.number().int().positive(),
  card: CardRequestSchema,
});

export type WireCardRequest = z.infer<typeof CardRequestSchema>;
export type WireDeckEntry = z.infer<typeof DeckEntrySchema>;

/**
 * Hand a parsed wire entry to anything expecting `@hadoku/deck`'s `DeckEntry` —
 * `totalCards`, `newDeck`, `deckIssues`, `writeDck`.
 *
 * The body is the identity function; the point is the signature. This is the
 * whole claim "we did not invent a second pool model", stated so the compiler
 * checks it.
 */
export function asDeckEntry(entry: WireDeckEntry): DeckEntryOfDeck {
  return entry;
}

/** The same proof one level down, so a drift inside `CardRequest` is caught too. */
export function asCardRequest(card: WireCardRequest): CardRequestOfDeck {
  return card;
}

/** `CardPool` on the wire: a quantity map, spelled the way a `.dck` spells one. */
export const CardPoolSchema = z.array(DeckEntrySchema);

/**
 * `List<PaperCard>` from a quantity map — n copies become n entries.
 *
 * Forge's reply type is flat; `@hadoku/deck` works in counts. A bridge needs
 * the conversion in exactly one place, so it lives next to the schema that
 * makes the claim rather than in whichever consumer needs it first.
 */
export function flattenEntries(entries: readonly WireDeckEntry[]): WireCardRequest[] {
  const out: WireCardRequest[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i++) out.push(entry.card);
  }
  return out;
}

/** A bare card name, with Forge's defaults for everything a `.dck` line may omit. */
export function cardRequest(name: string, set: string | null = null): WireCardRequest {
  return {
    name,
    set,
    artIndex: DEFAULT_ART_INDEX,
    collectorNumber: null,
    foil: false,
    backFace: false,
    flags: null,
  };
}
