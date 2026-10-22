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
import { Fragment, useId } from 'react';
import type { DraftCard } from '@hadoku/shared';

import { CardTile } from '../../components/CardTile.tsx';
import { colorWordToken, ManaPip } from '../../components/ManaPip.tsx';
import { AUTO_PAY_LABEL, type LiveButtons } from '../live/match.ts';
import '../live/live.css';
import { AnswerRow } from './PromptShell.tsx';
import { RulesText } from './RulesText.tsx';

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

/**
 * `InputPassPriority`'s second button at an ordinary priority window
 * (`lblEndTurn`, `InputPassPriority.java:174`) — PlayBridge's own
 * `END_TURN_LABEL`, which it reads for the same fact (`PlayBridge.java:767`).
 * The one input that puts it there, so it identifies the priority pass.
 */
const END_TURN_LABEL = 'End Turn';

/**
 * Where Forge's bar goes (wave 51). The operator, 2026-10-06: *"any game action
 * that requires the players to do something should land in the decision box not
 * in the control box … change the control box word to 'Next Phase' so that
 * button is specifically only for that. and any 'Ok' situations are popups
 * decisions instead"*.
 *
 *  - `next-phase`: the priority pass (`OK` + `End Turn`, button one enabled)
 *    with nothing on the stack. Button one moves the game to the next step, and
 *    the control box's fixed `Next Phase` button is the one that presses it.
 *    Also `OK` + `Undo (N)` with nothing on the stack (`InputPassPriority.java:171`,
 *    after a manual mana tap): the operator, 2026-10-06, chose Next Phase over a
 *    pop-up there, since a click on the land tapped last already untaps it, so
 *    Forge's `Undo (N)` button is not drawn at all.
 *  - `decision`: any other bar with an enabled button that is not `End Turn`
 *    (the control box's own second button). Priority with spells on the stack
 *    (button one lets the top resolve; with an `Undo (N)` beside it too), declare
 *    attackers or blockers done, a target's `Cancel`, the London mulligan's
 *    `OK` + `Auto`, a payment Forge drew no payment window for.
 *  - `none`: no bar, nothing enabled beyond `End Turn`, or a pop-up of its own
 *    already owns the input: the coin toss (`isPlayOrDrawPrompt`), a yes/no
 *    (`isConfirmPrompt`), or whatever the caller says is open (`owned`: an ask,
 *    the payment window, a selection pop-up, the pregame wait).
 */
export type BarRoute = 'next-phase' | 'decision' | 'none';

/** Forge's second button after a manual mana tap (`lblUndo` + ` (N)`, `InputPassPriority.java:171`). */
const UNDO_LABEL = /^Undo \(\d+\)$/;

export function barRoute(bar: LiveButtons | null, stackEmpty: boolean, owned = false): BarRoute {
  if (bar === null || owned || isPlayOrDrawPrompt(bar) || isConfirmPrompt(bar)) return 'none';
  const endTurn = bar.label2 === END_TURN_LABEL;
  const undo = UNDO_LABEL.test(bar.label2);
  if (bar.enable1 && bar.label1 === BAR_OK_LABEL && (endTurn || undo) && stackEmpty) return 'next-phase';
  return bar.enable1 || (bar.enable2 && !endTurn) ? 'decision' : 'none';
}

/** Forge's second button is enabled and is `End Turn` — the control box's own `End Turn` button. */
export function offersEndTurn(bar: LiveButtons | null): boolean {
  return bar !== null && bar.enable2 && bar.label2 === END_TURN_LABEL;
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
  /** Why the button is disabled, shown on hover by the board's tooltip (`data-tip`). */
  tip?: string;
  /** An answer that cannot be taken back (Concede): drawn in the warning colour (`.live__danger`). */
  danger?: boolean;
  onClick: () => void;
}

