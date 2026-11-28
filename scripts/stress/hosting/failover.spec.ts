/**
 * Failover on the claw path (`CARDTABLE_PLAY_HOSTS=claws`), with real browsers and real Forge: the
 * coordinator is a play stack, its claws are host agents this run starts (`e2e/play/claws.ts`), and
 * one fault is fired per run while matches are live. Kept out of `e2e/` so CI never runs it: copy it
 * (and nothing else) into `e2e/` on a claw under a lease drain, never on hokon:
 *
 *   cp scripts/stress/hosting/failover.spec.ts e2e/ && \
 *   FAULT=agent-kill CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… TMPDIR=… \
 *     pnpm --dir e2e exec playwright test failover.spec.ts
 *
 * Faults (`FAULT`), each with its pass line, stated before it runs:
 *
 *  - `agent-kill`  the agent holding the match SIGKILLed (heartbeat loss), back 20 s later as systemd
 *                  would start it. PASS: the claw fails over within 15 s; every match on it is restored
 *                  from its latest turn snapshot on the OTHER claw; the restarted agent ends the stale
 *                  JVMs (no second copy) and the claw comes back only after its canary.
 *  - `agent-stall` the agent holding the match SIGSTOPped 15 s (its link silent, its JVM running).
 *                  PASS: as `agent-kill`; once it runs again it ends the JVM it kept (no second copy).
 *  - `coord-stall` the coordinator SIGSTOPped 13 s (prod's "no word from the coordinator" fence).
 *                  PASS: the agents fence, every match is restored from its latest turn snapshot.
 *  - `jvm-kill`    the match's JVM SIGKILLed on its claw. PASS: as `agent-kill` (ruling 4: a claw
 *                  that dropped a match fails over).
 *  - `disk-full`   the match's claw's disk filled mid-match. PASS: the match goes on, or is restored
 *                  elsewhere; it never freezes, the server stays up.
 *  - `coord-restart` the coordinator SIGTERMed (a deploy). PASS: the agents hold, the next server
 *                  re-attaches the same JVMs, nothing is restored.
 *  - `coord-kill`  the coordinator SIGKILLed, up again 5 s later. PASS: as `coord-restart`.
 *
 * And for every fault: both seats' screens recover WITHOUT a page load (the same document, the board
 * drawn, no reconnect notice left, the turn shown being the restored one), and the game moves on
 * within 90 s of the recovery. With `ASK_OPEN=1` the fault fires while a seat holds an open ask
 * (a choice, a target, a payment), which must be answerable after the cutover.
 *
 * Evidence: `[failover]` lines, one JSON object each.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { startClaws } from './play/claws.ts';
import { enterMatch } from './play/enter.ts';
import { RESTORING, fire, hostOf, lostMatches, latestTurn, mark, marked, promptMethod, rows, say, sleep, turnShown, until, type Fault } from './play/failover.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const FAULT = (process.env.FAULT ?? 'agent-kill') as Fault;
const ASK_OPEN = process.env.ASK_OPEN === '1';
const FAULT_TURN = Number(process.env.FAULT_TURN ?? '3');

interface Seat {
  f: Friend;
  hands: Hands | null;
  answering: boolean;
  navigations: number;
}

/** A seat's driver: its hands play, its prompts are answered, unless `answering` is off. */
function drive(seat: Seat, stop: { done: boolean }): Promise<void> {
  return (async () => {
    while (!stop.done) {
      if (seat.answering) await answerPrompt(seat.f.page).catch(() => null);
      await sleep(400);
    }
  })();
}

