/**
 * The §Acceptance 1v1 sequence (wave 72 §Q, `docs/planning/wave72-2026-10-17.md`):
 *
 *   A 1v1 constructed room, bo1 with sideboarding on. Game 1 ends, and both
 *   players press Rematch. Each sees the sideboard step with their own 75,
 *   and one swaps a card. Game 2 starts with the swapped deck, and the loser
 *   of game 1 is asked play-or-draw. Then the same room set to bo3: after
 *   game 1 the sideboard step opens with no Rematch press.
 *
 * `[w72-sideboard]` lines are the evidence: which screen pressed what, and
 * what each saw.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, twoLegalDecks } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { openCreateRoom } from './play/rooms.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const result = (f: Friend) => f.page.getByTestId('game-result');
const rematch = (f: Friend) => f.page.getByTestId('game-result-rematch');

/** A real press: the mouse moves to the button's centre and clicks there — the same discipline `w69-rematch.spec.ts` uses, since a driver presses by state, not text. */
async function press(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on the screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Alice makes a room, toggles `sideboarding` on (the leader's control, before
 * anyone is seated — the operator's own rulings, `draft-pods-plan.md` §5b:
 * `bo1` is the default, `sideboarding` is a separate toggle), bob joins, each
 * loads a legal deck, and both ready — the server starts the match.
 */
async function enterSideboardedMatch(alice: Friend, bob: Friend, origin: string): Promise<{ matchId: string; roomUrl: string }> {
  const choice = await twoLegalDecks(alice.context.request, origin);
  await alice.page.goto(`${origin}${PREFIX}/`);
  await openCreateRoom(alice.page);
  await alice.page.getByTestId('room-create-name').fill(`e2e w72-sideboard ${Date.now()}`);
  await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await alice.page.getByTestId('room-create-submit').click();
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  const roomUrl = alice.page.url();

  await expect(alice.page.getByTestId('sideboarding')).toHaveAttribute('aria-pressed', 'false');
  await alice.page.getByTestId('sideboarding').click();
  await expect(alice.page.getByTestId('sideboarding'), 'bo1 + sideboarding on').toHaveAttribute('aria-pressed', 'true');
  console.log('[w72-sideboard] sideboarding switched on (bo1)');

  await bob.page.goto(roomUrl);
  await expect(alice.page.getByTestId('constructed')).toBeVisible();
  await expect(bob.page.getByTestId('constructed'), 'bob is in the room alice made').toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId('format').selectOption(choice.format);
  await expect(bob.page.getByTestId('format-fixed')).toHaveAttribute('data-format', choice.format);
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
    await expect(f.page.getByTestId('ready-toggle'), `${f.name}: their own deck is legal`).toBeEnabled();
  }
  await alice.page.getByTestId('ready-toggle').click();
  await bob.page.getByTestId('ready-toggle').click();
  const matchUrl = MATCH_URL;
  await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
  await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
  const matchId = matchUrl.exec(alice.page.url())?.[1];
  if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
  for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
  console.log(`[w72-sideboard] game 1 live: ${matchId}, alice=${choice.decks[0]} bob=${choice.decks[1]}`);
  return { matchId, roomUrl };
}

/** `loser` concedes; both screens show the result. Returns who won. */
async function concede(alice: Friend, bob: Friend, loser: Friend): Promise<void> {
  await loser.page.getByTestId('live-concede').click();
  await loser.page.getByTestId('live-concede-yes').click();
  await expect(result(alice), "alice's result screen").toBeVisible({ timeout: 45_000 });
  await expect(result(bob), "bob's result screen").toBeVisible({ timeout: 45_000 });
}

