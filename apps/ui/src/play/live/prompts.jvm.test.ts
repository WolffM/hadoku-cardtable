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
 * A third match, added by wave 25 §F, is the one ask the other two never
 * produced: a real `reveal`. Merfolk Branchwalker explores on entry, which
 * shows both seats the top card of a library, and that is the path where Forge
 * labels an option with `CardView.toString()` rather than a display function.
 * It is how §F.2's premise — "the card's own facts are already in the browser
 * when the ask renders" — is measured rather than read off the source.
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
 * ## These scenarios PIN `EVERY_PRIORITY_POLICY`, and here is why that is honest
 *
 * Wave 28 §B made `ARENA_STOP_POLICY` the server's default, so a seat now passes
 * every phase outside its stop sets whether or not Forge named something it could
 * do there. The operator asked for exactly that — *"it's stopping everywhere,
 * super annoying"* — and it is the right default.
 *
 * It also turned a latent race in `./game-driver.ts` into a routine one, which
 * lane B measured rather than guessed
 * (`docs/planning/wave28-evidence/B-tests-A-must-reaim.md`): with the change the
 * combat scenario ran out its 150 s budget with every one of its 70 asks answered
 * and `assignCombatDamage` never reached; with the change reverted in place, exit
 * 0, 3 passed. The mechanism is `jvm-harness.ts:158-165` — an `updateButtons`
 * arriving ALONE bumps `notes.version` while `notes.prompt` still holds the
 * previous window, and `game-driver.ts:92,106` keys on the version and then reads
 * the message. Passing a burst of phases at once makes that read stale often
 * instead of occasionally.
 *
 * **These scenarios do not test the stop set.** They exist to prove that fifteen
 * prompt shapes are asked, drawn, answered and accepted without a desync or a
 * leak. The stop set is asserted directly by `apps/server/src/play/auto.test.ts`
 * and `auto.jvm.test.ts`, which is where a change to it belongs. So every seat
 * here is pinned to {@link EVERY_PRIORITY_POLICY} — the stop behaviour that WAS
 * the default until 2026-09-28 — restoring the timing these scenarios were
 * written in and changing nothing about the prompts under test.
 *
 * `./board-play.jvm.test.ts:217` is the precedent and the same kind of reason.
 * Pinning is only honest written down, which is what this section is: **the
 * product's real default is exercised, by the suites that are about it.**
 *
 * Skips visibly without `CARDTABLE_FORGE_JAR` / `CARDTABLE_FORGE_RES`, like the
 * server's `jvm.test.ts`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';

import type { ChoiceOption } from '@hadoku/forge-wire';

import { EVERY_PRIORITY_POLICY } from '../../../../server/src/play/auto.ts';
import { leaked, rawStatesOf, secretsFor } from '../../../../server/src/play/fixtures/transcript.ts';
import { nightly } from '../../../../server/src/play/scenario.ts';
import { KNOWN_ART_IDS, scryfallIdFor } from '../adapter.ts';
import { lookupFromState, type PromptCardFacts } from '../prompts/lookup.ts';
import { nameFromForgeLabel, promptTileFor } from '../prompts/PromptShell.tsx';
import { createDriver, drive, type Plan } from './game-driver.ts';
import { forgeAvailability, liveJvmCount, startLiveMatch, waitUntil, type LiveHarness } from './jvm-harness.ts';
import { startMatch, type LiveAsk, type LiveMatch, type MatchTransport } from './match.ts';

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

/*
 * Wave 25 §F.2 — the runtime premise behind "a tile's name is not its label".
 *
 * `getChoices` and `order` are the two asks whose options Forge pre-renders,
 * and for a reveal it has no display function at all, so each label is
 * `CardView.toString()` — `zoneText + name + " (" + id + ")"`
 * (`CardView.java:1214-1232`, via `AbstractGuiGame.reveal` →
 * `getChoices(message, -1, -1, items)` and `PlayBridge.java:947-964`'s null
 * `display`). A tile whose ART is looked up on that string can never resolve.
 *
 * The fix looks the art up on the card's OWN facts instead, which only works if
 * the client actually HOLDS them when the prompt renders. Forge calls
 * `tempShowCards` → `addMayLookTemp` before revealing
 * (`PlayerControllerHuman.java:182-195`), so a revealed library card should
 * project as `full`. This measures it rather than trusting it: while each such
 * ask sits OPEN in the browser's own queue (`live.asks` — the very list the
 * components render from), what did `lookupFromState(live.state).card(id)`
 * hold for every card the ask labelled?
 */
interface LabelProbe {
  seat: number;
  method: string;
  label: string;
  id: number;
  facts: PromptCardFacts | undefined;
}

/** The options of the two asks Forge pre-renders, or null for any other ask. */
function preRenderedOptions(ask: LiveAsk): readonly ChoiceOption[] | null {
  if (ask.method === 'getChoices') return ask.choices;
  if (ask.method === 'order') return [...ask.sourceChoices, ...ask.destChoices];
  return null;
}

