/*
 * Tier C — the state channel. `setGameView` · `openView` · `applyDelta`: the
 * three methods that carry the whole game state.
 *
 * ## Modelled from captures, not from class definitions
 *
 * Until Wave 8 this file refused to parse anything, because no session had seen
 * a real delta stream and a schema would have been a guess. Wave 7 lane A ran
 * the experiment (`docs/spikes/tier-c.md`): 12 real two-player games, 658
 * `applyDelta` packets, 73,549 property values, every one round-tripped through
 * JSON. Everything below is fitted to what that run captured:
 *
 * - `scripts/spike/tierc/out/sample-newobjects.json` — the opening full sync.
 * - `scripts/spike/tierc/out/sample-delta.json` — a small mid-game delta.
 * - `scripts/spike/tierc/out/census.tsv` — every (property, runtime class,
 *   JSON tag) triple the run saw: 133 of them.
 * - `scripts/spike/tierc/out/coverage.tsv` — all 214 `TrackableProperty`
 *   constants in declaration order, with each one's declared `TrackableType`.
 *
 * `tier-c.test.ts` loads all four and checks this file against them in both
 * directions. The JSON form itself is the one `JsonDelta.java` in that spike
 * wrote and read back (`scripts/spike/tierc/src/JsonDelta.java`, `encode` /
 * `decode`): every value is a small object tagged by `t`, because bare JSON
 * cannot tell an `Integer` from a `Long` and the round trip had to be exact.
 *
 * ## What is NOT here, on purpose
 *
 * - **No entity-reference arm.** Wave 7 measured zero `ref`/`refs` values in
 *   73,549: the server has already flattened every `CardView`, `PlayerView`,
 *   `StackItemView` and collection of them to ints before a packet leaves
 *   (`DeltaSyncManager.toNetworkValue`, `DeltaSyncManager.java:356-401`). The
 *   54 properties Wave 6 budgeted an encoder each arrive as `{t:'int'}` ids.
 *   A `ref` tag anywhere in a state value is therefore a parse error — it
 *   would mean the server stopped flattening, which is worth hearing about.
 * - **No bespoke structure for the Forge-encoded texts.** `ManaCost`,
 *   `KeywordCollectionView`, `CounterType` names and `PaperCard` are carried as
 *   the text Forge wrote (the spike's DERIVED class). This file checks they are
 *   strings; it does not invent a grammar for them.
 * - **No events.** A `DeltaPacket` carries state AND a list of
 *   `TrackableSerializer.WrappedEvent`s — Java-serialized `GameEvent` bytes a
 *   browser cannot read. Giving those a JSON form is Wave 8 lane B's job, in
 *   `packages/forge-wire/src/events/`. Here the arm is `DeltaEventsArmSchema`:
 *   an array, and otherwise OPAQUE. It does not import from `events/`; when
 *   lane B's union lands, it replaces that one schema and nothing else.
 *
 * ## setGameView and openView are the bridge's flattening, not a capture
 *
 * The spike captured `applyDelta` packets as JSON; `setGameView` and
 * `openView` it only COUNTED (36 and 12 calls). Their Java payloads are a
 * `GameView` object graph and a `TrackableCollection<PlayerView>`. The JSON form
 * chosen here is the one the delta stream already proves out:
 *
 * - `setGameView.gameView` is a full object table — exactly the shape of a
 *   packet's `newObjects`, which on the opening sync IS the whole game (243
 *   objects in the committed run). One table shape for "the state" and "a
 *   change to the state" is what lets a client apply both with one function.
 * - `openView.myPlayers` is a list of player ids, the same flattening
 *   `toNetworkValue` gives every `PlayerViewCollectionType`.
 *
 * That is a decision, and it is written down as one.
 */

import { z } from 'zod';

import { PHASE_TYPES, ZONE_TYPES } from './refs.ts';

/** The three Tier C method names (ProtocolMethod.java:35-36,79). */
export const TIER_C_METHODS = ['setGameView', 'openView', 'applyDelta'] as const;

export type TierCMethod = (typeof TIER_C_METHODS)[number];

/** The spike whose captures this file is modelled on. */
export const TIER_C_SPIKE = 'docs/spikes/tier-c.md';

/* ── Delta keys ──────────────────────────────────────────────────────── */

/**
 * The object kinds a delta key can name, indexed by type tag
 * (`DeltaPacket.java:34-38`). `cardState` is a `CardStateView`, whose id is
 * `cardId * 16 + CardStateName.ordinal()` (`DeltaPacket.java:61-66`).
 */
export const DELTA_OBJECT_TYPES = ['card', 'player', 'stackItem', 'game', 'cardState'] as const;

export type DeltaObjectType = (typeof DELTA_OBJECT_TYPES)[number];

/** Type tag of the one `GameView` in a game. */
export const GAME_VIEW_TYPE_TAG = 3;

