/*
 * Tier B — the 23 methods that carry entity references.
 *
 * Wave 6 lane F (`docs/spikes/itoclient.md`, "Tier B — carry entity
 * references. Needs an id scheme, which Forge already has. 21 methods."), plus
 * `setWeaklySelectable`, which Wave 19 lane B added, plus `setHighlighted`,
 * which Wave 22 lane L added — see below for both. The
 * id scheme is `refs.ts`; this file is the transcription, with argument types
 * from `ProtocolMethod.java` and parameter names from `IGuiGame` /
 * `IGameController`.
 *
 * Twenty are server→client (twelve of them blocking) and three are
 * client→server. Together with Tier A's three, the blocking set is the 15 lane
 * F re-derived independently from `RemoteClientGuiGame`'s `sendAndWait` call
 * sites.
 *
 * ## `setWeaklySelectable` is the set Forge offers at PRIORITY
 *
 * Lane F's 38 did not include it, and that omission is what made the board
 * invent its own affordance: `setSelectables` is sent only by the two SELECTION
 * inputs (`InputSelectTargets.java:68`, `InputSelectEntitiesFromList.java:57`),
 * so outside a selection the client had nothing to go on and offered every card
 * it held. Forge does publish the priority-time answer — it just publishes it
 * through this method (ProtocolMethod.java:71-72, sent by
 * `RemoteClientGuiGame.java:507-516`), computed by
 * `PlayerControllerHuman.pushActionableCards` (:1543-1601) from
 * `AvailableActions.collectActionable` at priority and from
 * `cardHasPlayableManaAbility` during payment, and bracketed by
 * `clearActionableCards()` on every such input's `onStop`.
 *
 * It is gated on `FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS`, which defaults to
 * `"false"` (ForgePreferences.java:100) — our bridge turns it on
 * (`apps/server/src/play/bridge/PlayBridge.java`).
 *
 * ## `setHighlighted` is the set an input has MARKED
 *
 * Wave 22 lane L. It is the third and last entity frame Forge uses to say
 * anything per-card outside a selection, and it was missing: the bridge
 * implemented `setSelectables` and `setWeaklySelectable` and dropped this one,
 * so an input that speaks only through it reached a seat as prose plus a
 * two-button bar and nothing to click. `InputLondonMulligan` is that input —
 * see the note on the client side in `apps/ui/src/play/live/match.ts`.
 *
 * Unlike the other two it is INCREMENTAL and two-way: Forge calls it with
 * `true` to mark entities and with `false` to unmark them, one call per
 * change, against a set the GUI keeps
 * (`AbstractGuiGame.java:322-337` holds a `Set<GameEntityView>` and
 * adds/removes). So the wire carries the boolean and the client folds, rather
 * than replacing a set the way `setSelectables` does.
 *
 * Its argument is `Iterable<GameEntityView>`, not `Iterable<CardView>`
 * (IGuiGame.java:265, ProtocolMethod.java:70) — `InputSelectManyBase.java:127`
 * and `InputSelectTargets.java:409` both pass a player through it — so the
 * wire uses `GameEntityRefSchema`, which is exactly CardView-or-PlayerView.
 *
 * ## Three places where the transcription is a decision, not a copy
 *
 * 1. **`sideboard` is not a reference.** It passes two `CardPool`s — cards the
 *    client has never seen, because sideboarding happens between games. It is
 *    the only non-mechanical method in the tier and it gets its own file,
 *    `sideboard.ts`, built on `@hadoku/deck`.
 *
 * 2. **`openZones`'s `Map<PlayerView, Object>` is a player SET.** Forge's
 *    signature is `Map<PlayerView, Object> players` (IGuiGame.java:261) and the
 *    `Object` is untyped, which reads like a hole. It is not: every call site
 *    puts `null` — `TargetSelection.java:178-180` and
 *    `FControlGameEventHandler.java:443,451`, which are all four `.put(` sites
 *    in the tree. So the wire carries `PlayerRef[]` and no value. If a fifth
 *    call site ever puts something, this is the line that was wrong.
 *
 * 3. **`getChoices` and `order` are generic and carry a render function.**
 *    `<T>` has no wire type and `FSerializableFunction<T, String> display`
 *    cannot cross a socket. Both are projected onto `ChoiceOption`
 *    (`refs.ts`): a key, a pre-rendered label, and the entity the option stands
 *    for when it stands for one. The reply quotes keys back.
 *
 * ## `applyYieldUpdate` is here rather than in Tier A
 *
 * `YieldUpdate` is a sealed interface whose records embed `PlayerView`
 * (YieldUpdate.java:16-58), so it carries references. Its twelve arms are
 * transcribed below. Java's records have no tag field, so the wire adds one
 * (`update`); Java's maps are keyed by `PlayerView` and `FPref`, which are not
 * JSON object keys, so every map is an array of pairs.
 *
 * ## `sendYieldUpdate` is modelled, and is deliberately NOT in the census
 *
 * Wave 24 lane E. `sendYieldUpdate` — the client→server counterpart
 * (ProtocolMethod.java:101 `Mode.CLIENT, Void.TYPE, YieldUpdate.class`,
 * IGameController.java:84-86) — is how a client tells Forge what it wants to
 * stop for. It is the frame the whole yield model travels on, and until wave 24
 * it existed nowhere but this comment.
 *
 * `SendYieldUpdateSchema` is below, beside `ApplyYieldUpdateSchema`, over the
 * same `YieldUpdateSchema`. It is **not** in `TIER_B_METHODS` and **not** in
 * `TIER_B_CLIENT_FRAMES`, because `envelope.test.ts` pins the census — 23 Tier B
 * methods, 41 required, 38 examples — and wave 24 lane E owns neither that file
 * nor `examples.ts`, `index.ts` or `envelope.ts`. Adding it to the union is four
 * edits in three files this lane may not make, so the schema lands here and the
 * wiring is named as the next wave's: `TIER_B_METHODS` 23→24,
 * `TIER_B_CLIENT_FRAMES` 3→4, `CLIENT_FRAME_EXAMPLES.sendYieldUpdate`, the
 * `index.ts` re-export, and `envelope.test.ts`'s three counts. It is not lane
 * F's exclusion any more — it is a file boundary, and the exclusion is recorded
 * rather than quietly widened.
 *
 * It is not a BROWSER frame either way: the server builds one, `triggerDecision`
 * arm only, for the bridge (`Match.setTriggerDecision`, the `forge:trigger-decision`
 * event), so `SendYieldUpdate` types that command and nothing a seat sends.
 */

