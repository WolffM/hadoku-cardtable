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
import { SERVER_FRAME_EXAMPLES } from '../../../../../packages/forge-wire/src/examples.ts';

import { clearDeclineStreak, declineStreak, hasNoLegalAnswer, type DeclinedStreaks } from './seat-driver.ts';
import type { LiveAsk } from './random-answer.ts';
import { makeLogTail } from './run-match.ts';

import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
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

describe('declineStreak — flag (d), a loop', () => {
  it('flags the third decline of the SAME ask shape at the SAME turn and phase', () => {
    const streaks: DeclinedStreaks = new Map();
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1').looping).toBe(true);
  });

  it('does NOT flag the same shape recurring across DIFFERENT turns (ordinary play, not a loop)', () => {
    const streaks: DeclinedStreaks = new Map();
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 5, 'MAIN1').looping).toBe(false);
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 6, 'MAIN1').looping).toBe(false);
  });

  it('does NOT flag tempShowZones/openZones, however often they recur — exempt by design', () => {
    const streaks: DeclinedStreaks = new Map();
    for (let i = 0; i < 6; i += 1) {
      expect(declineStreak(streaks, 'tempShowZones', 'fp-zones', 4, 'CLEANUP').looping).toBe(false);
    }
  });

  it('answering (not declining) the ask resets its streak', () => {
    const streaks: DeclinedStreaks = new Map();
    declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1');
    declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1');
    clearDeclineStreak(streaks, 'fp-1');
    expect(declineStreak(streaks, 'getAbilityToPlay', 'fp-1', 4, 'MAIN1').looping).toBe(false);
  });
});

describe('makeLogTail — flag (e), server-unclassified', () => {
  it('surfaces a new ask-unanswerable/ask-unclassified line for this match, and ignores other matches and other evts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkey-logtail-'));
    const file = join(dir, 'server.jsonl');
    try {
      writeFileSync(file, `${JSON.stringify({ evt: 'match-created', matchId: 'm-1' })}\n`);
      const tail = makeLogTail(file);
      // Everything already on disk at construction counts as "new" on the FIRST read — there is
      // no record of the file's size before it: `run-match.ts` only ever constructs one of these
      // once its match's own log lines are the only ones left to read (plus whatever an earlier
      // match in the same stack wrote, which the matchId filter below drops regardless).
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