/** `DeltaPacket.makeDeltaKey(type, id)` (`DeltaPacket.java:67-69`): type in the top 4 bits. */
export function deltaKeyOf(typeTag: number, id: number): number {
  return ((typeTag << 28) | (id & 0x0fffffff)) >>> 0;
}

/** `DeltaPacket.getTypeFromDeltaKey` (`DeltaPacket.java:71-73`). */
export function deltaKeyType(key: number): number {
  return (key >>> 28) & 0xf;
}

/** `DeltaPacket.getIdFromDeltaKey` (`DeltaPacket.java:75-81`) — the 28-bit id, sign-extended. */
export function deltaKeyId(key: number): number {
  const id = key & 0x0fffffff;
  return id & 0x08000000 ? id | 0xf0000000 : id;
}

/**
 * A delta key as a JSON object key: the decimal spelling of a non-negative
 * Java `int`. A type tag of at most 4 keeps the sign bit clear, so a minus sign
 * or a value past `2^31 - 1` is never a real key.
 */
export const DeltaKeySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})$/, 'a delta key is a non-negative decimal int')
  .refine((key) => Number(key) <= 0x7fffffff, 'a delta key fits a Java int');

/* ── Values: the spike codec's tagged form ───────────────────────────── */

const JavaInt = z.int32();

/**
 * Every tag `JsonDelta.encode` can emit for STATE, as a recursive type. `ref`,
 * `refs`, `bytes` and `record` are deliberately absent: the first two never
 * occurred (see the header) and the last two only carry events.
 */
export type TaggedValue =
  | { t: 'bool'; v: boolean }
  | { t: 'int' | 'long' | 'short' | 'byte'; v: number }
  | { t: 'float' | 'double'; v: number }
  | { t: 'str'; v: string }
  | { t: 'enum'; c: string; v: string }
  | { t: 'ints'; v: number[] }
  | { t: 'list' | 'set'; v: (TaggedValue | null)[] }
  | { t: 'map'; v: [TaggedValue | null, TaggedValue | null][] }
  | { t: 'multiset'; v: [string, number][] }
  | { t: 'manacost'; v: string }
  | { t: 'cardtype'; sup: string[]; core: string[]; sub: string[]; all: boolean; exc: string[] }
  | { t: 'keywords'; v: string[] }
  | { t: 'papercard'; n: string; e: string; a: number; f: boolean }
  | { t: 'combat'; atk: number[][]; def: [number, number][]; blk: number[][]; pblk: number[][] };

const BoolValue = z.strictObject({ t: z.literal('bool'), v: z.boolean() });
const IntValue = z.strictObject({ t: z.literal('int'), v: JavaInt });
const StrValue = z.strictObject({ t: z.literal('str'), v: z.string() });
const ByteValue = z.strictObject({ t: z.literal('byte'), v: z.int().min(-128).max(127) });

function enumValue<C extends z.ZodType<string>, V extends z.ZodType<string>>(c: C, v: V) {
  return z.strictObject({ t: z.literal('enum'), c, v });
}

/**
 * A `GameEntityView`: `int[]{typeMarker, id}`, 0 = card, 1 = player
 * (`DeltaSyncManager.java:364-368`).
 */
const EntityMarker = z.tuple([z.union([z.literal(0), z.literal(1)]), JavaInt]);

const IdList = z.array(JavaInt);

/**
 * `DeltaPacket.CombatData` (`DeltaPacket.java:84-101`): four parallel lists,
 * one entry per attacking band. Captured: `{"atk":[[65],[114]],
 * "def":[[1,0],[1,0]],"blk":[[],[]],"pblk":[[],[]]}`.
 */
const CombatValue = z
  .strictObject({
    t: z.literal('combat'),
    atk: z.array(IdList),
    def: z.array(EntityMarker),
    blk: z.array(IdList),
    pblk: z.array(IdList),
  })
  .superRefine((combat, ctx) => {
    for (const key of ['def', 'blk', 'pblk'] as const) {
      if (combat[key].length !== combat.atk.length) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key} has ${combat[key].length} bands but atk has ${combat.atk.length}` +
            ` — CombatData's lists are parallel`,
        });
      }
    }
  });

/**
 * `CardTypeView` as its three token sets — NOT the printed type line, which
 * `CardType.parse` cannot read back (`docs/spikes/tier-c.md`).
 */
const CardTypeValue = z.strictObject({
  t: z.literal('cardtype'),
  sup: z.array(z.string()),
  core: z.array(z.string()),
  sub: z.array(z.string()),
  all: z.boolean(),
  exc: z.array(z.string()),
});

/** `ManaCost.serialize` text — DERIVED: carried, not parsed. */
const ManaCostValue = z.strictObject({ t: z.literal('manacost'), v: z.string() });

