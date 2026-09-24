/*
 * Tier A — the 15 methods that carry nothing but scalars.
 *
 * Wave 6 lane F's classification (`docs/spikes/itoclient.md`, "Tier A —
 * strings, numbers, booleans and enums only. Browser-ready as-is. 14
 * methods."), plus `clearWeaklySelectable`, which Wave 19 lane B added: it is
 * the other half of `setWeaklySelectable` (`tier-b.ts`), takes no argument at
 * all (ProtocolMethod.java:72) and so belongs here beside `clearSelectables`.
 * Argument and return types below come from
 * `forge/forge-gui/src/main/java/forge/gamemodes/net/ProtocolMethod.java`, with
 * the parameter NAMES from the interfaces that enum dispatches to —
 * `IGuiGame` for `Mode.SERVER` and `IGameController` for `Mode.CLIENT`
 * (ProtocolMethod.java:104-107).
 *
 * Nine are server→client, six are client→server, and three of the nine block
 * (`showConfirmDialog`, `showOptionDialog`, `showInputDialog`). `envelope.ts`
 * is where blocking is expressed; this file states the payloads.
 *
 * Two of the fourteen are proven end to end over a real socket by Wave 6 item
 * 1 — `message` (fire-and-forget) and `showConfirmDialog` (blocking ask) — and
 * they are the only two shapes in the tier, which is why lane F called it a
 * transcription job.
 *
 * ## Every frame is strict
 *
 * `z.strictObject` throughout, for the reason `@hadoku/shared`'s wire is
 * strict: an unrecognised key is a parse error, not a silently stripped field.
 * A bridge that grows a field nobody agreed to should fail loudly at the seam
 * rather than have it disappear.
 */

import { z } from 'zod';

import { JavaByteSchema, NextGameDecisionSchema, SkinPropSchema } from './refs.ts';

/** The 15 Tier A method names, in `ProtocolMethod` declaration order per direction. */
export const TIER_A_METHODS = [
  // Mode.SERVER
  'afterGameEnd',
  'finishGame',
  'message',
  'showErrorDialog',
  'showConfirmDialog',
  'showOptionDialog',
  'showInputDialog',
  'clearSelectables',
  'clearWeaklySelectable',
  // Mode.CLIENT
  'useMana',
  'selectButtonOk',
  'selectButtonCancel',
  'concede',
  'requestResync',
  'nextGameDecision',
] as const;

export type TierAMethod = (typeof TIER_A_METHODS)[number];

/* ── Server → client, fire-and-forget (6) ────────────────────────────── */

/** `void afterGameEnd()` — IGuiGame.java:70. */
export const AfterGameEndSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('afterGameEnd'),
});

/** `void finishGame()` — IGuiGame.java:100. */
export const FinishGameSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('finishGame'),
});

/** `void clearSelectables()` — IGuiGame.java:273. */
export const ClearSelectablesSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('clearSelectables'),
});

/**
 * `void clearWeaklySelectable()` — IGuiGame.java:277.
 *
 * The end of the actionable set `setWeaklySelectable` opened. Sent from
 * `PlayerControllerHuman.clearActionableCards()` (PlayerControllerHuman.java:
 * 1600), which every input that pushed a set calls on stop —
 * `InputPassPriority.onStop` (:70), `InputPayMana.onStop` (:69),
 * `InputAttack` (:101), `InputBlock` (:96).
 */
export const ClearWeaklySelectableSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('clearWeaklySelectable'),
});

/** `void message(String message, String title)` — IGuiGame.java:157. */
export const MessageSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('message'),
  message: z.string(),
  title: z.string(),
});

/** `void showErrorDialog(String message, String title)` — IGuiGame.java:162. */
export const ShowErrorDialogSchema = z.strictObject({
  kind: z.literal('notify'),
  method: z.literal('showErrorDialog'),
  message: z.string(),
  title: z.string(),
});

/* ── Server → client, blocking (3) ───────────────────────────────────── */

/**
 * `boolean showConfirmDialog(String message, String title, String yesButtonText,
 * String noButtonText, boolean defaultYes)` — IGuiGame.java:170.
 */
