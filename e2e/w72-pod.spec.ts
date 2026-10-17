/**
 * Wave 72 §R.4's acceptance sequence (`docs/planning/wave72-2026-10-17.md`,
 * §Acceptance 1): a pod of three humans drafts, each builds a deck, round 1
 * pairs across the table with a bye, a watcher switches boards with the
 * strip, standings show, and round 2 pairs by score.
 *
 * Written against the wire contract (§P's routes: `…/pod/sit`,
 * `…/pod/stand`, `…/pod/rounds`), then run and fixed against the real
 * server once lane P landed (`98f45240`) — two gaps the contract's wording
 * did not spell out, both confirmed by reading the room back rather than
 * assumed:
 *
 *   - `pod/rounds` only SEATS round 1's pairing; nothing else starts its
 *     first game. `PodTables`' own "Play" button does
 *     (`PodScreen.tsx`'s `startTableMatch`).
 *   - A pod table is gated the SAME way a constructed one is: both seats
 *     have to ready (`POST tables/rooms/:id/ready`) before
 *     `POST /api/play/matches` succeeds — `startTableMatch` does both.
 *
 * The run for `-f video=true` ×1 still needs the claw dispatch per the
 * wave file; this file's own local run (jar, no video) is what found and
 * fixed the two gaps above.
 *
 * Games end by concede (not a real finish) to keep the run fast — the
 * acceptance text only needs a round to RESOLVE, not a full game.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { makeTitled, resizeWindow, roomIdFromHash } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const UI_TIMEOUT = 30_000;

interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
}

async function join(browser: Browser, name: string, origin: string): Promise<Player> {
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, origin);
  // This e2e edge stamps identity on every request but serves no
  // `/session/whoami` of its own (`e2e/embed.spec.ts`'s own note) — routed
  // once the real `fk:` id is known, below, since `useWhoami()` is what
  // `PodSeats` uses to resolve "which seat is mine".
  const page = await context.newPage();
  return { name, context, page };
}

/** Clicks the lowest-indexed enabled card over and over, until the pod says "Draft complete". */
async function draftUntilDone(p: Player): Promise<void> {
  // The grid, not the fan: the fan overlaps its cards on purpose (`draft.spec.ts`'s
  // own note), so a click at a card's centre can land outside the viewport
  // or on a neighbour.
  const grid = p.page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  for (;;) {
    const next = await p.page.waitForFunction(
      () => {
        if (document.querySelector('.pod__done') !== null) return 'done';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      null,
      { timeout: 90_000, polling: 50 },
    );
    if ((await next.jsonValue()) === 'done') return;
    await p.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first().click();
    // Paced under the server's own pick rate limit (8 burst, then 1 per
    // 1.5 s — `draft.spec.ts`'s own header note). Clicking as fast as
    // Playwright can outruns that limit with no visible error (the pack
    // just never advances), which reads as a hang rather than a refusal.
    await p.page.waitForTimeout(1_600);
  }
}

/** Moves `n` cards from the side grid to the main deck and waits for the debounced save. */
async function buildMainDeck(p: Player, n: number): Promise<void> {
  const mainCount = p.page.getByTestId('main-count');
  const sideCard = p.page.locator('[data-testid="side-grid"] button[data-testid="card"]').first();
  for (let i = 0; i < n; i++) await sideCard.click();
  await expect(mainCount, `${p.name}: the maindeck reaches ${n}`).toHaveText(String(n));
  await expect(p.page.getByTestId('save-status'), `${p.name}: the build is saved`).toHaveText('Saved.', { timeout: UI_TIMEOUT });
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
      alice = await join(browser, 'alice', origin);
      bob = await join(browser, 'bob', origin);
      carol = await join(browser, 'carol', origin);
      const players = [alice, bob, carol];

      /* ── alice makes the pod, bob and carol find it ────────────────── */
      await alice.page.goto(`${origin}${PREFIX}/`);
      await openCreateRoom(alice.page);
      const podName = `e2e w72 pod ${Date.now()}`;
      await alice.page.getByTestId('room-create-name').fill(podName);
      await alice.page.getByTestId('room-create-type').selectOption('draft');
      await alice.page.getByTestId('room-create-submit').click();
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
       * material and unused once a friend key is present. The mock in
       * `join()` answered the wrong one; this reads each member's REAL id
       * off the room (already a member, by their joined name) and swaps the
       * route to the truth, then reloads so `useWhoami()`'s mount-only
       * effect re-fires against it — otherwise "which seat is mine" never
       * resolves and `PodSeats` shows nobody's own seat.
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
      for (const p of players) await expect(p.page.getByTestId('pod'), `${p.name}: the pod is dealt`).toBeVisible({ timeout: UI_TIMEOUT });
      await Promise.all(players.map((p) => draftUntilDone(p)));
      for (const p of players) await expect(p.page.locator('.pod__done h1')).toHaveText('Draft complete');

      for (const p of players) {
        await p.page.getByTestId('pod-build').click();
        await expect(p.page.getByTestId('deck-editor'), `${p.name}: the editor opens`).toBeVisible({ timeout: UI_TIMEOUT });
        await buildMainDeck(p, 40);
        await p.page.goto(roomUrl);
      }

      /* ── everyone shows built; alice (the leader) starts round 1 ─────── */
      await expect.poll(() => alice!.page.getByTestId('pod-built').locator('[data-built]').count(), { timeout: UI_TIMEOUT, message: 'every drafter shows built' }).toBe(3);
      await alice.page.getByTestId('pod-start-rounds').click();

      /*
       * `pod/rounds` only seats round 1's pairing. `PodTables`' own "Play"
       * button both readies and starts the game (see the header); either
       * of the pairing's two clicking first readies them and gets back
       * "the other seat isn't ready" with no error shown, and the second
       * click succeeds for both. The bye has no table of their own, so
       * this is a no-op for them.
       */
      for (const p of players) {
        await expect(p.page.getByTestId('pod-rounds'), `${p.name}: round 1 is up`).toBeVisible({ timeout: UI_TIMEOUT });
        const play = p.page.getByTestId('pod-tables-play');
        if (await play.isVisible().catch(() => false)) await play.click();
      }

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

      /* ── the bye watches via the pod's table list, then the strip back ── */
      await bye!.page.goto(roomUrl);
      await bye!.page.getByTestId('pod-tables-watch').click();
      await expect(bye!.page.locator('[aria-label="Game board"]'), 'the bye is watching round 1’s table').toBeVisible({ timeout: UI_TIMEOUT });
      await expect(bye!.page.getByTestId('board-strip-back'), 'the strip offers a way back to the pod').toBeVisible({ timeout: UI_TIMEOUT });
      await bye!.page.getByTestId('board-strip-back').click();
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
          // Pod tables are bo3 WITH sideboarding (the room setting every pod
          // match carries), so after game 1 the result screen opens the
          // sideboard step directly — no Rematch button in a pod (the
          // manager's own note). Both players press Ready with their
          // unchanged 75 before game 2 is dealt.
          for (const p of seated) {
            await expect(p.page.getByTestId('sideboard-step'), `${p.name}: the sideboard step opens`).toBeVisible({ timeout: UI_TIMEOUT });
          }
          // Q's sideboard layout fix (`8fc0f75f`) put the Ready button back
          // in the viewport — a real click again, not `dispatchEvent`.
          for (const p of seated) await p.page.getByTestId('sideboard-ready').click();
        }
      }

      /* ── standings show, and round 2 pairs by score ────────────────── */
      await bye!.page.goto(roomUrl);
      await expect(bye!.page.getByTestId('pod-standings'), 'standings after round 1').toBeVisible({ timeout: UI_TIMEOUT });
      const rows = bye!.page.getByTestId(/^pod-standings-row-\d+$/);
      await expect(rows).toHaveCount(3);
      await expect.poll(
        async () => bye!.page.getByTestId('pod-tables-row').count(),
        { timeout: UI_TIMEOUT, message: 'round 2’s tables are up' },
      ).toBeGreaterThan(0);
    } finally {
      await stack.stop();
      for (const p of [alice, bob, carol]) await p?.context.close();
    }
  },
);