/** Forge's own `(id)` suffix, the shape `CardView.toString()` ends in. */
const FORGE_ID_SUFFIX = /\(\d+\)$/;

interface LabelProbeRun {
  probes: LabelProbe[];
  /** Every distinct name a card TILE showed, in either seat, over the whole run. */
  tileNames: Set<string>;
  stop(): void;
}

/**
 * Sample the lookup for every card-bearing option of every `getChoices`/`order`
 * ask, at the moment the seat's own queue first holds it — and, on every tick,
 * collect the names the rendered tiles are showing.
 *
 * The tile names accumulate rather than being read once, because a React render
 * lands a tick after the fold and a single read would race it. The set is the
 * operator's own complaint, mechanised: no tile in a real match may be named
 * `<something> (130)`.
 */
function probeLabels(h: LiveHarness, roots: readonly HTMLElement[]): LabelProbeRun {
  const probes: LabelProbe[] = [];
  const tileNames = new Set<string>();
  const seen = new Set<string>();
  const sample = () => {
    for (const s of h.seats) {
      const lookup = lookupFromState(s.live.state);
      // A reveal is never an ask: the server answered it and the board shows it as a notice (`RevealNotice`).
      for (const ask of s.live.reveal === null ? s.live.asks : [...s.live.asks, s.live.reveal]) {
        if (seen.has(ask.callId)) continue;
        const options = preRenderedOptions(ask);
        if (options === null) continue;
        seen.add(ask.callId);
        for (const o of options) {
          if (o.ref === null || o.ref.kind !== 'card') continue;
          probes.push({ seat: s.seat, method: ask.method, label: o.label, id: o.ref.id, facts: lookup.card(o.ref.id) });
        }
      }
    }
    for (const root of roots) {
      for (const el of root.querySelectorAll('.card__name')) {
        const text = el.textContent;
        if (text !== null && text !== '') tileNames.add(text);
      }
    }
  };
  const timer = setInterval(sample, 20);
  return {
    probes,
    tileNames,
    stop: () => {
      sample();
      clearInterval(timer);
    },
  };
}

