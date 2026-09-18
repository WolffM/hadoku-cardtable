/*
 * The vocabulary every GameEvent schema is written in.
 *
 * All of it is derived from what `capture/EventJson.java` actually writes when
 * it decodes a captured `TrackableSerializer.WrappedEvent`, and each shape says
 * which rule of that decoder produces it. The decoder's rules are the contract;
 * `capture/EventJson.java`'s header states them.
 *
 * Paths below are under `forge/`, pinned at 2ad70eb4.
 */

import { z } from 'zod';

import { CardRefSchema, PlayerRefSchema, ZoneTypeSchema, type PlayerRef } from '../refs.ts';

/* ── References ──────────────────────────────────────────────────────── */

/**
 * A `CardView` inside an event.
 *
 * Events are NOT serialized like the rest of the protocol. `wrapEvents` writes
 * them with `eventMode = true` (TrackableSerializer.java `wrapEvents`), and in
 * that mode `replace` turns every `CardView` into an `EventCardRef(id, name,
 * imageKey, preserveSnapshot)` rather than an `IdRef` — because an event can
 * outlive the card it names. `preserveSnapshot` is set when the tracker already
 * holds a DIFFERENT object under the same id (a zone-change copy): the receiver
 * must then show the carried name and image key, not whatever the state arm now
 * has under that id. A browser needs the same rule, so all four fields cross.
 *
 * `ref` is exactly `refs.ts`'s `CardRef`, so a consumer resolves it against the
 * Tier C state arm with the lookup it already has.
 *
 * `imageKey` is Forge's own image-cache key (e.g. `c:Opt|DOM|1`), carried as
 * text. It is not a URL and nothing here fetches it; art is the art resolver's
 * job (`packages/carddata/src/art/`).
 *
 * `name`/`imageKey` are nullable because `EventCardRef` declares them as plain
 * `String`s that `replace` fills from `cv.getName()` and
 * `cv.getCurrentState().getImageKey()` without a null guard on the first.
 */
export const EventCardSchema = z.strictObject({
  ref: CardRefSchema,
  name: z.string().nullable(),
  imageKey: z.string().nullable(),
  preserveSnapshot: z.boolean(),
});

export type EventCard = z.infer<typeof EventCardSchema>;

/**
 * `GameEntityView` inside an event: a player (an `IdRef` with tag 1) or a card
 * (an `EventCardRef`). Attack targets, attachment endpoints and the defender
 * keys of a block map are all this.
 */
export const EventEntitySchema = z.union([PlayerRefSchema, EventCardSchema]);

export type EventEntity = z.infer<typeof EventEntitySchema>;

/** `ZoneView(PlayerView player, ZoneType zoneType)` — a record (ZoneView.java). */
export const ZoneViewSchema = z.strictObject({
  player: PlayerRefSchema.nullable(),
  zoneType: ZoneTypeSchema,
});

/* ── Enums, transcribed constant for constant ────────────────────────── */

/** `GameLogEntryType` (forge-game/.../game/GameLogEntryType.java:4-22) — 19 constants. */
export const GAME_LOG_ENTRY_TYPES = [
  'GAME_OUTCOME',
  'MATCH_RESULTS',
  'TURN',
  'MULLIGAN',
  'ANTE',
  'DRAFT',
  'ZONE_CHANGE',
  'PLAYER_CONTROL',
  'DAMAGE',
  'LIFE',
  'LAND',
  'DISCARD',
  'COMBAT',
  'INFORMATION',
  'STACK_RESOLVE',
  'STACK_ADD',
  'EFFECT_REPLACED',
  'MANA',
  'PHASE',
] as const;
export const GameLogEntryTypeSchema = z.enum(GAME_LOG_ENTRY_TYPES);

/** `EventValueChangeType` (forge-game/.../game/event/EventValueChangeType.java:4-7). */
export const EVENT_VALUE_CHANGE_TYPES = ['Added', 'Removed', 'Cleared', 'ComplexUpdate'] as const;
export const EventValueChangeTypeSchema = z.enum(EVENT_VALUE_CHANGE_TYPES);

/** `MagicColor.Color` (forge-core/.../card/MagicColor.java:150-156) — 6 constants. */
export const MAGIC_COLORS = ['WHITE', 'BLUE', 'BLACK', 'RED', 'GREEN', 'COLORLESS'] as const;
export const MagicColorSchema = z.enum(MAGIC_COLORS);

/** `GameEventCardDamaged.DamageType` (GameEventCardDamaged.java:7-12). */
export const DAMAGE_TYPES = ['Normal', 'M1M1Counters', 'Deathtouch', 'LoyaltyLoss'] as const;
export const DamageTypeSchema = z.enum(DAMAGE_TYPES);

