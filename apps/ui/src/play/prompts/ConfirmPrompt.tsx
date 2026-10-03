/*
 * Every Forge yes/no that is a QUESTION, not a priority pass — wave 36 T4
 * (shape 1). Operator: *"i hate yes/no on control bar. should always be the
 * big pop up."* This is `PlayOrDrawPrompt.tsx`'s own pattern (a presentational
 * component over Forge's `updateButtons` bar, never the wire, never a regex
 * over prompt prose) generalised from one label pair to "every label pair that
 * is not one of Forge's own mechanical ones".
 *
 * ## The two Java shapes on this bar, and how `updateButtons` tells them apart
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
 *    `Play`/`Draw` — already its own component, so this excludes it by name
 *    rather than re-deciding it.
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
 */
import { useId } from 'react';

import { AUTO_PAY_LABEL, type LiveButtons } from '../live/match.ts';
import { isPlayOrDrawPrompt } from './PlayOrDrawPrompt.tsx';
import './prompts.css';

/** Forge's own `lblOK` (`en-US.properties:598`) — see the module header's mechanical set. */
const BAR_OK_LABEL = 'OK';

/**
 * True for a Forge bar question that is an ANSWER (yes/no, Keep/Mulligan, a
 * scry's Top/Bottom, …), false for a priority pass, a mana payment, the
 * London mulligan's OK/Auto, an attack declaration, a default OK/Cancel
 * selection, or the coin toss (its own `PlayOrDrawPrompt`). See the module
 * header for the Forge citations behind each branch.
 */
export function isConfirmPrompt(bar: LiveButtons | null): boolean {
  if (bar === null || !bar.enable1 || !bar.enable2) return false;
  if (isPlayOrDrawPrompt(bar)) return false;
  return bar.label1 !== BAR_OK_LABEL && bar.label1 !== AUTO_PAY_LABEL && bar.label1 !== '';
}

export interface ConfirmPromptProps {
  /** Forge's own prompt line verbatim (`showPromptMessage`'s message, the same field `PlayOrDrawPrompt` reads). */
  message: string;
  /** Forge's own button text — never fixed, never retranslated here. Button 1 is `InputConfirm`'s `result = true` side. */
  label1: string;
  label2: string;
  enable1: boolean;
  enable2: boolean;
  onYes: () => void;
  onNo: () => void;
}

/**
 * Presentational only — same contract as `PlayOrDrawPrompt`: never touches
 * `LiveMatch` or the wire. `LiveBoard.tsx` (lane L) mounts this in the
 * decision area whenever `isConfirmPrompt(match.buttons)` is true, leaves the
 * control bar empty while it is up, wires `onYes`/`onNo` to
 * `pressButton(match, 'ok' | 'cancel')` — the same sender every other button
 * already uses — and passes `match.buttons!.label1/2/enable1/2` and
 * `match.prompt` straight through.
 */
export function ConfirmPrompt({ message, label1, label2, enable1, enable2, onYes, onNo }: ConfirmPromptProps) {
  const messageId = useId();
  return (
    <section className="prompt prompt-confirm" data-testid="live-confirm" role="dialog" aria-labelledby={messageId}>
      <p className="prompt__message prompt-confirm__message" id={messageId}>
        {message}
      </p>
      <div className="prompt__actions">
        <button
          type="button"
          className="prompt__submit"
          data-testid="prompt-confirm-yes"
          disabled={!enable1}
          onClick={onYes}
        >
          {label1}
        </button>
        <button
          type="button"
          className="prompt__submit"
          data-testid="prompt-confirm-no"
          disabled={!enable2}
          onClick={onNo}
        >
          {label2}
        </button>
      </div>
    </section>
  );
}
