/**
 * How long a released card's placement is waited for — the row's reserved gap
 * (`Board.tsx`), the other seat's back standing in it (`live/presence.ts`) and
 * the stack layer's record of the release point (`live/placed.ts`) are one
 * fact, so one clock: none of them may give up while another still holds. A
 * cast that never resolves (countered, cancelled, a land) just ages out.
 */
export const PLACEMENT_WAIT_MS = 15_000;

/**
 * The house glide — a float-back, a hand FLIP, the other seat's hand-move —
 * so both screens move in step. `gestures.css` and `presence.css` write the
 * same 300ms in their transitions.
 */
export const GLIDE_MS = 300;
