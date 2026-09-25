// @vitest-environment jsdom
/*
 * Every prompt this client can be asked, against a REAL Forge match.
 *
 * Two real matches in real child JVMs (`./jvm-harness.ts`), two seats each,
 * each seat a `LiveBoard` driven by `./game-driver.ts`. Custom decks steer the
 * engine into asking: Arc Lightning divides damage (`openZones`,
 * `assignGenericAmount`), a double block makes the attacker assign damage
 * (`assignCombatDamage`), Serum Powder is usable at the mulligan (`confirm`),
 * Brainstorm picks and orders cards (`tempShowZones`, `order`), Blaze announces
 * X past the list of numbers (`getChoices` → "Other..." → `showInputDialog`),
 * and Impetuous Lootmonger heists (`chooseSingleEntityForEffect`).
 * `showConfirmDialog` is Forge's server-side probe, answered AGAINST its
 * default.
 *
 * Temple of Mystery used to scry through `manipulateCardList` — until Wave 19
 * lane C closed the Preordain finding at the ORIGIN: each run directory writes
 * Forge's preferences with `UI_SELECT_FROM_CARD_DISPLAYS=false`, so a scry now
 * asks about the scried cards by name through the same `order` / `confirm`
 * prompts a desktop player gets. `arrangeForScry` was `manipulateCardList`'s
 * only production caller, so nothing asks it any more and no scenario here
 * waits on it.
 *
 * Each answer is given by clicking the component, and goes back through
 * `answerAsk` → `forge:c2s` → `Match.fromClient` → the bridge → Forge. A method
 * counts as live only when an ask of it was answered, `fromClient` accepted
 * the reply, and the seat was sent more frames afterwards (the game moved on).
 *
 * Then the two things this lane is really about:
 *
 * - **No desync.** Prompts arrived mid-priority with the state channel still
 *   moving. At the end each seat's board — folded incrementally, through every
 *   prompt — must equal a fresh fold of the server's own history for that seat,
 *   at the same cursor, with no gap, resync or invalid frame on the way.
 * - **What an open prompt does to the stream, measured.** `stateWhileOpen`
 *   counts the state frames a seat was sent while its ask sat unanswered. The
 *   bridge runs each seat's client calls on one serial thread
 *   (`PlayBridge.SeatGui.ui`), and a blocking ask holds that thread, so a
 *   seat's own stream pauses behind its open ask; the summary line prints the
 *   count so a bridge change that lets frames through shows up here. Frames
 *   that DO arrive under an open prompt are folded — `./match.test.ts` and
 *   `./LiveBoard.test.ts` prove that against the replay server.
 *
 * Hidden information is checked on the way: the server's leak oracle
 * (`apps/server/src/play/fixtures/transcript.ts`) over every envelope each seat
 * was sent. Each seat's deck carries four cards the other deck does not, never
 * cast, so there are secrets to leak.
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like the
 * server's `jvm.test.ts`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';

import { leaked, rawStatesOf, secretsFor } from '../../../../server/src/play/fixtures/transcript.ts';
import { createDriver, drive, type Plan } from './game-driver.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness } from './jvm-harness.ts';
import { startMatch, type LiveMatch, type MatchTransport } from './match.ts';

const available = forgeAvailability();
const title = available.ok
  ? 'the fifteen prompts against a real Forge match'
  : `the fifteen prompts against a real Forge match — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
  return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

/** A late joiner: a fresh client whose whole board comes from the server's snapshot of `seat`. */
async function freshFold(h: LiveHarness, seat: number): Promise<LiveMatch> {
  const transport: MatchTransport = {
    on: () => {},
    emit: () => {},
    request: (_e, _p, onAck) => setTimeout(() => onAck(null, h.match.snapshot(seat)), 0),
    disconnect: () => {},
  };
  const fresh = startMatch({ matchId: h.match.id, transport });
  await waitUntil(() => fresh.stats.snapshots === 1, `a fresh snapshot of seat ${seat}`, 5000);
  return fresh;
}

