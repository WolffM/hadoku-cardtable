/**
 * Tournament mode, end to end, against the REAL built server and real Forge —
 * `docs/planning/tournament-mode-plan.md`'s own operator sequence (2026-10-22):
 * *"basically we want the pairing and lobby logic of how the draft rooms work
 * but for constructed gameplay… lock all the seats first, construct a bracket
 * and then split players off to play their games."*
 *
 * Alice leads a Constructed room, turns Tournament on (Classic, Locked), she
 * and Bob sit and pick decks; the field locks BY ITSELF the instant Bob's own
 * Ready completes it (ruling 7, 2026-10-22 — "the seats lock when all players
 * are ready", no Lock seats button). Round 1 pairs them, both reach their
 * table, the game is played to a result (concede, twice — the same move
 * `e2e/w72-pod.spec.ts` uses to settle a round fast, since the acceptance
 * text only needs the round to RESOLVE, not a full game), the round settles,
 * and standings show.
 *
 * A second, lighter test exercises the operator's 2026-10-22 AI-entrant
 * ruling (*"AI can sit in the tournament, but we can also allow byes…"*): an
 * AI entrant, seated and never readying its own seat, never blocks the lock
 * — only Bob's final Ready (the last HUMAN) does, with the AI already
 * seated. It stops after round 1 pairs — it does NOT play the AI's own
 * match to a result, because which of the three entrants round 1 gives the
 * bye to is the real server's Swiss engine's own choice (`@hadoku/draft`'s
 * `pairRound`, tour-s's to build), not something this lane can pin down
 * without one to run against.
 *
 * Classic's deck choice is the SAME `PUT /api/tables/rooms/:roomId/deck` the
 * 1v1 table always used — tour-s's landed contract (`tournament-s`,
 * f828588c), not a guess. The lock itself is `room/lobby.ts`'s
 * `#maybeLockTournament`, called from the SAME `setReady`/`sitPod`/`aiPod`
 * writes these tests already make — ruling 7's own doc.
 */
import { expect, test, type Browser } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;
const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;

/** Routes `/session/whoami` to this member's own real id, and reloads so `useWhoami()` re-resolves it — `e2e/w72-pod.spec.ts`'s own fix for "which seat is mine" (`PodSeats`). */
async function routeRealIdentity(p: Player, roomId: string): Promise<void> {
  const roomBody = (await p.page.evaluate(
    (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
    roomId,
  )) as { members: { id: string; name: string }[] };
  const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
  if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
  await p.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: `e2e-${p.name}` } }));
  await p.page.reload();
  await resizeWindow(p.page, { width: 1280, height: 800 });
}

