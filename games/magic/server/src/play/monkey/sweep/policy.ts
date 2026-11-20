/*
 * The sweep's seat: it plays the cards it is given on purpose and answers everything that follows.
 *
 * It runs in `driveSeat`'s loop in place of the monkey's random policy, and like the monkey it never
 * models what is legal: every click is one `boardInteraction` offers and every answer is one
 * `randomAnswer` built. What it adds is intent. In its own main phase it takes its cards one at a
 * time, each through three stages:
 *
 *   cast    click the card in hand once it is offered
 *   casting answer what the cast asks (targets, costs, payment) and pass priority until it resolves
 *   use     click the card on the battlefield while it is offered (a Class's next level, an ability)
 *
 * and then it plays on (`follow`) to its next turn, attacking with its cards, so their turn-based
 * triggers fire. A card the main phase never offered is cast in those turns the moment it is: a
 * counterspell, when the AI casts its creature.
 *
 * `variant` settles every optional question the same way for a whole run: `accept` takes it (promise
 * the gift, pay the offspring cost, pick a target that is "up to one"), `decline` refuses it. A
 * yes/no Forge asks on its two buttons (`isConfirmPrompt`: "Pay for Offspring?", a trigger's "may")
 * is such a question once a card is being played, and is recorded with the asks as `bar`.
 *
 * Refusing can also cancel the cast: Forge asks a spell's target or its X in the same optional shape
 * as a cost, and a target picked on the board has the same Cancel a "may" has. When a `decline` run's
 * cast comes back to hand, the question it refused last is one it has to answer, and the card is cast
 * again taking it. A yes/no straight after a refused ask is Forge checking the refusal ("Cancel
 * Search?"), and is confirmed.
 */
import { isConfirmPrompt } from '../../../../../ui/src/play/prompts/confirm-bar.ts';
import { boardInteraction, liveBar, payFromPool, payingMana, poolPays, pressButton, selectCard, selectPlayer, type LiveMatch } from '../../../../../ui/src/play/live/match.ts';

import { cardLabel, type BoardAction } from '../board-action.ts';
import { randomAnswer, type LiveAsk } from '../random-answer.ts';
import type { SeatPolicy } from '../seat-driver.ts';

export type Variant = 'accept' | 'decline';

/** A question the card raised, as the seat got it: the ask's method and its own words and bounds, without ids. */
export interface AskSeen {
  /** When it was asked: while the card was being cast or used, or `follow`, the turns played on afterwards (combat, the AI's plays). */
  during: 'play' | 'follow';
  method: string;
  shape: Record<string, string | number | boolean | string[]>;
  declined: boolean;
}

export interface CardTrace {
  /** `not-offered`: the card was never offered, in the seat's main phase or the turns after it. `rolled-back`: the cast came back to hand. */
  cast: 'pending' | 'casting' | 'resolved' | 'not-offered' | 'rolled-back';
  /**
   * Every question, in order. Beside Forge's asks by their own method: `bar`, a yes/no on Forge's two
   * buttons, and `selection`, a pick Forge opened on the board (a target, a cost), once per wording.
   */
  asks: AskSeen[];
  /** Times the card was clicked on the battlefield after it resolved. */
  uses: number;
  attacked: boolean;
}

/** How many ticks of an empty main phase without the card offered before the seat goes on to its next card and waits for an offer of this one. */
const NOT_OFFERED_TICKS = 60;
/** How many ticks the card sits back in hand at priority before its cast is read as cancelled. */
const ROLLED_BACK_TICKS = 20;
/** How many ticks a selection may stay under the words that stood before it opened: its own arrive in a later frame. */
const UNWORDED_TICKS = 25;
/** How many ticks a pressed answer is given to be taken before it is pressed again: the server refuses a press made under a bar Forge has not re-armed, and sends the bar again. */
const BAR_RETRY_TICKS = 25;
/** How many ticks a selection's words must stand before the seat clicks in it. */
const STAND_TICKS = 3;
/** How many ticks a refusal waits for a selection's buttons to come live. */
const CANCEL_TICKS = 8;
/** How many quiet ticks a played card is given before the seat moves on: its triggers reach the view a frame after it lands. */
const SETTLE_TICKS = 20;
/** How many ticks an open selection may have nothing left to click before the seat starts it over. */
const RESELECT_TICKS = 15;
/** How many turns past its main phase the seat plays on. */
const FOLLOW_TURNS = 2;
const MAX_USES = 2;