import { z } from 'zod';

import {
  CardRefSchema,
  ChoiceOptionSchema,
  DelayedRevealSchema,
  GameEntityRefSchema,
  JavaByteSchema,
  PhaseTypeSchema,
  PlayerRefSchema,
  PlayerZoneUpdatesSchema,
  PrefKeySchema,
  SpellAbilityRefSchema,
  TriggerDecisionSchema,
  TriggerEventSchema,
  ZoneTypeSchema,
} from './refs.ts';
import { CardPoolSchema, DeckEntrySchema } from './sideboard.ts';

/** The 23 Tier B method names, in `ProtocolMethod` declaration order per direction. */
export const TIER_B_METHODS = [
  // Mode.SERVER
  'showPromptMessage',
  'updateButtons',
  'tempShowZones',
  'hideZones',
  'getAbilityToPlay',
  'assignCombatDamage',
  'assignGenericAmount',
  'confirm',
  'getChoices',
  'order',
  'sideboard',
  'chooseSingleEntityForEffect',
  'chooseEntitiesForEffect',
  'manipulateCardList',
  'setSelectables',
  'setHighlighted',
  'setWeaklySelectable',
  'openZones',
  'restoreOldZones',
  'applyYieldUpdate',
  // Mode.CLIENT
  'selectPlayer',
  'selectCard',
  'selectAbility',
] as const;

export type TierBMethod = (typeof TIER_B_METHODS)[number];