/** Alice leads, Bob joins, both identified for real, both resized — the shared opening every test here starts with. */
async function openRoomWithLeader(browser: Browser, origin: string, roomName: string): Promise<{ roomId: string; roomUrl: string; alice: Player; bob: Player }> {
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  await alice.page.goto(`${origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: roomName, gameType: 'constructed-1v1', mode: 'classic' });
  const roomId = await roomIdFromHash(alice.page);
  const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
  await bob.page.goto(roomUrl);
  await expect(bob.page.getByTestId('constructed'), 'bob: joined the room').toBeVisible({ timeout: UI_TIMEOUT });
  for (const p of [alice, bob]) await routeRealIdentity(p, roomId);
  return { roomId, roomUrl, alice, bob };
}

/** Turns Tournament on and sets Decks — the leader's own two controls, both read live on every browser. */
async function enableTournament(alice: Player, bob: Player, decks: 'locked' | 'per-round'): Promise<void> {
  // A controlled radio: click, then wait for the room to say so (`toBeChecked`).
  await alice.page.getByTestId('room-event-tournament').click();
  await expect(alice.page.getByTestId('room-event-tournament')).toBeChecked();
  for (const p of [alice, bob]) await expect(p.page.getByTestId('tournament-lobby'), `${p.name}: the pod lobby replaces the 1v1 seats`).toBeVisible({ timeout: UI_TIMEOUT });
  if (decks === 'per-round') {
    // Decks is a Match rule: open them, choose, close.
    await alice.page.getByTestId('match-rules').click();
    await alice.page.getByTestId('tournament-decks-per-round').click();
    await expect(alice.page.getByTestId('tournament-decks-per-round')).toBeChecked();
    await alice.page.getByTestId('match-rules-popover-close').click();
  }
}

/**
 * Sits the given seat — by its own seat number (`e2e/w72-pod.spec.ts`'s own
 * way of sitting several players down without a race over which "open seat"
 * is whose), nothing else. `sitPod` is one of ruling 7's own trigger points
 * (`#maybeLockTournament`), but seating alone never completes the field —
 * only a human's OWN readiness (Classic: a deck; Random/Gauntlet: Ready) can.
 */
async function sit(p: Player, seat: number): Promise<void> {
  await p.page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click();
  await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds a pod seat`).toBeVisible({ timeout: UI_TIMEOUT });
}

/**
 * Picks the first legal deck on offer — Classic's OWN readiness condition
 * for the lock (`room/lobby.ts`'s `#lockTournament`: `hasLegalSeatDeck`,
 * never the Ready button). Ruling 7's own lock is not instrumented on the
 * deck PUT itself (`http/routes.ts`, outside this lane's claim), so picking
 * a deck alone never fires it — but it means this player now COUNTS as
 * ready for it, whether or not they ever press Ready, the next time
 * anything else does (another sit, an AI seated, anyone's own Ready).
 */
async function pickDeck(p: Player): Promise<void> {
  await expect(p.page.getByTestId('deck-mine'), `${p.name}: the tournament lobby’s own deck chooser`).toBeVisible({ timeout: UI_TIMEOUT });
  const tile = p.page.getByTestId('deck-mine').getByTestId('deck-option').first();
  await tile.click();
  await expect(p.page.getByTestId('ready-toggle'), `${p.name}: a legal deck enables Ready`).toBeEnabled({ timeout: UI_TIMEOUT });
}

/** Sits, then picks a deck. */
async function sitPick(p: Player, seat: number): Promise<void> {
  await sit(p, seat);
  await pickDeck(p);
}

/**
 * Presses Ready — one of ruling 7's own trigger points. For Classic this is
 * NOT what the lock itself waits on (the deck already is, `pickDeck`'s own
 * doc), so by the time this player already holds one, EITHER seat's own
 * Ready can be the one that completes the field; the lock may fire inside
 * THIS very click, racing the UI past ever painting "pressed" before the
 * screen moves on to the round — so this does not assert the pressed state,
 * only that the click landed. Callers prove the lock's own effect downstream
 * (the round starting, the lobby seats gone, standings), not this button.
 */
async function ready(p: Player): Promise<void> {
  await p.page.getByTestId('ready-toggle').click();
}

/** `sitPick` then `ready`, in one call — most callers want both. */
async function sitPickReady(p: Player, seat: number): Promise<void> {
  await sitPick(p, seat);
  await ready(p);
}

/** Concedes a game and waits for the result — `e2e/w72-pod.spec.ts`'s own fast way to settle a series. */
async function concedeToResult(loser: Player, winner: Player): Promise<void> {
  await loser.page.getByTestId('live-concede').click();
  await loser.page.getByTestId('live-concede-yes').click();
  await expect(winner.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
}

test(
  titled('Alice leads a Classic tournament, locked decks: lock, round 1, a played result, and standings'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const opened = await openRoomWithLeader(browser, stack.origin, `e2e tournament ${Date.now()}`);
      alice = opened.alice;
      bob = opened.bob;
      const { roomUrl } = opened;

      /* ── the leader turns Tournament on, Classic stays, Decks stays Locked ── */
      await enableTournament(alice, bob, 'locked');

      /* ── both sit and pick a deck; Ready lights once it is legal ──────── */
      await sitPickReady(alice, 0);
      // Bob's own Ready is the last thing the field needed: it locks by
      // itself, with nothing for anyone to press (ruling 7).
      await sitPickReady(bob, 1);

      /* ── round 1 pairs the only two entrants: both reach their table ──── */
      for (const p of [alice, bob]) await p.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
      for (const p of [alice, bob]) await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: carried to the tournament table`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── settle the round by concede, twice, the same winner — 2-0, no game 3 ── */
      const winner = alice;
      const loser = bob;
      await concedeToResult(loser, winner);
      for (const p of [winner, loser]) {
        await p.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('sideboard-step'), `${p.name}: Next opens the sideboard step`).toBeVisible({ timeout: UI_TIMEOUT });
      }
      await loser.page.goto(roomUrl);
      await expect(loser.page.getByTestId('table-sideboard'), 'the room opens the loser’s sideboard step').toBeVisible({ timeout: UI_TIMEOUT });
      for (const p of [winner, loser]) await p.page.getByTestId('sideboard-ready').click();
      await loser.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
      await expect(loser.page.locator('[aria-label="Game board"]'), 'game 2, back at the table').toBeVisible({ timeout: UI_TIMEOUT });
      await concedeToResult(loser, winner);

      /* ── the round settles; standings show ─────────────────────────── */
      await winner.page.goto(roomUrl);
      await expect(winner.page.getByTestId('pod-standings'), 'standings after round 1').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(winner.page.getByTestId(/^pod-standings-row-\d+$/)).toHaveCount(2);
      // The seat strip is gone (replaced by the bracket/standings), but the
      // header's Tournament choice stays visible, reading the room's actual
      // state — just frozen (the plan's own "locked once seats lock", not hidden).
      await expect(winner.page.getByTestId('pod-lock-seats')).toHaveCount(0);
      await expect(winner.page.getByTestId('room-event-tournament')).toBeDisabled();
    } finally {
      await stack.stop();
    }
  },
);

test(
  titled('an AI entrant seats before Lock, counts toward it without blocking it, and no AI action exists once seats lock'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(5 * 60_000);

    const stack = await startPlayStack(forge);
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const opened = await openRoomWithLeader(browser, stack.origin, `e2e tournament ai ${Date.now()}`);
      alice = opened.alice;
      bob = opened.bob;

      await enableTournament(alice, bob, 'locked');
      // Alice sits, with no deck yet: Classic's own readiness for the lock
      // is the deck (`pickDeck`'s own doc), not the seat, so the field is
      // nowhere near complete.
      await sit(alice, 0);

      /*
       * ── the leader seats an AI on a second, still-open seat — ≥ 2
       * entrants now, but it changes NOTHING about the lock: Alice herself
       * has no deck yet ──────────────────────────────────────────────────
       *
       * `isPodAi` (tour-s's fix) is true for a tournament pod's own `ai:<seat>`
       * entrant too, so `PodSeats.tsx` now draws the AI look and the Remove
       * action for it, same as the draft pod's shared `ai` — asserted here.
       */
      const openSeats = alice.page.locator('[data-testid="pod-seat-sit"]');
      const before = await openSeats.count();
      await alice.page.getByTestId('pod-seat-ai').first().click();
      await expect(openSeats, 'one fewer open seat: the AI took it').toHaveCount(before - 1, { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pod-seat-ai-remove'), 'the seat now offers Remove, not AI').toHaveCount(1, { timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('pod-tables'), 'the AI entrant alone never locks the field — Alice has no deck yet').toHaveCount(0);

      // Bob sits and both humans pick their decks — Classic's own readiness,
      // still short of anything instrumented re-checking the lock.
      await sit(bob, 2);
      await pickDeck(alice);
      await pickDeck(bob);
      await expect(alice.page.getByTestId('pod-tables'), 'both decks held, but nothing has re-checked the lock yet').toHaveCount(0);

      // Bob's own Ready is the last thing the field needed: it locks by
      // itself, with the AI entrant counted but never asked for its own.
      await ready(bob);

      /*
       * Round 1 pairs two of the three entrants; which one gets the bye is
       * the real Swiss engine's call (not proven here — see the file
       * header), so this only asserts the pod moved past its lobby for
       * both humans: no more seats, no more AI action, somewhere to watch.
       */
      for (const p of [alice, bob]) {
        await expect(p.page.getByTestId('pod-seats'), `${p.name}: the seat strip is gone once seats lock`).toHaveCount(0, { timeout: UI_TIMEOUT });
        await expect(p.page.getByTestId('pod-seat-ai'), `${p.name}: no AI action exists after lock`).toHaveCount(0);
        await expect(p.page.getByTestId('pod-tables'), `${p.name}: the bracket is up`).toBeVisible({ timeout: UI_TIMEOUT });
      }
    } finally {
      await stack.stop();
    }
  },
);

/**
 * The regression this lane's priority fix needed (room r-228e5e39987e, a
 * real run): one human and three AI entrants, Classic, Decks "each round",
 * auto-locked (ruling 7) the instant Alice's own Ready completes the field
 * — no Lock seats press. `roundsFor(4) === 2`, so this plays TWO rounds:
 * round 1 pairs Alice against one AI (the other two AI settle each other
 * without a table); Alice picks THAT round's own deck, the match starts,
 * and a concede settles it; round 2 pairs her again (a new AI, the Swiss
 * engine's own call), and the SAME re-pick → match → result repeats.
 *
 * Before the fix, `tables[0]` — the room's own stale, never-played 1v1
 * table — was what the screen read for "my table": the round's own table,
 * and its per-round deck chooser, never surfaced, and the match never
 * started. This is why that bug existed at all.
 */
test(
  titled('a Classic, per-round, mostly-AI tournament: auto-lock, round 1’s own table and deck pick, a result, and round 2 again'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    let alice: Player | undefined;
    let bob: Player | undefined;
    try {
      const opened = await openRoomWithLeader(browser, stack.origin, `e2e tournament per-round ai ${Date.now()}`);
      alice = opened.alice;
      bob = opened.bob;
      const { roomUrl } = opened;

      await enableTournament(alice, bob, 'per-round');
      // Bob never sits: one human, three AI — entrants enough for two rounds
      // (`roundsFor(4) === 2`), none of Bob's own doing. Alice sits with NO
      // deck yet (Classic's own readiness for the lock, `pickDeck`'s own
      // doc) — otherwise the very first AI seated would already complete a
      // 2-entrant field and lock before the loop seats the other two.
      await sit(alice, 0);
      // One AI at a time: a second click before the feed redraws lands on the same seat.
      for (let seat = 1; seat <= 3; seat++) {
        await alice.page.getByTestId('pod-seat-ai').first().click();
        await expect(alice.page.getByTestId('pod-seat-ai-remove')).toHaveCount(seat, { timeout: UI_TIMEOUT });
      }
      await pickDeck(alice);

      // Alice's own Ready is the last thing the field needed: it locks by itself.
      await ready(alice);
      await expect(alice.page.getByTestId('pod-tables'), 'round 1 is up').toBeVisible({ timeout: UI_TIMEOUT });

      /**
       * Round N's own table, vs the AI: picks THAT round's deck, waits for
       * the match, concedes — Bo3 with sideboarding (ruling 4), so ONE
       * concede is a Bo1 and the series is not yet decided (`#settleSeries`'s
       * own doc); a second, after the sideboard step, is what decides it
       * 0–2. The AI's own "ready" for sideboarding is the server's, with
       * nothing for a browser to press.
       */
      const playRound = async (round: number): Promise<void> => {
        await expect(alice!.page.getByTestId('pod-round'), `round ${round} is current`).toHaveText(`Round ${round} of 2`, { timeout: UI_TIMEOUT });
        await expect(alice!.page.getByTestId('deck-mine'), `round ${round}: the round’s OWN deck chooser — never tables[0]’s`).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.getByTestId('deck-mine').getByTestId('deck-option').first().click();
        await alice!.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
        await expect(alice!.page.locator('[aria-label="Game board"]'), `round ${round}: carried to the round’s own table`).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.getByTestId('live-concede').click();
        await alice!.page.getByTestId('live-concede-yes').click();
        await expect(alice!.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
        await expect(alice!.page.getByTestId('sideboard-step'), `round ${round}: game 1 alone is a Bo1 — Next opens the sideboard step`).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.goto(roomUrl);
        await expect(alice!.page.getByTestId('table-sideboard'), `round ${round}: the room opens the sideboard step`).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.getByTestId('sideboard-ready').click();
        await alice!.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
        await expect(alice!.page.locator('[aria-label="Game board"]'), `round ${round}: game 2`).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.getByTestId('live-concede').click();
        await alice!.page.getByTestId('live-concede-yes').click();
        await expect(alice!.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
        await alice!.page.goto(roomUrl);
      };

      await playRound(1);
      await playRound(2);

      await expect(alice.page.getByTestId('pod-standings'), 'standings after round 2').toBeVisible({ timeout: UI_TIMEOUT });
    } finally {
      await stack.stop();
    }
  },
);
