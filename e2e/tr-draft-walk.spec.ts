/**
 * "Testing: Draft pod — one pick left" (`games/magic/server/src/room/testing-rooms.ts`), walked as the
 * operator asked to walk it, 2026-11-19: *"something that lets me get through every single phase (one
 * pick left in draft, opponent concedes after turn1) that way i can see all of it."*
 *
 * An admin opens the seeded room from the front page and is its drafter: one card is in front of them,
 * the last of the draft. They take it, build, press Play, and enter game 1 from their table's page.
 * The AI gives the game up at the start of its second turn (`play/ai-concedes.ts`), so the board ends
 * on a win nobody pressed Concede for; the sideboard step and game 2 follow, the AI gives that up too,
 * and the pod's round 2 is paired. Real Forge throughout: the turn the server reads and the end it
 * makes of a game Forge is still playing are what this proves.
 *
 * `[draft-walk]` lines are the evidence, one per step.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import type { PodView } from '../packages/shared/src/pod.ts';

import { trimMainDeck } from './deckBuilder.ts';
import { PREFIX } from './identities.ts';
import { enabledOk, enterFromTablePage, grindPriority, makeTitled, pressIntoGame2, readyFromSideboard, resizeWindow, roomIdOfUrl, selectionOpen, serverLog } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const ROOM_NAME = 'Testing: Draft pod — one pick left';
const UI_TIMEOUT = 30_000;
/** A game the AI gives up: the opening, a turn each, and the AI's second turn beginning. */
const GAME_TIMEOUT = 4 * 60_000;
const MATCH_URL = /#\/match\/(m-[0-9a-f]{12})$/;
const say = (line: string): void => console.log(`[draft-walk] ${line}`);

interface RoomBody {
  members: { id: string; name: string }[];
  game: { pod: PodView };
}

async function roomOf(request: APIRequestContext, origin: string, roomId: string): Promise<RoomBody> {
  return (await (await request.get(`${origin}${PREFIX}/api/rooms/${roomId}`)).json()) as RoomBody;
}

/**
 * Plays the admin's seat forward until the game is over, taking nothing but what Forge asks: OK on
 * every window that offers it, and a card of their hand when a selection is open (a hand of drafted
 * spells plays no land, so each turn ends on a discard to seven).
 */
async function passUntilOver(page: Page): Promise<void> {
  const over = async (): Promise<boolean> => (await page.getByTestId('game-result').count()) > 0;
  await grindPriority([page], over, {
    timeoutMs: GAME_TIMEOUT,
    intervalMs: 100,
    press: async (p) => {
      if (await selectionOpen(p)) {
        const pickable = p.locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]').first();
        if ((await pickable.count()) > 0) await pickable.click({ timeout: 2_000 }).catch(() => undefined);
      }
      const ok = enabledOk(p);
      if ((await ok.count()) > 0) await ok.click({ timeout: 2_000 }).catch(() => undefined);
    },
  });
}