/** Each keyword's `original()` text — DERIVED. */
const KeywordsValue = z.strictObject({ t: z.literal('keywords'), v: z.array(z.string()) });

/** Counter multiset as `[CounterType name, count]` pairs — DERIVED names, e.g. `["+1/+1", 3]`. */
const MultisetValue = z.strictObject({
  t: z.literal('multiset'),
  v: z.array(z.tuple([z.string().min(1), z.int().positive()])),
});

/** `PaperCard` as name / edition / art index / foil — DERIVED (needs the card DB to rebuild). */
const PaperCardValue = z.strictObject({
  t: z.literal('papercard'),
  n: z.string(),
  e: z.string(),
  a: JavaInt,
  f: z.boolean(),
});

/**
 * Any value the codec can emit for state, recursively. Used ONLY for the three
 * declared types no run has ever produced (`UNOBSERVED_DECLARED_TYPES`), where
 * a narrower schema would be a guess. It still refuses untagged JSON and every
 * reference or event tag.
 */
export const TaggedValueSchema: z.ZodType<TaggedValue> = z.lazy(() =>
  z.discriminatedUnion('t', [
    BoolValue,
    z.strictObject({ t: z.literal('int'), v: JavaInt }),
    z.strictObject({ t: z.literal('long'), v: z.int() }),
    z.strictObject({ t: z.literal('short'), v: z.int().min(-32768).max(32767) }),
    ByteValue,
    z.strictObject({ t: z.literal('float'), v: z.number() }),
    z.strictObject({ t: z.literal('double'), v: z.number() }),
    StrValue,
    enumValue(z.string().min(1), z.string().min(1)),
    z.strictObject({ t: z.literal('ints'), v: IdList }),
    z.strictObject({ t: z.literal('list'), v: z.array(TaggedValueSchema.nullable()) }),
    z.strictObject({ t: z.literal('set'), v: z.array(TaggedValueSchema.nullable()) }),
    z.strictObject({
      t: z.literal('map'),
      v: z.array(z.tuple([TaggedValueSchema.nullable(), TaggedValueSchema.nullable()])),
    }),
    MultisetValue,
    ManaCostValue,
    CardTypeValue,
    KeywordsValue,
    PaperCardValue,
    CombatValue,
  ]),
);

/**
 * One schema per declared `TrackableType` (`TrackableTypes.java`), after
 * `toNetworkValue` has flattened it. The tag each maps to is the one
 * `census.tsv` recorded for every property of that type; the element types of
 * collections are the ones the spike's full stream dump showed.
 */
export const DECLARED_TYPE_SCHEMAS = {
  BooleanType: BoolValue,
  IntegerType: IntValue,
  StringType: StrValue,
  /** A `CardStateName` ordinal, which `DeltaPacket`'s static assert caps at 16 values. */
  CardStateViewType: z.strictObject({ t: z.literal('int'), v: z.int().min(0).max(15) }),
  CardViewType: IntValue,
  PlayerViewType: IntValue,
  StackItemViewType: IntValue,
  CardViewCollectionType: z.strictObject({ t: z.literal('list'), v: z.array(IntValue) }),
  PlayerViewCollectionType: z.strictObject({ t: z.literal('list'), v: z.array(IntValue) }),
  StackItemViewListType: z.strictObject({ t: z.literal('list'), v: z.array(IntValue) }),
  GameEntityViewType: z.strictObject({ t: z.literal('ints'), v: EntityMarker }),
  CombatViewType: CombatValue,
  /** Narrowed per property by `ENUM_PROPERTY_SCHEMAS`; this is the fallback. */
  EnumType: enumValue(z.string().min(1), z.string().min(1)),
  /** `ColorSet` is itself an enum (`ColorSet.java:38`); captured: `"W"`, `"BG"`, `"C"`. */
  ColorSetType: enumValue(z.literal('forge.card.ColorSet'), z.string().min(1)),
  CardTypeViewType: CardTypeValue,
  ManaCostType: ManaCostValue,
  KeywordCollectionViewType: KeywordsValue,
  CounterMapType: MultisetValue,
  IPaperCardType: PaperCardValue,
  ManaMapType: z.strictObject({ t: z.literal('map'), v: z.array(z.tuple([ByteValue, IntValue])) }),
  StringMapType: z.strictObject({ t: z.literal('map'), v: z.array(z.tuple([StrValue, StrValue])) }),
  StringListType: z.strictObject({ t: z.literal('list'), v: z.array(StrValue) }),
  StringSetType: z.strictObject({ t: z.literal('set'), v: z.array(StrValue) }),
  IntegerSetType: z.strictObject({ t: z.literal('set'), v: z.array(IntValue) }),
  GenericMapType: TaggedValueSchema,
  IntegerMapType: TaggedValueSchema,
  ObjectType: TaggedValueSchema,
} as const;

export type DeclaredType = keyof typeof DECLARED_TYPE_SCHEMAS;