/** `GameType` (forge-game/.../game/GameType.java:20-56) — 26 constants. */
export const GAME_TYPES = [
  'Sealed',
  'Draft',
  'Winston',
  'Gauntlet',
  'Tournament',
  'CommanderGauntlet',
  'Quest',
  'QuestCommander',
  'QuestDraft',
  'PlanarConquest',
  'Adventure',
  'AdventureEvent',
  'Puzzle',
  'Constructed',
  'DeckManager',
  'Vanguard',
  'Commander',
  'Oathbreaker',
  'TinyLeaders',
  'Brawl',
  'Planeswalker',
  'Planechase',
  'Archenemy',
  'ArchenemyRumble',
  'MomirBasic',
  'MoJhoSto',
] as const;
export const GameTypeSchema = z.enum(GAME_TYPES);

/**
 * `CounterType.getName()` — NOT an enum name.
 *
 * `CounterType` is an interface with three implementations
 * (`CounterEnumType`, `CounterKeywordType`, `CounterCustomType`); only the
 * first is an enum, and its `getName()` is the display form (`"+1/+1"` for
 * `P1P1`). The decoder writes `getName()` for all three, which is also what the
 * state arm's `JsonDelta` writes for counter multisets, so a counter name means
 * the same thing on both arms. Open string: the custom set is open by
 * construction (`CounterCustomType.get(String)` mints on demand).
 */
export const CounterNameSchema = z.string().min(1);

/* ── Inline view objects ─────────────────────────────────────────────── */

/**
 * `SpellAbilityView` — NOT swapped for a marker.
 *
 * `TrackableSerializer.typeTagFor` returns -1 for anything but `CardView` and
 * `PlayerView`, so `replace` passes a `SpellAbilityView` through untouched and
 * Java serializes the whole object: its id and its `TrackableProperty` bag. The
 * decoder writes it as `{ ref, props }`. `props` keys are the five
 * `TrackableProperty` constants `SpellAbilityView` sets
 * (TrackableProperty.java:211-215); each is optional because an unset property
 * is absent from the bag, not null.
 *
 * The id resolves against NOTHING in the state arm — `DeltaPacket.typeTagFor`
 * has no spell-ability tag (DeltaPacket.java:34-38) — so the props carried here
 * are all a browser will ever know about this ability.
 */
export const InlineSpellAbilitySchema = z.strictObject({
  ref: z.strictObject({ kind: z.literal('spellAbility'), id: z.number().int() }),
  props: z.strictObject({
    HostCard: EventCardSchema.optional(),
    Description: z.string().optional(),
    CanPlay: z.boolean().optional(),
    PromptIfOnlyPossibleAbility: z.boolean().optional(),
    SA_IsSpell: z.boolean().optional(),
  }),
});

export type InlineSpellAbility = z.infer<typeof InlineSpellAbilitySchema>;

export interface InlineStackItem {
  ref: { kind: 'stackItem'; id: number };
  props: {
    Key?: string;
    SourceTrigger?: number;
    SourceCard?: EventCard;
    ActivatingPlayer?: PlayerRef;
    TargetCards?: EventCard[];
    TargetPlayers?: PlayerRef[];
    SubInstance?: InlineStackItem;
    Ability?: boolean;
    OptionalTrigger?: boolean;
    OptionalCosts?: string;
    Description?: string;
  };
}

/**
 * `StackItemView` — also NOT swapped for a marker, for the same reason.
 *
 * Unlike a spell ability, its id DOES resolve: the state arm tracks stack items
 * under `DeltaPacket.TYPE_STACK_ITEM_VIEW` (DeltaPacket.java:36). The props are
 * the eleven `StackItemView` sets (TrackableProperty.java:212,221-230).
 * `SubInstance` is another inline stack item — the decoder recurses, and so
 * does this schema.
 */
export const InlineStackItemSchema: z.ZodType<InlineStackItem> = z.lazy(() =>
  z.strictObject({
    ref: z.strictObject({ kind: z.literal('stackItem'), id: z.number().int() }),
    props: z.strictObject({
      Key: z.string().optional(),
      SourceTrigger: z.number().int().optional(),
      SourceCard: EventCardSchema.optional(),
      ActivatingPlayer: PlayerRefSchema.optional(),
      TargetCards: z.array(EventCardSchema).optional(),
      TargetPlayers: z.array(PlayerRefSchema).optional(),
      SubInstance: InlineStackItemSchema.optional(),
      Ability: z.boolean().optional(),
      OptionalTrigger: z.boolean().optional(),
      OptionalCosts: z.string().optional(),
      Description: z.string().optional(),
    }),
  }),
);

/* ── Guava multimaps ─────────────────────────────────────────────────── */

/**
 * A Guava `Multimap<K, V>` as the decoder writes it: one entry per key, with
 * all of that key's values. JSON object keys are strings, and these keys are
 * entity references, so it is an entry list rather than an object.
 */
export function multimapSchema<K extends z.ZodType, V extends z.ZodType>(key: K, value: V) {
  return z.array(z.strictObject({ key, values: z.array(value) }));
}

/** A `java.util.Map<K, V>` with non-string keys: an entry list, for the same reason. */
export function mapSchema<K extends z.ZodType, V extends z.ZodType>(key: K, value: V) {
  return z.array(z.strictObject({ key, value }));
}