/* ── YieldUpdate — the sealed interface, arm by arm ──────────────────── */

/**
 * `YieldStateSnapshot` (YieldStateSnapshot.java:21-29).
 *
 * Its two `Map<String, TriggerDecision>` fields could be `z.record`, but
 * `Map<PlayerView, EnumSet<PhaseType>>` and `Map<FPref, String>` cannot —
 * a `PlayerView` is not a JSON key. All four are arrays of pairs so the shape
 * is one thing rather than two, and so an unknown key inside one of them is a
 * parse error under `strictObject` rather than a silently accepted entry.
 */
export const YieldStateSnapshotSchema = z.strictObject({
  cardYields: z.array(z.string()),
  abilityYields: z.array(z.string()),
  cardTriggerDecisions: z.array(
    z.strictObject({ key: z.string(), decision: TriggerDecisionSchema }),
  ),
  abilityTriggerDecisions: z.array(
    z.strictObject({ key: z.string(), decision: TriggerDecisionSchema }),
  ),
  autoYieldsDisabled: z.boolean(),
  autoTriggersDisabled: z.boolean(),
  skipPhases: z.array(
    z.strictObject({ player: PlayerRefSchema, phases: z.array(PhaseTypeSchema) }),
  ),
  prefOverrides: z.array(z.strictObject({ pref: PrefKeySchema, value: z.string() })),
});

/** `YieldUpdate` (YieldUpdate.java:16-58) — twelve permitted records, tagged. */
export const YieldUpdateSchema = z.discriminatedUnion('update', [
  z.strictObject({
    update: z.literal('setMarker'),
    phaseOwner: PlayerRefSchema,
    phase: PhaseTypeSchema,
    atOrPastAtClick: z.boolean(),
  }),
  z.strictObject({ update: z.literal('clearMarker'), player: PlayerRefSchema }),
  z.strictObject({
    update: z.literal('stackYield'),
    player: PlayerRefSchema,
    active: z.boolean(),
    respectsInterrupts: z.boolean(),
  }),
  z.strictObject({
    update: z.literal('setAutoPassUntilEndOfTurn'),
    player: PlayerRefSchema,
    active: z.boolean(),
  }),
  z.strictObject({
    update: z.literal('cardAutoYield'),
    cardKey: z.string(),
    active: z.boolean(),
  }),
  z.strictObject({
    update: z.literal('triggerDecision'),
    storageKey: z.string(),
    decision: TriggerDecisionSchema,
  }),
  z.strictObject({ update: z.literal('setDisableYields'), disabled: z.boolean() }),
  z.strictObject({ update: z.literal('setDisableTriggers'), disabled: z.boolean() }),
  z.strictObject({
    update: z.literal('skipPhase'),
    turnPlayer: PlayerRefSchema,
    phase: PhaseTypeSchema,
    skip: z.boolean(),
  }),
  z.strictObject({
    update: z.literal('setYieldPref'),
    pref: PrefKeySchema,
    value: z.string(),
  }),
  z.strictObject({ update: z.literal('seedFromClient'), snapshot: YieldStateSnapshotSchema }),
  z.strictObject({ update: z.literal('clearAbilityOrders') }),
]);

export type YieldUpdate = z.infer<typeof YieldUpdateSchema>;

/* ── Server → client, fire-and-forget (7) ────────────────────────────── */

/** `void showPromptMessage(PlayerView playerView, String message, CardView card)` — IGuiGame.java:77. */
export const ShowPromptMessageSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('showPromptMessage'),
  player: PlayerRefSchema,
  message: z.string(),
  card: CardRefSchema.nullable(),
  /**
   * Ours, wave 52 §S (B): the ability a Yes/No confirm belongs to — Forge's
   * `InputConfirm.sa`, read by the bridge while the game thread is parked on it.
   * A cost confirm (`HumanCostDecision` → `confirmPayment`) and an optional
   * trigger's confirm (`confirmTrigger`) both arrive with `card: null`, so the
   * message alone cannot tell them apart; the ability can. Absent on every other
   * prompt.
   *
   * `trigger` is present on an optional trigger's confirm only: `key` is the
   * storage key Forge keeps a remembered answer under (`AutoYieldStore.abilitySuffix`
   * of the wrapper's `yieldKey()`, per ability as Forge's default
   * `UI_AUTO_DECISION_MODE` keeps it), `name` the trigger's host card.
   */
  confirmAbility: z
    .strictObject({
      hostCard: CardRefSchema,
      abilityId: z.number().int(),
      trigger: z.strictObject({ key: z.string().min(1), name: z.string() }).optional(),
    })
    .optional(),
});