/**
 * The declared types no captured game has ever produced a value for
 * (`docs/spikes/tier-c.md`, "Not verified"). They get `TaggedValueSchema`
 * rather than a narrower guess; the test holds this list equal to what
 * `coverage.tsv` says was never observed.
 */
export const UNOBSERVED_DECLARED_TYPES = [
  'GenericMapType',
  'IntegerMapType',
  'ObjectType',
] as const;

/**
 * The 214 `TrackableProperty` constants, in declaration order — so a
 * property's index here is its ordinal, which is what `checksumProperties`
 * carries — each with its declared type. Transcribed from `coverage.tsv`;
 * `tier-c.test.ts` fails if the two ever differ.
 */
export const STATE_PROPERTIES = {
  PreventNextDamage: 'IntegerType',
  AttachedCards: 'CardViewCollectionType',
  Counters: 'CounterMapType',
  CurrentPlane: 'StringType',
  PlanarPlayer: 'PlayerViewType',
  Owner: 'PlayerViewType',
  Controller: 'PlayerViewType',
  Zone: 'EnumType',
  GamePieceType: 'EnumType',
  IsEmblem: 'BooleanType',
  IsBoon: 'BooleanType',
  CanSpecialize: 'BooleanType',
  Flipped: 'BooleanType',
  Facedown: 'BooleanType',
  Foretold: 'BooleanType',
  Modal: 'BooleanType',
  Secondary: 'BooleanType',
  DoubleFaced: 'BooleanType',
  FacedownImageKey: 'StringType',
  PaperFoil: 'BooleanType',
  Cloner: 'StringType',
  Cloned: 'BooleanType',
  FlipCard: 'BooleanType',
  SplitCard: 'BooleanType',
  MergedCards: 'StringType',
  MergedCardsCollection: 'CardViewCollectionType',
  RevealedCardsCollection: 'CardViewCollectionType',
  PaperCardBackup: 'IPaperCardType',
  Attacking: 'BooleanType',
  Blocking: 'BooleanType',
  PhasedOut: 'BooleanType',
  Sickness: 'BooleanType',
  Tapped: 'BooleanType',
  Token: 'BooleanType',
  TokenCard: 'BooleanType',
  IsCommander: 'BooleanType',
  IsRingBearer: 'BooleanType',
  CommanderAltType: 'StringType',
  Damage: 'IntegerType',
  AssignedDamage: 'IntegerType',
  LethalDamage: 'IntegerType',
  ShieldCount: 'IntegerType',
  ChosenType: 'StringType',
  ChosenType2: 'StringType',
  NotedTypes: 'StringListType',
  ChosenColors: 'StringListType',
  ChosenCards: 'CardViewCollectionType',
  ChosenNumber: 'StringType',
  StoredRolls: 'StringListType',
  ChosenPlayer: 'PlayerViewType',
  PromisedGift: 'PlayerViewType',
  ProtectingPlayer: 'PlayerViewType',
  ChosenDirection: 'EnumType',
  ChosenEvenOdd: 'EnumType',
  ChosenMode: 'StringType',
  Sector: 'StringType',
  Sprocket: 'IntegerType',
  DraftAction: 'StringListType',
  ClassLevel: 'IntegerType',
  RingLevel: 'IntegerType',
  CurrentRoom: 'StringType',
  Intensity: 'IntegerType',
  OverlayText: 'StringType',
  MarkerText: 'StringListType',
  Remembered: 'StringType',
  NamedCard: 'StringListType',
  PlayerMayLook: 'PlayerViewCollectionType',
  EntityAttachedTo: 'GameEntityViewType',
  EncodedCards: 'CardViewCollectionType',
  UntilLeavesBattlefield: 'CardViewCollectionType',
  GainControlTargets: 'CardViewCollectionType',
  CloneOrigin: 'CardViewType',
  ExiledWith: 'CardViewType',
  PreparedSpell: 'CardViewType',
  WasDestroyed: 'BooleanType',
  NeedsTransformAnimation: 'BooleanType',
  NeedsUntapAnimation: 'BooleanType',
  NeedsTapAnimation: 'BooleanType',
  MarkedColors: 'ColorSetType',
  ImprintedCards: 'CardViewCollectionType',
  ExiledCards: 'CardViewCollectionType',
  HauntedBy: 'CardViewCollectionType',
  Haunting: 'CardViewType',
  MustBlockCards: 'CardViewCollectionType',
  PairedWith: 'CardViewType',
  CurrentState: 'CardStateViewType',
  AlternateState: 'CardStateViewType',
  LeftSplitState: 'CardStateViewType',
  RightSplitState: 'CardStateViewType',
  Room: 'BooleanType',
  HiddenId: 'IntegerType',
  ExertedThisTurn: 'BooleanType',
  Detained: 'BooleanType',
  Name: 'StringType',
  Colors: 'ColorSetType',
  OriginalColors: 'ColorSetType',
  ImageKey: 'StringType',
  Type: 'CardTypeViewType',
  ManaCost: 'ManaCostType',
  OriginalManaCost: 'ManaCostType',
  SetCode: 'StringType',
  Rarity: 'EnumType',
  FunctionalVariant: 'StringType',
  OracleText: 'StringType',
  RulesText: 'StringType',
  OracleName: 'StringType',
  Power: 'IntegerType',
  Toughness: 'IntegerType',
  Loyalty: 'StringType',
  Defense: 'StringType',
  AttractionLights: 'IntegerSetType',
  ChangedColorWords: 'StringMapType',
  HasChangedColors: 'BooleanType',
  HasPrintedPT: 'BooleanType',
  ChangedTypes: 'StringMapType',
  OrigProduceMana: 'ColorSetType',
  OrigProduceAnyMana: 'BooleanType',
  Keywords: 'KeywordCollectionViewType',
  HasAnnihilator: 'BooleanType',
  HasWard: 'BooleanType',
  BlockAdditional: 'IntegerType',
  BlockAny: 'BooleanType',
  AbilityText: 'StringType',
  NonAbilityText: 'StringType',
  HasDivideDamage: 'BooleanType',
  FoilIndex: 'IntegerType',
  CantHaveKeyword: 'StringSetType',
  IsAI: 'BooleanType',
  LobbyPlayerName: 'StringType',
  AvatarIndex: 'IntegerType',
  AvatarCardImageKey: 'StringType',
  SleeveIndex: 'IntegerType',
  SleeveArtKey: 'StringType',
  SleeveArtOffset: 'IntegerType',
  Opponents: 'PlayerViewCollectionType',
  Life: 'IntegerType',
  MaxHandSize: 'IntegerType',
  HasUnlimitedHandSize: 'BooleanType',
  MaxLandPlay: 'IntegerType',
  HasUnlimitedLandPlay: 'BooleanType',
  NumLandThisTurn: 'IntegerType',
  NumManaShards: 'IntegerType',
  DraftNotes: 'StringMapType',
  NumDrawnThisTurn: 'IntegerType',
  AdditionalVote: 'IntegerType',
  OptionalAdditionalVote: 'IntegerType',
  ControlVotes: 'BooleanType',
  AdditionalVillainousChoices: 'IntegerType',
  Commander: 'CardViewCollectionType',
  CommanderCast: 'IntegerMapType',
  CommanderDamage: 'IntegerMapType',
  MindSlaveMaster: 'PlayerViewType',
  Ante: 'CardViewCollectionType',
  Battlefield: 'CardViewCollectionType',
  Command: 'CardViewCollectionType',
  Exile: 'CardViewCollectionType',
  Flashback: 'CardViewCollectionType',
  Graveyard: 'CardViewCollectionType',
  Hand: 'CardViewCollectionType',
  Library: 'CardViewCollectionType',
  Sideboard: 'CardViewCollectionType',
  PlanarDeck: 'CardViewCollectionType',
  SchemeDeck: 'CardViewCollectionType',
  AttractionDeck: 'CardViewCollectionType',
  ContraptionDeck: 'CardViewCollectionType',
  Junkyard: 'CardViewCollectionType',
  Mana: 'ManaMapType',
  IsExtraTurn: 'BooleanType',
  ExtraTurnCount: 'IntegerType',
  HasPriority: 'BooleanType',
  AvatarLifeDifference: 'IntegerType',
  HasLost: 'BooleanType',
  HasAvailableActions: 'BooleanType',
  HostCard: 'CardViewType',
  Description: 'StringType',
  CanPlay: 'BooleanType',
  PromptIfOnlyPossibleAbility: 'BooleanType',
  SA_IsSpell: 'BooleanType',
  HasBackSide: 'BooleanType',
  Key: 'StringType',
  SourceTrigger: 'IntegerType',
  SourceCard: 'CardViewType',
  ActivatingPlayer: 'PlayerViewType',
  TargetCards: 'CardViewCollectionType',
  TargetPlayers: 'PlayerViewCollectionType',
  SubInstance: 'StackItemViewType',
  Ability: 'BooleanType',
  OptionalTrigger: 'BooleanType',
  OptionalCosts: 'StringType',
  AttackersWithDefenders: 'GenericMapType',
  AttackersWithBlockers: 'GenericMapType',
  BandsWithDefenders: 'GenericMapType',
  BandsWithBlockers: 'GenericMapType',
  AttackersWithPlannedBlockers: 'GenericMapType',
  BandsWithPlannedBlockers: 'GenericMapType',
  CombatView: 'CombatViewType',
  Players: 'PlayerViewCollectionType',
  GameType: 'EnumType',
  Title: 'StringType',
  Turn: 'IntegerType',
  WinningPlayerName: 'StringType',
  WinningTeam: 'IntegerType',
  MatchOver: 'BooleanType',
  Mulligan: 'BooleanType',
  NumGamesInMatch: 'IntegerType',
  NumPlayedGamesInMatch: 'IntegerType',
  Stack: 'StackItemViewListType',
  StormCount: 'IntegerType',
  GameOver: 'BooleanType',
  PoisonCountersToLose: 'IntegerType',
  PlayerTurn: 'PlayerViewType',
  Phase: 'EnumType',
  Object: 'ObjectType',
  Dependencies: 'StringType',
} as const satisfies Record<string, DeclaredType>;

