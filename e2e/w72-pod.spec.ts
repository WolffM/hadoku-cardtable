/**
 * Wave 72 §R.4's acceptance sequence (`docs/planning/wave72-2026-10-17.md`,
 * §Acceptance 1): a pod of three humans drafts, each builds a deck, round 1
 * pairs across the table with a bye, a watcher switches boards with the
 * strip, standings show, and round 2 pairs by score.
 *
 * Nobody presses anything between the editor and the game (the operator,
 * 2026-10-18: draft → deck building → inside a game already ready to play).
 * Each drafter's Play in the editor says they are done (`…/pod/play`); the
 * last one's deals round 1, and the pod screen readies and starts each table
 * by itself (`PodScreen.tsx`'s `startMyTable`) — the second of a table's two
 * players to land on the pod is the one whose start succeeds.
 *
 * The run for `-f video=true` ×1 still needs the claw dispatch per the
 * wave file; this file's own local run (jar, no video) is what found and
 * fixed the two gaps above.
 *
 * Games end by concede (not a real finish) to keep the run fast — the
 * acceptance text only needs a round to RESOLVE, not a full game.
 */
import { trimMainDeck } from './deckBuilder.ts';
import { fillWithAi } from './podSeats.ts';
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

/** Clicks the lowest-indexed enabled card over and over, until the finished draft lands in the deck builder. */
async function draftUntilDone(p: Player): Promise<void> {
  // The grid, not the fan: the fan overlaps its cards on purpose (`draft.spec.ts`'s
  // own note), so a click at a card's centre can land outside the viewport
  // or on a neighbour.
  const grid = p.page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  for (;;) {
    const next = await p.page.waitForFunction(
      () => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      null,
      { timeout: 90_000, polling: 50 },
    );
    if ((await next.jsonValue()) === 'done') return;
    await p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first().click();
    // Paced under the server's own pick rate limit (15 burst, then one per
    // 250 ms — `PICK_RATE_LIMIT`).
    await p.page.waitForTimeout(400);
  }
}