export interface ConfirmPromptProps {
  /** The root element's testid — `live-confirm`, `live-play-or-draw`, or `confirm-dialog`. */
  testId: string;
  role?: 'dialog' | 'alertdialog';
  /** `showConfirmDialog` only — Forge's own dialog title. */
  title?: string;
  /** Forge's own prompt line verbatim: the question. */
  message: string;
  /** The ability text the question needs under it, on its own line (`promptLines`); omitted when it stands alone. */
  context?: string | null;
  /** The coin-toss decoration (`.confirm__coin` in `../live/live.css`) — play/draw only. */
  coin?: boolean;
  /** `showConfirmDialog`'s callId, so `data-call-id` still finds the open ask. */
  callId?: string;
  /** Omitted where Forge has not offered the button at all (the bar decision draws only what Forge enabled). */
  button1?: ConfirmPromptButton;
  button2?: ConfirmPromptButton;
  /**
   * A box beside the buttons: an optional trigger's "Always" (ticked, the answer pressed is the one
   * Forge keeps giving), a trigger target's "Same target for all".
   */
  check?: { label: string; testId: string; checked: boolean; onChange: (checked: boolean) => void };
  /**
   * The card the question is about, drawn in the window, when the board has no face of it to point at —
   * a scry 1's library card (the operator, 2026-10-11: *"we should have a proper decision card for this"*).
   */
  card?: { id: number; tile: DraftCard };
}

/**
 * Presentational only — never touches `LiveMatch` or the wire. `LiveBoard.tsx`
 * mounts this for every one of its two-button questions: `isConfirmPrompt`'s
 * bar yes/no, `isPlayOrDrawPrompt`'s coin toss, `ask.method ===
 * 'showConfirmDialog'`, the bar decision, and the Concede confirmation. Every
 * `onClick` it is handed is one of `LiveBoard.tsx`'s own handlers — this
 * component sends nothing itself.
 */
export function ConfirmPrompt({ testId, role = 'dialog', title, message, context, coin, callId, button1, button2, check, card }: ConfirmPromptProps) {
  const titleId = useId();
  const messageId = useId();
  return (
    <section
      className="confirm ct-panel"
      data-testid={testId}
      data-call-id={callId}
      role={role}
      aria-labelledby={title !== undefined ? titleId : messageId}
      aria-describedby={title !== undefined ? messageId : undefined}
    >
      {title !== undefined && (
        <h2 className="confirm__title ct-panel__title" id={titleId}>
          {title}
        </h2>
      )}
      {coin === true && <span className="confirm__coin" aria-hidden="true" data-testid="live-play-or-draw-coin" />}
      {card !== undefined && (
        <div className="confirm__card" data-testid="confirm-card" data-card-id={card.id}>
          <CardTile card={card.tile} />
        </div>
      )}
      <p className="confirm__message" id={messageId}>
        <RulesText text={message} />
      </p>
      {context != null && context !== '' && (
        <p className="confirm__context" data-testid="prompt-source-text">
          <RulesText text={context} />
        </p>
      )}
      <AnswerRow
        aside={
          check !== undefined && (
            <label className="confirm__check">
              <input type="checkbox" data-testid={check.testId} checked={check.checked} onChange={(event) => check.onChange(event.currentTarget.checked)} />
              {check.label}
            </label>
          )
        }
      >
        {[button1, button2].map((b, i) => {
          if (b === undefined) return null;
          const button = (
            <button
              type="button"
              className={b.danger === true ? 'button confirm__button live__danger' : 'button confirm__button'}
              data-testid={b.testId}
              data-answer={b.answer}
              data-default={b.isDefault || undefined}
              aria-label={b.label}
              autoFocus={b.isDefault === true}
              disabled={!b.enabled}
              onClick={b.onClick}
            >
              {/*
               * The operator, repeated (Z10, Y23, AD6, 2026-10-08): Underground
               * River's colour choice reaches THIS bar, through
               * `InputConfirm`'s non-libgdx branch (`showMessage`/`updateButtons`,
               * never `getGui().confirm()` — this bridge is not libgdx), with the
               * two colour NAMES as Forge's own button labels. Same table every
               * other colour choice in this lane reads now.
               */}
              {colorWordToken(b.label) === null ? b.label : <ManaPip token={colorWordToken(b.label)!} />}
            </button>
          );
          // A disabled button takes no pointer, so its words ride on a wrapper the board's tooltip finds (`tip/index.ts`).
          return b.tip === undefined ? (
            <Fragment key={i}>{button}</Fragment>
          ) : (
            <span key={i} className="confirm__tip" data-tip={b.tip}>
              {button}
            </span>
          );
        })}
      </AnswerRow>
    </section>
  );
}
