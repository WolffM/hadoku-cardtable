/*
 * The 41 GameEvent classes captured on the wire — one schema each.
 *
 * The count is a measurement, and it moves with the deck draw. Wave 7 lane A's
 * 12 games (`scripts/spike/tierc/out/phase2-capture.txt`) fired 36 classes.
 * This lane's committed capture (`fixtures/census.json`) is 100 games — 40
 * random-precon games, then 60 more whose first two were AIMED at dice with
 * `-Devents.decks` — and fired 41: all 36 of Wave 7's plus
 * `GameEventCardForetold`, `GameEventCardModeChosen`,
 * `GameEventCardRegenerated`, `GameEventPlayerCounters` and
 * `GameEventPlayerPoisoned`. A 12-game run of this lane fired only 34 (no
 * `RollDie`, no `Scry`), which is why the census merges runs: a class seen once
 * stays evidenced. Modelling the five extras instead of refusing them follows
 * the rule the refusals exist for — refuse what nobody has seen, model what
 * somebody has.
 *
 * Every schema below was validated against EVERY decoded instance of those 100
 * games — 330,942 events — by `capture/validate-dump.ts`, not only against the
 * samples. The samples committed under `fixtures/` (kept so that together they
 * show every field-path/JSON-kind pair the 100 games produced) are what
 * `events.test.ts` parses, and breaks, on every run.
 *
 * Each event is a Java `record`, and its JSON is its record components in
 * declaration order under their Java names, plus `event` — the record's simple
 * class name — as the discriminator. (Not `type`: `GameEventAddLog`,
 * `GameEventCardCounters` and `GameEventCardDamaged` each have a component
 * called `type`, and the first capture overwrote the class name with it.) Every field is REQUIRED; a Java component
 * that can be null is `.nullable()`, never `.optional()`, because the decoder
 * always writes every component and a missing key therefore means a broken
 * frame, not an absent value.
 *
 * Record sources are `forge-game/src/main/java/forge/game/event/<Class>.java`,
 * the `public record` line cited per schema. Nullability is justified either by
 * a constructor that passes null or by a captured null, and says which.
 */

import { z } from 'zod';

import { PhaseTypeSchema, PlayerRefSchema, ZoneTypeSchema } from '../refs.ts';
import {
  CounterNameSchema,
  DamageTypeSchema,
  EventCardSchema,
  EventEntitySchema,
  EventValueChangeTypeSchema,
  GameLogEntryTypeSchema,
  GameTypeSchema,
  InlineSpellAbilitySchema,
  InlineStackItemSchema,
  MagicColorSchema,
  ZoneViewSchema,
  mapSchema,
  multimapSchema,
} from './common.ts';

function event<E extends string, S extends z.ZodRawShape>(name: E, shape: S) {
  return z.strictObject({ event: z.literal(name), ...shape });
}

const int = z.number().int();
const player = PlayerRefSchema;
const card = EventCardSchema;

/* ── Log, turn and priority ──────────────────────────────────────────── */

/** `GameEventAddLog(GameLogEntryType type, String message, CardView sourceCard)` — :7. `sourceCard` is null from the two-argument constructor (:9-11); captured null in almost every instance. */
export const AddLogSchema = event('GameEventAddLog', {
  type: GameLogEntryTypeSchema,
  message: z.string(),
  sourceCard: card.nullable(),
});

/** `GameEventTurnBegan(PlayerView turnOwner, int turnNumber)` — :6. */
export const TurnBeganSchema = event('GameEventTurnBegan', { turnOwner: player, turnNumber: int });

/** `GameEventTurnEnded()` — :3. No components: the browser learns only that it happened. */
export const TurnEndedSchema = event('GameEventTurnEnded', {});

/** `GameEventTurnPhase(PlayerView playerTurn, PhaseType phase, String phaseDesc)` — :9. */
export const TurnPhaseSchema = event('GameEventTurnPhase', {
  playerTurn: player,
  phase: PhaseTypeSchema,
  phaseDesc: z.string(),
});

/** `GameEventPlayerPriority(PlayerView turn, PhaseType phase, PlayerView priority)` — :7. */
export const PlayerPrioritySchema = event('GameEventPlayerPriority', {
  turn: player,
  phase: PhaseTypeSchema,
  priority: player,
});