export type StateProperty = keyof typeof STATE_PROPERTIES;

export const STATE_PROPERTY_COUNT = Object.keys(STATE_PROPERTIES).length;

/**
 * `EnumType` properties whose enum class a capture has pinned. Zone and Phase
 * also pin the constant, using this package's own `ZONE_TYPES` / `PHASE_TYPES`.
 * `ChosenDirection` and `ChosenEvenOdd` were never observed and keep the
 * fallback.
 */
export const ENUM_PROPERTY_SCHEMAS = {
  Zone: enumValue(z.literal('forge.game.zone.ZoneType'), z.enum(ZONE_TYPES)),
  Phase: enumValue(z.literal('forge.game.phase.PhaseType'), z.enum(PHASE_TYPES)),
  Rarity: enumValue(z.literal('forge.card.CardRarity'), z.string().min(1)),
  GamePieceType: enumValue(z.literal('forge.card.GamePieceType'), z.string().min(1)),
  GameType: enumValue(z.literal('forge.game.GameType'), z.string().min(1)),
} as const satisfies Partial<Record<StateProperty, z.ZodType>>;

function valueSchemaFor(property: StateProperty): z.ZodType {
  const pinned = (ENUM_PROPERTY_SCHEMAS as Partial<Record<StateProperty, z.ZodType>>)[property];
  return pinned ?? DECLARED_TYPE_SCHEMAS[STATE_PROPERTIES[property]];
}

