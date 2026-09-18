/*
 * TEST SUPPORT — two players at a real Forge match, steered to the questions
 * a scenario wants Forge to ask. Never imported by the app.
 *
 * Each seat is a `LiveBoard` rendered into its own container. On every tick a
 * seat either has a prompt open — and `answerOpenPrompt` answers it through
 * the component, the way a person would — or it reads the game (Forge's prompt
 * message, buttons and selectables, which `jvm-harness.ts` keeps, plus the
 * seat's own board) and sends at most one act. Acts are what a person would
 * click: a land, a spell, an attacker, a blocker, a target, OK.
 *
 * The plan is deliberately simple play: lands first, then the plan's spells
 * in order, attack with one creature, block with as many as the plan says.
 * It is not trying to win; it is trying to reach the asks.
 */

import { createElement } from 'react';
import { render } from '@testing-library/react';

import type { BoardPlayer, BoardView } from '../adapter.ts';
import { LiveBoard } from './LiveBoard.tsx';
import { currentAsk } from './match.ts';
import type { LiveHarness, SeatClient } from './jvm-harness.ts';
import { answerOpenPrompt, type PromptPreferences } from './prompt-driver.ts';

export interface CastPlan {
  name: string;
  /** Untapped lands needed before it is tried. */
  mana: number;
}

export interface Plan {
  /** Which hand cards are lands. */
  land: RegExp;
  /** Spells to cast in the first main phase, in this order, one of each per turn. */
  casts: readonly CastPlan[];
  /** Cast every copy of these each main phase — free creatures. */
  zeroDrops?: readonly string[];
  /** Attack with one creature of this name, from this turn on. */
  attack?: { name: string; fromTurn: number };
  /** Block the first attacker with up to this many creatures of this name. */
  block?: { name: string; count: number };
  /** At the keep/mulligan prompt, click this card in hand once (Serum Powder). */
  mulliganWith?: string;
  /** Target preference: an opponent's creature of this name, else the opponent. */
  targetCard?: string;
  prompts?: PromptPreferences;
}

type Act = Parameters<SeatClient['act']>[0];

const cardRef = (id: number) => ({ kind: 'card' as const, id });
const select = (id: number): Act => ({ kind: 'act', method: 'selectCard', card: cardRef(id), otherCardViewsToSelect: [], triggerEvent: null });
const OK: Act = { kind: 'act', method: 'selectButtonOk' };

export interface Driver {
  roots: [HTMLElement, HTMLElement];
  log: string[];
  /** One tick: answer an open prompt, or take at most one action, per seat. */
  step(): void;
}

/** How long a seat may sit on an enabled OK with nothing new before it presses it. */
const IDLE_MS = 3000;

