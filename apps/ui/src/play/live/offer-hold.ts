/*
 * The board's offer through Forge's silences: from a click, a press or the end of a priority window
 * to the next set Forge names this seat.
 *
 * The operator, 2026-10-16: *"activating an ability from one creature to another causes an extra
 * flash of the blue outline … 1. i activate Nomads en-Kor (all cards turn black, then things turn
 * green again as they are selectable) 2. i select a card, everything turns black then things turn
 * green again … can we remove the intermittent flashing to black?"* Between a click and Forge's
 * next input, Forge first withdraws the input the click answered (`clearWeaklySelectable`,
 * `clearSelectables`), then asks the questions the browser answers by itself (`getAbilityToPlay`
 * with one ability, `openZones`), then the server passes the caster's own priority and the stack
 * resolves under the pacer's beat — and only then names the next set. Drawn frame by frame, every
 * one of those steps is "nothing offered", and every outline went dark for it.
 *
 * The operator again, 2026-10-28, on normal play: *"i notice there is a lot of flashing going on
 * when proceeding through phases. this happens whenever cards are clickable and briefly become
 * not-clickable between phases."* Measured (`e2e/w80-steady-glow.spec.ts`), every one of those
 * blinks was a silence of the same kind: a press of Next Phase drops the bar's input until Forge
 * answers, Forge clears the actionable set at the end of each priority window
 * (`clearWeaklySelectable`) and names the next one a pacer beat later, and the card just clicked went
 * dark on its spend and lit again from the stale set on Forge's next frame, then dark again.
 *
 * So the board keeps drawing the last offer it had through every silence of Forge's about what this
 * seat may do, and not a moment past Forge's word. A hold starts on a click on a card or a player,
 * on a press of Forge's bar, and on Forge's own end of a priority window in this seat's own turn
 * (on the other's, the windows the server passes for this seat were never drawn); while it stands
 * the board draws the held offer together with whatever Forge's own state still names. It ends when:
 *
 *  - Forge names a set, even an empty one (`setSelectables`, `setWeaklySelectable`): its word is drawn;
 *  - a question this seat answers by hand opens (any ask `selfAnswer` does not answer);
 *  - the game waits on another seat (`forge:seats`' `waitingOn`): the decision has left this seat;
 *  - the turn moves on;
 *  - or it has stood `HOLD_MAX_MS` (`./timed-hold.ts`).
 *
 * A phase moving on does not end it: Forge passes through steps nobody stops in, and a card offered
 * on both sides of one is the blink this exists to remove.
 *
 * What a click held: everything but what it pressed. The card or player pressed goes dark at once and
 * stays dark until Forge says what came of it (a land played is offered again for its mana, a spell
 * cast is not) — never lit again from Forge's stale state in between, which is what a press on it
 * would be refused against, and in an open selection a chosen target pressed again cancels the cast.
 * Nor is anything Forge marks in a held selection drawn ({@link dropMarked}).
 *
 * It is drawing only. What a click may SEND is still `boardInteraction`, Forge's real state
 * (`selectCard`, `selectPlayer` and the gesture layer read nothing else), so a held outline never
 * answers anything Forge did not offer.
 */

import type { LiveClickables } from './match.ts';
import { holdStands, type TimedHold } from './timed-hold.ts';

/** A silence of Forge's: the offer to keep drawing, and the turn it belongs to. */
export interface OfferHold extends TimedHold {
  /** The offer drawn when the silence began, less anything marked since in a held selection. */
  offer: LiveClickables;
  readonly turn: number;
  /** What was pressed while it stood: not drawn until Forge names it again, never a press to keep. */
  readonly pressed: Pressed;
}

/** The cards and players clicked under a hold. */
export interface Pressed {
  readonly cards: ReadonlySet<number>;
  readonly players: ReadonlySet<number>;
}

/** Why a held offer may no longer be drawn: the facts {@link drawnOfferOf} reads, gathered by `match.ts`. */
export interface OfferFacts {
  readonly now: number;
  readonly turn: number | null;
  /** A question is open that this seat answers by hand. */
  readonly askedByHand: boolean;
  /** The game is waiting on a seat that is not this one. */
  readonly waitingOnAnother: boolean;
}

const isEmpty = (offer: LiveClickables): boolean => offer.selectable.size === 0 && offer.selectablePlayers.size === 0;

/** `a` with `b`, less `out`. */
const joined = (a: ReadonlySet<number>, b: ReadonlySet<number>, out: ReadonlySet<number>): ReadonlySet<number> =>
  new Set([...a, ...[...b].filter((id) => !out.has(id))]);

/** The offer the board draws: Forge's own (`real`), with the held one through a silence. */
export function drawnOfferOf(real: LiveClickables, hold: OfferHold | null, facts: OfferFacts): LiveClickables {
  if (!holdStands(hold, facts.now) || facts.turn !== hold.turn || facts.askedByHand || facts.waitingOnAnother) return real;
  if (isEmpty(real)) return hold.offer;
  // Forge's state still names what was pressed — its stale set, a selection still open — and what was
  // pressed is dark until Forge names it again.
  return {
    selectable: joined(hold.offer.selectable, real.selectable, hold.pressed.cards),
    selectablePlayers: joined(hold.offer.selectablePlayers, real.selectablePlayers, hold.pressed.players),
    selectionOpen: hold.offer.selectionOpen || real.selectionOpen,
  };
}

/** What Forge has marked (`setHighlighted`): cards and players. */
export interface Marked {
  readonly cards: ReadonlySet<number> | null;
  readonly players: ReadonlySet<number> | null;
}

/**
 * A frame arrived while the hold stands: a held SELECTION loses whatever Forge has marked in it. A
 * mark inside an open selection is a choice already made (`InputSelectManyBase`'s chosen targets), and
 * Forge marks the target a click chose BEFORE it closes the selection: kept, the chosen target would
 * be drawn as offered through the whole turnaround to the next question, and a press on it there
 * cancels the cast (af69's Searing Blaze, run 39032975298: bob's face, held after he was chosen,
 * pressed once the creature step was open). Folded in as the frame arrives, because `clearSelectables`
 * drops the marks with the selection they belonged to.
 */
export function dropMarked(hold: OfferHold, marked: Marked): void {
  if (!hold.offer.selectionOpen) return;
  const unmarked = (ids: ReadonlySet<number>, marks: ReadonlySet<number> | null): ReadonlySet<number> =>
    marks === null ? ids : new Set([...ids].filter((id) => !marks.has(id)));
  hold.offer = { ...hold.offer, selectable: unmarked(hold.offer.selectable, marked.cards), selectablePlayers: unmarked(hold.offer.selectablePlayers, marked.players) };
}