/**
 * Every property is optional (a delta names only what changed) and nullable:
 * `null` is a real value on this wire, the "it is no longer true" signal —
 * 23 of the 133 captured (property, class) pairs were `null` at least once.
 */
type PropertyShape = {
  [K in StateProperty]: z.ZodOptional<
    z.ZodNullable<(typeof DECLARED_TYPE_SCHEMAS)[(typeof STATE_PROPERTIES)[K]]>
  >;
};

const PROPERTY_SHAPE = Object.fromEntries(
  (Object.keys(STATE_PROPERTIES) as StateProperty[]).map((property) => [
    property,
    valueSchemaFor(property).nullable().optional(),
  ]),
) as PropertyShape;

/* ── Objects and tables ──────────────────────────────────────────────── */

/**
 * One tracked object's properties. `_type` and `_id` repeat what the delta key
 * already packs, so a client never has to bit-twiddle; the table schema checks
 * they agree with the key. Strict: a property name outside the 214 fails with
 * that name in the path.
 */
export const TrackedObjectSchema = z
  .strictObject({
    _type: z.int().min(0).max(DELTA_OBJECT_TYPES.length - 1),
    _id: JavaInt,
    ...PROPERTY_SHAPE,
  })
  .superRefine((object, ctx) => {
    // DeltaSyncManager only puts an object in either map when it has at least
    // one property (`DeltaSyncManager.java:257,281`).
    if (!Object.keys(object).some((key) => !key.startsWith('_'))) {
      ctx.addIssue({ code: 'custom', message: 'a tracked object carries at least one property' });
    }
  });

export type TrackedObject = z.infer<typeof TrackedObjectSchema>;

/**
 * `Map<Integer deltaKey, Map<TrackableProperty, Object>>` — the shape of
 * `newObjects`, `objectDeltas`, and a full `setGameView` state.
 */
export const ObjectTableSchema = z
  .record(DeltaKeySchema, TrackedObjectSchema)
  .superRefine((table, ctx) => {
    for (const [key, object] of Object.entries(table)) {
      const k = Number(key);
      if (object._type !== deltaKeyType(k)) {
        ctx.addIssue({
          code: 'custom',
          path: [key, '_type'],
          message: `_type ${object._type} disagrees with delta key ${key}, type ${deltaKeyType(k)}`,
        });
      }
      if (object._id !== deltaKeyId(k)) {
        ctx.addIssue({
          code: 'custom',
          path: [key, '_id'],
          message: `_id ${object._id} disagrees with delta key ${key} (id ${deltaKeyId(k)})`,
        });
      }
    }
  });

export type ObjectTable = z.infer<typeof ObjectTableSchema>;