/** What a listed option says of itself: the string it is, or the first of its own naming fields. */
function optionWords(option: unknown): string {
  if (typeof option === 'string') return option.slice(0, 120);
  if (typeof option !== 'object' || option === null) return String(option);
  const fields = option as Record<string, unknown>;
  for (const key of ['text', 'label', 'description', 'name', 'value', 'key', 'kind']) if (typeof fields[key] === 'string') return fields[key].slice(0, 120);
  return '?';
}

/** How many of a list's options an ask's shape names. */
const OPTIONS_NAMED = 8;

/** The ask without its ids: strings and numbers as they are, lists as their length and their first options' own words. */
function shapeOf(ask: LiveAsk): AskSeen['shape'] {
  const out: AskSeen['shape'] = {};
  for (const [key, value] of Object.entries(ask as unknown as Record<string, unknown>)) {
    if (key === 'callId' || key === 'kind' || key === 'method' || key === 'source') continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) {
      out[`${key}.length`] = value.length;
      if (value.length > 0) out[key] = value.slice(0, OPTIONS_NAMED).map(optionWords);
    }
  }
  return out;
}

export interface Sweeper {
  policy: SeatPolicy;
  /** The index of the card whose cast is in flight or which is being used, or null between cards and while playing on. */
  playing(): number | null;
  /** Every card has been played, or given up on, and the turns after are over. */
  done(): boolean;
}