test(titled(`claw failover, one 1v1 match: ${FAULT}${ASK_OPEN ? ' with an ask open' : ''}`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(20 * 60_000);
  const claws = await startClaws({ count: 2, ...(FAULT === 'disk-full' ? { diskMb: { 0: Number(process.env.DISK_MB ?? '1200'), 1: Number(process.env.DISK_MB ?? '1200') } } : {}) });
  const stack = await startPlayStack(forge, { env: claws.env });
  const stop = { done: false };
  const drivers: Promise<void>[] = [];
  try {
    await until('both claws connected', 60_000, () => rows(stack).filter((r) => r.evt === 'claw-connected').length >= 2);
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    const host = await until('the match placed on a claw', 60_000, () => hostOf(rows(stack), matchId));
    say('placed', { matchId, host });
    expect(host, 'placed on a scratch claw, not the backstop').toMatch(/^127\.0\.0\.\d$/);

    const seats: Seat[] = [];
    for (const f of [alice, bob]) {
      const seat: Seat = { f, hands: await connectHands(f, 0, { attack: true }), answering: true, navigations: 0 };
      f.page.on('framenavigated', (frame) => {
        if (frame === f.page.mainFrame()) seat.navigations += 1;
      });
      seats.push(seat);
      drivers.push(drive(seat, stop));
    }
    await until(`turn ${FAULT_TURN}'s snapshot`, 8 * 60_000, () => latestTurn(rows(stack), matchId) >= FAULT_TURN);

    if (ASK_OPEN) {
      for (const s of seats) s.answering = false;
      const open = await until('a seat holding an open ask', 4 * 60_000, async () => {
        for (const s of seats) {
          const m = await promptMethod(s.f.page);
          if (m !== null && m !== 'showPromptMessage') return { who: s.f.name, method: m };
        }
        return null;
      });
      say('ask-open', open);
      for (const s of seats) await s.hands?.pause();
    }
    for (const s of seats) await mark(s.f.page);
    const beforeRows = rows(stack).length;
    const turnBefore = latestTurn(rows(stack), matchId);
    const jvmsBefore = claws.agents.find((a) => a.node === host)!.jvmPids();
    const { at, detail } = await fire(FAULT, stack, claws, host);
    say('fired', { fault: FAULT, host, turnBefore, jvmsBefore, ...detail });

    const restoring = RESTORING.has(FAULT);
    if (restoring) {
      const restored = await until('the match restored', 60_000, () => rows(stack).slice(beforeRows).find((r) => r.evt === 'match-restored' && r.matchId === matchId));
      say('restored', { ms: Date.parse(String(restored.t ?? '')) - at, ...restored });
      expect(restored.from, 'restored from its turn snapshot, not a new game').toBe('snapshot');
      expect(restored.turn, 'to the latest turn start').toBe(turnBefore);
      const now = await until('the match on a host again', 30_000, () => {
        const h = rows(stack).slice(beforeRows).filter((r) => r.evt === 'match-host' && r.matchId === matchId).at(-1)?.host;
        return typeof h === 'string' ? h : null;
      });
      say('moved', { from: host, to: now });
      if (FAULT !== 'coord-stall') expect(now, 'never back on the claw that dropped it').not.toBe(host);
    } else {
      await sleep(5_000);
      const after = rows(stack).slice(beforeRows);
      const restored = after.filter((r) => r.evt === 'match-restored' && r.matchId === matchId);
      say('after', { restored: restored.length, failed: after.filter((r) => r.evt === 'claw-failed-over' || r.evt === 'fenced-over').map((r) => r.evt) });
      if (FAULT === 'coord-restart' || FAULT === 'coord-kill') expect(restored, 'a restart re-attaches, it does not restore').toHaveLength(0);
    }

    /* both screens, without a page load */
    for (const s of seats) {
      await expect(s.f.page.locator('[aria-label="Game board"]'), `${s.f.name}: the board`).toBeVisible({ timeout: 60_000 });
      await expect(s.f.page.getByTestId('live-status'), `${s.f.name}: no reconnect notice left`).toHaveCount(0, { timeout: 60_000 });
      expect(await marked(s.f.page), `${s.f.name}: the same document, never reloaded`).toBe(true);
      say('screen', { who: s.f.name, navigations: s.navigations, turn: await turnShown(s.f.page), prompt: await promptMethod(s.f.page) });
    }
    if (restoring) for (const s of seats) await expect(s.f.page.getByTestId('live-turn-n'), `${s.f.name}: shows the restored turn`).toHaveText(String(turnBefore), { timeout: 30_000 });

    /* and the game moves on */
    for (const s of seats) {
      s.answering = true;
      s.hands?.resume();
    }
    const progressed = await until('the game moves on after the recovery', 3 * 60_000, () => {
      const after = rows(stack).filter((r) => r.matchId === matchId && (r.evt === 'turn-snapshot' || r.evt === 'game-over'));
      return after.some((r) => r.evt === 'game-over' || Number(r.turn) > turnBefore) ? after.at(-1) : null;
    });
    say('progressed', { ...progressed, sinceFaultMs: Date.now() - at });

    if (FAULT === 'agent-kill' || FAULT === 'agent-stall') {
      const agent = claws.agents.find((a) => a.node === host)!;
      await until('the dropped claw back after its canary', 3 * 60_000, () => rows(stack).find((r) => r.evt === 'claw-recovered' && r.host === host));
      const stale = jvmsBefore.filter((pid) => agent.jvmPids().includes(pid));
      say('stale-jvms', { host, stale });
      expect(stale, 'the stale JVMs of the dropped claw are gone').toEqual([]);
    }
    const lost = lostMatches(rows(stack));
    expect(lost, 'no match lost').toEqual([]);
  } finally {
    stop.done = true;
    await Promise.all(drivers);
    await stack.stop();
    await claws.stop();
  }
});