/* ── Game lifecycle ──────────────────────────────────────────────────── */

/** `GameEventGameStarted(GameType gameType, PlayerView firstTurn, Iterable<PlayerView> players)` — :9. `players` is an `FCollection`, a `java.util.List`. */
export const GameStartedSchema = event('GameEventGameStarted', {
  gameType: GameTypeSchema,
  firstTurn: player,
  players: z.array(player),
});

/** `GameEventGameFinished()` — :3. */
export const GameFinishedSchema = event('GameEventGameFinished', {});

/**
 * `GameEventGameOutcome(int lastTurnNumber, List<String> outcomeStrings, String winningPlayerName, String matchSummary)` — :16.
 * `winningPlayerName` is null when `getWinningLobbyPlayer()` is (a draw) — `computeWinningPlayerName`, :25-27. Never captured null (no draws).
 */
export const GameOutcomeSchema = event('GameEventGameOutcome', {
  lastTurnNumber: int,
  outcomeStrings: z.array(z.string()),
  winningPlayerName: z.string().nullable(),
  matchSummary: z.string(),
});

/** `GameEventMulligan(PlayerView player)` — :5. */
export const MulliganSchema = event('GameEventMulligan', { player });

/** `GameEventPlayerControl(PlayerView player, String newLobbyPlayerName, boolean newControllerIsHuman)` — :5. `newLobbyPlayerName` captured null. */
export const PlayerControlSchema = event('GameEventPlayerControl', {
  player,
  newLobbyPlayerName: z.string().nullable(),
  newControllerIsHuman: z.boolean(),
});

/** `GameEventShuffle(PlayerView player)` — :8. */
export const ShuffleSchema = event('GameEventShuffle', { player });

/** `GameEventFlipCoin()` — :3. No components: WHICH side came up is not on the wire. */
export const FlipCoinSchema = event('GameEventFlipCoin', {});

/** `GameEventRollDie()` — :3. No components: the result is not on the wire. */
export const RollDieSchema = event('GameEventRollDie', {});

/** `GameEventScry(PlayerView player, int toTop, int toBottom)` — :5. Counts only; which cards is hidden information and does not cross. */
export const ScrySchema = event('GameEventScry', { player, toTop: int, toBottom: int });

/* ── Players ─────────────────────────────────────────────────────────── */

/** `GameEventPlayerDamaged(PlayerView target, CardView source, int amount, boolean combat, boolean infect)` — :6. */
export const PlayerDamagedSchema = event('GameEventPlayerDamaged', {
  target: player,
  source: card,
  amount: int,
  combat: z.boolean(),
  infect: z.boolean(),
});

/** `GameEventPlayerLivesChanged(PlayerView player, int oldLives, int newLives)` — :8. */
export const PlayerLivesChangedSchema = event('GameEventPlayerLivesChanged', {
  player,
  oldLives: int,
  newLives: int,
});

/** `GameEventPlayerStatsChanged(FCollection<PlayerView> players)` — :12. "Re-read these players from state"; it carries no stats itself. */
export const PlayerStatsChangedSchema = event('GameEventPlayerStatsChanged', {
  players: z.array(player),
});

/**
 * `GameEventManaPool(PlayerView player, EventValueChangeType mode, Set<MagicColor.Color> colors)` — :10.
 * `colors` is null on `Cleared`: forge-game/.../mana/ManaPool.java:173 passes
 * null. The first draft of this schema missed it; validating EVERY captured
 * instance, not just the fixture samples, caught it (`capture/validate-dump.ts`:
 * one `Cleared` among 1,119 ManaPool events in the first 12-game run).
 */
export const ManaPoolSchema = event('GameEventManaPool', {
  player,
  mode: EventValueChangeTypeSchema,
  colors: z.array(MagicColorSchema).nullable(),
});

/**
 * `GameEventPlayerCounters(PlayerView receiver, CounterType type, int oldValue, int amount)` — :7.
 * `type` is null when a player's counters are cleared or replaced wholesale
 * (forge-game/.../player/Player.java:914,939 pass null, 0, 0). NOTE `amount`
 * is the NEW TOTAL, not a delta, despite its name: Player.java:922 passes
 * `num`, the value just set.
 */