function answered(h: LiveHarness, method: string) {
  return h.asks.filter((a) => a.method === method && a.outcome?.ok === true && a.framesAfter > 0);
}

function snapshotCursor(h: LiveHarness, seat: number) {
  const snap = h.match.snapshot(seat);
  if (!('frames' in snap)) throw new Error(`no snapshot for seat ${seat}: ${snap.error}`);
  return snap.cursor;
}

/** Stop acting, let the frames in flight land, then hold each seat to the server's own history. */
async function expectNoDesync(h: LiveHarness): Promise<void> {
  /*
   * QUIESCENCE, not a single equality: with the shortcuts on, the server keeps
   * talking after the plan is done — every auto-pass is a frame, and the last
   * one can cross between a poll that matched and the assert that read the
   * snapshot again (a one-frame race this suite hit the moment lane C's says
   * made the ending livelier). The equality must HOLD across two polls before
   * anything is asserted; the game does go quiet, because a seat with a land
   * in hand has an action and is never auto-passed for it.
   */
  let stable = 0;
  const settleBy = Date.now() + 10_000;
  while (stable < 2) {
    if (Date.now() > settleBy) throw new Error('each seat never settled level with the server');
    const level = h.seats.every((s) => JSON.stringify(s.live.cursor) === JSON.stringify(snapshotCursor(h, s.seat)));
    stable = level ? stable + 1 : 0;
    await new Promise((r) => setTimeout(r, 150));
  }
  for (const s of h.seats) {
    expect(s.live.cursor).toEqual(snapshotCursor(h, s.seat));
    expect(s.live.stats).toMatchObject({ gaps: 0, epochChanges: 0, resyncsRequested: 0, invalid: 0 });
    expect(s.live.lastError).toBeNull();
    const fresh = await freshFold(h, s.seat);
    expect(Object.fromEntries(s.live.state)).toEqual(Object.fromEntries(fresh.state));
    expect(s.live.view).toEqual(fresh.view);
  }
}

/**
 * Nothing a seat was not shown reached it — and the oracle had something to
 * look for.
 *
 * The non-vacuity guard — "the oracle had something to look for" — is asked for
 * PER SCENARIO, because it is a property of the decks, not of the projection.
 *
 * A seat's secrets are the cards that were only ever hidden AND whose names
 * never appeared in a shown zone. `combat`'s decks hold four cards apiece that
 * the other does not and that the plan never casts, so it always has some, and
 * it is the scenario that carries the guard. `choices` deals seven distinct
 * names over 54 cards, nearly the same list on both sides, and plays most of
 * them out: measured across wave 20's runs it ended with 0, 4 and 0 secrets on
 * the two seats — not a leak, but a hand with nothing left to hide. Demanding a
 * number there fails the suite for the decks rather than for the code.
 *
 * What both scenarios always assert is the leak itself, and that every secret
 * really was in Forge's unprojected stream — so a projection that started
 * leaking is caught by `combat` (and by `apps/server/src/play/jvm.test.ts`,
 * which counts secrets in the hundreds) on the same run.
 */
function expectNoLeak(h: LiveHarness, mustHaveSecrets = true): void {
  let total = 0;
  for (const seat of [0, 1]) {
    const { secrets } = secretsFor(rawStatesOf(h.raw, seat), seat);
    const rawText = h.raw.filter((l) => l.t === 'frame' && l.seat === seat).map((l) => JSON.stringify(l)).join('\n');
    const emitted = h.emitted.filter((e) => e.seat === seat).map((e) => JSON.stringify(e.envelope)).join('\n');
    console.log(
      `[prompts.jvm] seat ${seat}: ${secrets.size} secrets, ${leaked(secrets, rawText).length} in Forge's raw stream, ${leaked(secrets, emitted).length} emitted`,
    );
    total += secrets.size;
    // Every secret really is in Forge's own stream — the oracle is reading the
    // unprojected truth — and none of them is in what the seat was sent.
    expect(leaked(secrets, rawText).length).toBe(secrets.size);
    expect(leaked(secrets, emitted)).toEqual([]);
  }
  if (mustHaveSecrets) expect(total, 'the leak check had secrets to look for').toBeGreaterThan(0);
  else console.log(`[prompts.jvm] non-vacuity not required here; the two seats held ${total} secrets between them`);
}