test(
  titled(
    'bo1 + sideboarding: Rematch opens the sideboard step, a swap carries into game 2, the loser of game 1 is asked play-or-draw; then bo3 opens it with no Rematch press',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const alice = await openFriend(browser, 'alice'); // the room's leader
      const bob = await openFriend(browser, 'bob');
      const { matchId: match1, roomUrl } = await enterSideboardedMatch(alice, bob, stack.origin);

      /* ── game 1 ends; bob is the loser ───────────────────────────────── */
      await concede(alice, bob, bob);
      console.log('[w72-sideboard] game 1 ended: bob conceded (bob is the loser)');
      for (const f of [alice, bob]) await expect(rematch(f), `${f.name}: Rematch is offered`).toBeEnabled({ timeout: 15_000 });

      /* ── both press Rematch — the sideboard step, not a new game ─────── */
      for (const f of [alice, bob]) await press(f.page, 'game-result-rematch');
      for (const f of [alice, bob]) {
        await expect(f.page.getByTestId('sideboard-step'), `${f.name} sees the sideboard step`).toBeVisible({ timeout: 20_000 });
        await expect(f.page.getByTestId('game-result-rematch'), 'the editor replaces the button').toHaveCount(0);
        // Ready must sit inside the window with no scrolling at this size
        // (1280×800) — the defect a real-Forge run found: the editor's own
        // card grids used to grow the whole dialog past the fold.
        await expect(f.page.getByTestId('sideboard-ready'), `${f.name}: Ready is in the viewport, no scroll needed`).toBeInViewport();
      }
      console.log('[w72-sideboard] both pressed Rematch: the sideboard step is open on both screens, Ready in view');

      /* ── alice swaps a card between her main and her sideboard ───────── */
      const mainCountBefore = await alice.page.getByTestId('sideboard-step').getByTestId('main-count').textContent();
      await alice.page.getByTestId('sideboard-step').getByTestId('side-grid').locator('[data-testid="card"]').first().click();
      await expect
        .poll(async () => alice.page.getByTestId('sideboard-step').getByTestId('main-count').textContent())
        .not.toBe(mainCountBefore);
      console.log(`[w72-sideboard] alice swapped a card into her main (${mainCountBefore} -> changed)`);

      /* ── both ready the sideboard step: Ready is reachable, no scroll ── */
      for (const f of [alice, bob]) {
        const readyButton = f.page.getByTestId('sideboard-ready');
        await expect(readyButton, `${f.name}: Ready is still in the viewport`).toBeInViewport();
        await readyButton.click();
      }
      for (const f of [alice, bob]) await expect(f.page.getByTestId('sideboard-ready')).toHaveAttribute('aria-pressed', 'true');

      /* ── game 2 starts; bob (game 1's loser) is asked play-or-draw ────── */
      // Both pages are STILL on game 1's match URL at this point (nothing has
      // navigated yet), and that URL already satisfies the bare `MATCH_URL`
      // pattern — a plain `waitForURL(matchUrl)` resolves at once against the
      // unchanged URL rather than waiting for game 2's. Wait for a match id
      // that differs from game 1's instead.
      const matchUrl = MATCH_URL;
      const isNewMatch = (url: URL): boolean => {
        const id = matchUrl.exec(url.href)?.[1];
        return id !== undefined && id !== match1;
      };
      await alice.page.waitForURL(isNewMatch, { timeout: 120_000 });
      await bob.page.waitForURL(isNewMatch, { timeout: 120_000 });
      const match2 = matchUrl.exec(alice.page.url())?.[1];
      expect(match2, 'a fresh Forge match, not game 1 again').not.toBe(match1);
      expect(matchUrl.exec(bob.page.url())?.[1]).toBe(match2);
      console.log(`[w72-sideboard] game 2 live: ${match2}`);
      await expect(bob.page.getByTestId('live-play-or-draw-host'), "bob (game 1's loser) is asked play-or-draw").toBeVisible({ timeout: 30_000 });
      await bob.page.getByTestId('live-play-or-draw-play').click();
      for (const f of [alice, bob]) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });

      /* ── end game 2, back to the room, and switch it to bo3 ───────────── */
      await concede(alice, bob, alice);
      console.log('[w72-sideboard] game 2 ended: alice conceded');
      await press(alice.page, 'game-result-room');
      await expect(alice.page.getByTestId('constructed'), 'alice is back at the room').toBeVisible({ timeout: 15_000 });
      await expect(alice.page.getByTestId('match-length')).toHaveAttribute('aria-pressed', 'false');
      await alice.page.getByTestId('match-length').click();
      await expect(alice.page.getByTestId('match-length'), 'bo3 now').toHaveAttribute('aria-pressed', 'true');
      await expect(alice.page.getByTestId('sideboarding'), 'bo3 forces sideboarding on, locked').toHaveAttribute('aria-pressed', 'true');
      await expect(alice.page.getByTestId('sideboarding')).toBeDisabled();
      console.log('[w72-sideboard] room switched to bo3');

      /* ── bo3's own game 1: both ready up fresh, concede it ────────────── */
      await bob.page.goto(roomUrl);
      await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
      for (const f of [alice, bob]) {
        await expect(f.page.getByTestId('ready-toggle')).toBeEnabled({ timeout: 15_000 });
        await f.page.getByTestId('ready-toggle').click();
      }
      await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
      await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
      const match3 = matchUrl.exec(alice.page.url())?.[1];
      console.log(`[w72-sideboard] bo3 game 1 live: ${match3}`);
      await concede(alice, bob, bob);
      console.log('[w72-sideboard] bo3 game 1 ended: bob conceded, series not decided (0-1 of 3)');

      /* ── the sideboard step opens on its own: no Rematch press ───────── */
      for (const f of [alice, bob]) {
        await expect(f.page.getByTestId('sideboard-step'), `${f.name}: the sideboard step opens on its own`).toBeVisible({ timeout: 20_000 });
        await expect(f.page.getByTestId('game-result-rematch'), 'no Rematch/Next game press happened').toHaveCount(0);
        await expect(f.page.getByTestId('sideboard-ready'), `${f.name}: Ready is in the viewport, no scroll needed`).toBeInViewport();
      }
      console.log('[w72-sideboard] bo3: the sideboard step opened with no Rematch press on either screen, Ready in view');
    } finally {
      await stack.stop();
    }
  },
);
