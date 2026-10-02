/*
 * The coin toss and play/draw question (R2), drawn in the decision area
 * (shape 2, `.live__prompt`) instead of the control bar.
 *
 * Forge resolves the coin toss itself — `GameAction.determineFirstTurnPlayer`
 * picks the winner with `Aggregates.random` before anyone is asked anything
 * (`forge/forge-game/.../GameAction.java:2415`) — and only ever asks the
 * WINNER one question, through the same two-button bar every other yes/no
 * answer uses: `PlayerControllerHuman.chooseStartingPlayer`
 * (`forge/forge-gui/.../PlayerControllerHuman.java:832-849`) builds
 * `"<name>, you have won the coin toss.\n\nWould you like to play or draw?"`
 * and opens an `InputConfirm` whose `showMessage()` calls
 * `getGui().updateButtons(owner, "Play", "Draw", true, true, true)` — Forge's
 * own `lblPlay`/`lblDraw` strings (`en-US.properties:1510-1511`). There is no
 * `ask` with a `callId` here: it is the SAME notify-only `prompt` + `buttons`
 * channel `payingMana`/`offersSecondButton` already read in `match.ts`
 * (`LiveMatch`'s own header explains why: "the coin toss, the mulligan and
 * every 'pass priority?' come through here"). The losing seat gets only a
 * "waiting for opponent" prompt line and no buttons, so `isPlayOrDrawPrompt`
 * is naturally false for them — nothing of theirs renders here.
 *
 * So "is this the coin toss" is answered the way `AUTO_PAY_LABEL` and
 * `CALL_BACK_LABEL` already answer their own questions in `match.ts`: Forge's
 * own exact button text, never a regex over its prose. `PLAY_LABEL`/
 * `DRAW_LABEL` are those two strings; a second locale would need a second
 * pair.
 *
 * The flip itself is decoration — Forge already knows the winner before
 * either seat sees a pixel, so there is nothing a client-side flip could
 * reveal. It plays once, CSS only (`prompts.css`), and
 * `prefers-reduced-motion` turns the animation off outright rather than
 * skipping it in JS: the question and its buttons are live under the coin
 * from the very first frame either way, so there is nothing to gate on the
 * animation finishing.
 */
import { useId } from 'react';

import type { LiveButtons } from '../live/match.ts';
import './prompts.css';

/** Forge's own two labels for this question (`en-US.properties`'s `lblPlay`/`lblDraw`). See the module header. */
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

export interface PlayOrDrawPromptProps {
  /** Forge's own message verbatim — the coin-toss line and the question, already joined by Forge's own `\n\n`. */
  message: string;
  enablePlay: boolean;
  enableDraw: boolean;
  onPlay: () => void;
  onDraw: () => void;
}

/**
 * Presentational only — never touches `LiveMatch` or the wire. `LiveBoard.tsx`
 * (lane L) wires `onPlay`/`onDraw` to `pressButton(match, 'ok' | 'cancel')`,
 * the one sender every other button in the control bar already uses, and
 * decides whether to mount this at all from `isPlayOrDrawPrompt(match.buttons)`.
 */
export function PlayOrDrawPrompt({ message, enablePlay, enableDraw, onPlay, onDraw }: PlayOrDrawPromptProps) {
  const messageId = useId();
  return (
    <section className="prompt prompt-playdraw" data-testid="live-play-or-draw" role="dialog" aria-labelledby={messageId}>
      {/*
       * Decoration only (see the module header) — `aria-hidden` so a screen
       * reader reads straight to the message, and no `data-mode`/`data-*`
       * beyond its testid: nothing else ever reads this element's state.
       */}
      <span className="prompt-playdraw__coin" aria-hidden="true" data-testid="live-play-or-draw-coin" />
      <p className="prompt__message prompt-playdraw__message" id={messageId}>
        {message}
      </p>
      <div className="prompt__actions">
        <button
          type="button"
          className="prompt__submit"
          data-testid="live-play-or-draw-play"
          disabled={!enablePlay}
          onClick={onPlay}
        >
          {PLAY_LABEL}
        </button>
        <button
          type="button"
          className="prompt__submit"
          data-testid="live-play-or-draw-draw"
          disabled={!enableDraw}
          onClick={onDraw}
        >
          {DRAW_LABEL}
        </button>
      </div>
    </section>
  );
}