function expectCleanBridge(h: LiveHarness): void {
  expect(h.refused).toEqual([]);
  expect(h.raw.filter((l) => l.t === 'rejected' || l.t === 'stale' || l.t === 'fatal' || l.t === 'unsupported')).toEqual([]);
  expect(h.match.invalidFrames).toBe(0);
  // Every ask this client answered was accepted.
  for (const a of h.asks.filter((x) => x.answer !== null)) {
    expect(a.answer?.kind, `${a.method} ${a.callId}`).toBe('reply');
    expect(a.outcome, `${a.method} ${a.callId}`).toEqual({ ok: true });
  }
}

function status(h: LiveHarness): string {
  const asks = h.asks.map((a) => [a.seat, a.method, a.callId, a.outcome, a.framesAfter]);
  const log = h.serverLog.filter((e) => /ask|probe|bridge/.test(String(e.evt)));
  return `${JSON.stringify(asks)}\nserver: ${JSON.stringify(log.slice(0, 20))}\nbridge: ${JSON.stringify(h.raw.filter((l) => l.t !== 'frame').slice(0, 20))}`;
}

function summary(label: string, h: LiveHarness): void {
  const counts = new Map<string, number>();
  for (const a of h.asks) if (a.outcome?.ok === true) counts.set(a.method, (counts.get(a.method) ?? 0) + 1);
  const underPrompts = h.asks.reduce((n, a) => n + a.stateWhileOpen, 0);
  console.log(
    `[prompts.jvm] ${label}: answered ${[...counts].map(([m, n]) => `${m}×${n}`).join(', ')}; ` +
      `${underPrompts} state frames arrived while an ask was open`,
  );
}

