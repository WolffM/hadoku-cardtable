/*
 * One seat's whole game: tick, answer an open ask or take a board action, tick
 * again, until the match ends or a cap is hit. This is the loop every flag in
 * `docs/MONKEY.md` comes out of.
 */

import { choiceBounds } from '../../../../ui/src/play/prompts/rules.ts';
import { currentAsk, type LiveMatch } from '../../../../ui/src/play/live/match.ts';
import { answerAsk, answerConfirm } from '../../../../ui/src/play/live/match.ts';

import { takeRandomBoardAction } from './board-action.ts';
import { randomAnswer, type LiveAsk } from './random-answer.ts';
import type { Rng } from './rng.ts';
import type { Flag, FlagKind } from './report.ts';

export interface SeatDriverOptions {
  matchId: string;
  seed: number;
  deck: { seat0: string; seat1: string };
  seat: number;
  /** How long this seat may be blocked (an ask open, or holding priority) with no progress before it is flagged `stuck`. */
  stuckMs: number;
  /** Server-side `flashIncorrectAction` / click-refused signals, fed in from the wire tap. */
  refusals: () => number;
  /** Server log lines this match's `ask-unanswerable`/`ask-unclassified` landed as, since the last read. */
  drainServerFlags: () => { evt: string; detail: string }[];
}

export interface SeatDriverResult {
  flags: Flag[];
  decisions: number;
}

const now = (): string => new Date().toISOString();

/** A compact signature of what is currently asked/offered — unchanged means no progress. */
function signatureOf(match: LiveMatch): string {
  const ask = currentAsk(match);
  if (ask !== null) return `ask:${ask.callId}`;
  return `bar:${match.prompt ?? ''}:${match.buttons?.label1 ?? ''}:${match.buttons?.enable1 ?? ''}:${match.selectables?.cards.size ?? -1}`;
}

/** A shape fingerprint for loop detection: the ask's method and what it offered, NOT its callId. */
function askFingerprint(ask: LiveAsk): string {
  const { callId, source: _source, ...rest } = ask as unknown as Record<string, unknown> & { callId: string };
  void callId;
  return JSON.stringify(rest);
}

export type DeclinedStreaks = Map<string, { count: number; turn: number; phase: string }>;

/** Asks that legitimately repeat with the same shape every turn by design — see the module header. */
export const LOOP_EXEMPT_METHODS: ReadonlySet<string> = new Set(['tempShowZones', 'openZones']);

/**
 * Track one more decline of `fp` (an ask's method + offered shape) at `(turn, phase)`, mutating
 * `streaks` in place, and say whether this is the THIRD time in a row at the SAME turn and phase —
 * the loop flag. A turn or phase change resets the count to 1: the same question shape recurring
 * turn after turn (a `tempShowZones` at every cleanup) is normal, never a loop; `method` in
 * {@link LOOP_EXEMPT_METHODS} is never counted at all.
 */
export function declineStreak(streaks: DeclinedStreaks, method: string, fp: string, turn: number, phase: string): { looping: boolean; count: number } {
  if (LOOP_EXEMPT_METHODS.has(method)) return { looping: false, count: 0 };
  const before = streaks.get(fp);
  const count = before !== undefined && before.turn === turn && before.phase === phase ? before.count + 1 : 1;
  streaks.set(fp, { count, turn, phase });
  return { looping: count >= 3, count };
}

/** `fp` answered (not declined), or exempt: no longer part of any streak. */
export function clearDeclineStreak(streaks: DeclinedStreaks, fp: string): void {
  streaks.delete(fp);
}

/** Whether `ask` demands more answers than it offered — the client-side mirror of `auto.ts`'s `answerability`. */
export function hasNoLegalAnswer(ask: LiveAsk): string | null {
  if (ask.method === 'getChoices') {
    const keys = ask.names ?? ask.choices.map((c) => c.key);
    const { min } = choiceBounds(ask.min, ask.max);
    if (min > keys.length) return `getChoices wants at least ${min} of ${keys.length} offered`;
  }
  if (ask.method === 'chooseEntitiesForEffect') {
    const { min } = choiceBounds(ask.min, ask.max);
    if (min > ask.optionList.length) return `chooseEntitiesForEffect wants at least ${min} of ${ask.optionList.length} offered`;
  }
  if (ask.method === 'chooseSingleEntityForEffect' && !ask.isOptional && ask.optionList.length === 0) {
    return 'chooseSingleEntityForEffect is required but offers nothing';
  }
  return null;
}