test(
  titled('a pod of three humans drafts, builds, plays round 1 with a bye, a watcher switches boards, and round 2 pairs by score'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    const stack = await startPlayStack(forge);
    const origin = stack.origin;
    let alice: Player | undefined;
    let bob: Player | undefined;
    let carol: Player | undefined;
    try {
      /*
       * `openFriend` (not a hand-rolled context): it already records video
       * under `CARDTABLE_E2E_VIDEO=1` (`play/browser.ts`'s own
       * `specVideoSlug`-named directory — AE20, the operator's acceptance
       * gate), the same way `e2e/w71-boards.spec.ts` already does, which a
       * hand-rolled context here skipped — the claw run that found this
       * uploaded no video at all. `/session/whoami` is routed once each
       * real `fk:` id is known, below, since `useWhoami()` is what
       * `PodSeats` uses to resolve "which seat is mine" — this e2e edge
       * stamps identity on every request but serves no `/session/whoami`
       * of its own (`e2e/embed.spec.ts`'s own note).
       */
      alice = await openFriend(browser, 'alice');
      bob = await openFriend(browser, 'bob');
      carol = await openFriend(browser, 'carol');
      const players = [alice, bob, carol];

      /* ── alice makes the pod, bob and carol find it ────────────────── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      const podName = `e2e w72 pod ${Date.now()}`;
      await submitCreateRoom(alice.page, { name: podName, gameType: 'draft' });
      const roomId = await roomIdFromHash(alice.page);
      const roomUrl = `${origin}${PREFIX}/#/room/${roomId}`;
      await bob.page.goto(roomUrl);
      await carol.page.goto(roomUrl);
      // `goto` only waits for the page to load, not for `ConstructedScreen`'s
      // own join-on-mount effect — the room has to see them as members
      // before the id lookup below can find them (`e2e/w71-boards.spec.ts`
      // hit the same race for a table-scoped PUT).
      for (const p of [bob, carol]) await expect(p.page.getByTestId('draft-lobby'), `${p.name}: joined the room`).toBeVisible({ timeout: UI_TIMEOUT });

      /*
       * `useWhoami()`'s real id is `fk:<hash of X-User-Key>`
       * (`apps/server/src/room/identity.ts`) — NOT the `e2e-<name>-id` this
       * harness's `X-User-Id` carries, which is the DEVICE tier's fallback
       * material and unused once a friend key is present. This reads each
       * member's REAL id off the room (already a member, by their joined
       * name) and routes `/session/whoami` to it, then reloads so
       * `useWhoami()`'s mount-only effect re-fires against it — otherwise
       * "which seat is mine" never resolves and `PodSeats` shows nobody's
       * own seat.
       */
      const roomBody = (await alice.page.evaluate(
        (id) => fetch(`${window.location.pathname.replace(/\/?$/, '/')}api/rooms/${id}`).then((r) => r.json()),
        roomId,
      )) as { members: { id: string; name: string }[] };
      for (const p of players) {
        const me = roomBody.members.find((m) => m.name === `e2e-${p.name}`);
        if (me === undefined) throw new Error(`${p.name}: not found among the room’s own members`);
        await p.context.route('**/session/whoami', (route) =>
          route.fulfill({ json: { valid: true, userId: me.id, userType: 'friend', name: `e2e-${p.name}` } }),
        );
        await p.page.reload();
        await resizeWindow(p.page, { width: 1280, height: 800 });
      }

      /* ── all three sit — the new 8-seat lobby, not the old auto-join ── */
      for (const p of players) await expect(p.page.getByTestId('pod-seats'), `${p.name}: the pod's 8 seats are up`).toBeVisible({ timeout: UI_TIMEOUT });
      await alice.page.locator('[data-testid="pod-seat-sit"][data-seat="0"]').click();
      await bob.page.locator('[data-testid="pod-seat-sit"][data-seat="1"]').click();
      await carol.page.locator('[data-testid="pod-seat-sit"][data-seat="2"]').click();
      for (const p of players) await expect(p.page.getByTestId('pod-seat-stand'), `${p.name}: holds their own seat`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── ready, deal, draft, build ──────────────────────────────────── */
      for (const p of players) await p.page.getByTestId('ready-toggle').click();
      await fillWithAi(alice.page, UI_TIMEOUT);
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });
      await Promise.all(players.map((p) => draftUntilDone(p)));
      for (const p of players) {
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the finished draft opens the editor`).toBeVisible({ timeout: UI_TIMEOUT });
        await trimMainDeck(p.page, 40, p.name);
        // Play: done building. The builder stays up, showing who else is.
        await p.page.getByTestId('play-deck').click();
      }
      // The first two wait in the builder, shown as ready; the third's Play
      // dealt round 1, and every builder hands its drafter to the room, whose
      // pod screen starts their table.

      /*
       * Round 1: two play, one has the bye. `pod-tables-bye` is drawn for
       * EVERYONE on the pod screen (it names the bye, it does not mean
       * "I am the bye"), so this cannot race it against the redirect — only
       * the redirect itself tells a page apart from the other two. Each is
       * given its own window rather than one shared timeout, since the bye
       * never redirects and must not make the other two wait the full
       * budget behind it.
       */
      const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
      const seated: Player[] = [];
      let bye: Player | undefined;
      for (const p of players) {
        const toMatch = await p.page
          .waitForURL(matchUrl, { timeout: UI_TIMEOUT })
          .then(() => true)
          .catch(() => false);
        if (toMatch) seated.push(p);
        else bye = p;
      }
      expect(seated, 'exactly two of the three play round 1').toHaveLength(2);
      expect(bye, 'the third has the bye').not.toBeUndefined();
      for (const p of seated) await expect(p.page.locator('[aria-label="Game board"]'), `${p.name}: carried to their own table`).toBeVisible({ timeout: UI_TIMEOUT });

      /* ── the bye watches via the pod's table cards, then back to the room ── */
      await bye!.page.goto(roomUrl);
      await bye!.page.getByTestId('pod-tables-watch').click();
      await expect(bye!.page.locator('[aria-label="Game board"]'), 'the bye is watching round 1’s table').toBeVisible({ timeout: UI_TIMEOUT });
      await bye!.page.evaluate((hash) => (window.location.hash = hash), new URL(roomUrl).hash);
      await expect(bye!.page.getByTestId('pod-tables'), 'back on the pod').toBeVisible({ timeout: UI_TIMEOUT });

      /*
       * End round 1 by concede, twice, the SAME winner both times — a clean
       * 2-0 sweep, so the series is decided after game 2 and never needs a
       * third. Fast, not a real finish: the acceptance text only needs the
       * round to RESOLVE.
       */
      const winner = seated[0]!;
      const loser = seated[1]!;
      for (let game = 0; game < 2; game++) {
        await loser.page.getByTestId('live-concede').click();
        await loser.page.getByTestId('live-concede-yes').click();
        await expect(winner.page.getByTestId('game-result')).toBeVisible({ timeout: UI_TIMEOUT });
        if (game === 0) {
          // Pod tables are bo3 WITH sideboarding (every pod series is,
          // `room/series.ts`'s `seriesFormatOf`), so after game 1 the result screen opens the
          // sideboard step directly — no Rematch button in a pod (the
          // manager's own note). Both players press Ready with their
          // unchanged 75 before game 2 is dealt.
          for (const p of seated) {
            await p.page.getByTestId('game-result-next').click({ timeout: UI_TIMEOUT });
            await expect(p.page.getByTestId('sideboard-step'), `${p.name}: Next opens the sideboard step`).toBeVisible({ timeout: UI_TIMEOUT });
          }
          // The loser closes the tab and comes back through the room link: the
          // room itself opens their sideboard step (the rejoin audit, 2026-10-19,
          // stranded them on the round screen while the winner waited).
          await loser.page.goto(roomUrl);
          await expect(loser.page.getByTestId('table-sideboard'), 'the room opens the sideboard step').toBeVisible({ timeout: UI_TIMEOUT });
          // Q's sideboard layout fix (`8fc0f75f`) put the Ready button back
          // in the viewport — a real click again, not `dispatchEvent`.
          for (const p of seated) await p.page.getByTestId('sideboard-ready').click();
          // Game 2 starts from the two Readys, and the room carries the loser into it.
          await loser.page.waitForURL(matchUrl, { timeout: UI_TIMEOUT });
          await expect(loser.page.locator('[aria-label="Game board"]'), 'the loser is back at the table for game 2').toBeVisible({ timeout: UI_TIMEOUT });
          // Game 2: the loser of game 1 is asked play or draw — no coin (the operator, 2026-10-19: "please check").
          await expect(loser.page.getByTestId('live-play-or-draw-host'), 'game 1’s loser chooses play or draw').toBeVisible({ timeout: 30_000 });
          await expect(winner.page.getByTestId('live-play-or-draw-host'), 'the winner is not asked').toHaveCount(0);
          await expect(winner.page.getByTestId('coin-toss'), 'no coin is flipped for game 2').toHaveCount(0);
          await loser.page.getByTestId('live-play-or-draw-play').click();
        }
      }

      /* ── standings show, and round 2 pairs by score ────────────────── */
      await bye!.page.goto(roomUrl);
      await expect(bye!.page.getByTestId('pod-standings'), 'standings after round 1').toBeVisible({ timeout: UI_TIMEOUT });
      const rows = bye!.page.getByTestId(/^pod-standings-row-\d+$/);
      await expect(rows).toHaveCount(3);
      // Round 1's table stays as its result; round 2's are the ones still to play.
      await expect.poll(
        async () => bye!.page.locator('[data-testid="pod-tables-row"]:not([data-phase="done"])').count(),
        { timeout: UI_TIMEOUT, message: 'round 2’s tables are up' },
      ).toBeGreaterThan(0);
      await expect(bye!.page.locator('[data-testid="pod-tables-row"][data-phase="done"]'), 'round 1’s table is still on show, finished').toHaveCount(1);
    } finally {
      // `stack.stop()` itself closes every open `openFriend` context and
      // renames its video when `CARDTABLE_E2E_VIDEO=1` (`play/harness.ts`'s
      // own note on why — the LAST test in a run would otherwise never
      // flush its `.webm`). Closing them here too would remove them from
      // that registry first and leave their footage unrenamed.
      await stack.stop();
    }
  },
);