export function createDriver(h: LiveHarness, plan: Plan): Driver {
  const mount = (s: SeatClient): HTMLElement => {
    const root = document.createElement('div');
    root.dataset.seat = String(s.seat);
    document.body.appendChild(root);
    render(createElement(LiveBoard, { match: s.live }), { container: root });
    return root;
  };
  const roots: [HTMLElement, HTMLElement] = [mount(h.seats[0]), mount(h.seats[1])];
  const log: string[] = [];
  const seen = [0, 0];
  const idleSince = [Date.now(), Date.now()];
  const done = [new Set<string>(), new Set<string>()];
  const picks = [new Map<string, number[]>(), new Map<string, number[]>()];

  function decide(s: SeatClient, v: BoardView, me: BoardPlayer, opp: BoardPlayer): [string, Act] | null {
    const msg = s.notes.prompt?.message ?? '';
    const buttons = s.notes.buttons;
    const mine = done[s.seat]!;
    const once = (k: string) => (mine.has(`${v.turn}:${k}`) ? false : (mine.add(`${v.turn}:${k}`), true));
    const myTurn = v.activePlayerId === me.id;

    if (/keep your hand/.test(msg) && plan.mulliganWith !== undefined) {
      const card = me.hand?.find((c) => c.card.name === plan.mulliganWith);
      if (card !== undefined && once('mulligan-with')) return [`use ${card.card.name}`, select(card.id)];
    }
    if (msg.startsWith(`Priority: ${me.name}`)) {
      if (myTurn && v.phase === 'MAIN1' && /Stack: Empty/.test(msg)) {
        const land = me.hand?.find((c) => plan.land.test(c.card.name));
        if (land !== undefined && once('land')) return [`play ${land.card.name}`, select(land.id)];
        for (const name of plan.zeroDrops ?? []) {
          const c = me.hand?.find((x) => x.card.name === name);
          if (c !== undefined && once(`zero-${c.id}`)) return [`cast ${name}`, select(c.id)];
        }
        const untapped = me.battlefield.filter((c) => plan.land.test(c.card.name) && !c.tapped).length;
        for (const { name, mana } of plan.casts) {
          const c = me.hand?.find((x) => x.card.name === name);
          if (c !== undefined && untapped >= mana && once(`cast-${name}`)) return [`cast ${name}`, select(c.id)];
        }
      }
      return buttons?.enable1 === true ? ['pass', OK] : null;
    }
    if (/to attack/.test(msg) && myTurn) {
      const a = plan.attack;
      const attacker = me.battlefield.find((c) => c.card.name === a?.name && !c.summoningSick && !c.tapped && !c.attacking);
      if (a !== undefined && attacker !== undefined && v.turn >= a.fromTurn && once('attack')) return [`attack with ${attacker.id}`, select(attacker.id)];
      return ['attackers done', OK];
    }
    if (/[Bb]lock/.test(msg) && !myTurn) {
      const b = plan.block;
      const free = me.battlefield.filter((c) => c.card.name === b?.name && !c.tapped && !c.blocking);
      const used = [...mine].filter((k) => k.startsWith(`${v.turn}:block-`)).length;
      if (b !== undefined && free[0] !== undefined && used < b.count) {
        mine.add(`${v.turn}:block-${used}`);
        return [`block with ${free[0].id}`, select(free[0].id)];
      }
      return ['blockers done', OK];
    }
    if (/target/i.test(msg) && !/Pay Mana Cost/.test(msg)) {
      const t = opp.battlefield.find((c) => c.card.name === plan.targetCard);
      if (t !== undefined && once('target-card')) return [`target ${t.card.name} ${t.id}`, select(t.id)];
      if (once('target-player')) {
        return [`target player ${opp.id}`, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: opp.id }, triggerEvent: null }];
      }
      return buttons?.enable1 === true ? ['targets done', OK] : null;
    }
    const sel = s.notes.selectables;
    if (sel !== null && sel.cards.length > 0 && sel.min > 0) {
      const key = `${v.turn}:${msg}`;
      const picked = picks[s.seat]!.get(key) ?? [];
      const next = sel.cards.find((c) => !picked.includes(c.id));
      if (picked.length < sel.min && next !== undefined) {
        picks[s.seat]!.set(key, [...picked, next.id]);
        return [`choose ${next.id}`, select(next.id)];
      }
    }
    return buttons?.enable1 === true ? ['OK', OK] : null;
  }

  function step(): void {
    for (const s of h.seats) {
      const ask = currentAsk(s.live);
      if (ask !== null) {
        const shown = roots[s.seat]!.querySelector('[data-testid="live-prompt"]')?.textContent ?? '';
        log.push(`seat ${s.seat} answers ${ask.method} ${ask.callId}: ${shown.slice(0, 200)}`);
        answerOpenPrompt(roots[s.seat]!, plan.prompts);
        idleSince[s.seat] = Date.now();
        continue;
      }
      const v = s.live.view;
      if (v === null) continue;
      const me = v.players.find((p) => p.isViewer);
      const opp = v.players.find((p) => !p.isViewer);
      if (me === undefined || opp === undefined) continue;
      if (/^Waiting/.test(s.notes.prompt?.message ?? '')) continue;
      if (s.notes.version === seen[s.seat]) {
        // Nothing new: an act that changed nothing (a card that cannot be
        // played now). Press OK rather than wait forever.
        if (Date.now() - idleSince[s.seat]! > IDLE_MS && s.notes.buttons?.enable1 === true) {
          log.push(`seat ${s.seat} idle -> OK`);
          idleSince[s.seat] = Date.now();
          s.act(OK);
        }
        continue;
      }
      seen[s.seat] = s.notes.version;
      idleSince[s.seat] = Date.now();
      const decision = decide(s, v, me, opp);
      if (decision === null) continue;
      log.push(`seat ${s.seat} t${v.turn} ${v.phase ?? '-'}: ${decision[0]}`);
      s.act(decision[1]);
    }
  }

  return { roots, log, step };
}

/** Tick until `done` holds, or fail with the driver's log. */
export async function drive(
  driver: Driver,
  done: () => boolean,
  timeoutMs: number,
  status: () => string = () => '',
  tickMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`the scenario did not finish in ${timeoutMs} ms: ${status()}\n${driver.log.slice(-60).join('\n')}`);
    }
    driver.step();
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
