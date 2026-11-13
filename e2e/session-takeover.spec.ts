/**
 * One live tab per player per room. The operator, 2026-11-07: *"whenever a player tried to join a game
 * when they already have an active session we should: 1. show a prompt in the middle of the screen,
 * with the rest of the site greyed out behind, asking whether they want to take over in this session?
 * if they click yes, then we terminate their previous session."*
 *
 * The rule is the shared room layer's (`@wolffm/rooms-server`'s `SessionClaims`); the server's half is
 * `packages/game-server/src/room/session.ts`, the screen's `packages/game-ui/src/room/session.ts`. Here, in real
 * browsers against a real server and a real Forge: a second page of the same account is asked, takes
 * over and plays; the first page is told and takes it back the same way; and a reload never asks.
 *
 * Needs a Forge build like `play.spec.ts`; without one each test SKIPS and its title says why. Serves
 * the prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { enterMatch, makeTitled, serverLog } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { answerConfirm, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { TURN_TEXT } from './play/turn.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const board = (page: Page) => page.locator('[aria-label="Game board"]');
const playOrDrawPlay = (page: Page) => page.getByTestId('live-play-or-draw-play');
const ask = (page: Page) => page.getByTestId('session-ask');
const taken = (page: Page) => page.getByTestId('session-taken');

async function boardUp(page: Page): Promise<void> {
  await expect(board(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 30_000 });
}

/** A question in the middle of the page, with nothing on it but its words and its answers, and the page behind it inert. */
async function expectQuestion(page: Page, testId: 'session-ask' | 'session-taken', title: string, answers: string[]): Promise<void> {
  const panel = page.getByTestId(testId);
  await expect(panel, `${testId} is drawn`).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('h3')).toHaveText(title);
  await expect(panel.getByRole('button')).toHaveText(answers);
  await expect(page.getByTestId(`${testId}-close`), 'it can only be answered').toHaveCount(0);
  await expect(board(page), 'no table behind it').toHaveCount(0);
  // Centred over the window.
  const box = await panel.boundingBox();
  const view = page.viewportSize();
  if (box === null || view === null) throw new Error('no box for the question');
  expect(Math.abs(box.x + box.width / 2 - view.width / 2), 'centred across').toBeLessThan(4);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2), 'centred down').toBeLessThan(4);
  // The page behind it cannot be reached: the room's chrome is inert.
  const shell = page.getByTestId('room-shell');
  if ((await shell.count()) > 0) await expect(shell).toHaveAttribute('inert', '');
}

test(titled('a second page of the same player is asked; yes plays there, the first page is told, and its Play here takes the game back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);
    await expect(playOrDrawPlay(alice.page), 'the first page holds the question').toBeEnabled({ timeout: 30_000 });

    // The second page: the same account opens the room. It is asked, and joins nothing meanwhile.
    const second = await openFriend(browser, 'alice');
    await second.page.goto(roomUrl);
    await expectQuestion(second.page, 'session-ask', 'Play here instead?', ['No', 'Yes']);
    await expect(board(alice.page), 'the first page plays on while the second asks').toBeVisible();
    await expect(taken(alice.page)).toHaveCount(0);
    expect(serverLog(stack).filter((l) => l.evt === 'seat-taken-over' || l.evt === 'session-taken'), 'nothing was taken before the answer').toEqual([]);

    // Yes: the second page plays, and is handed the open question.
    await second.page.getByTestId('session-ask-yes').click();
    await expect(ask(second.page)).toHaveCount(0);
    await second.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: 60_000 });
    await boardUp(second.page);
    await expect(playOrDrawPlay(second.page), 'the new page is handed the question').toBeEnabled({ timeout: 30_000 });
    expect(serverLog(stack).filter((l) => l.evt === 'session-taken').map((l) => l.holder), 'one take, from a live holder').toEqual(['live']);

    // The first page is told, over a dimmed and inert page, and draws no table.
    await expectQuestion(alice.page, 'session-taken', 'Open in another tab', ['Play here']);

    // Its Play here takes it back the same way: now the second page is the one told.
    await alice.page.getByTestId('session-take-back').click();
    await expect(taken(alice.page)).toHaveCount(0);
    await boardUp(alice.page);
    await expect(playOrDrawPlay(alice.page), 'Play here hands the question back').toBeEnabled({ timeout: 30_000 });
    await expectQuestion(second.page, 'session-taken', 'Open in another tab', ['Play here']);
    await playOrDrawPlay(alice.page).click();
    await expect(alice.page.getByTestId('live-says')).toContainText(/keep your hand/i, { timeout: 30_000 });
    expect(serverLog(stack).filter((l) => l.evt === 'session-taken').map((l) => l.holder)).toEqual(['live', 'live']);

    // No: a third page goes back to the front page without joining.
    const third = await openFriend(browser, 'alice');
    await third.page.goto(roomUrl);
    await expectQuestion(third.page, 'session-ask', 'Play here instead?', ['No', 'Yes']);
    await third.page.getByTestId('session-ask-no').click();
    await expect(third.page.getByTestId('lobby'), 'back on the front page').toBeVisible({ timeout: 30_000 });
    await expect(ask(third.page)).toHaveCount(0);
    await expect(board(alice.page), 'and the game stays where it was').toBeVisible();
    await expect(taken(alice.page)).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(titled('a reload of the playing page is the same tab: it is never asked, and plays on'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);
    await expect(playOrDrawPlay(alice.page)).toBeEnabled({ timeout: 30_000 });
    await playOrDrawPlay(alice.page).click();
    await expect(confirmYes(alice.page), 'her keep is asked').toHaveCount(1, { timeout: 30_000 });

    // Records, in the reloaded page, whether either question was ever drawn.
    await alice.page.addInitScript(() => {
      const w = window as unknown as { __askedSession?: boolean };
      w.__askedSession = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="session-ask"], [data-testid="session-taken"]') !== null) w.__askedSession = true;
      }).observe(document, { subtree: true, childList: true });
    });
    await alice.page.reload();
    await boardUp(alice.page);
    await expect(confirmYes(alice.page), 'the keep is still hers after the reload').toHaveCount(1, { timeout: 30_000 });
    await answerConfirm(alice.page, 'yes');
    await expect(alice.page.getByTestId('live-says'), 'and the keep went through').not.toContainText(/keep your hand/i, { timeout: 30_000 });
    expect(await alice.page.evaluate(() => (window as unknown as { __askedSession?: boolean }).__askedSession), 'a reload never asks').toBe(false);
    expect(serverLog(stack).filter((l) => l.evt === 'session-taken' || l.evt === 'session-held' || l.evt === 'session-elsewhere'), 'the server never saw a second tab').toEqual([]);
  } finally {
    await stack.stop();
  }
});