export const ShowConfirmDialogSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('showConfirmDialog'),
  message: z.string(),
  title: z.string(),
  yesButtonText: z.string(),
  noButtonText: z.string(),
  defaultYes: z.boolean(),
});

export const ShowConfirmDialogReplySchema = z.boolean();

/**
 * `int showOptionDialog(String message, String title, FSkinProp icon,
 * List<String> options, int defaultOption)` — IGuiGame.java:172.
 *
 * The reply is an INDEX into `options`. It is not range-checked here: the range
 * depends on the request, and a schema validates one message at a time. A
 * bridge checks it against the ask it is answering — see `envelope.ts`'s note
 * on correlation.
 */
export const ShowOptionDialogSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('showOptionDialog'),
  message: z.string(),
  title: z.string(),
  icon: SkinPropSchema.nullable(),
  options: z.array(z.string()),
  defaultOption: z.number().int(),
});

export const ShowOptionDialogReplySchema = z.number().int();

/**
 * `String showInputDialog(String message, String title, FSkinProp icon,
 * String initialInput, List<String> inputOptions, boolean isNumeric)` —
 * IGuiGame.java:174. The reply is nullable: Forge's dialogs return null on
 * cancel.
 */
export const ShowInputDialogSchema = z.strictObject({
  kind: z.literal('ask'),
  callId: z.string().min(1),
  method: z.literal('showInputDialog'),
  message: z.string(),
  title: z.string(),
  icon: SkinPropSchema.nullable(),
  initialInput: z.string(),
  inputOptions: z.array(z.string()),
  isNumeric: z.boolean(),
});

export const ShowInputDialogReplySchema = z.string().nullable();

/* ── Client → server (6) ─────────────────────────────────────────────── */
/*
 * All six return void. That is not an accident of this contract — it is
 * ProtocolMethod's own rule, stated in the comment above the CLIENT block
 * (ProtocolMethod.java:84-86): "these should all return void, to avoid awkward
 * situations in which client and server wait for one another's response and
 * block the threads that're supposed to give that response". So there is no
 * client→server ask, only actions.
 */

/** `void useMana(byte color)` — IGameController.java:28. */
export const UseManaSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('useMana'),
  color: JavaByteSchema,
});

/** `void selectButtonOk()` — IGameController.java:30. */
export const SelectButtonOkSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('selectButtonOk'),
});

/** `void selectButtonCancel()` — IGameController.java:32. */
export const SelectButtonCancelSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('selectButtonCancel'),
});

/** `void concede()` — IGameController.java:22. */
export const ConcedeSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('concede'),
});

/** `void requestResync()` — IGameController.java:56. */
export const RequestResyncSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('requestResync'),
});

/** `void nextGameDecision(NextGameDecision decision)` — IGameController.java:46. */
export const NextGameDecisionActionSchema = z.strictObject({
  kind: z.literal('act'),
  method: z.literal('nextGameDecision'),
  decision: NextGameDecisionSchema,
});

/* ── The tier, assembled ─────────────────────────────────────────────── */

/** The 9 server→client Tier A frames. */
export const TIER_A_SERVER_FRAMES = [
  AfterGameEndSchema,
  FinishGameSchema,
  MessageSchema,
  ShowErrorDialogSchema,
  ShowConfirmDialogSchema,
  ShowOptionDialogSchema,
  ShowInputDialogSchema,
  ClearSelectablesSchema,
  ClearWeaklySelectableSchema,
] as const;

/** The 6 client→server Tier A frames. */
export const TIER_A_CLIENT_FRAMES = [
  UseManaSchema,
  SelectButtonOkSchema,
  SelectButtonCancelSchema,
  ConcedeSchema,
  RequestResyncSchema,
  NextGameDecisionActionSchema,
] as const;

/** Reply payloads for the three blocking Tier A methods, keyed by method. */
export const TIER_A_REPLIES = {
  showConfirmDialog: ShowConfirmDialogReplySchema,
  showOptionDialog: ShowOptionDialogReplySchema,
  showInputDialog: ShowInputDialogReplySchema,
} as const;
