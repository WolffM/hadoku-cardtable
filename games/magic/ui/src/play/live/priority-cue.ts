/**
 * When "priority is back with you" sounds (`ui.priority`).
 *
 * The operator, 2026-10-14: *"we need to play a sound effect when players get priority beyond
 * the first time. makes it easier to know when you have priority."*
 *
 * A window is a live priority bar of this seat's own — the server forwards only the windows it
 * keeps, so a window it passed for the seat never reaches here and never sounds. The cue sounds as
 * a window opens, except for the first one of the seat's own turn (its turn's own sound already
 * says so): every later window of that turn, and every window on the other seat's turn, which is
 * priority handed back after they acted.
 */

export interface PriorityCue {
  /** The turn the count below belongs to. */
  readonly turn: number;
  /** Windows this seat has held this turn. */
  readonly held: number;
  /** A window is open now. */
  readonly live: boolean;
}

export const NO_PRIORITY_CUE: PriorityCue = { turn: -1, held: 0, live: false };

/** The cue after one render: the window's state now, and whether a window just opened that sounds. */
export function nextPriorityCue(prev: PriorityCue, now: { turn: number; mine: boolean; live: boolean }): { cue: PriorityCue; sound: boolean } {
  const sameTurn = now.turn === prev.turn;
  const held = sameTurn ? prev.held : 0;
  if (!now.live) return { cue: { turn: now.turn, held, live: false }, sound: false };
  if (prev.live && sameTurn) return { cue: prev, sound: false };
  return { cue: { turn: now.turn, held: held + 1, live: true }, sound: !now.mine || held > 0 };
}