/**
 * The whole game, as `setGameView` carries it and a board renderer consumes
 * it: an object table holding exactly one `GameView` (type tag 3), whose
 * `Players` ids lead to the players and whose zones lead to the cards.
 *
 * `GameStateSchema.parse(x)` is the one-liner for a full state.
 */
export const GameStateSchema = ObjectTableSchema.superRefine((table, ctx) => {
  const games = Object.values(table).filter((o) => o._type === GAME_VIEW_TYPE_TAG).length;
  if (games !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: `a game state holds exactly one GameView (type ${GAME_VIEW_TYPE_TAG}); found ${games}`,
    });
  }
});

export type GameState = z.infer<typeof GameStateSchema>;

/**
 * The events arm of a `DeltaPacket` — OPAQUE, and owned by Wave 8 lane B
 * (`packages/forge-wire/src/events/`). What the spike captured here is
 * `TrackableSerializer.WrappedEvent` records around Java-serialized bytes,
 * which no browser can read; the JSON form of the 36 `GameEvent`s a real match
 * fires is lane B's schema, not this one. When it lands it replaces this
 * schema, and the state arm above does not change.
 */
export const DeltaEventsArmSchema = z.array(z.unknown());

/** `Long.MAX_VALUE`-safe enough: a sequence number past 2^53 is decades of packets. */
const SequenceNumber = z.int().min(-1);

/**
 * `DeltaPacket` (`DeltaPacket.java:24-32`). `seq` is -1 on an events-only
 * packet (`DeltaPacket.eventsOnly`, `:103-107`); `checksumProperties` holds
 * `TrackableProperty` ordinals, empty on the packets that carry no checksum.
 *
 * `DeltaPacketSchema.parse(x)` is the one-liner for a delta.
 */
export const DeltaPacketSchema = z.strictObject({
  seq: SequenceNumber,
  checksum: JavaInt,
  checksumProperties: z.array(z.int().min(0).max(STATE_PROPERTY_COUNT - 1)),
  newObjects: ObjectTableSchema,
  objectDeltas: ObjectTableSchema,
  events: DeltaEventsArmSchema,
});

export type DeltaPacket = z.infer<typeof DeltaPacketSchema>;

/**
 * Wave 49 §A — what each stack item targets, when that target is itself
 * ANOTHER item on the stack (a spell counter-targeting a spell, or an
 * ability targeting an ability).
 *
 * Not a `TrackableProperty`: `STATE_PROPERTIES` above stays pinned at
 * Forge's real 214 (`tier-c.test.ts` cross-checks it against
 * `coverage.tsv`), and `forge/` is stock upstream, not ours to add a 215th
 * constant to (`AGENTS.md`: "Don't modify `forge/` until the fork exists").
 * `StackItemView.java`'s own `TargetCards`/`TargetPlayers` are typed
 * `CardViewCollectionType`/`PlayerViewCollectionType` and Forge's
 * `TargetChoices` can hold a bare `SpellAbility` for "counter target spell",
 * which fails both of their runtime-type filters
 * (`scenario-w46-b-counterspell.jvm.test.ts`, confirmed against the real
 * jar) — so there is no wire fact for this at the per-object property-bag
 * layer at all. `PlayBridge.java` computes it itself, straight off the live
 * `MagicStack`, and sends it as a SIBLING of `gameView`/`packet` in the
 * frame's own payload — additive to the envelope, not to `STATE_PROPERTIES`.
 *
 * `[fromStackItemId, toStackItemId]` pairs, one per stack item that targets
 * another stack item, whether the target is the item's own or a
 * sub-instance's (a charm's chosen mode, `PlayBridge.java`'s
 * `stackTargetOf`). Forge's own stack-target ask offers one choice at a
 * time, so a real game never has a second target to carry here.
 * Optional on the payload: a historical capture or fixture predating this
 * addition parses exactly as it did before — "additive and strict" (see
 * `AGENTS.md`'s Settled note) does not mean every past frame grows the key,
 * only that a frame carrying it must shape it exactly so.
 */
export const StackTargetSpellsSchema = z.array(z.tuple([JavaInt, JavaInt]));

export type StackTargetSpells = z.infer<typeof StackTargetSpellsSchema>;

/**
 * The bridge's own addition beside `stackTargetSpells`: the triggers Forge has collected and not
 * yet put on the stack (`PlayBridge.java`'s `pendingTriggersJson`, read off `MagicStack`'s
 * `activePlayerSAs` and `simultaneousStackEntryList`). `id` is the trigger's own ability id (not a
 * stack id: it has none yet), `key` its auto-yield key (`WrappedAbility.yieldKey`, the card's words
 * the chip reads), `current` the one whose target question is open. A full snapshot each time.
 */
export const PendingTriggersSchema = z.array(
  z.strictObject({ id: JavaInt, hostCard: JavaInt, controller: JavaInt, key: z.string(), current: z.literal(true).optional() }),
);

