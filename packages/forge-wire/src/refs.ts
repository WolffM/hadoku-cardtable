/*
 * The reference vocabulary: what a Forge view object looks like on a wire.
 *
 * Wave 6 lane F's finding, in one sentence: a browser never receives a
 * serialized `CardView`, because every method that mentions one is a
 * *reference* to an object the client already holds from the state channel
 * (`docs/spikes/itoclient.md`, "Tier B"). `TrackableObject` carries a stable
 * int id (`TrackableObject.java:33,47`) and `DeltaPacket.makeDeltaKey` already
 * packs `(typeTag, id)` into one int (`DeltaPacket.java:61-70`). So the whole
 * of Tier B is "replace the object with its id", and this file is that id
 * scheme plus the handful of plain value objects the 38 methods also carry.
 *
 * ## Why the kind travels with the id
 *
 * Forge's ids are unique per `Tracker`, not per type, so `{ id: 7 }` alone
 * would be ambiguous the moment two trackers meet — and, worse, a schema that
 * accepted a bare int could not tell a `CardView` argument from a `PlayerView`
 * one. Every ref below is a two-field strict object whose `kind` is a literal,
 * so handing `selectPlayer` a card id is a parse error rather than a lookup
 * that silently returns the wrong object.
 *
 * `GameEntityView` is abstract and is extended by exactly `CardView`
 * (`CardView.java:32`) and `PlayerView` (`PlayerView.java:33`), so it is a
 * union of the two rather than a third kind. `SpellAbilityView` and
 * `StackItemView` extend `TrackableObject` directly
 * (`SpellAbilityView.java:13`, `StackItemView.java:12`) and are their own
 * kinds.
 *
 * ## Enums: named where they are small, opaque where they are not
 *
 * `ZoneType` (19), `PhaseType` (13), `NextGameDecision` (3) and
 * `AutoYieldStore.TriggerDecision` (3) are transcribed constant for constant,
 * so a typo is a parse error. `FSkinProp` (508 constants) and
 * `ForgePreferences.FPref` (291) are NOT: transcribing them would be five
 * hundred lines that go stale on the next upstream merge, and neither is
 * branched on by a browser — `FSkinProp` names a desktop skin asset we do not
 * and must not draw (no WotC trademarks), and `FPref` is an opaque storage key.
 * Both are modelled as the enum constant's NAME with a shape guard, which is
 * weaker than an enum and is stated here rather than pretended away.
 */

import { z } from 'zod';

/* ── Entity references ───────────────────────────────────────────────── */

/**
 * `TrackableObject.getId()` — an `int` (`TrackableObject.java:33`).
 *
 * No sign constraint: Forge's ids come from the game's own id generator and
 * this lane did not verify that they are always positive, so asserting it
 * would be a guess with a parse error attached.
 */
export const TrackableIdSchema = z.number().int();

export const CardRefSchema = z.strictObject({
  kind: z.literal('card'),
  id: TrackableIdSchema,
});

export const PlayerRefSchema = z.strictObject({
  kind: z.literal('player'),
  id: TrackableIdSchema,
});

export const SpellAbilityRefSchema = z.strictObject({
  kind: z.literal('spellAbility'),
  id: TrackableIdSchema,
});

export const StackItemRefSchema = z.strictObject({
  kind: z.literal('stackItem'),
  id: TrackableIdSchema,
});

/** `GameEntityView` is abstract; its only subclasses are `CardView` and `PlayerView`. */
export const GameEntityRefSchema = z.discriminatedUnion('kind', [CardRefSchema, PlayerRefSchema]);

/** Every reference shape, for a consumer that wants one switch. */
export const EntityRefSchema = z.discriminatedUnion('kind', [
  CardRefSchema,
  PlayerRefSchema,
  SpellAbilityRefSchema,
  StackItemRefSchema,
]);

export type CardRef = z.infer<typeof CardRefSchema>;
export type PlayerRef = z.infer<typeof PlayerRefSchema>;
export type SpellAbilityRef = z.infer<typeof SpellAbilityRefSchema>;
export type StackItemRef = z.infer<typeof StackItemRefSchema>;
export type GameEntityRef = z.infer<typeof GameEntityRefSchema>;
export type EntityRef = z.infer<typeof EntityRefSchema>;

export function cardRef(id: number): CardRef {
  return { kind: 'card', id };
}

/* ── Enums transcribed from Forge ────────────────────────────────────── */

/** `ZoneType` (ZoneType.java:15-35) — 19 constants, in declaration order. */
export const ZONE_TYPES = [
  'Hand',
  'Library',
  'Graveyard',
  'Battlefield',
  'Exile',
  'Flashback',
  'Command',
  'Stack',
  'Sideboard',
  'Ante',
  'Merged',
  'SchemeDeck',
  'PlanarDeck',
  'AttractionDeck',
  'Junkyard',
  'ContraptionDeck',
  'Subgame',
  'ExtraHand',
  'None',
] as const;

export const ZoneTypeSchema = z.enum(ZONE_TYPES);
export type ZoneType = z.infer<typeof ZoneTypeSchema>;

