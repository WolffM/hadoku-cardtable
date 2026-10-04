/*
 * Every two-button question Forge can ask through the decision area, in one
 * component: the bar-derived yes/no (shockland's "pay 2 life?", the
 * mulligan's Keep/Mulligan, …), the coin toss's Play/Draw, and
 * `showConfirmDialog`'s own ask. Operator: *"i hate yes/no on control bar.
 * should always be the big pop up."* These three were three components
 * (`ConfirmPrompt`, `PlayOrDrawPrompt`, `../live/ConfirmDialog`) with three
 * CSS families — the code-quality retro
 * (`docs/planning/retro-code-quality-2026-10-03.md`) named that duplication —
 * and this is the fold: one presentational component, driven by
 * `ConfirmPromptProps.button1`/`button2`, with `coin`, `title` and `callId`
 * the only things that differ between its three call sites, all in
 * `LiveBoard.tsx`.
 *
 * NOT covered: `confirm`'s own ask (`DialogPrompts.tsx`'s `ConfirmAskPrompt`)
 * — Forge's `GuiDialog.confirm`, answered through the generic `PromptShell`
 * every other Tier-A dialog uses, with 1 or 2 buttons depending on
 * `rules.ts`'s `confirmButtons`. That shell and that rule are outside this
 * lane's files, and `dialogs.test.ts` (also outside them) pins its exact
 * markup, so it stays its own thing; only its colliding `ConfirmPrompt`
 * export name changed.
 *
 * ## The two Java shapes on the bar, and how `updateButtons` tells them apart
 *
 * `updateButtons` (`ProtocolMethod.java:41`) carries only `label1`, `label2`,
 * `enable1`, `enable2` — no "kind" flag. Forge puts two different THINGS on
 * it:
 *
 *  - **a priority/mechanical action** — `InputPassPriority` (OK + End Turn or
 *    OK + `Undo (N)`, `InputPassPriority.java:171,174`), `InputPayMana` (Auto +
 *    Cancel, or "" + Cancel while mandatory with no auto-pay,
 *    `InputPayMana.java:391,393,405`), `InputLondonMulligan` (OK + Auto,
 *    `:65`), `InputAttack` (OK + an alpha-strike/"Call Back" label, always OK
 *    first, `InputAttack.java:90`), and the boolean-only overload every
 *    selection input (`InputBlock`, `InputSelectManyBase`,
 *    `InputSelectTargets`, `InputSelectEntitiesFromList`) falls back to, which
 *    defaults label 1/2 to Forge's own `lblOK`/`lblCancel`
 *    (`IGuiGame.java:82-85`). **Every one of these puts `lblOK` (`"OK"`,
 *    `en-US.properties:598`) or `lblAuto` (`"Auto"`, `:518`) in label 1** —
 *    that pair of words is reserved for "continue what Forge is already
 *    doing", never for an answer.
 *  - **a real yes/no question** — `InputConfirm.showMessage`
 *    (`InputConfirm.java:108`) and `InputConfirmMulligan.showMessage`
 *    (`InputConfirmMulligan.java:74`), both calling the SAME `updateButtons`
 *    with BOTH buttons always enabled and label text that is never `OK` or
 *    `Auto`: the shockland's "pay 2 life?" is `InputConfirm`'s own
 *    default pair, `lblYes`/`lblNo` (`InputConfirm.java:51`, reached from
 *    `PlayerControllerHuman.confirmReplacementEffect:1489` →
 *    `confirmPayment:2075` → `HumanCostDecision.visit(CostPayLife):733`, all
 *    non-libgdx so none of them take the `getGui().confirm()` blocking-ask
 *    branch — `RemoteClientGuiGame.isLibgdxPort():86` returns
 *    `client.isLibgdx()`, false for this bridge); the mulligan's Keep/Mulligan
 *    is `InputConfirmMulligan`'s own fixed pair, `lblKeep`/`lblMulligan`
 *    (`:74`, from `PlayerControllerHuman.mulliganKeepHand:1492`). The coin
 *    toss (`chooseBinary`'s `PlayOrDraw` case, `PlayerControllerHuman.java:
 *    1828-1829`) is the SAME `InputConfirm` shape with its own label pair,
 *    `Play`/`Draw` — rendered here with the coin decoration, excluded from
 *    `isConfirmPrompt` by name rather than re-decided.
 *
 * So the rule below is the complement of the mechanical set, not an allowlist
 * of known questions: Forge's card scripts hand `InputConfirm`/`chooseBinary`
 * arbitrary two-word pairs (`Heads`/`Tails`, `Tap`/`Untap`, `Left`/`Right`, a
 * scry's `Top`/`Bottom`, …, `PlayerControllerHuman.java:1816-1841`), and no
 * finite allowlist could cover every card. Enumerating the SMALL, FIXED
 * mechanical set instead is what the repo's own practice
 * (`AUTO_PAY_LABEL`/`CALL_BACK_LABEL`, `../live/match.ts`) already does for
 * single facts; this is the same practice for a disjunction of them.
 *
 * One desktop-only exception, checked and found unreachable here:
 * `InputPassPriority.showYieldSuggestionPrompt` puts `Accept`/`Decline` on
 * this same bar (`:154-156`), which this rule would NOT catch (neither label is
 * `OK` or `Auto`). It is gated on `YIELD_DECLINE_SCOPE_STACK_YIELD` and
 * `YIELD_DECLINE_SCOPE_NO_ACTIONS` both being something other than `NEVER`
 * (`InputPassPriority.java:102-106`); both default to `"NEVER"`
 * (`ForgePreferences.java:145-146`) and `apps/server/src/play/host.ts`'s
 * `FORGE_PREFERENCES` never touches either key, so `showNormalPrompt` is
 * taken unconditionally today. If a future run directory ever sets one of
 * those two prefs, this would need a third label check — written down here so
 * that change does not land quietly.
 *
 * ## The coin toss (R2)
 *
 * Forge resolves the toss itself — `GameAction.determineFirstTurnPlayer`
 * picks the winner with `Aggregates.random` before anyone is asked anything
 * — and only ever asks the WINNER the Play/Draw question, through the same
 * bar every other yes/no uses: `PlayerControllerHuman.chooseStartingPlayer`
 * (`PlayerControllerHuman.java:832-849`). The losing seat gets only a
 * "waiting for opponent" line and no buttons, so `isPlayOrDrawPrompt` is
 * naturally false for them. The flip (`coin`) is decoration only — Forge
 * already knows the winner before either seat sees a pixel — and
 * `../live/live.css`'s `prefers-reduced-motion` rule turns it off outright
 * rather than skipping it in JS.
 *
 * ## `showConfirmDialog`
 *
 * `boolean showConfirmDialog(message, title, yesButtonText, noButtonText,
 * defaultYes)` (`IGuiGame.java`; `@hadoku/forge-wire`'s `tier-a.ts`).
 * `LiveBoard.tsx` reads the ask (`../live/match.ts`'s `ConfirmAsk`) and hands
 * this component `title`/`message`/the two buttons/`callId`; this component
 * still does not know a socket exists — `answerConfirm` is the only sender.
 * `defaultYes` decides which button has focus, so Enter takes the engine's
 * default — and ONLY focus (the spike that proved this seam,
 * `docs/spikes/itoclient.md`, answered the opposite of the default both ways;
 * a dialog that pre-answered would have failed it).
 */
