/*
 * @hadoku/forge-wire — the bridge contract.
 *
 * Zod schemas for the 41 Forge `ProtocolMethod`s a browser client actually
 * needs — Wave 6 lane F's 38 (`docs/spikes/itoclient.md`, item 3), plus the
 * `setWeaklySelectable` / `clearWeaklySelectable` pair Wave 19 lane B added so
 * the board can offer exactly what Forge offers at priority, plus
 * `setHighlighted`, which Wave 22 lane L added for the inputs that offer
 * through neither (the London mulligan is the one that reached the operator):
 *
 *   Tier A — 16 methods, scalars only. Transcription. `tier-a.ts`
 *   Tier B — 23 methods, entity references. `refs.ts` is the id scheme,
 *            `sideboard.ts` is the one method that is not a reference.
 *   Tier C —  3 methods, the state channel. `tier-c.ts`, modelled from and
 *            tested against Wave 7's captured packets. Its events arm is
 *            opaque until lane B's `events/` lands.
 *
 * `envelope.ts` is the transport: channel names, `notify` / `ask` / `act`, the
 * correlation id, the `abort` frame that answers Forge's untimed `ReplyPool`,
 * and the parse helpers.
 *
 * ## Nothing here imports from `forge/`
 *
 * The vendored tree is a 392k-line Java checkout and a git submodule that CI
 * does not even fetch. Every fact in this package came from reading it and is
 * cited file-and-line in a comment; not one line of it is a dependency. The
 * only imports are `zod` and `@hadoku/deck`.
 *
 * ## GPL, not MIT
 *
 * This package consumes Forge's protocol shape, so it is GPL-3.0-or-later like
 * the rest of the repo. D16's MIT carve-out is for `@hadoku/room-ask` alone and
 * does not generalise.
 */

export {
  TrackableIdSchema,
  CardRefSchema,
  PlayerRefSchema,
  SpellAbilityRefSchema,
  StackItemRefSchema,
  GameEntityRefSchema,
  EntityRefSchema,
  cardRef,
  playerRef,
  spellAbilityRef,
  ZONE_TYPES,
  ZoneTypeSchema,
  PHASE_TYPES,
  PhaseTypeSchema,
  NEXT_GAME_DECISIONS,
  NextGameDecisionSchema,
  TRIGGER_DECISIONS,
  TriggerDecisionSchema,
  EnumConstantNameSchema,
  SkinPropSchema,
  PrefKeySchema,
  TriggerEventSchema,
  PlayerZoneUpdateSchema,
  PlayerZoneUpdatesSchema,
  DelayedRevealSchema,
  ChoiceOptionSchema,
  JavaByteSchema,
  type CardRef,
  type PlayerRef,
  type SpellAbilityRef,
  type StackItemRef,
  type GameEntityRef,
  type EntityRef,
  type ZoneType,
  type PhaseType,
  type NextGameDecision,
  type TriggerDecision,
  type TriggerEvent,
  type PlayerZoneUpdate,
  type DelayedReveal,
  type ChoiceOption,
} from './refs.ts';

export {
  CardRequestSchema,
  DeckEntrySchema,
  CardPoolSchema,
  asCardRequest,
  asDeckEntry,
  cardRequest,
  flattenEntries,
  type WireCardRequest,
  type WireDeckEntry,
} from './sideboard.ts';

export {
  TIER_A_METHODS,
  TIER_A_SERVER_FRAMES,
  TIER_A_CLIENT_FRAMES,
  TIER_A_REPLIES,
  AfterGameEndSchema,
  FinishGameSchema,
  LossSchema,
  type Loss,
  ClearSelectablesSchema,
  ClearWeaklySelectableSchema,
  FlashIncorrectActionSchema,
  MessageSchema,
  GameLogLineSchema,
  type GameLogLine,
  ShowErrorDialogSchema,
  ShowConfirmDialogSchema,
  ShowConfirmDialogReplySchema,
  ShowOptionDialogSchema,
  ShowOptionDialogReplySchema,
  ShowInputDialogSchema,
  ShowInputDialogReplySchema,
  UseManaSchema,
  SelectButtonOkSchema,
  SelectButtonCancelSchema,
  ConcedeSchema,
  RequestResyncSchema,
  NextGameDecisionActionSchema,
  type TierAMethod,
} from './tier-a.ts';