/** `PhaseType` (PhaseType.java:16-28) — 13 constants, in declaration order. */
export const PHASE_TYPES = [
  'UNTAP',
  'UPKEEP',
  'DRAW',
  'MAIN1',
  'COMBAT_BEGIN',
  'COMBAT_DECLARE_ATTACKERS',
  'COMBAT_DECLARE_BLOCKERS',
  'COMBAT_FIRST_STRIKE_DAMAGE',
  'COMBAT_DAMAGE',
  'COMBAT_END',
  'MAIN2',
  'END_OF_TURN',
  'CLEANUP',
] as const;

export const PhaseTypeSchema = z.enum(PHASE_TYPES);
export type PhaseType = z.infer<typeof PhaseTypeSchema>;

/** `NextGameDecision` (NextGameDecision.java:3-7). */
export const NEXT_GAME_DECISIONS = ['NEW', 'CONTINUE', 'QUIT'] as const;
export const NextGameDecisionSchema = z.enum(NEXT_GAME_DECISIONS);
export type NextGameDecision = z.infer<typeof NextGameDecisionSchema>;

/** `AutoYieldStore.TriggerDecision` (AutoYieldStore.java:12). */
export const TRIGGER_DECISIONS = ['ASK', 'ACCEPT', 'DECLINE'] as const;
export const TriggerDecisionSchema = z.enum(TRIGGER_DECISIONS);
export type TriggerDecision = z.infer<typeof TriggerDecisionSchema>;

/**
 * A Java enum constant's NAME, not the enum itself.
 *
 * Used for `FSkinProp` (508 constants) and `FPref` (291). The guard is the
 * shape Java's own naming gives these two — `SCREAMING_SNAKE_CASE`, first
 * character a letter — which rejects an empty string, a lowercased name and an
 * accidental JSON object, and does NOT reject a name Forge does not have. That
 * is the weakness, and it is deliberate: see the module header.
 */
export const EnumConstantNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** `FSkinProp` (FSkinProp.java) — a desktop skin asset name. Null where Forge passes no icon. */
export const SkinPropSchema = EnumConstantNameSchema;

/** `ForgePreferences.FPref` — an opaque preference key. */
export const PrefKeySchema = EnumConstantNameSchema;

/* ── Plain value objects ─────────────────────────────────────────────── */

/**
 * `ITriggerEvent` (ITriggerEvent.java) — a mouse button and a point, and
 * nothing else. Three ints, so it crosses as itself rather than as a
 * reference. Null at every call site that can be reached without a click.
 */
export const TriggerEventSchema = z.strictObject({
  button: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
});

export type TriggerEvent = z.infer<typeof TriggerEventSchema>;

/**
 * `PlayerZoneUpdate` (PlayerZoneUpdate.java:11-22) — one player and a set of
 * their zones. `PlayerZoneUpdates` is `Iterable<PlayerZoneUpdate>` keyed by
 * player (`PlayerZoneUpdates.java:11-14`), so it is an array here.
 */
export const PlayerZoneUpdateSchema = z.strictObject({
  player: PlayerRefSchema,
  zones: z.array(ZoneTypeSchema),
});

export const PlayerZoneUpdatesSchema = z.array(PlayerZoneUpdateSchema);

export type PlayerZoneUpdate = z.infer<typeof PlayerZoneUpdateSchema>;

/**
 * `DelayedReveal` (DelayedReveal.java:16-21) — cards to show the chooser after
 * the fact, the zone(s) they came from, whose they are, and a message prefix.
 */
export const DelayedRevealSchema = z.strictObject({
  cards: z.array(CardRefSchema),
  zones: z.array(ZoneTypeSchema),
  owner: PlayerRefSchema,
  messagePrefix: z.string(),
});

export type DelayedReveal = z.infer<typeof DelayedRevealSchema>;

/**
 * One option in a `getChoices` / `order` prompt.
 *
 * Both methods are generic in Forge (`<T> List<T> getChoices(…)`,
 * `<T> OrderResult<T> order(…)`, IGuiGame.java:185,234) and `T` is whatever the
 * effect is choosing between — a `CardView`, a `PlayerView`, a `String`, a
 * `SpellAbilityView`. There is no wire type for "T", so an option is projected:
 * a `key` the reply quotes back, a `label` the browser draws, and the `ref` the
 * option stands for when it stands for an entity at all.
 *
 * The `display` argument both methods also take is an
 * `FSerializableFunction<T, String>` (ProtocolMethod.java:63-64). A function
 * cannot cross a wire, so the bridge applies it host-side and what crosses is
 * `label`. That is a projection decision, not a transcription — it is written
 * down here because the next session will otherwise look for the missing arg.
 */
export const ChoiceOptionSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string(),
  ref: EntityRefSchema.nullable(),
});

export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;

/**
 * The card an ask is raised on behalf of, and Forge's own text for that effect: the replacement
 * running (Cavern of Souls' "As Cavern of Souls enters, choose a creature type."), or the stack
 * item resolving. Not part of any `IGuiGame` signature — Forge's GUI calls drop the ability — so
 * the bridge reads it off the live game when it opens the ask (`PlayBridge.java`'s `askSource`),
 * for every ask alike. Absent when the game names no such card, or when this seat may not see it.
 */
export const AskSourceSchema = z.strictObject({
  card: CardRefSchema,
  text: z.string(),
});

export type AskSource = z.infer<typeof AskSourceSchema>;

/**
 * A byte, as Java means it: `useMana(byte color)` (IGameController.java:28)
 * carries `MagicColor`'s bit flags, and Java bytes are signed.
 */
export const JavaByteSchema = z.number().int().min(-128).max(127);
