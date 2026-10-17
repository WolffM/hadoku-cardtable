/*
 * The board's offer through one turnaround of Forge's: a click on an offered card or player, and
 * the next decision Forge shows this seat.
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
 * So after a click the board keeps drawing the last offer it had — minus everything clicked since —
 * for as long as Forge is SILENT about what this seat may do, and not a moment past Forge's word:
 *
 *  - a non-empty offer is always drawn as it is, and becomes the held offer;
 *  - Forge naming a set, even an empty one (`setSelectables`, `setWeaklySelectable`), ends it;
 *  - a question this seat answers by hand (any ask `selfAnswer` does not answer) ends it;
 *  - the game waiting on another seat (`forge:seats`' `waitingOn`) ends it;
 *  - the turn or the phase moving on ends it;
 *  - and it never stands longer than {@link OFFER_HOLD_MAX_MS}.
 *
 * It is drawing only. What a click may SEND is still `boardInteraction`, Forge's real state
 * (`selectCard`, `selectPlayer` and the gesture layer read nothing else), so a held outline never
 * answers anything Forge did not offer.
 */

import type { LiveClickables } from './match.ts';

/** The longest the board keeps drawing an offer after a click while Forge says nothing. */
export const OFFER_HOLD_MAX_MS = 2_000;

/** A click's turnaround: the offer to keep drawing, and the moment it belongs to. */
export interface OfferHold {
  /** The last non-empty offer since the click, never including what was clicked. */
  offer: LiveClickables;
  /** `Date.now()` at the click. */
  readonly since: number;
  readonly turn: number;
  readonly phase: string | null;
}

/** Why a held offer may no longer be drawn: the facts {@link drawnOfferOf} reads, gathered by `match.ts`. */
export interface OfferFacts {
  readonly now: number;
  readonly turn: number | null;
  readonly phase: string | null;
  /** Forge has named a set for this seat — a selection or an actionable set, even an empty one. */
  readonly forgeNamedASet: boolean;
  /** A question is open that this seat answers by hand. */
  readonly askedByHand: boolean;
  /** The game is waiting on a seat that is not this one. */
  readonly waitingOnAnother: boolean;
}

const isEmpty = (offer: LiveClickables): boolean => offer.selectable.size === 0 && offer.selectablePlayers.size === 0;

/** The offer the board draws: Forge's own (`real`), or the held one through a silence after a click. */
export function drawnOfferOf(real: LiveClickables, hold: OfferHold | null, facts: OfferFacts): LiveClickables {
  if (hold === null || !isEmpty(real)) return real;
  if (facts.now - hold.since >= OFFER_HOLD_MAX_MS) return real;
  if (facts.turn !== hold.turn || facts.phase !== hold.phase) return real;
  if (facts.forgeNamedASet || facts.askedByHand || facts.waitingOnAnother) return real;
  return hold.offer;
}

/** What Forge has marked (`setHighlighted`): cards and players. */
export interface Marked {
  readonly cards: ReadonlySet<number> | null;
  readonly players: ReadonlySet<number> | null;
}

/**
 * A frame arrived while the hold stands: a non-empty offer from Forge is the one to keep drawing —
 * less, while it is a selection, whatever Forge has marked in it. A mark inside an open selection is
 * a choice already made (`InputSelectManyBase`'s chosen targets), and Forge marks the target a click
 * chose BEFORE it closes the selection: kept, the chosen target would be drawn as offered through the
 * whole turnaround to the next question, and a press on it there cancels the cast (af69's Searing
 * Blaze, run 39032975298: bob's face, held after he was chosen, pressed once the creature step was
 * open).
 */
export function followOffer(hold: OfferHold, real: LiveClickables, marked: Marked): void {
  if (isEmpty(real)) return;
  if (!real.selectionOpen) {
    hold.offer = real;
    return;
  }
  const unmarked = (ids: ReadonlySet<number>, marks: ReadonlySet<number> | null): ReadonlySet<number> =>
    marks === null ? ids : new Set([...ids].filter((id) => !marks.has(id)));
  hold.offer = { ...real, selectable: unmarked(real.selectable, marked.cards), selectablePlayers: unmarked(real.selectablePlayers, marked.players) };
}
