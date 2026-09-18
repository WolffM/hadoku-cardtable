/*
 * `showConfirmDialog`, drawn — the one Forge prompt this wave wires end to end.
 *
 * `boolean showConfirmDialog(message, title, yesButtonText, noButtonText,
 * defaultYes)` (IGuiGame.java; `@hadoku/forge-wire`'s `tier-a.ts`). Two
 * buttons, and the answer is which one was pressed. It takes the ask and
 * returns the answer through `onAnswer`; it does not know a socket exists,
 * the same rule lane C's fourteen prompt components are held to.
 *
 * `defaultYes` decides which button has focus, so Enter takes the engine's
 * default — and ONLY focus. The spike that proved this seam
 * (`docs/spikes/itoclient.md`) deliberately answered the opposite of the
 * default both ways; a dialog that pre-answered would have failed it.
 *
 * Button text is Forge's, verbatim, falling back to our own "Yes" / "No" only
 * when Forge sends an empty string.
 */

import { useId } from 'react';

import type { ConfirmAsk } from './match.ts';

export function ConfirmDialog({ ask, onAnswer }: { ask: ConfirmAsk; onAnswer: (yes: boolean) => void }) {
  const titleId = useId();
  const messageId = useId();
  const yes = ask.yesButtonText === '' ? 'Yes' : ask.yesButtonText;
  const no = ask.noButtonText === '' ? 'No' : ask.noButtonText;

  return (
    <section
      className="confirm"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      data-testid="confirm-dialog"
      data-call-id={ask.callId}
    >
      <h2 className="confirm__title" id={titleId}>
        {ask.title === '' ? 'A question' : ask.title}
      </h2>
      <p className="confirm__message" id={messageId}>
        {ask.message}
      </p>
      <div className="confirm__actions">
        <button
          type="button"
          className="button confirm__button"
          data-answer="yes"
          data-default={ask.defaultYes || undefined}
          autoFocus={ask.defaultYes}
          onClick={() => onAnswer(true)}
        >
          {yes}
        </button>
        <button
          type="button"
          className="button confirm__button"
          data-answer="no"
          data-default={!ask.defaultYes || undefined}
          autoFocus={!ask.defaultYes}
          onClick={() => onAnswer(false)}
        >
          {no}
        </button>
      </div>
    </section>
  );
}