export type PendingTriggers = z.infer<typeof PendingTriggersSchema>;

/**
 * The bridge's third addition beside the packet: what a resolved ability left waiting on the card
 * that made it (`PlayBridge.java`'s `waitingEffectsJson`) — a delayed trigger Forge holds until it
 * fires (`kind: 'trigger'`), or a command-zone effect naming its source (`kind: 'effect'`). `source`
 * is that card's id, `text` Forge's own description. A full snapshot each time.
 */
export const WaitingEffectsSchema = z.array(z.strictObject({ source: JavaInt, text: z.string(), kind: z.enum(['trigger', 'effect']) }));

export type WaitingEffects = z.infer<typeof WaitingEffectsSchema>;

/**
 * The bridge's fourth addition beside the packet: which card made each token on a battlefield
 * (`PlayBridge.java`'s `tokenSourcesJson`, off `Card.getTokenSpawningAbility`'s host) as
 * `[tokenId, sourceId]` pairs — the view itself never says. A full snapshot each time.
 */
export const TokenSourcesSchema = z.array(z.tuple([JavaInt, JavaInt]));

export type TokenSources = z.infer<typeof TokenSourcesSchema>;

/**
 * The bridge's fifth addition beside the packet: the ids of the creatures on a battlefield that
 * can't block (`PlayBridge.java`'s `cantBlockJson`, Forge's own `CombatUtil.canBlock(card, true)`:
 * the creature's restriction, not whether it is tapped) — the view itself never says. A full
 * snapshot each time.
 */
export const CantBlockSchema = z.array(JavaInt);

export type CantBlock = z.infer<typeof CantBlockSchema>;

/**
 * The bridge's sixth addition beside the packet: the damage dealt to cards since the seat's last
 * state frame (`PlayBridge.java`'s `DamageJournal`, Forge's own `GameEventCardDamaged`), oldest
 * first, as `[targetId, sourceId, amount]` — `sourceId` -1 when Forge names none. An event list, not
 * a snapshot, and only on `applyDelta`: a creature killed by it is in its graveyard, its damage
 * wiped, by the time the frame is built, so the view alone never says it was hit.
 */
export const DamageSchema = z.array(z.tuple([JavaInt, JavaInt, JavaInt]));

export type Damage = z.infer<typeof DamageSchema>;

/* ── The three frames ────────────────────────────────────────────────── */

/**
 * `void setGameView(GameView gameView, long sequenceNumber)` —
 * ProtocolMethod.java:35, IGuiGame.java:57. The full-state baseline;
 * `sequenceNumber` is -1 on the batch-flush resend
 * (`RemoteClientGuiGame.java:214`). `stackTargetSpells` is the bridge's own
 * addition — see {@link StackTargetSpellsSchema}.
 */
export const SetGameViewSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('setGameView'),
  payload: z.strictObject({
    gameView: GameStateSchema,
    sequenceNumber: SequenceNumber,
    stackTargetSpells: StackTargetSpellsSchema.optional(),
    pendingTriggers: PendingTriggersSchema.optional(),
    waitingEffects: WaitingEffectsSchema.optional(),
    tokenSources: TokenSourcesSchema.optional(),
    cantBlock: CantBlockSchema.optional(),
  }),
});

/**
 * `void openView(TrackableCollection<PlayerView> myPlayers)` —
 * ProtocolMethod.java:36, IGuiGame.java:68. The seats this client controls, as
 * player ids.
 */
export const OpenViewSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('openView'),
  payload: z.strictObject({
    myPlayers: z
      .array(JavaInt)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'a player is listed once'),
  }),
});

/**
 * `void applyDelta(DeltaPacket packet)` — ProtocolMethod.java:79,
 * IGuiGame.java:304. The incremental state channel. `stackTargetSpells` is
 * the bridge's own addition, a sibling of `packet` rather than a field
 * inside it — see {@link StackTargetSpellsSchema}.
 */
export const ApplyDeltaSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('applyDelta'),
  payload: z.strictObject({
    packet: DeltaPacketSchema,
    stackTargetSpells: StackTargetSpellsSchema.optional(),
    pendingTriggers: PendingTriggersSchema.optional(),
    waitingEffects: WaitingEffectsSchema.optional(),
    tokenSources: TokenSourcesSchema.optional(),
    cantBlock: CantBlockSchema.optional(),
    damage: DamageSchema.optional(),
  }),
});

/** The three Tier C frames, as the envelope's discriminated union consumes them. */
export const TIER_C_SERVER_FRAMES = [SetGameViewSchema, OpenViewSchema, ApplyDeltaSchema] as const;

/**
 * Tier C has no client→server half. All three methods are `Mode.SERVER` and
 * none blocks, so there are no replies either — `TIER_C_REPLIES` is empty on
 * purpose rather than missing.
 */
export const TIER_C_REPLIES = {} as const;