export const PlayerCountersSchema = event('GameEventPlayerCounters', {
  receiver: player,
  type: CounterNameSchema.nullable(),
  oldValue: int,
  amount: int,
});

/**
 * `GameEventPlayerPoisoned(PlayerView receiver, PlayerView source, int oldValue, int amount)` — :10.
 * Here `amount` IS a delta (Player.java:924 passes `num - old`). `source` is
 * null when poison is added with no source player (Player.java:893 passes
 * null); never captured null.
 */
export const PlayerPoisonedSchema = event('GameEventPlayerPoisoned', {
  receiver: player,
  source: player.nullable(),
  oldValue: int,
  amount: int,
});

/* ── Cards ───────────────────────────────────────────────────────────── */

/** `GameEventCardStatsChanged(Collection<CardView> cards, boolean transform)` — :15. "Re-read these cards from state." */
export const CardStatsChangedSchema = event('GameEventCardStatsChanged', {
  cards: z.array(card),
  transform: z.boolean(),
});

/** `GameEventCardTapped(CardView card, boolean tapped)` — :6. */
export const CardTappedSchema = event('GameEventCardTapped', { card, tapped: z.boolean() });

/**
 * `GameEventCardChangeZone(CardView card, ZoneView from, ZoneView to)` — :9.
 * Either end is null when the engine passes a null `Zone` (:13-14 null-check each); `from` captured null.
 */
export const CardChangeZoneSchema = event('GameEventCardChangeZone', {
  card,
  from: ZoneViewSchema.nullable(),
  to: ZoneViewSchema.nullable(),
});

/** `GameEventCardCounters(CardView card, CounterType type, int oldValue, int newValue)` — :7. */
export const CardCountersSchema = event('GameEventCardCounters', {
  card,
  type: CounterNameSchema,
  oldValue: int,
  newValue: int,
});

/** `GameEventCardDamaged(CardView card, CardView source, int amount, DamageType type)` — :5. */
export const CardDamagedSchema = event('GameEventCardDamaged', {
  card,
  source: card,
  amount: int,
  type: DamageTypeSchema,
});

/** `GameEventCardDestroyed()` — :3. No components: WHICH card is not on the wire; a following zone change says. */
export const CardDestroyedSchema = event('GameEventCardDestroyed', {});

/** `GameEventCardSacrificed(CardView card)` — :5. */
export const CardSacrificedSchema = event('GameEventCardSacrificed', { card });

/**
 * `GameEventCardAttachment(CardView equipment, GameEntityView oldEntity, GameEntityView newTarget)` — :8.
 * `oldEntity` is null on a first attach and `newTarget` on a detach (`toString`, :24); both captured null.
 */
export const CardAttachmentSchema = event('GameEventCardAttachment', {
  equipment: card,
  oldEntity: EventEntitySchema.nullable(),
  newTarget: EventEntitySchema.nullable(),
});

/** `GameEventTokenCreated()` — :3. No components: the token arrives through the state arm. */
export const TokenCreatedSchema = event('GameEventTokenCreated', {});

/** `GameEventLandPlayed(PlayerView player, CardView land)` — :6. */
export const LandPlayedSchema = event('GameEventLandPlayed', { player, land: card });

/**
 * `GameEventZone(ZoneType zoneType, PlayerView player, EventValueChangeType mode, CardView card, SpellAbilityView sa)` — :18.
 * The single most frequent event on the wire. `player` is null for a shared
 * zone (captured: the battlefield, the stack); `card` and `sa` are null for a
 * whole-zone `ComplexUpdate`; `sa` is null from the four-argument constructor
 * (:20) and set from the spell-ability one (:24). All three captured null.
 */
export const ZoneSchema = event('GameEventZone', {
  zoneType: ZoneTypeSchema,
  player: player.nullable(),
  mode: EventValueChangeTypeSchema,
  card: card.nullable(),
  sa: InlineSpellAbilitySchema.nullable(),
});