export {
  TIER_B_METHODS,
  TIER_B_SERVER_FRAMES,
  TIER_B_CLIENT_FRAMES,
  TIER_B_REPLIES,
  YieldStateSnapshotSchema,
  YieldUpdateSchema,
  ShowPromptMessageSchema,
  YIELDING,
  UpdateButtonsSchema,
  HideZonesSchema,
  SetSelectablesSchema,
  SetHighlightedSchema,
  SetWeaklySelectableSchema,
  RestoreOldZonesSchema,
  ApplyYieldUpdateSchema,
  SendYieldUpdateSchema,
  type SendYieldUpdate,
  TempShowZonesSchema,
  TempShowZonesReplySchema,
  GetAbilityToPlaySchema,
  GetAbilityToPlayReplySchema,
  OfferedAbilitySchema,
  type OfferedAbility,
  AssignCombatDamageSchema,
  AssignCombatDamageReplySchema,
  GenericAmountKeySchema,
  AssignGenericAmountSchema,
  AssignGenericAmountReplySchema,
  ConfirmSchema,
  ConfirmReplySchema,
  GetChoicesSchema,
  GetChoicesReplySchema,
  OrderSchema,
  OrderReplySchema,
  SideboardSchema,
  SideboardReplySchema,
  ChooseSingleEntityForEffectSchema,
  ChooseSingleEntityForEffectReplySchema,
  ChooseEntitiesForEffectSchema,
  ChooseEntitiesForEffectReplySchema,
  ManipulateCardListSchema,
  ManipulateCardListReplySchema,
  OpenZonesSchema,
  OpenZonesReplySchema,
  SelectPlayerSchema,
  SelectCardSchema,
  SelectAbilitySchema,
  type TierBMethod,
  type YieldUpdate,
} from './tier-b.ts';

export {
  TIER_C_METHODS,
  TIER_C_SPIKE,
  TIER_C_SERVER_FRAMES,
  TIER_C_REPLIES,
  SetGameViewSchema,
  OpenViewSchema,
  ApplyDeltaSchema,
  StackTargetSpellsSchema,
  PendingTriggersSchema,
  WaitingEffectsSchema,
  TokenSourcesSchema,
  GameStateSchema,
  DeltaPacketSchema,
  ObjectTableSchema,
  TrackedObjectSchema,
  TaggedValueSchema,
  DeltaEventsArmSchema,
  DeltaKeySchema,
  DECLARED_TYPE_SCHEMAS,
  ENUM_PROPERTY_SCHEMAS,
  STATE_PROPERTIES,
  STATE_PROPERTY_COUNT,
  UNOBSERVED_DECLARED_TYPES,
  DELTA_OBJECT_TYPES,
  GAME_VIEW_TYPE_TAG,
  deltaKeyOf,
  deltaKeyType,
  deltaKeyId,
  type TierCMethod,
  type GameState,
  type DeltaPacket,
  type StackTargetSpells,
  type PendingTriggers,
  type WaitingEffects,
  type TokenSources,
  type ObjectTable,
  type TrackedObject,
  type TaggedValue,
  type StateProperty,
  type DeclaredType,
  type DeltaObjectType,
} from './tier-c.ts';

export {
  FORGE_CHANNEL,
  CallIdSchema,
  REQUIRED_METHODS,
  BLOCKING_METHODS,
  REPLY_SCHEMAS,
  ABORT_REASONS,
  AbortReasonSchema,
  ServerFrameSchema,
  ClientActionSchema,
  ClientReplySchema,
  ClientAbortSchema,
  ClientFrameSchema,
  isBlocking,
  isTierC,
  parseClientFrame,
  parseServerFrame,
  safeParseClientFrame,
  safeParseServerFrame,
  type RequiredMethod,
  type BlockingMethod,
  type ServerFrame,
  type ClientAction,
  type ClientReply,
  type ClientAbort,
  type ClientFrame,
  type ParseOutcome,
  type WireIssue,
} from './envelope.ts';

/*
 * Tier C's events arm — the JSON form of `DeltaPacket.events`. 41 GameEvent
 * classes modelled from captured instances, the other 17 of Forge's 58 refused
 * by name. `events/index.ts` has the whole story.
 */
export {
  GameEventSchema,
  GameEventListSchema,
  MODELLED_EVENTS,
  MODELLED_EVENT_NAMES,
  REFUSED_EVENTS,
  REFUSED_EVENT_NAMES,
  EVENTS_CAPTURE,
  EVENTS_NEEDING_JAVA_HELP,
  eventRefusal,
  EventCardSchema,
  EventEntitySchema,
  ZoneViewSchema,
  InlineSpellAbilitySchema,
  InlineStackItemSchema,
  CounterNameSchema,
  GAME_LOG_ENTRY_TYPES,
  GameLogEntryTypeSchema,
  EVENT_VALUE_CHANGE_TYPES,
  EventValueChangeTypeSchema,
  MAGIC_COLORS,
  MagicColorSchema,
  DAMAGE_TYPES,
  DamageTypeSchema,
  GAME_TYPES,
  GameTypeSchema,
  type GameEvent,
  type ModelledEventName,
  type RefusedEventName,
  type EventCard,
  type EventEntity,
  type InlineSpellAbility,
  type InlineStackItem,
} from './events/index.ts';