/** `traces[i]` is filled for `cards[i]`. */
export function sweeper(cards: readonly string[], variant: Variant, traces: readonly CardTrace[]): Sweeper {
  /** Cards still to cast in the seat's own main phase, by index. */
  const queue = cards.map((_, i) => i);
  /** Cards the main phase did not offer: cast when offered while playing on. */
  const deferred: number[] = [];
  let playing: number | null = null;
  let stage: 'casting' | 'use' = 'casting';
  let following = false;
  let followFrom = 0;
  let finished = false;
  let clickedACard = false;
  let idle = 0;
  /** What this seat clicked in the selection now open; emptied when it closes. */
  const picked = new Set<string>();
  /** Ticks an open selection has had nothing left to click and no live button. */
  let nothingToPick = 0;
  /** Questions a refusal of which cancelled the cast, by {@link wordsOf}: taken from then on. */
  const required = new Set<string>();
  let lastDeclined: string | null = null;
  /** The last decision was an ask refused: a yes/no straight after it is Forge checking the refusal. */
  let askJustDeclined = false;
  /** The selection now open, by {@link wordsOf}: recorded once however many clicks it takes. */
  let openSelection: string | null = null;
  /** The prompt as it stood with no selection open, and the ticks an open selection has still shown it. */
  let quietPrompt: string | null = null;
  let unworded = 0;
  /** The open selection's prompt, and the ticks it has stood unchanged. */
  let standingPrompt: string | null = null;
  let stood = 0;
  /** Ticks a refusal has waited for the open selection's Cancel. */
  let cancelWait = 0;
  /** The prompt when the seat last clicked in the open selection: the next click waits for the words to move. */
  let promptAtPick: string | null = null;
  /** The last yes/no the seat pressed, and the ticks it has stayed up since. */
  let barAnswer: { declined: boolean; ticks: number } | null = null;
  /** Quiet ticks since the card being played last did anything. */
  let settled = 0;
  /** `LiveMatch.forgeSeq` when the seat last answered a question on the bar. */
  let barAnsweredAt = -1;
  /** The attackers this seat has declared, by card id. */
  const attacked = new Set<number>();
  /** A question by its method and wording, without the counts and card ids Forge writes into it. */
  const wordsOf = (method: string, shape: AskSeen['shape']): string => `${method}:${String(shape.message ?? shape.title ?? '').replace(/\d+/g, 'N')}`;

  /** A question goes to the card being played; one asked while playing on belongs to every card of the match. */
  const record = (ask: Omit<AskSeen, 'during'>): void => {
    if (playing !== null) traces[playing]!.asks.push({ during: 'play', ...ask });
    else for (const trace of traces) trace.asks.push({ during: 'follow', ...ask });
  };
  const press = (match: LiveMatch, which: 'ok' | 'cancel', label: string): BoardAction => ({ kind: which === 'ok' ? 'press-ok' : 'press-cancel', detail: label, ok: pressButton(match, which) });
  const click = (match: LiveMatch, id: number): BoardAction => {
    clickedACard = true;
    return { kind: 'select-card', detail: cardLabel(match, id), ok: selectCard(match, id) };
  };
  const start = (match: LiveMatch, index: number, id: number): BoardAction => {
    playing = index;
    stage = 'casting';
    traces[index]!.cast = 'casting';
    idle = 0;
    lastDeclined = null;
    return click(match, id);
  };

  const policy: SeatPolicy = {
    answer(rng, ask) {
      const shape = shapeOf(ask);
      // Which ability of the clicked card to play is the play itself, never an option to refuse: declining it cancels the cast.
      const decline = variant === 'decline' && ask.method !== 'getAbilityToPlay' && !required.has(wordsOf(ask.method, shape));
      let answer = randomAnswer(rng, ask);
      for (let i = 0; i < 32 && answer.declined !== decline; i += 1) answer = randomAnswer(rng, ask);
      if (answer.declined) lastDeclined = wordsOf(ask.method, shape);
      askJustDeclined = answer.declined;
      record({ method: ask.method, shape, declined: answer.declined });
      return answer;
    },

    act(rng, match) {
      const view = match.view;
      if (view === null || !match.connected || !match.inputLive) return null;
      const me = view.players.find((p) => p.isViewer);
      if (me === undefined) return null;
      const offer = boardInteraction(match);
      const bar = liveBar(match);
      const ok = bar?.enable1 === true && bar.refusal1 === undefined;

      if (payingMana(match)) {
        if (ok) return press(match, 'ok', bar.label1);
        const source = [...offer.selectable][0];
        if (source !== undefined) return click(match, source);
        const color = poolPays(match)[0];
        if (color !== undefined) return { kind: 'pay-from-pool', detail: color, ok: payFromPool(match, color) };
        return bar?.enable2 === true ? press(match, 'cancel', bar.label2) : null;
      }

      if (offer.selectionOpen) {
        // The selection and its words are two frames: it is neither answered nor recorded under the last prompt's.
        if ((match.prompt === quietPrompt || match.prompt === promptAtPick) && unworded < UNWORDED_TICKS) {
          unworded += 1;
          return null;
        }
        // Its buttons are a third frame: nothing is clicked until the words have stood for a few ticks.
        if (match.prompt !== standingPrompt) {
          standingPrompt = match.prompt;
          stood = 0;
        }
        stood += 1;
        if (stood <= STAND_TICKS) return null;
        settled = 0;
        const shape = { message: (match.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) };
        const key = wordsOf('selection', shape);
        const cancel = bar?.enable2 === true;
        const declining = variant === 'decline' && clickedACard;
        // Refused where Forge lets it be, before anything is picked: a "may" at resolution, or the cast itself.
        const refuse = declining && cancel && picked.size === 0 && !required.has(key);
        // Forge's buttons arrive after the selection they belong to: a refusal waits for one before settling for a pick.
        if (declining && !refuse && !ok && cancelWait < CANCEL_TICKS) {
          cancelWait += 1;
          return null;
        }
        // Recorded when the seat first acts in it: a selection still open under "Waiting for…" is not a question yet.
        const seen = (declined: boolean): void => {
          if (key === openSelection) return;
          openSelection = key;
          record({ method: 'selection', shape, declined });
        };
        askJustDeclined = false;
        if (refuse) {
          seen(true);
          lastDeclined = key;
          return press(match, 'cancel', bar.label2);
        }
        // OK with nothing picked is "up to one" refused; after a pick it is the fewest Forge takes.
        if (declining && ok) {
          seen(picked.size === 0);
          return press(match, 'ok', bar.label1);
        }
        // Its own cards last: a card that bounces or exiles a permanent is not aimed at itself while anything else is offered.
        const own = new Set([...me.battlefield, ...(me.hand ?? [])].filter((c) => cards.includes(c.card.name)).map((c) => c.id));
        const unpicked = [...offer.selectable].filter((id) => !picked.has(`c${id}`));
        const others = unpicked.filter((id) => !own.has(id));
        const candidates = others.length > 0 ? others : unpicked;
        const players = [...offer.selectablePlayers].filter((id) => !picked.has(`p${id}`));
        // `accept` takes every target offered ("up to two"); `decline` stops as soon as Forge lets it.
        const wantsOne = variant === 'accept' || !ok || picked.size === 0;
        if (wantsOne && candidates.length > 0) {
          seen(false);
          const id = rng.pick(candidates)!;
          picked.add(`c${id}`);
          nothingToPick = 0;
          promptAtPick = match.prompt;
          unworded = 0;
          cancelWait = 0;
          return click(match, id);
        }
        if (wantsOne && players.length > 0) {
          seen(false);
          const id = rng.pick(players)!;
          picked.add(`p${id}`);
          nothingToPick = 0;
          promptAtPick = match.prompt;
          unworded = 0;
          cancelWait = 0;
          return { kind: 'select-player', detail: `player ${id}`, ok: selectPlayer(match, id) };
        }
        if (ok) return press(match, 'ok', bar.label1);
        if (cancel) return press(match, 'cancel', bar.label2);
        // Everything offered was clicked and nothing is live: a second selection opened in the same words
        // (two copies of one trigger) while the first's clicks were still counted. Start it over.
        nothingToPick += 1;
        if (nothingToPick > RESELECT_TICKS) {
          picked.clear();
          nothingToPick = 0;
        }
        return null;
      }
      picked.clear();
      nothingToPick = 0;
      openSelection = null;
      quietPrompt = match.prompt;
      promptAtPick = null;
      unworded = 0;
      cancelWait = 0;
      standingPrompt = null;

      // A question on the bar. Before any card is clicked it is the opening's (Keep or Mulligan), always kept.
      if (bar !== null && isConfirmPrompt(bar)) {
        if (!clickedACard) return press(match, 'ok', bar.label1);
        // One answer per question: the bar stays up until Forge has taken the press. A press the server
        // refused leaves it up for good, so the same answer is pressed again, and recorded once.
        if (match.forgeSeq === barAnsweredAt && barAnswer !== null) {
          barAnswer.ticks += 1;
          if (barAnswer.ticks <= BAR_RETRY_TICKS) return null;
          barAnswer.ticks = 0;
          return press(match, barAnswer.declined ? 'cancel' : 'ok', barAnswer.declined ? bar.label2 : bar.label1);
        }
        barAnsweredAt = match.forgeSeq;
        const shape = { message: (match.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), label1: bar.label1, label2: bar.label2 };
        const declined = variant === 'decline' && !askJustDeclined && !required.has(wordsOf('bar', shape));
        if (declined) lastDeclined = wordsOf('bar', shape);
        askJustDeclined = false;
        record({ method: 'bar', shape, declined });
        barAnswer = { declined, ticks: 0 };
        return press(match, declined ? 'cancel' : 'ok', declined ? bar.label2 : bar.label1);
      }
      askJustDeclined = false;

      const mine = view.activePlayerId === match.playerId;
      const quietMain = mine && (view.phase === 'MAIN1' || view.phase === 'MAIN2') && view.stack.length === 0 && (view.pendingTriggers ?? []).length === 0;
      const priority = ok && !isConfirmPrompt(bar);
      const inHand = (name: string) => (me.hand ?? []).find((c) => c.card.name === name);
      const pass = (): BoardAction | null => (ok ? press(match, 'ok', bar.label1) : null);

      if (playing !== null) {
        const name = cards[playing]!;
        const trace = traces[playing]!;
        if (stage === 'casting') {
          const held = inHand(name);
          if (priority && held === undefined && !view.stack.some((entry) => entry.sourceName === name)) {
            trace.cast = 'resolved';
            stage = 'use';
            settled = 0;
          } else if (priority && held !== undefined) {
            idle += 1;
            if (idle <= ROLLED_BACK_TICKS) return null;
            // The cast came back. Refusing its last question cancelled it: cast it again, taking that question.
            if (lastDeclined !== null && !required.has(lastDeclined)) {
              required.add(lastDeclined);
              trace.cast = 'pending';
              (following ? deferred : queue).unshift(playing);
            } else {
              trace.cast = 'rolled-back';
            }
            playing = null;
            idle = 0;
            return null;
          } else {
            return pass();
          }
        }
        if (stage === 'use') {
          const onBoard = me.battlefield.find((c) => c.card.name === name);
          if (quietMain && onBoard !== undefined && trace.uses < MAX_USES && offer.selectable.has(onBoard.id)) {
            trace.uses += 1;
            settled = 0;
            return click(match, onBoard.id);
          }
          // In the seat's own main phase a use still resolving is waited out, and a quiet board is given
          // time to show a trigger; anywhere else the card is done with.
          if (mine && !following) {
            if (!quietMain) {
              settled = 0;
              return pass();
            }
            // Counted only while the seat holds priority: what the card offers is not known before then.
            if (priority) settled += 1;
            if (settled <= SETTLE_TICKS) return null;
          }
          playing = null;
          idle = 0;
        }
      }

      if (!following) {
        const next = queue[0];
        if (next === undefined) {
          following = true;
          followFrom = view.turn;
        } else {
          const held = inHand(cards[next]!);
          if (held !== undefined && quietMain && priority && offer.selectable.has(held.id)) {
            queue.shift();
            return start(match, next, held.id);
          }
          if (!quietMain) return pass();
          idle += 1;
          if (idle > NOT_OFFERED_TICKS) {
            queue.shift();
            deferred.push(next);
            idle = 0;
          }
          return null;
        }
      }

      for (const index of deferred) {
        const held = inHand(cards[index]!);
        if (held === undefined || !priority || !offer.selectable.has(held.id)) continue;
        deferred.splice(deferred.indexOf(index), 1);
        return start(match, index, held.id);
      }
      if (view.turn >= followFrom + FOLLOW_TURNS && mine && view.phase === 'MAIN2') {
        for (const index of deferred) traces[index]!.cast = 'not-offered';
        finished = true;
        return null;
      }
      if (mine && view.phase === 'COMBAT_DECLARE_ATTACKERS') {
        const attacker = me.battlefield.find((c) => cards.includes(c.card.name) && !attacked.has(c.id) && offer.selectable.has(c.id));
        if (attacker !== undefined) {
          attacked.add(attacker.id);
          traces[cards.indexOf(attacker.card.name)]!.attacked = true;
          return click(match, attacker.id);
        }
      }
      return pass();
    },
  };
  return { policy, playing: () => playing, done: () => finished };
}
