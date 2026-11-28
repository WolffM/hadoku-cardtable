/*
 * Mutation evidence for three of the monkey's six flags — the ones that are
 * pure functions over an ask or a log line, and so are provable without a
 * real Forge match: feed the exact shape the flag is designed to catch, and
 * show it fires; feed the ordinary shape beside it, and show it does not.
 * The other three (`stuck`, `click-refused`, `no-finish`) are proved against
 * a real running server instead — see `docs/MONKEY.md`'s "Proof" section for
 * both halves.
 */

import { describe, expect, it } from 'vitest';

// Not re-exported from `@hadoku/forge-wire`'s own index (its `exports` map
// is `.` → `src/index.ts` alone), so this reaches the package's test fixture
// file directly — it is `export`ed there precisely to be a shared fixture.
import { SERVER_FRAME_EXAMPLES } from '../../../../packages/forge-wire/src/examples.ts';

import type { LiveMatch } from '../../../../ui/src/play/live/match.ts';

import { blockedSince, clearDeclineStreak, declineStreak, hasNoLegalAnswer, isBlocked, OBSERVER_GAP_MS, signatureOf, type DeclinedStreaks } from './seat-driver.ts';
import type { LiveAsk } from './random-answer.ts';
import { isRefusal, logEnd, makeLogTail, serverFlagsOf } from './run-match.ts';
import { seedArg, seedFrom } from './rng.ts';