/**
 * `GameEventCardRegenerated(Collection<CardView> cards)` — :9. The public
 * constructor wraps one card in a singleton list (:10-12).
 */
export const CardRegeneratedSchema = event('GameEventCardRegenerated', { cards: z.array(card) });

/**
 * `GameEventCardModeChosen(PlayerView player, String cardName, String mode, boolean log, boolean random)` — :6.
 * The card is carried by NAME, not reference (ChooseGenericEffect.java:123
 * passes `host.getName()`).
 */
export const CardModeChosenSchema = event('GameEventCardModeChosen', {
  player,
  cardName: z.string(),
  mode: z.string(),
  log: z.boolean(),
  random: z.boolean(),
});

/**
 * `GameEventCardForetold(PlayerView activatingPlayer)` — :5. Only the player:
 * WHICH card was foretold is not on the wire (it is face-down in exile, so
 * that is hidden information by design).
 */
export const CardForetoldSchema = event('GameEventCardForetold', { activatingPlayer: player });

/* ── Stack ───────────────────────────────────────────────────────────── */

/**
 * `GameEventSpellAbilityCast(SpellAbilityView sa, StackItemView si, int stackIndex, String targetDescription)` — :9.
 * `targetDescription` is null when the ability has no targets
 * (`computeTargetDescription`, :15-21); captured null.
 */
export const SpellAbilityCastSchema = event('GameEventSpellAbilityCast', {
  sa: InlineSpellAbilitySchema,
  si: InlineStackItemSchema,
  stackIndex: int,
  targetDescription: z.string().nullable(),
});

/** `GameEventSpellRemovedFromStack(SpellAbilityView sa)` — :5. */
export const SpellRemovedFromStackSchema = event('GameEventSpellRemovedFromStack', {
  sa: InlineSpellAbilitySchema,
});

/** `GameEventSpellResolved(SpellAbilityView spell, boolean hasFizzled, String stackDescription)` — :6. */
export const SpellResolvedSchema = event('GameEventSpellResolved', {
  spell: InlineSpellAbilitySchema,
  hasFizzled: z.boolean(),
  stackDescription: z.string(),
});

/* ── Combat ──────────────────────────────────────────────────────────── */

/** `GameEventCombatChanged()` — :3. "Re-read combat from state." */
export const CombatChangedSchema = event('GameEventCombatChanged', {});

/**
 * `GameEventAttackersDeclared(PlayerView player, Multimap<GameEntityView, CardView> attackersMap)` — :15.
 * Defender (a player, or a planeswalker/battle card) → the attackers on it.
 */
export const AttackersDeclaredSchema = event('GameEventAttackersDeclared', {
  player,
  attackersMap: multimapSchema(EventEntitySchema, card),
});

/**
 * `GameEventBlockersDeclared(PlayerView defendingPlayer, Map<GameEntityView, Multimap<CardView, CardView>> blockers)` — :20.
 * Defender → (attacker → its blockers).
 */
export const BlockersDeclaredSchema = event('GameEventBlockersDeclared', {
  defendingPlayer: player,
  blockers: mapSchema(EventEntitySchema, multimapSchema(card, card)),
});

/** `GameEventCombatEnded(List<CardView> attackers, List<CardView> blockers)` — :9. Either list is null when `fromCards` is handed null (:11-14). Never captured null. */
export const CombatEndedSchema = event('GameEventCombatEnded', {
  attackers: z.array(card).nullable(),
  blockers: z.array(card).nullable(),
});

