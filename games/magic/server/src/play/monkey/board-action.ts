/*
 * A random LEGAL board action, for everything Forge asks through a click or a
 * button rather than through a blocking ask: playing a land or a spell,
 * declaring an attacker or a blocker, paying a mana cost, the mulligan
 * keep/bottom pick, passing priority.
 *
 * As with `./random-answer.ts`, legality is never modelled here — `boardInteraction`
 * (`apps/ui/src/play/live/match.ts`) is the ONE function that says what Forge
 * currently offers (`setSelectables` when a selection is open, else
 * `setWeaklySelectable` union the marks and the mulligan hand and the combat
 * targets), reused verbatim. This file only picks UNIFORMLY AT RANDOM among
 * what it returns, plus the live button bar and the mana/life payment
 * alternatives `match.ts` also already exposes.
 */

import {
  boardInteraction,
  liveBar,
  lifePayer,
  payFromPool,
  payWithLife,
  payingMana,
  poolChoice,
  poolPays,
  pressButton,
  selectCard,
  selectPlayer,
  type LiveMatch,
} from '../../../../../../apps/ui/src/play/live/match.ts';
import type { BoardView } from '../../../../../../apps/ui/src/play/adapter.ts';

import type { Rng } from './rng.ts';

export type BoardActionKind =
  | 'select-card'
  | 'select-player'
  | 'press-ok'
  | 'press-cancel'
  | 'pay-from-pool'
  | 'pay-with-life';

export interface BoardAction {
  kind: BoardActionKind;
  detail: string;
  /** What `match.ts` reported: false means the click was refused (a client-side guard, or Forge's `flashIncorrectAction` lagging a stale offer). */
  ok: boolean;
}

/**
 * A clicked card as the report names it: its id, then its name, zone and tapped state off this
 * seat's own view, then which of the offers `boardInteraction` unions named it — so a refused
 * click says what was clicked and why the monkey thought it was on offer.
 */
export function cardLabel(match: LiveMatch, id: number): string {
  const where = cardWhere(match.view, id);
  const offers = [
    match.selectables?.cards.has(id) === true ? 'selection' : null,
    match.weaklySelectable?.has(id) === true ? 'weakly' : null,
    match.weaklySelectableManaOnly?.has(id) === true ? 'mana-only' : null,
    match.highlighted?.has(id) === true ? 'highlighted' : null,
  ].filter((o) => o !== null);
  return `card ${id}${where === null ? '' : ` ${where}`}${offers.length > 0 ? ` [${offers.join(',')}]` : ''}`;
}

function cardWhere(view: BoardView | null, id: number): string | null {
  if (view === null) return null;
  for (const p of view.players) {
    const zones = { hand: p.hand ?? [], battlefield: p.battlefield, graveyard: p.graveyard, exile: p.exile } as const;
    for (const [zone, cards] of Object.entries(zones)) {
      const c = cards.find((x) => x.id === id);
      if (c !== undefined) return `"${c.card.name}" (${p.isViewer ? 'own' : 'their'} ${zone}${c.tapped ? ', tapped' : ''})`;
    }
  }
  return null;
}

/**
 * One random board action, or null when nothing is offered right now — not a
 * flag by itself: it is this seat's normal state while it holds no priority
 * and no ask is open (`!match.inputLive`), waiting on the other seat or on
 * Forge's own resolution.
 */
export function takeRandomBoardAction(rng: Rng, match: LiveMatch): BoardAction | null {
  if (match.view === null || !match.connected || !match.inputLive) return null;

  const offer = boardInteraction(match);
  const bar = liveBar(match);
  type Candidate = () => BoardAction;
  const candidates: Candidate[] = [];

  for (const cardId of offer.selectable) {
    candidates.push(() => ({ kind: 'select-card', detail: cardLabel(match, cardId), ok: selectCard(match, cardId) }));
  }
  for (const playerId of offer.selectablePlayers) {
    candidates.push(() => ({ kind: 'select-player', detail: `player ${playerId}`, ok: selectPlayer(match, playerId) }));
  }
  if (bar?.enable1 === true && bar.refusal1 === undefined) {
    candidates.push(() => ({ kind: 'press-ok', detail: bar.label1, ok: pressButton(match, 'ok') }));
  }
  if (bar?.enable2 === true) {
    candidates.push(() => ({ kind: 'press-cancel', detail: bar.label2 ?? 'cancel', ok: pressButton(match, 'cancel') }));
  }
  if (payingMana(match) && poolChoice(match)) {
    for (const color of poolPays(match)) {
      candidates.push(() => ({ kind: 'pay-from-pool', detail: color, ok: payFromPool(match, color) }));
    }
  }
  // The board's own life button, enabled only while a press is open (`LiveBoard`'s `live-payment-life`): spent
  // after a press until Forge answers it, so a second press there is one no player can make.
  if (payingMana(match) && bar !== null && lifePayer(match) !== null) {
    candidates.push(() => ({ kind: 'pay-with-life', detail: 'life', ok: payWithLife(match) }));
  }

  const chosen = rng.pick(candidates);
  return chosen === undefined ? null : chosen();
}