import { mkdtempSync, writeFileSync, appendFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('hasNoLegalAnswer — flag (a)', () => {
  it('flags getChoices asking for more than it offered', () => {
    const ask = { ...(SERVER_FRAME_EXAMPLES.getChoices as object), min: 3, max: 3 } as unknown as LiveAsk;
    expect(hasNoLegalAnswer(ask)).toMatch(/getChoices wants at least 3 of 2 offered/);
  });

  it('does not flag the same ask asking for what it offered', () => {
    const ask = SERVER_FRAME_EXAMPLES.getChoices as LiveAsk;
    expect(hasNoLegalAnswer(ask)).toBeNull();
  });

  it('flags a REQUIRED chooseSingleEntityForEffect with nothing to choose', () => {
    const ask = { ...(SERVER_FRAME_EXAMPLES.chooseSingleEntityForEffect as object), optionList: [], isOptional: false } as unknown as LiveAsk;
    expect(hasNoLegalAnswer(ask)).toMatch(/offers nothing/);
  });

  it('does not flag the same shape when it is OPTIONAL (declining is legal)', () => {
    const ask = { ...(SERVER_FRAME_EXAMPLES.chooseSingleEntityForEffect as object), optionList: [], isOptional: true } as unknown as LiveAsk;
    expect(hasNoLegalAnswer(ask)).toBeNull();
  });

  it('flags chooseEntitiesForEffect asking for more than it offered', () => {
    const ask = { ...(SERVER_FRAME_EXAMPLES.chooseEntitiesForEffect as object), optionList: [], min: 1 } as unknown as LiveAsk;
    expect(hasNoLegalAnswer(ask)).toMatch(/chooseEntitiesForEffect wants at least 1 of 0 offered/);
  });
});

describe('signatureOf — what flag (b), stuck, counts as progress', () => {
  // The shape of every `stuck` in monkey run 45348742559: the seat reads one dead "Waiting for Forge AI..."
  // while the server auto-passes its priority through the AI's turn, and Forge's view keeps moving.
  const waiting = (forgeSeq: number, phase: string): LiveMatch =>
    ({
      asks: [],
      forgeSeq,
      view: { turn: 12, phase },
      prompt: 'Waiting for Forge AI...',
      buttons: { label1: 'OK', label2: 'Cancel', enable1: false, enable2: false },
      selectables: null,
    }) as unknown as LiveMatch;

  it('moves when Forge’s game moves under an unchanged wait, within a phase or across one', () => {
    expect(signatureOf(waiting(201, 'MAIN1'))).not.toBe(signatureOf(waiting(202, 'MAIN1')));
    expect(signatureOf(waiting(201, 'MAIN1'))).not.toBe(signatureOf(waiting(201, 'COMBAT_BEGIN')));
  });

  it('holds still when nothing at all changes, so a game that stopped is still flagged', () => {
    expect(signatureOf(waiting(201, 'MAIN1'))).toBe(signatureOf(waiting(201, 'MAIN1')));
  });

  // The `stuck` of sweep match m-fce02d44b3e2: discarding 8 of 15 at cleanup, one answered click every
  // 4 s, under one prompt and one selectable set — five picks in, it was flagged.
  const discarding = (picked: number[]): LiveMatch =>
    ({
      asks: [],
      forgeSeq: 412,
      view: { turn: 3, phase: 'CLEANUP' },
      prompt: 'Cleanup Phase\nSelect 8 card(s) to discard to bring your hand down to the maximum of 7 cards.',
      buttons: { label1: 'OK', label2: 'Cancel', enable1: false, enable2: false },
      selectables: { cards: new Set([104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118]), min: 8, max: 8 },
      highlighted: new Set(picked),
    }) as unknown as LiveMatch;

  it('moves with each card picked into a selection that is not yet complete', () => {
    expect(signatureOf(discarding([116]))).not.toBe(signatureOf(discarding([116, 107])));
    expect(signatureOf(discarding([116, 107]))).toBe(signatureOf(discarding([107, 116])));
  });
});

describe('blockedSince — flag (b), stuck, counts only time the driver watched', () => {
  // The two-seat run's first `stuck` (match m-e08109de0a59, turn 13): the process that drives both seats
  // spent 21 s reading another match's log, and the next tick saw 27 s with nothing changed.
  it('starts over when the driver itself was away longer than a tick can be', () => {
    expect(blockedSince({ since: 1_000, lastTick: 2_000 }, 2_000 + OBSERVER_GAP_MS + 1, false)).toBe(2_000 + OBSERVER_GAP_MS + 1);
  });

  it('keeps counting across ordinary ticks, and starts over on any change', () => {
    expect(blockedSince({ since: 1_000, lastTick: 24_940 }, 25_000, false)).toBe(1_000);
    expect(blockedSince({ since: 1_000, lastTick: 24_940 }, 25_000, true)).toBe(25_000);
  });
});

describe('isBlocked — who flag (b), stuck, waits on', () => {
  // Monkey run 45959106636, match m-d6c51357ff5a, the AI's turn 8: the server auto-passed seat 0's
  // priority step after step, Forge handed priority to the AI, and the AI took 30–44 s at each step.
  // Seat 0's input stayed live under a dead "Waiting for Forge AI..." bar the whole time.
  const seat = (over: { hasPriority: boolean; enable1?: boolean; enable2?: boolean; selectable?: number[]; asks?: unknown[] }): LiveMatch =>
    ({
      asks: over.asks ?? [],
      inputLive: true,
      forgeSeq: 352,
      view: { turn: 8, phase: 'COMBAT_BEGIN', players: [{ isViewer: true, hasPriority: over.hasPriority }, { isViewer: false, hasPriority: !over.hasPriority }] },
      prompt: 'Waiting for Forge AI...',
      buttons: { label1: 'OK', label2: 'Cancel', enable1: over.enable1 ?? false, enable2: over.enable2 ?? false },
      selectables: over.selectable === undefined ? null : { cards: new Set(over.selectable), min: 1, max: 1 },
    }) as unknown as LiveMatch;

  it('a seat waiting on the other player, nothing to press and no priority, is not what the game waits on', () => {
    expect(isBlocked(seat({ hasPriority: false }))).toBe(false);
  });

  it('a seat Forge says holds priority is blocked even with a dead bar: the softlock the flag is for', () => {
    expect(isBlocked(seat({ hasPriority: true }))).toBe(true);
  });

  it('a seat with something to press, or an ask open, is blocked whoever Forge says holds priority', () => {
    expect(isBlocked(seat({ hasPriority: false, enable1: true }))).toBe(true);
    expect(isBlocked(seat({ hasPriority: false, enable2: true }))).toBe(true);
    expect(isBlocked(seat({ hasPriority: false, selectable: [12] }))).toBe(true);
    expect(isBlocked(seat({ hasPriority: false, asks: [{ method: 'getChoices' }] }))).toBe(true);
  });
});

describe('declineStreak — flag (d), a loop', () => {
  it('flags the third decline of the SAME ask shape at the SAME turn and phase', () => {
    const streaks: DeclinedStreaks = new Map();
    expect(declineStreak(streaks, 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'fp-1', 4, 'MAIN1').looping).toBe(true);
  });

  it('does NOT flag the same shape recurring across DIFFERENT turns (ordinary play, not a loop)', () => {
    const streaks: DeclinedStreaks = new Map();
    expect(declineStreak(streaks, 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'fp-1', 5, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'fp-1', 6, 'MAIN1').looping).toBe(false);
  });

  it('answering (not declining) the ask resets its streak', () => {
    const streaks: DeclinedStreaks = new Map();
    declineStreak(streaks, 'fp-1', 4, 'MAIN1');
    declineStreak(streaks, 'fp-1', 4, 'MAIN1');
    clearDeclineStreak(streaks, 'fp-1');
    expect(declineStreak(streaks, 'fp-1', 4, 'MAIN1').looping).toBe(false);
  });
});

describe('makeLogTail — flag (e), server-unclassified', () => {
  it('surfaces a new ask-unanswerable/ask-unclassified line for this match, and ignores other matches and other evts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkey-logtail-'));
    const file = join(dir, 'server.jsonl');
    try {
      writeFileSync(file, `${JSON.stringify({ evt: 'match-created', matchId: 'm-1' })}\n`);
      const tail = makeLogTail(file);
      // A tail given no start reads the log from its first byte.
      expect(tail().map((r) => r.evt)).toEqual(['match-created']);

      appendFileSync(file, `${JSON.stringify({ evt: 'ask-unanswerable', matchId: 'm-1', method: 'chooseEntitiesForEffect' })}\n`);
      appendFileSync(file, `${JSON.stringify({ evt: 'ask-unanswerable', matchId: 'm-OTHER', method: 'confirm' })}\n`);
      appendFileSync(file, `${JSON.stringify({ evt: 'match-created', matchId: 'm-1' })}\n`);
      const rows = tail();
      expect(rows.filter((r) => r.matchId === 'm-1' && r.evt === 'ask-unanswerable')).toHaveLength(1);
      expect(rows.some((r) => r.matchId === 'm-OTHER')).toBe(true); // the filter by matchId is `run-match.ts`'s own job, not `makeLogTail`'s
      expect(rows.filter((r) => r.evt === 'match-created')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a match's tail starts where the log ended when the match was asked for, and reads only what is appended, whatever the log's size", () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkey-logtail-'));
    const file = join(dir, 'server.jsonl');
    try {
      // Three sparse GiB of an earlier run's rows: more than one read of the whole file can hold.
      writeFileSync(file, `${JSON.stringify({ evt: 'ask-unclassified', matchId: 'm-EARLIER' })}\n`);
      truncateSync(file, 3 * 2 ** 30);
      const tail = makeLogTail(file, logEnd(file));
      expect(tail()).toEqual([]);
      appendFileSync(file, `${JSON.stringify({ evt: 'match-created', matchId: 'm-1', deck: 'Œuvre' })}\n`);
      expect(tail()).toEqual([{ evt: 'match-created', matchId: 'm-1', deck: 'Œuvre' }]);
      appendFileSync(file, `${JSON.stringify({ evt: 'ask-unclassified', matchId: 'm-1' })}\n`);
      expect(tail()).toEqual([{ evt: 'ask-unclassified', matchId: 'm-1' }]);
      expect(tail()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds back a torn final line until its newline arrives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkey-logtail-'));
    const file = join(dir, 'server.jsonl');
    try {
      writeFileSync(file, '');
      const tail = makeLogTail(file);
      tail();
      appendFileSync(file, '{"evt":"ask-uncla');
      expect(tail()).toHaveLength(0);
      appendFileSync(file, `ssified","matchId":"m-1"}\n`);
      expect(tail()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what counts as a finding — the server handling a case by its own rule never does', () => {
  it('a turned-away click is a refusal; the server cancelling a cost nothing can pay is not', () => {
    expect(isRefusal({ frame: { kind: 'notify', method: 'flashIncorrectAction' } })).toBe(true);
    expect(isRefusal({ frame: { kind: 'notify', method: 'flashIncorrectAction', cause: 'unpayable' } })).toBe(false);
    expect(isRefusal({ frame: { kind: 'notify', method: 'showPromptMessage' } })).toBe(false);
  });

  it('flags this match’s ask-unclassified lines, not ask-unanswerable ones the server answered itself', () => {
    const rows = [
      { evt: 'ask-unanswerable', matchId: 'm-1', method: 'payment', why: 'nothing can pay {5}{B}' },
      { evt: 'ask-unclassified', matchId: 'm-1', method: 'payment' },
      { evt: 'ask-unclassified', matchId: 'm-OTHER', method: 'confirm' },
    ];
    expect(serverFlagsOf(rows, 'm-1').map((f) => f.evt)).toEqual(['ask-unclassified']);
  });
});

describe('seedArg — a printed seed reproduces its run', () => {
  it('reads the digits a run printed as that number, and anything else as a text seed', () => {
    expect(seedFrom(seedArg('2899421584')!)).toBe(2899421584);
    expect(seedArg('nightly-1')).toBe('nightly-1');
    expect(seedArg(undefined)).toBeUndefined();
  });
});