/** Every modelled class, keyed by the `event` discriminator. */
export const MODELLED_EVENTS = {
  GameEventAddLog: AddLogSchema,
  GameEventAttackersDeclared: AttackersDeclaredSchema,
  GameEventBlockersDeclared: BlockersDeclaredSchema,
  GameEventCardAttachment: CardAttachmentSchema,
  GameEventCardChangeZone: CardChangeZoneSchema,
  GameEventCardCounters: CardCountersSchema,
  GameEventCardDamaged: CardDamagedSchema,
  GameEventCardDestroyed: CardDestroyedSchema,
  GameEventCardForetold: CardForetoldSchema,
  GameEventCardModeChosen: CardModeChosenSchema,
  GameEventCardRegenerated: CardRegeneratedSchema,
  GameEventCardSacrificed: CardSacrificedSchema,
  GameEventCardStatsChanged: CardStatsChangedSchema,
  GameEventCardTapped: CardTappedSchema,
  GameEventCombatChanged: CombatChangedSchema,
  GameEventCombatEnded: CombatEndedSchema,
  GameEventFlipCoin: FlipCoinSchema,
  GameEventGameFinished: GameFinishedSchema,
  GameEventGameOutcome: GameOutcomeSchema,
  GameEventGameStarted: GameStartedSchema,
  GameEventLandPlayed: LandPlayedSchema,
  GameEventManaPool: ManaPoolSchema,
  GameEventMulligan: MulliganSchema,
  GameEventPlayerControl: PlayerControlSchema,
  GameEventPlayerCounters: PlayerCountersSchema,
  GameEventPlayerDamaged: PlayerDamagedSchema,
  GameEventPlayerLivesChanged: PlayerLivesChangedSchema,
  GameEventPlayerPoisoned: PlayerPoisonedSchema,
  GameEventPlayerPriority: PlayerPrioritySchema,
  GameEventPlayerStatsChanged: PlayerStatsChangedSchema,
  GameEventRollDie: RollDieSchema,
  GameEventScry: ScrySchema,
  GameEventShuffle: ShuffleSchema,
  GameEventSpellAbilityCast: SpellAbilityCastSchema,
  GameEventSpellRemovedFromStack: SpellRemovedFromStackSchema,
  GameEventSpellResolved: SpellResolvedSchema,
  GameEventTokenCreated: TokenCreatedSchema,
  GameEventTurnBegan: TurnBeganSchema,
  GameEventTurnEnded: TurnEndedSchema,
  GameEventTurnPhase: TurnPhaseSchema,
  GameEventZone: ZoneSchema,
} as const;

export type ModelledEventName = keyof typeof MODELLED_EVENTS;

export const MODELLED_EVENT_NAMES = Object.keys(MODELLED_EVENTS) as ModelledEventName[];

/**
 * The modelled classes whose JSON needed Java-side help — a BESPOKE rule in
 * `capture/EventJson.java` — in at least one captured instance, and which one.
 *
 * "Java-side help" is defined there, and computed per capture from the rules
 * that actually fired (`fixtures/census.json`, `javaSideHelp`); `events.test.ts`
 * fails if this list and the census disagree. Every OTHER modelled class is
 * produced by the generic rules alone: nulls, primitives, strings, enum names,
 * records, `java.util` collections and maps, and the two reference markers.
 *
 * None of these is a browser-side gap. Each needs a projection written once,
 * in the JVM bridge; the resulting JSON is complete and needs nothing further
 * from Java. That is also true of every event in the other group — all of them
 * arrive as Java serialization, so NONE is readable from the wire bytes
 * without a JVM decode.
 */
export const EVENTS_NEEDING_JAVA_HELP = {
  GameEventAttackersDeclared:
    'MULTIMAP — attackersMap is a Guava Multimap; Guava serializes it in its own format and it implements neither java.util.Map nor Collection',
  GameEventBlockersDeclared:
    'MULTIMAP — each value of the blockers map is a Guava Multimap',
  GameEventCardCounters:
    'COUNTER_TYPE — `type` is a CounterType: an interface with three implementations, written via Forge\'s getName()',
  GameEventPlayerCounters:
    'COUNTER_TYPE — as CardCounters',
  GameEventSpellAbilityCast:
    'TRACKABLE_INLINE — `sa` (SpellAbilityView) and `si` (StackItemView) arrive as whole view objects, not markers, and are projected to { ref, props }',
  GameEventSpellRemovedFromStack: 'TRACKABLE_INLINE — `sa` is an inline SpellAbilityView',
  GameEventSpellResolved: 'TRACKABLE_INLINE — `spell` is an inline SpellAbilityView',
  GameEventZone:
    'TRACKABLE_INLINE — `sa`, when set, is an inline SpellAbilityView (only in the zone events the spell-ability constructor fires)',
} as const satisfies Partial<Record<ModelledEventName, string>>;