/**
 * The prompt Forge shows a seat that pressed End Turn: it has passed priority for the rest of the
 * turn (or phase, or stack) and keeps only a Cancel live to take the yield back
 * (`AbstractGuiGame.java:598-604`, `lblYieldingUntilEndOfTurn` / `lblYieldingUntilPhaseFmt` /
 * `lblYieldingUntilStackClears`). Nothing waits on that seat while it shows.
 */
export const YIELDING = /^Yielding until /;

/**
 * `void updateButtons(PlayerView owner, String label1, String label2,
 * boolean enable1, boolean enable2, boolean focus1)` — IGuiGame.java:85.
 */
export const UpdateButtonsSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('updateButtons'),
  owner: PlayerRefSchema,
  label1: z.string(),
  label2: z.string(),
  enable1: z.boolean(),
  enable2: z.boolean(),
  focus1: z.boolean(),
});

/** `void hideZones(PlayerView controller, Iterable<PlayerZoneUpdate> zonesToUpdate)` — IGuiGame.java:121. */
export const HideZonesSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('hideZones'),
  controller: PlayerRefSchema,
  zonesToUpdate: PlayerZoneUpdatesSchema,
});

/**
 * `void setSelectables(Iterable<CardView> cards, int min, int max)` — IGuiGame.java:272.
 *
 * `players` is the bridge's addition, not Forge's: Forge publishes cards only and
 * checks a player only once it is clicked (`InputSelectTargets.onPlayerSelected`).
 * The bridge runs those same checks for every player when the selection opens and
 * sends the ones that pass. Absent when the bridge could not tell (an input it does
 * not read): then every player stays offered, as before.
 */
export const SetSelectablesSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('setSelectables'),
  cards: z.array(CardRefSchema),
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  players: z.array(PlayerRefSchema).optional(),
});

/**
 * `void setHighlighted(Iterable<GameEntityView> entities, boolean b)` —
 * IGuiGame.java:265, `ProtocolMethod.java:70`.
 *
 * The entities Forge's current input has MARKED. Incremental: `on: true` adds
 * them to the set the GUI keeps, `on: false` removes them
 * (`AbstractGuiGame.java:325-337`). The parameter is named `b` in Forge; the
 * wire calls it `on`, because `b` names nothing.
 *
 * An entity ref, not a card ref: a player can be highlighted
 * (`InputSelectManyBase.java:127`, `InputSelectTargets.java:409` both go
 * through `GameEntityView.get(ge)`).
 */
export const SetHighlightedSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('setHighlighted'),
  entities: z.array(GameEntityRefSchema),
  on: z.boolean(),
});

/**
 * `void setWeaklySelectable(Iterable<CardView> cards)` — IGuiGame.java:276.
 *
 * The cards Forge's CURRENT input will actually do something with. Unlike
 * `setSelectables` it carries no min/max: it is not a selection with a size,
 * it is "these are the cards that are worth clicking".
 *
 * Forge's own iterable is WEIGHTED — a card appears twice when the auto-tap
 * preview also names it (`AbstractGuiGame.java:385-394` counts into a
 * `Multiset`, and the desktop reads the count at `CardPanel.java:326`). The
 * wire keeps the list rather than a set, so the weighting survives if a client
 * ever wants it; our board only asks whether a card is in it.
 */