export async function driveSeat(
  match: LiveMatch,
  rng: Rng,
  opts: SeatDriverOptions,
  isOver: () => boolean,
  tickMs = 60,
): Promise<SeatDriverResult> {
  const flags: Flag[] = [];
  const log: string[] = [];
  const push = (s: string): void => {
    log.push(s);
    if (log.length > 40) log.shift();
  };
  const flag = (kind: FlagKind, detail: string, ask?: { method: string; prompt?: string }): void => {
    flags.push({
      kind,
      matchId: opts.matchId,
      seed: opts.seed,
      deck: opts.deck,
      seat: opts.seat,
      turn: match.view?.turn ?? null,
      phase: match.view?.phase ?? null,
      ask,
      detail,
      context: [...log],
      at: now(),
    });
  };

  let decisions = 0;
  let lastSignature = '';
  let blockedSince = Date.now();
  const flaggedStuckSignatures = new Set<string>();
  const declined: DeclinedStreaks = new Map();
  let seenRefusals = opts.refusals();

  while (!isOver()) {
    for (const line of opts.drainServerFlags()) {
      flag('server-unclassified', `server log ${line.evt}: ${line.detail}`);
    }
    const refusedNow = opts.refusals();
    if (refusedNow > seenRefusals) {
      flag('click-refused', `the server (or this client) refused ${refusedNow - seenRefusals} answer(s) since the last tick`);
      seenRefusals = refusedNow;
    }

    const signature = signatureOf(match);
    const blocked = match.asks.length > 0 || match.inputLive;
    if (signature !== lastSignature) {
      blockedSince = Date.now();
      lastSignature = signature;
    } else if (blocked && Date.now() - blockedSince > opts.stuckMs && !flaggedStuckSignatures.has(signature)) {
      flaggedStuckSignatures.add(signature);
      const ask = currentAsk(match);
      flag(
        'stuck',
        `no progress for over ${opts.stuckMs} ms while ${ask !== null ? `an ask (${ask.method}) was open` : 'holding priority'}`,
        ask === null ? undefined : { method: ask.method, prompt: match.prompt ?? undefined },
      );
    }

    const ask = currentAsk(match);
    if (ask !== null) {
      const noLegal = hasNoLegalAnswer(ask);
      if (noLegal !== null) flag('no-legal-answer', noLegal, { method: ask.method, prompt: match.prompt ?? undefined });

      const fp = `${ask.method}:${askFingerprint(ask)}`;
      const answer = randomAnswer(rng, ask);
      const turn = match.view?.turn ?? -1;
      const phase = match.view?.phase ?? '';
      if (answer.declined) {
        const { looping, count } = declineStreak(declined, ask.method, fp, turn, phase);
        if (looping) flag('loop', `declined ${ask.method} came back unchanged ${count} times in a row at the same turn/phase`, { method: ask.method });
      } else {
        clearDeclineStreak(declined, fp);
      }
      const sent = ask.method === 'showConfirmDialog' ? answerConfirm(match, ask.callId, answer.result as boolean) : answerAsk(match, ask.callId, ask.method, answer.result);
      push(`seat ${opts.seat} t${match.view?.turn ?? '-'} ${match.view?.phase ?? '-'}: answer ${ask.method}${answer.declined ? ' (declined)' : ''} ok=${sent}`);
      if (!sent) flag('click-refused', `this client's own schema check refused its ${ask.method} answer`, { method: ask.method });
      decisions += 1;
    } else {
      const action = takeRandomBoardAction(rng, match);
      if (action !== null) {
        push(`seat ${opts.seat} t${match.view?.turn ?? '-'} ${match.view?.phase ?? '-'}: ${action.kind} ${action.detail} ok=${action.ok}`);
        if (!action.ok) flag('click-refused', `board action ${action.kind} ${action.detail} was refused`);
        decisions += 1;
      }
    }

    await new Promise((r) => setTimeout(r, tickMs));
  }

  return { flags, decisions };
}
