/**
 * Rematch is a mutual agreement — the operator, 2026-10-10:
 * *"when the rematch button is clicked, it should give a green checkmark over
 * the persons avatar instead of immediately launching into a new game. only
 * when both players have rematch clicked should it launch into a new game.
 * when one player clicks the button, it should highlight for the other button."*
 *
 * The operator's own game (production log, room r-106e5fcf9968): a deploy
 * restarted the server mid-match, the match carried on, and the moment the
 * winner pressed Rematch a new match started with nobody else pressing
 * anything. The first case replays that, deploy and all.
 *
 * `[w69-rematch]` lines are the evidence: each screen's URL, the checkmarks and
 * highlight each screen draws, how many matches the server started, and any
 * error either screen drew.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { enterMatch, makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;

const result = (f: Friend) => f.page.getByTestId('game-result');
const rematch = (f: Friend) => f.page.getByTestId('game-result-rematch');
/** The face on `f`'s result screen: their own (`you`) or the other player's. */
const face = (f: Friend, whose: 'you' | 'other') => f.page.locator(`[data-testid="game-result-face"][data-you="${whose === 'you'}"]`);
const check = (f: Friend, whose: 'you' | 'other') => face(f, whose).getByTestId('game-result-check');

/** A real press: the mouse moves to the button's centre and clicks there. */
async function press(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on the screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** How many matches the server has started from a room. */
function matchesStarted(stack: PlayStack): number {
  return readFileSync(stack.serverLogFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"evt":"room-match-started"')).length;
}

/** Every error text `f`'s screen draws from now on, as it is drawn. */
async function recordErrors(f: Friend, seen: string[]): Promise<void> {
  await f.page.exposeBinding('__w69Error', (_src, text: string) => {
    seen.push(`${f.name}: ${text}`);
    console.log(`[w69-rematch] ERROR DRAWN ${f.name}: ${text}`);
  });
  await f.page.evaluate(() => {
    const said = new WeakMap<Element, string>();
    const look = (): void => {
      for (const el of Array.from(document.querySelectorAll('[role="alert"], .lobby__error, .live__error'))) {
        const text = (el.textContent ?? '').trim();
        if (text === '' || said.get(el) === text) continue;
        said.set(el, text);
        (window as unknown as { __w69Error: (t: string) => void }).__w69Error(text);
      }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

async function report(stack: PlayStack, alice: Friend, bob: Friend, when: string): Promise<void> {
  const marks = async (f: Friend): Promise<string> =>
    `you=${await check(f, 'you').count()} other=${await check(f, 'other').count()} highlight=${(await rematch(f).getAttribute('data-highlight').catch(() => null)) ?? '-'}`;
  console.log(
    `[w69-rematch] ${when}: matches started=${matchesStarted(stack)} alice ${alice.page.url().split('#')[1]} [${await marks(alice)}] bob ${bob.page.url().split('#')[1]} [${await marks(bob)}]`,
  );
}

/** Bob concedes; both screens show the result. */
async function bobConcedes(alice: Friend, bob: Friend): Promise<void> {
  await bob.page.getByTestId('live-concede').click();
  await bob.page.getByTestId('live-concede-yes').click();
  await expect(result(alice), "alice's result screen").toBeVisible({ timeout: 45_000 });
  await expect(result(bob), "bob's result screen").toBeVisible({ timeout: 45_000 });
  for (const f of [alice, bob]) {
    await expect(check(f, 'you'), `${f.name}: nobody has pressed Rematch yet`).toHaveCount(0);
    await expect(check(f, 'other')).toHaveCount(0);
    await expect(rematch(f)).toBeEnabled({ timeout: 15_000 });
  }
}

/** Alice has pressed Rematch: her checkmark on both screens, bob's button highlighted, nothing started. */
async function aliceWaits(stack: PlayStack, alice: Friend, bob: Friend, matchId: string, started: number): Promise<void> {
  // A launch takes a moment to reach the URL: give it the time it took in production.
  await alice.page.waitForTimeout(5_000);
  await report(stack, alice, bob, 'alice pressed Rematch, 5 s later');
  expect(matchesStarted(stack), 'no new match started on one Rematch').toBe(started);
  for (const f of [alice, bob]) {
    expect(MATCH_URL.exec(f.page.url())?.[1], `${f.name} is still on the finished match`).toBe(matchId);
    await expect(result(f), `${f.name} still sees the result screen`).toBeVisible();
  }
  await expect(check(alice, 'you'), "alice's checkmark over her own face").toBeVisible();
  await expect(check(bob, 'other'), "alice's checkmark over her face on bob's screen").toBeVisible();
  await expect(rematch(bob), "bob's Rematch is highlighted while alice waits").toHaveAttribute('data-highlight', 'true');
  await expect(rematch(alice), "alice's own button is pressed, not highlighted").toHaveAttribute('aria-pressed', 'true');
  await expect(rematch(alice)).not.toHaveAttribute('data-highlight', 'true');
  await expect(check(alice, 'other'), 'bob has not pressed').toHaveCount(0);
}

/** Bob presses too: one new match, the same on both screens, no error. */
async function bobAgrees(stack: PlayStack, alice: Friend, bob: Friend, matchId: string, started: number, errors: string[]): Promise<void> {
  await press(bob.page, 'game-result-rematch');
  for (const f of [alice, bob]) {
    await expect.poll(() => MATCH_URL.exec(f.page.url())?.[1], { message: `${f.name} reaches a new match`, timeout: 120_000 }).not.toBe(matchId);
    await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 60_000 });
    await expect(result(f), `${f.name}: the new game is not over`).toHaveCount(0);
  }
  const a = MATCH_URL.exec(alice.page.url())?.[1];
  const b = MATCH_URL.exec(bob.page.url())?.[1];
  await report(stack, alice, bob, `both pressed: alice in ${a}, bob in ${b}`);
  expect(b, 'both screens are in the same new match').toBe(a);
  expect(matchesStarted(stack), 'exactly one new match').toBe(started + 1);
  expect(errors, 'no error text on either screen').toEqual([]);
}

test(titled('after a deploy mid-match, one Rematch starts nothing: a checkmark over alice, bob highlighted; bob pressing starts one new match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await stack.restart();
    for (const f of [alice, bob]) {
      await expect(f.page.getByTestId('live-status'), `${f.name} is back in the match after the deploy`).toHaveCount(0, { timeout: 60_000 });
    }
    console.log(`[w69-rematch] deployed mid-match; ${matchId} carried on`);
    await bobConcedes(alice, bob);
    const errors: string[] = [];
    await recordErrors(alice, errors);
    await recordErrors(bob, errors);
    const started = matchesStarted(stack);

    await press(alice.page, 'game-result-rematch');
    await aliceWaits(stack, alice, bob, matchId, started);
    await bobAgrees(stack, alice, bob, matchId, started, errors);
  } finally {
    await stack.stop();
  }
});

test(titled('Rematch toggles: alice presses, takes it back, presses again; bob pressing starts one new match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await bobConcedes(alice, bob);
    const errors: string[] = [];
    await recordErrors(alice, errors);
    await recordErrors(bob, errors);
    const started = matchesStarted(stack);

    await press(alice.page, 'game-result-rematch');
    await expect(check(bob, 'other'), "alice's checkmark reaches bob").toBeVisible({ timeout: 10_000 });
    await press(alice.page, 'game-result-rematch');
    for (const f of [alice, bob]) {
      await expect(face(f, f === alice ? 'you' : 'other').getByTestId('game-result-check'), `${f.name}: alice took it back`).toHaveCount(0, { timeout: 10_000 });
    }
    await expect(rematch(bob), 'bob is no longer highlighted').not.toHaveAttribute('data-highlight', 'true');
    await report(stack, alice, bob, 'alice pressed twice');

    await press(alice.page, 'game-result-rematch');
    await aliceWaits(stack, alice, bob, matchId, started);
    await bobAgrees(stack, alice, bob, matchId, started, errors);
  } finally {
    await stack.stop();
  }
});

test(titled("alice presses Rematch, then Main menu: her checkmark and bob's highlight go, and bob leads the room"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice'); // the room's leader: she made it
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);
    await bobConcedes(alice, bob);
    const started = matchesStarted(stack);

    await press(alice.page, 'game-result-rematch');
    await expect(check(bob, 'other'), "alice's checkmark reaches bob").toBeVisible({ timeout: 10_000 });
    await expect(rematch(bob)).toHaveAttribute('data-highlight', 'true');
    await press(alice.page, 'game-result-menu');
    await expect(alice.page.getByTestId('room-create'), 'alice is on the lobby list').toBeVisible({ timeout: 15_000 });

    await expect(check(bob, 'other'), "alice's checkmark is gone from bob's screen").toHaveCount(0, { timeout: 10_000 });
    await expect(rematch(bob), "bob's highlight is gone").not.toHaveAttribute('data-highlight', 'true');
    await expect(rematch(bob), 'there is nobody left to rematch').toBeDisabled();
    await report(stack, alice, bob, 'alice left after pressing');
    expect(matchesStarted(stack), 'nothing started').toBe(started);
    expect(MATCH_URL.exec(bob.page.url())?.[1], 'bob is still on the result screen').toBe(matchId);

    // The leader left, so the room is bob's now (R16's handoff).
    await bob.page.goto(roomUrl);
    await expect(bob.page.getByTestId('constructed')).toBeVisible({ timeout: 15_000 });
    await expect(bob.page.getByTestId('format'), 'bob has the leader\'s format picker').toBeVisible({ timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});