export const SetWeaklySelectableSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('setWeaklySelectable'),
  cards: z.array(CardRefSchema),
  /**
   * Ours, wave 52 §S: the offered cards whose every playable ability is a mana
   * ability (a land, a Signet). Read by the bridge off Forge's abilities, never
   * card text. Absent when the bridge could not read them.
   */
  manaOnly: z.array(CardRefSchema).optional(),
  /**
   * Ours, wave 52 §S (A): the offered permanents this seat controls with a
   * playable ability whose `ActivationPhases` restriction is met right now —
   * Augur of Skulls in its controller's upkeep. Battlefield only.
   */
  phaseRestricted: z.array(CardRefSchema).optional(),
});

/** `void restoreOldZones(PlayerView playerView, PlayerZoneUpdates playerZoneUpdates)` — IGuiGame.java:263. */
export const RestoreOldZonesSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('restoreOldZones'),
  player: PlayerRefSchema,
  playerZoneUpdates: PlayerZoneUpdatesSchema,
});

/** `void applyYieldUpdate(YieldUpdate update)` — IGuiGame.java:310. */
export const ApplyYieldUpdateSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('applyYieldUpdate'),
  update: YieldUpdateSchema,
});

/**
 * `void sendYieldUpdate(YieldUpdate update)` — IGameController.java:84-86,
 * `ProtocolMethod.java:101` (`Mode.CLIENT, Void.TYPE, YieldUpdate.class`).
 *
 * The client→server half of the yield model: the frame a browser sends to tell
 * Forge what it wants to stop for. An `act`, not an `ask` — `Mode.CLIENT`
 * methods return void by Forge's own rule, and `IGameController`'s default
 * implementation routes straight to `applyYieldUpdate` on the receiving
 * controller's `YieldController`.
 *
 * It carries exactly the same twelve-arm payload as its server→client
 * counterpart: the union is Forge's one sealed `YieldUpdate`, and a direction is
 * not a shape. Nothing on this side narrows it — `SeedFromClient` is the arm a
 * client sends and `ClearMarker` is one Forge sends back, but both are legal
 * both ways, and `YieldController.apply` no-ops on a variant it does not expect
 * rather than refusing it (`YieldController.java:359-393`).
 *
 * **Not in `TIER_B_METHODS` or `TIER_B_CLIENT_FRAMES`** — see the module header
 * for why, and for the five edits that put it there.
 */
export const SendYieldUpdateSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('sendYieldUpdate'),
  update: YieldUpdateSchema,
});

export type SendYieldUpdate = z.infer<typeof SendYieldUpdateSchema>;

/* ── Server → client, blocking (12) ──────────────────────────────────── */

/**
 * `Iterable<PlayerZoneUpdate> tempShowZones(PlayerView controller,
 * Iterable<PlayerZoneUpdate> zonesToUpdate)` — IGuiGame.java:119.
 */
export const TempShowZonesSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('tempShowZones'),
  controller: PlayerRefSchema,
  zonesToUpdate: PlayerZoneUpdatesSchema,
});

export const TempShowZonesReplySchema = PlayerZoneUpdatesSchema;

/**
 * An ability as `getAbilityToPlay` carries it: the ref, plus the label Forge's
 * own menu would show.
 *
 * Wave 19 lane B. The picker drew "ability #243" because the state channel
 * carries no `SpellAbilityView` objects at all — Tier C's object types are
 * 0–4, and a spell ability is none of them (`apps/ui/src/play/prompts/
 * lookup.ts`'s header records the finding). The label closes that: the bridge
 * sends `SpellAbilityView.toString()`, which is Forge's "cost then
 * description" (`SpellAbilityView.java:42-55` → `toUnsuppressedString`) —
 * `{1}, Sacrifice Pyrite Spellbomb: Draw a card.` — and the picker shows it
 * instead of a number. The braces stay Forge's notation on the wire; the UI
 * already says them in words (`lookup.ts` `plainRulesText`, because `{T}` is
 * a WotC mark).
 *
 * OPTIONAL, and on this offer's own shape rather than on `SpellAbilityRef`
 * itself, so an offer without labels — a bridge that predates this, the
 * committed fixtures — parses unchanged, and so a ref somewhere else
 * (`selectAbility`, an entity list) still carries identity only. The reply
 * echoes whatever it was offered; the bridge reads `kind` and `id` and
 * nothing else.
 */
