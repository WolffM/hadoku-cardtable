/*
 * A ready state, drawn: the table's seats, a pod's seats and building list, a Gauntlet's choice.
 */

/** A pass: the ready pill's tick. */
export const TICK = 'M2.6 6.3 4.9 8.8 9.4 3.3';

/**
 * A status, drawn: a shape, a colour and a word.
 *
 * Colour alone is not a status — a third of the operator's friends could not
 * read it — so each state has its OWN SHAPE (`data-mark`, drawn in an inline
 * `<svg>` we own) and its own border style as well. `screens/screens.css` colours it;
 * remove every colour from that file and this still reads.
 */
export function StatusPill({ testId, state, mark, label }: { testId: string; state: 'yes' | 'no'; mark: 'tick' | 'ring'; label: string }) {
  return (
    <span className="pill pill--ready" data-testid={testId} data-state={state} data-mark={mark}>
      <svg className="pill__mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {mark === 'tick' ? <path d={TICK} /> : <circle cx="6" cy="6" r="3.4" />}
      </svg>
      {label}
    </span>
  );
}