/** What the probe found, printed, and the two things §F has to settle. */
function reportLabelProbe(run: LabelProbeRun): void {
  const { probes, tileNames } = run;
  console.log(`[prompts.jvm] §F.2 pre-rendered card options sampled: ${probes.length}`);
  for (const p of probes.slice(0, 12)) {
    console.log(
      `[prompts.jvm] §F.2 ${p.method} seat ${p.seat} id ${p.id}: label ${JSON.stringify(p.label)} ` +
        `-> lookup ${p.facts === undefined ? 'MISS' : JSON.stringify({ name: p.facts.name, setCode: p.facts.setCode })}`,
    );
  }
  const suffixed = probes.filter((p) => FORGE_ID_SUFFIX.test(p.label));
  const misses = probes.filter((p) => p.facts === undefined || p.facts.name === null);
  console.log(
    `[prompts.jvm] §F.2 labels carrying Forge's "(id)" suffix: ${suffixed.length}/${probes.length}; ` +
      `lookup misses: ${misses.length}/${probes.length}`,
  );
  if (probes.length > 0) {
    // The premise: the card's own facts ARE in the browser when the ask
    // renders, so separating identity from label is enough on its own.
    expect(misses, 'every card a pre-rendered ask labelled was in the folded state').toEqual([]);
    for (const p of probes) {
      expect(p.facts?.name, `id ${p.id} has a real name, not the label`).not.toBe(p.label);
      expect(p.facts?.name?.length, `id ${p.id} has a non-empty name`).toBeGreaterThan(0);
    }
  }
  /*
   * What the tiles were CALLED, for the record.
   *
   * A forge id showing up here is not a failure: §F keeps Forge's own wording on
   * the tile on purpose — it may carry a zone the lookup cannot know, and a fix
   * may remove a question but never information. What §F changed is the art
   * KEY, which is no longer this string. So this is printed, not asserted; the
   * scenario below asserts that each reveal's label did reach the screen.
   */
  const named = [...tileNames].filter((n) => FORGE_ID_SUFFIX.test(n));
  console.log(
    `[prompts.jvm] §F ${tileNames.size} distinct tile names rendered, ${named.length} carrying Forge's own id: ` +
      `${JSON.stringify(named.slice(0, 6))}`,
  );
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
      // The stop policy these scenarios were written in — see "These scenarios
      // PIN `EVERY_PRIORITY_POLICY`" above. Set before anything is driven.
      for (const seat of h.seats) expect(h.match.setStopPolicy(seat.seat, EVERY_PRIORITY_POLICY)).toEqual({ ok: true });

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

  // Nightly only while it is pinned `known_failing` in ci.yml: the driver stalls after
  // seat 1's first confirm and the case then burns its whole 180 s budget, every run
  // (docs/planning/wave38-evidence/U-prompts-jvm-red.md). Drop the gate with the pin.
  it.skipIf(!nightly)(
    '[nightly] choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityForEffect',
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
      // The stop policy these scenarios were written in — see "These scenarios
      // PIN `EVERY_PRIORITY_POLICY`" above. Set before anything is driven.
      for (const seat of h.seats) expect(h.match.setStopPolicy(seat.seat, EVERY_PRIORITY_POLICY)).toEqual({ ok: true });
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
      const probe = probeLabels(h, driver.roots);
      try {
        await drive(driver, () => want.every((m) => answered(h, m).length > 0), 180_000, () => status(h));
      } finally {
        probe.stop();
      }

      summary('choices', h);
      reportLabelProbe(probe);
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

  /*
   * Wave 25 §F — a real reveal, which is the ask the operator was looking at.
   *
   * Merfolk Branchwalker explores when it enters: `ExploreEffect.java:78` calls
   * `GameAction.reveal(top, pl, false, …)` with `dontRevealToOwner` false, so
   * BOTH seats are shown the top card of the controller's library. That lands
   * as `PlayerControllerHuman.reveal` → `tempShowCards` →
   * `AbstractGuiGame.reveal` → `getChoices(message, -1, -1, items)` with no
   * display function, which is the one path in Forge that labels a card option
   * `CardView.toString()`. Nothing else in this file produced such an ask: the
   * `getChoices` of the `choices` scenario is Blaze's X (numbers, no refs) and
   * its `order` arrived with both lists empty.
   *
   * So this is the scenario that answers §F.2 from a real match, and it holds
   * two things: the lookup had the card's own `Name`/`SetCode` while the ask was
   * open, and no tile anywhere was named with a forge id.
   */
  it(
    'a reveal: the label carries Forge\'s "(id)", and the card\'s own facts are in the browser anyway',
    async () => {
      const h = await startLiveMatch({
        seed: 7,
        seats: [
          { name: 'A', ai: false, deck: deck('Explore A', ['32 Forest', '28 Merfolk Branchwalker']) },
          { name: 'B', ai: false, deck: deck('Explore B', ['32 Forest', '28 Merfolk Branchwalker']) },
        ],
      });
      running.push(h);
      // The stop policy these scenarios were written in — see "These scenarios
      // PIN `EVERY_PRIORITY_POLICY`" above. Set before anything is driven.
      for (const seat of h.seats) expect(h.match.setStopPolicy(seat.seat, EVERY_PRIORITY_POLICY)).toEqual({ ok: true });
      const plan: Plan = { land: /Forest/, casts: [{ name: 'Merfolk Branchwalker', mana: 2 }] };
      const driver = createDriver(h, plan);
      const probe = probeLabels(h, driver.roots);
      try {
        await drive(
          driver,
          () => probe.probes.some((x) => x.method === 'getChoices'),
          150_000,
          () => status(h),
        );
      } finally {
        probe.stop();
      }

      summary('explore', h);
      reportLabelProbe(probe);

      const reveals = probe.probes.filter((x) => x.method === 'getChoices');
      expect(reveals.length, 'Forge revealed a library card through getChoices').toBeGreaterThan(0);
      // The bug's fingerprint, measured rather than quoted: Forge really does
      // label a revealed card `<name> (<id>)`.
      expect(
        reveals.filter((x) => FORGE_ID_SUFFIX.test(x.label)).length,
        'a reveal label carried the forge id',
      ).toBeGreaterThan(0);
      for (const r of reveals) {
        // The label is not a usable art key — that is the whole bug — and the
        // name the lookup holds is the one the board would key on.
        expect(scryfallIdFor(KNOWN_ART_IDS, r.label, r.facts?.setCode ?? ''), r.label).toBeUndefined();
        expect(r.label, `${r.facts?.name} (${r.id})`).toContain(r.facts?.name ?? '\u0000');
        // The notice draws the card by the name inside Forge's label (`RevealNotice`).
        const shown = nameFromForgeLabel(r.label, r.id);
        expect([...probe.tileNames], `the tile said ${shown}`).toContain(shown);
        /*
         * And where the art-id table knows the revealed printing, the tile §F
         * builds carries that art id — from the card's facts, never the label. Conditional because which card a library reveals is up
         * to the shuffle: measured runs have revealed `Forest (89)` (in the
         * table, `Forest|TRK`) and `Merfolk Branchwalker (2)` (not in it, and
         * the manifest is empty — the tracker's own watch).
         */
        const byFacts = scryfallIdFor(KNOWN_ART_IDS, r.facts?.name ?? '', r.facts?.setCode ?? '');
        console.log(
          `[prompts.jvm] §F reveal ${JSON.stringify(r.label)} -> art id ${String(byFacts)} ` +
            `(from ${JSON.stringify(r.facts?.name)}|${r.facts?.setCode ?? ''})`,
        );
        if (byFacts !== undefined) {
          const tile = promptTileFor(lookupFromState(h.seats[r.seat]!.live.state), r.id, shown);
          expect(tile.scryfallId, 'the tile resolved art through the facts, not the label').toBe(byFacts);
          expect(tile.name, 'and says the card name').toBe(shown);
        }
      }
      expectCleanBridge(h);
      await expectNoDesync(h);
      expectNoLeak(h, false);
      h.stop();
    },
    240_000,
  );
});