export const OfferedAbilitySchema = z.strictObject({
  ...SpellAbilityRefSchema.shape,
  label: z.string().optional(),
});

export type OfferedAbility = z.infer<typeof OfferedAbilitySchema>;

/**
 * `SpellAbilityView getAbilityToPlay(CardView hostCard,
 * List<SpellAbilityView> abilities, ITriggerEvent triggerEvent)` —
 * IGuiGame.java:147. Reply nullable: no ability chosen.
 */
export const GetAbilityToPlaySchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('getAbilityToPlay'),
  hostCard: CardRefSchema,
  abilities: z.array(OfferedAbilitySchema),
  triggerEvent: TriggerEventSchema.nullable(),
});

export const GetAbilityToPlayReplySchema = OfferedAbilitySchema.nullable();

/**
 * `Map<CardView, Integer> assignCombatDamage(CardView attacker,
 * List<CardView> blockers, int damage, GameEntityView defender,
 * boolean overrideOrder, boolean maySkip)` — IGuiGame.java:149.
 *
 * `defender` is nullable: `PlayerControllerHuman.java:288` guards on
 * `defender != null`. The reply is Forge's `Map<CardView, Integer>` as an array
 * of pairs, for the reason every map here is one — a `CardView` is not a JSON
 * key.
 */
export const AssignCombatDamageSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('assignCombatDamage'),
  attacker: CardRefSchema,
  blockers: z.array(CardRefSchema),
  damage: z.number().int(),
  defender: GameEntityRefSchema.nullable(),
  overrideOrder: z.boolean(),
  maySkip: z.boolean(),
});

export const AssignCombatDamageReplySchema = z.array(
  z.strictObject({ target: CardRefSchema, amount: z.number().int() }),
);

/**
 * The `Object` key of `assignGenericAmount`'s map.
 *
 * IGuiGame.java:151: "The Object passed should be GameEntityView for most
 * case. Can be Byte for 'generate mana of any combination' effect". The mana
 * case is in fact a `MagicColor.Color` (`PlayerControllerHuman.specifyManaCombo`
 * — Fire-Lit Thicket's {R}{R}/{R}{G}/{G}{G}); the bridge sends its colour mask.
 * Two cases, so two arms, rather than an `unknown` that would accept the third
 * thing nobody meant to send.
 */
export const GenericAmountKeySchema = z.discriminatedUnion('target', [
  z.strictObject({ target: z.literal('entity'), ref: GameEntityRefSchema }),
  z.strictObject({ target: z.literal('manaColor'), color: JavaByteSchema }),
]);

const GenericAmountEntrySchema = z.strictObject({
  key: GenericAmountKeySchema,
  amount: z.number().int(),
});

/**
 * `Map<Object, Integer> assignGenericAmount(CardView effectSource,
 * Map<Object, Integer> target, int amount, boolean atLeastOne,
 * String amountLabel)` — IGuiGame.java:152.
 */
export const AssignGenericAmountSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('assignGenericAmount'),
  effectSource: CardRefSchema,
  target: z.array(GenericAmountEntrySchema),
  amount: z.number().int(),
  atLeastOne: z.boolean(),
  amountLabel: z.string(),
});

export const AssignGenericAmountReplySchema = z.array(GenericAmountEntrySchema);

/**
 * `boolean confirm(CardView c, String question, boolean defaultIsYes,
 * List<String> options)` — IGuiGame.java:179. The card is nullable; Forge's
 * two-argument default passes one through but callers pass null for a
 * cardless question.
 */
export const ConfirmSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('confirm'),
  card: CardRefSchema.nullable(),
  question: z.string(),
  defaultIsYes: z.boolean(),
  options: z.array(z.string()),
});

export const ConfirmReplySchema = z.boolean();