test(titled('the walk room: an admin makes the draft’s last pick, builds, and wins two games the AI gives up on its second turn'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(15 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const admin = await openFriend(browser, 'admin');
    const page = admin.page;

    /* ── the seeded room, from the front page ────────────────────────── */
    await page.goto(`${stack.origin}${PREFIX}/`);
    const row = page.getByTestId('room-row').filter({ has: page.getByTestId('room-name').getByText(ROOM_NAME, { exact: true }) });
    // Seeded after `listen`, behind the other testing rooms: the list is read again until it is there.
    await expect(async () => {
      if ((await row.count()) === 0) await page.reload();
      await expect(row).toBeVisible({ timeout: 5_000 });
    }, 'the Testing section lists the walk room for an admin').toPass({ timeout: 90_000 });
    await row.getByTestId('room-enter').click();
    await page.waitForURL(/\/room\/r-[0-9a-f]{12}/, { timeout: UI_TIMEOUT });
    const roomId = roomIdOfUrl(page.url());
    const entered = await roomOf(admin.context.request, stack.origin, roomId);
    const me = entered.members.find((m) => m.name === 'e2e-admin');
    if (me === undefined) throw new Error('the admin is not among the room’s own members');
    expect(entered.members, 'the stand-in gave its place up: the admin is the room’s one member').toHaveLength(1);
    expect(entered.game.pod.phase).toBe('drafting');
    // `useWhoami()` is how the pod knows which seat is mine; this edge serves no `/session/whoami`.
    await admin.context.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: me.id, userType: 'guest', name: 'e2e-admin' } }));
    await page.reload();
    await resizeWindow(page, { width: 1280, height: 800 });

    /* ── one pick left: the draft's last card ────────────────────────── */
    await expect(page.getByTestId('pod'), 'the draft, under way').toBeVisible({ timeout: UI_TIMEOUT });
    const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
    if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
    const pack = page.locator('[data-testid="pack"] button[data-testid="card"]');
    await expect(pack, 'one card in front of me: the last pick of the draft').toHaveCount(1, { timeout: UI_TIMEOUT });
    await pack.first().click();
    await expect(page.getByTestId('deck-editor'), 'that pick finishes the draft: the builder opens').toBeVisible({ timeout: UI_TIMEOUT });
    say(`room ${roomId}: the one pick made, the builder is open`);
    await trimMainDeck(page, 40, 'admin');

    /* ── Play → my table's page → Enter game ─────────────────────────── */
    await page.getByTestId('play-deck').click();
    await enterFromTablePage(page, MATCH_URL, UI_TIMEOUT);
    await expect(page.locator('[aria-label="Game board"]'), 'game 1').toBeVisible({ timeout: UI_TIMEOUT });
    const game1 = new URL(page.url()).hash;
    say(`entered ${game1}`);

    /* ── game 1: the AI gives it up on its second turn ───────────────── */
    await passUntilOver(page);
    await expect(page.locator('[data-testid="game-result"][data-result="victory"]'), 'game 1 is mine: the AI conceded').toBeVisible({ timeout: UI_TIMEOUT });
    const conceded = (): Record<string, unknown>[] => serverLog(stack).filter((l) => l.evt === 'ai-conceded');
    expect(conceded(), 'the server ended it for the AI, once').toHaveLength(1);
    say(`game 1 won: ai-conceded ${JSON.stringify(conceded()[0])}`);

    /* ── sideboard, then game 2 behind Enter game ────────────────────── */
    await readyFromSideboard(page);
    await pressIntoGame2(page, MATCH_URL, UI_TIMEOUT);
    await page.waitForURL((url) => MATCH_URL.test(url.toString()) && url.hash !== game1, { timeout: UI_TIMEOUT });
    await expect(page.locator('[aria-label="Game board"]'), 'game 2').toBeVisible({ timeout: UI_TIMEOUT });
    say(`entered ${new URL(page.url()).hash}`);

    /* ── game 2: given up too; the series is mine 2–0 and round 2 is paired ── */
    await passUntilOver(page);
    await expect(page.locator('[data-testid="game-result"][data-result="victory"]'), 'game 2 is mine').toBeVisible({ timeout: UI_TIMEOUT });
    expect(conceded(), 'every game of the series, not only the first').toHaveLength(2);
    expect(serverLog(stack).filter((l) => l.evt === 'concede-forced'), 'no concede was left for the watchdog').toEqual([]);
    await expect
      .poll(async () => (await roomOf(admin.context.request, stack.origin, roomId)).game.pod.round, { timeout: UI_TIMEOUT, message: 'the series is over: the pod is on round 2' })
      .toBe(2);
    const pod = (await roomOf(admin.context.request, stack.origin, roomId)).game.pod;
    const mine = pod.results.find((r) => r.round === 1 && (r.playerA === me.id || r.playerB === me.id));
    expect(mine, 'round 1 has my result').toBeDefined();
    expect(mine!.playerA === me.id ? [mine!.gamesA, mine!.gamesB] : [mine!.gamesB, mine!.gamesA], 'won 2–0').toEqual([2, 0]);
    say(`series won 2–0; round ${pod.round} of ${pod.rounds} paired`);
  } finally {
    await stack.stop();
  }
});