describe.skipIf(!available.ok)(title, () => {
  const running: LiveHarness[] = [];

  afterAll(async () => {
    cleanup();
    for (const h of running) h.stop();
    await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
    expect(liveJvmCount()).toBe(0);
  }, 60_000);

  it(
    'combat and targets: showConfirmDialog, openZones, assignGenericAmount, assignCombatDamage, getAbilityToPlay',
    async () => {
      const h = await startLiveMatch({
        seed: 7,
        seats: [
          { name: 'A', ai: false, deck: deck('Combat A', ['22 Volcanic Island', '22 Memnite', '12 Arc Lightning', '4 Shivan Dragon']) },
          { name: 'B', ai: false, deck: deck('Combat B', ['22 Volcanic Island', '22 Memnite', '12 Arc Lightning', '4 Serra Angel']) },
        ],
      });
      running.push(h);

      // Forge's server side asks seat 0 a real showConfirmDialog. Its default
      // is No, and the driver presses the other button, so a `true` can only
      // have come from the click.
      const probe = h.match.probe(0, 'Answer me', 60_000);
      const plan: Plan = {
        land: /Volcanic Island/,
        casts: [{ name: 'Arc Lightning', mana: 3 }],
        zeroDrops: ['Memnite'],
        attack: { name: 'Memnite', fromTurn: 3 },
        block: { name: 'Memnite', count: 2 },
        targetCard: 'Memnite',
        prompts: { confirmAgainstDefault: true },
      };
      const driver = createDriver(h, plan);
      await drive(
        driver,
        () => ['openZones', 'assignGenericAmount', 'assignCombatDamage', 'showConfirmDialog'].every((m) => answered(h, m).length > 0),
        150_000,
        () => status(h),
      );
      expect(await probe).toMatchObject({ answer: true });

      summary('combat', h);
      console.log(driver.log.filter((l) => / answers (showConfirmDialog|assignCombatDamage|assignGenericAmount|getAbilityToPlay) /.test(l)).slice(0, 8).join('\n'));
      for (const m of ['getAbilityToPlay', 'openZones', 'assignGenericAmount', 'assignCombatDamage', 'showConfirmDialog']) {
        expect(answered(h, m).length, m).toBeGreaterThan(0);
      }

      // Wave 19 lane B, against the real jar: every ability Forge offered
      // carried its label — the picker never has to say "ability #id".
      const abilityAsks = h.asks.filter((a) => a.method === 'getAbilityToPlay');
      const labelled = abilityAsks.flatMap((a) => (a.ask as Extract<typeof a.ask, { method: 'getAbilityToPlay' }>).abilities);
      expect(labelled.length, 'abilities were offered').toBeGreaterThan(0);
      for (const ab of labelled) {
        expect(typeof ab.label === 'string' && ab.label.length > 0, `ability ${ab.id} carried a label`).toBe(true);
      }
      console.log(`[prompts.jvm] ability labels over the wire: ${JSON.stringify(labelled.map((ab) => ab.label).slice(0, 4))}`);

      // And the says reached the browser (§C.2's observability, client side):
      // what was auto-passed and what was paid, held by the live handle.
      for (const seat of h.seats) {
        expect(seat.live.says.length, `seat ${seat.seat} holds says`).toBeGreaterThan(0);
      }
      console.log(`[prompts.jvm] says held: ${JSON.stringify(h.seats.map((s) => s.live.says.slice(-3)))}`);
      expectCleanBridge(h);
      await expectNoDesync(h);
      expectNoLeak(h);
      h.stop();
    },
    240_000,
  );

  it(
    'choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityForEffect',
    async () => {
      const h = await startLiveMatch({
        seed: 7,
        seats: [
          {
            name: 'A',
            ai: false,
            deck: deck('Choices A', ['14 Volcanic Island', '8 Temple of Mystery', '10 Serum Powder', '8 Impetuous Lootmonger', '8 Blaze', '8 Brainstorm', '4 Shivan Dragon']),
          },
          {
            name: 'B',
            ai: false,
            deck: deck('Choices B', ['14 Volcanic Island', '8 Temple of Mystery', '10 Serum Powder', '8 Impetuous Lootmonger', '8 Blaze', '8 Brainstorm', '4 Serra Angel']),
          },
        ],
      });
      running.push(h);
      const plan: Plan = {
        land: /Volcanic Island|Temple of Mystery/,
        casts: [
          { name: 'Brainstorm', mana: 1 },
          { name: 'Impetuous Lootmonger', mana: 2 },
          { name: 'Blaze', mana: 1 },
        ],
        mulliganWith: 'Serum Powder',
        // Blaze's X: take "Other..." past the list of numbers, then type 0.
        prompts: { choice: (label) => label === 'Other...', input: '0' },
      };
      const want = ['confirm', 'order', 'tempShowZones', 'getChoices', 'showInputDialog', 'chooseSingleEntityForEffect'];
      const driver = createDriver(h, plan);
      await drive(driver, () => want.every((m) => answered(h, m).length > 0), 180_000, () => status(h));

      summary('choices', h);
      console.log(driver.log.filter((l) => / answers (chooseSingleEntityForEffect|order|confirm|getChoices|showInputDialog|tempShowZones) /.test(l)).join('\n'));
      for (const m of want) expect(answered(h, m).length, m).toBeGreaterThan(0);
      // Lane C's origin fix, held: a scry must not arrive as the library-sized
      // list any more, so nothing of that shape was asked on the way here.
      expect(answered(h, 'manipulateCardList').length).toBe(0);
      expectCleanBridge(h);
      await expectNoDesync(h);
      expectNoLeak(h, false);
      h.stop();
    },
    240_000,
  );
});