/**
 * `<T> List<T> getChoices(String message, int min, int max, List<T> choices,
 * List<T> selected, FSerializableFunction<T, String> display)` —
 * IGuiGame.java:185. See the module header on the `<T>` and `display`
 * projection. The reply is the chosen options' keys.
 *
 * `names` is a card-name ask (`PlayerControllerHuman.chooseSingleCardFace`:
 * Forge's `CardFaceView`s, every face of every card a predicate lets through —
 * 33,659 for Cabal Therapy's "nonland"). It replaces `choices`, which is then
 * empty: each name is its own key, so the reply quotes the chosen name back.
 */
export const GetChoicesSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('getChoices'),
  message: z.string(),
  min: z.number().int(),
  max: z.number().int(),
  choices: z.array(ChoiceOptionSchema),
  selected: z.array(z.string()),
  names: z.array(z.string()).optional(),
});

export const GetChoicesReplySchema = z.array(z.string());

/**
 * `<T> OrderResult<T> order(String title, String top, int remainingObjectsMin,
 * int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices,
 * CardView referenceCard, boolean sideboardingMode,
 * boolean showRememberCheckbox)` — IGuiGame.java:234.
 *
 * `OrderResult` is a record, `record OrderResult<T>(List<T> ordered,
 * boolean rememberDecision)` (IGuiGame.java:41), so the reply is that pair with
 * `ordered` as keys.
 */
export const OrderSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('order'),
  title: z.string(),
  top: z.string(),
  remainingObjectsMin: z.number().int(),
  remainingObjectsMax: z.number().int(),
  sourceChoices: z.array(ChoiceOptionSchema),
  destChoices: z.array(ChoiceOptionSchema),
  referenceCard: CardRefSchema.nullable(),
  sideboardingMode: z.boolean(),
  showRememberCheckbox: z.boolean(),
});

export const OrderReplySchema = z.strictObject({
  ordered: z.array(z.string()),
  rememberDecision: z.boolean(),
});

/**
 * `List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message)` —
 * IGuiGame.java:248. The one non-mechanical method in the tier; see
 * `sideboard.ts` for the pool model and for why the reply is the new MAINDECK
 * and why null is meaningful.
 */
export const SideboardSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('sideboard'),
  sideboard: CardPoolSchema,
  main: CardPoolSchema,
  message: z.string(),
});

export const SideboardReplySchema = z.array(DeckEntrySchema).nullable();

/**
 * `GameEntityView chooseSingleEntityForEffect(String title,
 * List<? extends GameEntityView> optionList, DelayedReveal delayedReveal,
 * boolean isOptional)` — IGuiGame.java:250. Reply nullable, which is what
 * `isOptional` buys.
 */
export const ChooseSingleEntityForEffectSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('chooseSingleEntityForEffect'),
  title: z.string(),
  optionList: z.array(GameEntityRefSchema),
  delayedReveal: DelayedRevealSchema.nullable(),
  isOptional: z.boolean(),
});

export const ChooseSingleEntityForEffectReplySchema = GameEntityRefSchema.nullable();

/**
 * `List<GameEntityView> chooseEntitiesForEffect(String title,
 * List<? extends GameEntityView> optionList, int min, int max,
 * DelayedReveal delayedReveal)` — IGuiGame.java:252.
 */
export const ChooseEntitiesForEffectSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('chooseEntitiesForEffect'),
  title: z.string(),
  optionList: z.array(GameEntityRefSchema),
  min: z.number().int(),
  max: z.number().int(),
  delayedReveal: DelayedRevealSchema.nullable(),
});

export const ChooseEntitiesForEffectReplySchema = z.array(GameEntityRefSchema);

/**
 * `List<CardView> manipulateCardList(String title, Iterable<CardView> cards,
 * Iterable<CardView> manipulable, boolean toTop, boolean toBottom,
 * boolean toAnywhere)` — IGuiGame.java:255.
 */