import { useId } from 'react';

import { AUTO_PAY_LABEL, type LiveButtons } from '../live/match.ts';
import '../live/live.css';

/** Forge's own `lblOK` (`en-US.properties:598`) — see the module header's mechanical set. */
const BAR_OK_LABEL = 'OK';

/** Forge's own two labels for the coin toss (`en-US.properties`'s `lblPlay`/`lblDraw`). */
export const PLAY_LABEL = 'Play';
export const DRAW_LABEL = 'Draw';

/** True only for the coin-toss winner's own "play or draw" question — see the module header. */
export function isPlayOrDrawPrompt(buttons: LiveButtons | null): boolean {
  return (
    buttons !== null &&
    buttons.label1 === PLAY_LABEL &&
    buttons.label2 === DRAW_LABEL &&
    buttons.enable1 &&
    buttons.enable2
  );
}

/**
 * True for a Forge bar question that is an ANSWER (yes/no, Keep/Mulligan, a
 * scry's Top/Bottom, …), false for a priority pass, a mana payment, the
 * London mulligan's OK/Auto, an attack declaration, a default OK/Cancel
 * selection, or the coin toss (its own branch below). See the module header
 * for the Forge citations behind each branch.
 */
export function isConfirmPrompt(bar: LiveButtons | null): boolean {
  if (bar === null || !bar.enable1 || !bar.enable2) return false;
  if (isPlayOrDrawPrompt(bar)) return false;
  return bar.label1 !== BAR_OK_LABEL && bar.label1 !== AUTO_PAY_LABEL && bar.label1 !== '';
}