export const ManipulateCardListSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('manipulateCardList'),
  title: z.string(),
  cards: z.array(CardRefSchema),
  manipulable: z.array(CardRefSchema),
  toTop: z.boolean(),
  toBottom: z.boolean(),
  toAnywhere: z.boolean(),
});

export const ManipulateCardListReplySchema = z.array(CardRefSchema);

/**
 * `PlayerZoneUpdates openZones(PlayerView controller, Collection<ZoneType> zones,
 * Map<PlayerView, Object> players, boolean backupLastZones)` —
 * IGuiGame.java:261. `players` is a set; see the module header for the four
 * call sites that prove the map's value is always null.
 */
export const OpenZonesSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('openZones'),
  controller: PlayerRefSchema,
  zones: z.array(ZoneTypeSchema),
  players: z.array(PlayerRefSchema),
  backupLastZones: z.boolean(),
});

export const OpenZonesReplySchema = PlayerZoneUpdatesSchema;

/* ── Client → server (3) ─────────────────────────────────────────────── */

/** `void selectPlayer(PlayerView playerView, ITriggerEvent triggerEvent)` — IGameController.java:34. */
export const SelectPlayerSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('selectPlayer'),
  player: PlayerRefSchema,
  triggerEvent: TriggerEventSchema.nullable(),
});

/**
 * `boolean selectCard(CardView cardView, List<CardView> otherCardViewsToSelect,
 * ITriggerEvent triggerEvent)` — IGameController.java:36.
 *
 * The interface returns `boolean`, but `ProtocolMethod` declares this one
 * `Void.TYPE` (ProtocolMethod.java:90) and CLIENT return values are not checked
 * (ProtocolMethod.java:134-136). So it is an action on the wire, not an ask,
 * and a bridge that waited for a boolean here would wait forever.
 */
export const SelectCardSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('selectCard'),
  card: CardRefSchema,
  otherCardViewsToSelect: z.array(CardRefSchema),
  triggerEvent: TriggerEventSchema.nullable(),
});

/** `void selectAbility(SpellAbilityView sa)` — IGameController.java:38. */
export const SelectAbilitySchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('selectAbility'),
  ability: SpellAbilityRefSchema,
});

/* ── The tier, assembled ─────────────────────────────────────────────── */

/** The 20 server→client Tier B frames. */
export const TIER_B_SERVER_FRAMES = [
  ShowPromptMessageSchema,
  UpdateButtonsSchema,
  TempShowZonesSchema,
  HideZonesSchema,
  GetAbilityToPlaySchema,
  AssignCombatDamageSchema,
  AssignGenericAmountSchema,
  ConfirmSchema,
  GetChoicesSchema,
  OrderSchema,
  SideboardSchema,
  ChooseSingleEntityForEffectSchema,
  ChooseEntitiesForEffectSchema,
  ManipulateCardListSchema,
  SetSelectablesSchema,
  SetHighlightedSchema,
  SetWeaklySelectableSchema,
  OpenZonesSchema,
  RestoreOldZonesSchema,
  ApplyYieldUpdateSchema,
] as const;

/** The 3 client→server Tier B frames. */
export const TIER_B_CLIENT_FRAMES = [
  SelectPlayerSchema,
  SelectCardSchema,
  SelectAbilitySchema,
] as const;

/** Reply payloads for the twelve blocking Tier B methods, keyed by method. */
export const TIER_B_REPLIES = {
  tempShowZones: TempShowZonesReplySchema,
  getAbilityToPlay: GetAbilityToPlayReplySchema,
  assignCombatDamage: AssignCombatDamageReplySchema,
  assignGenericAmount: AssignGenericAmountReplySchema,
  confirm: ConfirmReplySchema,
  getChoices: GetChoicesReplySchema,
  order: OrderReplySchema,
  sideboard: SideboardReplySchema,
  chooseSingleEntityForEffect: ChooseSingleEntityForEffectReplySchema,
  chooseEntitiesForEffect: ChooseEntitiesForEffectReplySchema,
  manipulateCardList: ManipulateCardListReplySchema,
  openZones: OpenZonesReplySchema,
} as const;