/** One button: Forge's own label, whether it is pressable, and what pressing it sends. */
export interface ConfirmPromptButton {
  label: string;
  enabled: boolean;
  /** Fixed testid for a caller the blast radius requires one on; omitted where nothing reads one. */
  testId?: string;
  /** `showConfirmDialog`'s `defaultYes`/`!defaultYes` — which button is `data-default` and focused. */
  isDefault?: boolean;
  /** `showConfirmDialog`'s own answer shape — `data-answer`, read by `LiveBoard.test.ts`. */
  answer?: 'yes' | 'no';
  onClick: () => void;
}

export interface ConfirmPromptProps {
  /** The root element's testid — `live-confirm`, `live-play-or-draw`, or `confirm-dialog`. */
  testId: string;
  role?: 'dialog' | 'alertdialog';
  /** `showConfirmDialog` only — Forge's own dialog title. */
  title?: string;
  /** Forge's own prompt line verbatim. */
  message: string;
  /** The coin-toss decoration (`.confirm__coin` in `../live/live.css`) — play/draw only. */
  coin?: boolean;
  /** `showConfirmDialog`'s callId, so `data-call-id` still finds the open ask. */
  callId?: string;
  button1: ConfirmPromptButton;
  button2: ConfirmPromptButton;
}

/**
 * Presentational only — never touches `LiveMatch` or the wire. `LiveBoard.tsx`
 * mounts this for all three of its two-button questions: `isConfirmPrompt`'s
 * bar yes/no, `isPlayOrDrawPrompt`'s coin toss, and `ask.method ===
 * 'showConfirmDialog'`. Every `onClick` it is handed is already one of
 * `LiveBoard.tsx`'s own senders (`pressButton`/`answerConfirm`) — this
 * component sends nothing itself.
 */
export function ConfirmPrompt({ testId, role = 'dialog', title, message, coin, callId, button1, button2 }: ConfirmPromptProps) {
  const titleId = useId();
  const messageId = useId();
  return (
    <section
      className="confirm"
      data-testid={testId}
      data-call-id={callId}
      role={role}
      aria-labelledby={title !== undefined ? titleId : messageId}
      aria-describedby={title !== undefined ? messageId : undefined}
    >
      {title !== undefined && (
        <h2 className="confirm__title" id={titleId}>
          {title}
        </h2>
      )}
      {coin === true && <span className="confirm__coin" aria-hidden="true" data-testid="live-play-or-draw-coin" />}
      <p className="confirm__message" id={messageId}>
        {message}
      </p>
      <div className="confirm__actions">
        {[button1, button2].map((b, i) => (
          <button
            key={i}
            type="button"
            className="button confirm__button"
            data-testid={b.testId}
            data-answer={b.answer}
            data-default={b.isDefault || undefined}
            autoFocus={b.isDefault === true}
            disabled={!b.enabled}
            onClick={b.onClick}
          >
            {b.label}
          </button>
        ))}
      </div>
    </section>
  );
}
