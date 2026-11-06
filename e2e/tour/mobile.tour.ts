/**
 * Every screen a player can reach, at phone width (`docs/handoff/wmobile.md`). One test per area, each on
 * its own play stack; `phone.ts` measures and screenshots. A state that cannot be reached is recorded in
 * `misses.jsonl` and the tour goes on.
 */
import { test, type Page } from '@playwright/test';

import { PREFIX } from '../identities.ts';
import { clickHandCard, enabledOk, handCardNamed, offeredNamed, pressPaymentAuto, says, stackCount, twoLegalDecks } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { keepBothHands, matchUrl, readScenario } from '../play/scenario.ts';
import type { Friend } from '../play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { openCreateRoom, submitCreateRoom } from '../play/rooms.ts';
import { fillWithAi, readyPod, sitPodAt } from '../podSeats.ts';
import { inMore, longPressCard } from '../play/phone.ts';
import { attempt, expect, openPhone, shot, shotSizes } from './phone.ts';
import { choosePool, poolValue } from '../play/pool.ts';

const forge = forgeAvailability();

const at = (stack: PlayStack, hash: string): string => `${stack.origin}${PREFIX}/${hash}`;

async function go(page: Page, url: string, settle = 1_500): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(settle);
}

/**
 * Wave 89 §B moved End turn, Full control, Concede and the log toggle into `action-menu`'s own
 * popover in portrait (Settled 7) — the same test ids as before, just behind one tap to open it.
 * Open it first when it's there; an older build (no `action-menu` yet, or desktop) leaves it absent,
 * and the direct press that follows still lands exactly as it always did.
 */
async function openActionMenuIfPresent(page: Page): Promise<void> {
  const menu = page.getByTestId('action-menu');
  if ((await menu.count()) === 0) return;
  // A toggle: tapping a menu an earlier step left open would close it. It sits in the bar's ⋯ sheet.
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await (await inMore(page, 'action-menu')).tap();
}

/**
 * The settings popout, then each of its tabs: the fleet header's user button, or, in a portrait match
 * where the header is hidden, the action menu's own Settings gear.
 */
async function settingsTabs(page: Page, area: string, route: string, prefix: string): Promise<void> {
  await page.evaluate(() => {
    for (const el of [document.scrollingElement!, ...Array.from(document.querySelectorAll('*'))]) if (el.scrollTop > 0) el.scrollTop = 0;
  });
  const button = page.getByRole('button', { name: /^User settings/ }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    await openActionMenuIfPresent(page);
    await page.getByTestId('settings-gear').click();
  }
  const panel = page.locator('.settings-popout__panel, [data-testid="settings"]').first();
  await panel.waitFor({ timeout: 10_000 });
  const tabs = panel.getByRole('tab');
  const names = (await tabs.allTextContents()).map((t) => t.trim());
  console.log(`[tour] settings tabs: ${JSON.stringify(names)}`);
  if (names.length === 0) await shotSizes(page, `${prefix}-settings`, { area, route, state: 'settings popout' }, { small: true, full: true });
  for (const [i, name] of names.entries()) {
    await tabs.nth(i).click();
    await page.waitForTimeout(400);
    await shotSizes(page, `${prefix}-settings-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, { area, route, state: `settings popout — ${name} tab` }, { small: i === 0, full: true });
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

test('shell: front page, lists, settings, errors, admin and embed screens', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openPhone(browser, 'alice');
    const p = alice.page;

    await attempt('front page, empty', async () => {
      await go(p, at(stack, ''), 3_000);
      await shotSizes(p, 'front-empty', { area: 'front', route: '#/', state: 'loaded, no rooms' }, { small: true, landscape: true, full: true });
    });
    await attempt('front galleries', async () => {
      for (const gallery of ['front-upcoming', 'front-wildcard']) {
        const next = p.locator(`[data-testid="${gallery}"] [data-testid$="-next"]`).first();
        if ((await next.count()) === 0) {
          console.log(`[tour] ${gallery}: no gallery arrows`);
          continue;
        }
        await next.scrollIntoViewIfNeeded();
        await next.click();
        await shot(p, `${gallery}-flipped`, { area: 'front', route: '#/', state: `${gallery.replace('front-', '')} gallery flipped once` });
      }
    });
    await attempt('settings popout', () => settingsTabs(p, 'front', '#/', 'front'));
    await attempt('create-room dialog', async () => {
      await go(p, at(stack, ''));
      await openCreateRoom(p);
      await shotSizes(p, 'create-room', { area: 'rooms', route: '#/', state: 'create-room dialog, Constructed' }, { small: true, full: true });
      await p.getByTestId('room-create-type-draft').check();
      await shot(p, 'create-room-draft', { area: 'rooms', route: '#/', state: 'create-room dialog, Draft' }, { full: true });
      await p.keyboard.press('Escape');
    });
    await attempt('room not found', async () => {
      await go(p, at(stack, '#/room/r-000000000000'));
      await shot(p, 'room-not-found', { area: 'rooms', route: '#/room/<missing>', state: 'room not found' });
    });
    for (const [hash, id, area, state] of [
      ['#/stats', 'stats', 'stats', 'the stats Leaderboard (no games yet)'],
      ['#/profile', 'stats-profile', 'stats', 'your stats profile (no games yet)'],
      ['#/stats/e2e-bob', 'stats-other', 'stats', 'another player’s stats profile'],
      ['#/tournaments', 'tournaments', 'stats', 'past tournaments tab (empty)'],
      ['#/decks', 'decks-empty', 'decks', 'your decks, none yet'],
      ['#/inventory', 'inventory-friend', 'admin', 'imported cubes (as a friend)'],
      ['#/play', 'play', 'rooms', 'constructed #/play'],
      ['#/ui', 'ui-friend', 'admin', 'trim composer as a friend (admin only)'],
      ['#/sounds', 'sounds-friend', 'admin', 'sound builder as a friend (view only)'],
    ] as const) {
      await attempt(hash, async () => {
        await go(p, at(stack, hash));
        await shot(p, id, { area, route: hash, state }, { full: true });
      });
    }

    const admin = await openPhone(browser, 'admin');
    const a = admin.page;
    for (const [hash, id, state] of [
      ['#/sounds', 'sounds', 'sound builder'],
      ['#/sounds/sandbox', 'sounds-sandbox', 'sound sandbox'],
      ['#/sounds/music', 'sounds-music', 'match-music review'],
      ['#/ui', 'ui', 'trim composer'],
      ['#/inventory', 'inventory', 'imported cubes'],
    ] as const) {
      await attempt(`admin ${hash}`, async () => {
        await go(a, at(stack, hash), 2_500);
        await shotSizes(a, `admin-${id}`, { area: 'admin', route: hash, state, admin: true }, { small: hash === '#/sounds', full: true });
      });
    }

    await attempt('rally embed', async () => {
      for (const kind of ['draft-preset', 'set', 'cube'] as const) {
        const res = await alice.context.request.get(`${stack.origin}${PREFIX}/api/rally/options/${kind}?q=`);
        const body = (await res.json().catch(() => null)) as { suggestions?: { id: string; name?: string }[] } | null;
        const options = body?.suggestions ?? [];
        console.log(`[tour] rally ${kind}: ${res.status()} ${JSON.stringify(options.slice(0, 3))}`);
        const id = options[0]?.id;
        if (id === undefined) continue;
        for (const view of ['cards', 'pack'] as const) {
          await go(p, at(stack, `#/embed/${kind}/${encodeURIComponent(id)}/${view}`), 3_000);
          await shot(p, `embed-${kind}-${view}`, { area: 'embed', route: `#/embed/${kind}/<id>/${view}`, state: `Rally embed, ${kind} ${view}` }, { full: true });
        }
      }
    });
  } finally {
    await stack.stop();
  }
});

/** Answer whatever pre-game question is up (play or draw, keep, bottom N), shooting each the first time it shows. */
async function throughMulligan(f: Friend, label: string, seen: Set<string>): Promise<boolean> {
  const text = await says(f.page);
  const kind = /play or draw/i.test(text) ? 'play-or-draw' : /keep your hand/i.test(text) ? 'keep' : /return \d+ card/i.test(text) ? 'bottom' : null;
  if (kind === null) return false;
  if (!seen.has(`${label}:${kind}`)) {
    seen.add(`${label}:${kind}`);
    await shotSizes(f.page, `match-mulligan-${kind}-${label}`, { area: 'match', route: '#/match/<id>', state: `mulligan: ${kind.replace(/-/g, ' ')} (${label})` }, { small: label === 'alice' && kind === 'keep', landscape: label === 'alice' && kind === 'keep' });
  }
  // Alice sends her first hand back once, so the London return (a card from the hand, the dock standing on it) is seen.
  const mulligan = kind === 'keep' && label === 'alice' && !seen.has('alice:mulliganed');
  if (mulligan) seen.add('alice:mulliganed');
  // The card put back is picked once: past the return, a tap on a hand card reads it.
  if (kind === 'bottom' && !seen.has(`${label}:picked`)) {
    seen.add(`${label}:picked`);
    await f.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card] button').first().tap({ timeout: 2_000 }).catch(() => undefined);
    await f.page.waitForTimeout(400);
  }
  const button =
    kind === 'play-or-draw'
      ? f.page.getByTestId('live-play-or-draw-play')
      : kind === 'keep'
        ? f.page.locator(`[data-testid="prompt-confirm-${mulligan ? 'no' : 'yes'}"]:enabled`)
        : enabledOk(f.page);
  await button.first().click({ timeout: 2_000 }).catch(() => undefined);
  return true;
}

test('room: constructed room, a live match through the room, spectator, result, sideboard, replay', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openPhone(browser, 'alice');
    const bob = await openPhone(browser, 'bob');
    const carol = await openPhone(browser, 'carol');
    const choice = await twoLegalDecks(alice.context.request, stack.origin);

    await go(alice.page, at(stack, ''));
    await submitCreateRoom(alice.page, { name: `Friday Legacy ${Date.now() % 1000}` });
    await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = alice.page.url();
    const roomId = roomUrl.split('/room/')[1]!;
    await alice.page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    await shotSizes(alice.page, 'room-leader', { area: 'rooms', route: '#/room/<id>', state: 'constructed room, leader, default format' }, { small: true, landscape: true, full: true });

    await attempt('format switch', async () => {
      const tabs = alice.page.getByRole('tab');
      const names = (await tabs.allTextContents()).map((t) => t.trim()).filter((t) => t !== '');
      const first = ((await alice.page.locator('[role="tab"][aria-selected="true"]').first().textContent()) ?? '').trim();
      console.log(`[tour] room tabs: ${JSON.stringify(names)}; selected ${first}`);
      for (const name of names.filter((n) => /legacy|modern|vintage|pauper/i.test(n)).slice(0, 2)) {
        await alice.page.getByRole('tab', { name, exact: true }).click();
        await alice.page.waitForTimeout(1_500);
        await shot(alice.page, `room-family-${name.toLowerCase()}`, { area: 'rooms', route: '#/room/<id>', state: `format family tab: ${name}` }, { full: true });
      }
      await alice.page.getByRole('tab', { name: first, exact: true }).click();
      await alice.page.waitForTimeout(1_000);
      await choosePool(alice.page, choice.format);
      await alice.page.waitForTimeout(2_000);
      await shotSizes(alice.page, 'room-era', { area: 'rooms', route: '#/room/<id>', state: `era ${choice.format}: the deck grid` }, { small: true, full: true });
    });

    // The era the decks below are legal in, whatever the tour above left selected.
    if ((await poolValue(alice.page).catch(() => '')) !== choice.format) await choosePool(alice.page, choice.format);
    await bob.page.goto(roomUrl);
    await bob.page.getByTestId('constructed').waitFor({ timeout: 30_000 });
    await bob.page.waitForTimeout(1_500);
    await shotSizes(bob.page, 'room-joiner', { area: 'rooms', route: '#/room/<id>', state: 'constructed room, joined (format fixed by the leader)' }, { full: true });

    await attempt('deck tap / peek', async () => {
      const tile = alice.page.getByTestId('deck-mine').locator(`[data-deck-id="${choice.decks[0]}"]`);
      await tile.scrollIntoViewIfNeeded();
      await tile.hover();
      await alice.page.waitForTimeout(1_200);
      await shot(alice.page, 'room-deck-hover', { area: 'rooms', route: '#/room/<id>', state: `deck hover (peek ${(await alice.page.getByTestId('deck-peek').count()) > 0 ? 'open' : 'not shown'})` });
      await tile.tap();
      await alice.page.waitForTimeout(1_200);
      await shot(alice.page, 'room-deck-tapped', { area: 'rooms', route: '#/room/<id>', state: `deck tapped (peek ${(await alice.page.getByTestId('deck-peek').count()) > 0 ? 'open' : 'not shown'})` });
    });

    await attempt('front with a room', async () => {
      await go(carol.page, at(stack, ''), 3_000);
      await shotSizes(carol.page, 'front-rooms', { area: 'front', route: '#/', state: 'front page with an open room card' }, { small: true, full: true });
    });

    // Both decks, both ready: into the match.
    for (const [f, deck] of [[alice, choice.decks[0]], [bob, choice.decks[1]]] as const) {
      await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
      await f.page.getByTestId('ready-toggle').waitFor({ state: 'visible' });
    }
    await alice.page.getByTestId('ready-toggle').click();
    await alice.page.waitForTimeout(800);
    await shot(alice.page, 'room-ready', { area: 'rooms', route: '#/room/<id>', state: 'deck chosen, ready' }, { full: true });
    await bob.page.getByTestId('ready-toggle').click();
    const matchRe = /#\/match\/(m-[0-9a-f]{12})$/;
    await alice.page.waitForURL(matchRe, { timeout: 120_000 });
    await bob.page.waitForURL(matchRe, { timeout: 120_000 });
    const matchId = matchRe.exec(alice.page.url())![1]!;
    for (const f of [alice, bob]) await f.page.locator('[aria-label="Game board"]').waitFor({ timeout: 60_000 });

    const seen = new Set<string>();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const a = await throughMulligan(alice, 'alice', seen);
      const b = await throughMulligan(bob, 'bob', seen);
      if (!a && !b && seen.size > 0 && (await alice.page.getByTestId('live-prompt').count()) === 0) {
        await alice.page.waitForTimeout(1_500);
        if (!(await throughMulligan(alice, 'alice', seen)) && !(await throughMulligan(bob, 'bob', seen))) break;
      }
      await alice.page.waitForTimeout(400);
    }
    console.log(`[tour] mulligan states shot: ${[...seen].join(', ')}`);

    // A few real turns, so the board has something on it.
    for (let i = 0; i < 6; i++) {
      for (const f of [alice, bob]) {
        await openActionMenuIfPresent(f.page);
        await f.page.getByTestId('live-button-end-turn').click({ timeout: 8_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(800);
    }
    // The board itself, not the menu the end-turn presses left open.
    for (const f of [alice, bob]) {
      const menu = f.page.getByTestId('action-menu');
      if ((await menu.count()) > 0 && (await menu.getAttribute('aria-expanded')) === 'true') await f.page.keyboard.press('Escape');
    }
    await alice.page.waitForTimeout(400);
    await shotSizes(alice.page, 'match-board', { area: 'match', route: '#/match/<id>', state: 'a mid-game board (seat view)' }, { small: true, landscape: true });
    await shot(bob.page, 'match-board-bob', { area: 'match', route: '#/match/<id>', state: 'the other seat’s board' });

    await attempt('front with a live match', async () => {
      await go(carol.page, at(stack, ''), 4_000);
      await shotSizes(carol.page, 'front-live', { area: 'front', route: '#/', state: 'front page with a live match (featured + room card)' }, { full: true, landscape: true });
    });
    await attempt('spectator', async () => {
      await go(carol.page, at(stack, `#/match/${matchId}`), 4_000);
      await shotSizes(carol.page, 'spectator', { area: 'spectator', route: '#/match/<id>', state: 'a watcher’s view' }, { small: true, landscape: true });
    });
    await attempt('table page', async () => {
      await go(carol.page, at(stack, `#/room/${roomId}`), 3_000);
      await shot(carol.page, 'room-watcher', { area: 'spectator', route: '#/room/<id>', state: 'the room, as a non-player while a game runs' }, { full: true });
    });

    await attempt('log', async () => {
      await openActionMenuIfPresent(alice.page);
      await alice.page.getByTestId('live-log-toggle').click();
      await alice.page.waitForTimeout(600);
      await shotSizes(alice.page, 'match-log', { area: 'match', route: '#/match/<id>', state: 'the game log open' }, { landscape: true });
      await alice.page.getByTestId('live-log-toggle').click().catch(() => alice.page.keyboard.press('Escape'));
    });
    await attempt('chat sheet', async () => {
      if ((await alice.page.getByTestId('action-chat').count()) === 0) return;
      await (await inMore(alice.page, 'action-chat')).tap();
      await alice.page.waitForTimeout(700);
      await shot(alice.page, 'match-chat', { area: 'match', route: '#/match/<id>', state: 'the chat sheet open: the bar stays on the bottom edge' });
      await (await inMore(alice.page, 'action-chat')).tap();
      await alice.page.waitForTimeout(300);
    });
    await attempt('settings in a match', async () => {
      await settingsTabs(alice.page, 'match', '#/match/<id>', 'match');
    });

    await openActionMenuIfPresent(bob.page);
    await bob.page.getByTestId('live-concede').click();
    await shot(bob.page, 'match-concede-confirm', { area: 'match', route: '#/match/<id>', state: 'concede confirmation' });
    await bob.page.getByTestId('live-concede-yes').click();
    await alice.page.getByTestId('game-result').waitFor({ timeout: 30_000 });
    await alice.page.waitForTimeout(1_500);
    await shotSizes(alice.page, 'match-result-win', { area: 'match', route: '#/match/<id>', state: 'game result — winner' }, { small: true, landscape: true });
    await shot(bob.page, 'match-result-loss', { area: 'match', route: '#/match/<id>', state: 'game result — loser' });

    await attempt('sideboard step', async () => {
      for (const f of [alice, bob]) await f.page.getByTestId('game-result-rematch').click({ timeout: 10_000 });
      const next = alice.page.getByTestId('game-result-next');
      const step = alice.page.getByTestId('sideboard-step').or(alice.page.getByTestId('sideboard-ready'));
      await next.or(step).first().waitFor({ timeout: 30_000 });
      if (await next.isVisible()) await next.click();
      await step.first().waitFor({ timeout: 30_000 });
      await alice.page.waitForTimeout(1_200);
      await shotSizes(alice.page, 'sideboard', { area: 'match', route: '#/match/<id>', state: 'sideboard step (Bo3 after a rematch)' }, { small: true, landscape: true, full: true });
    });

    await attempt('replay', async () => {
      await go(carol.page, at(stack, `#/replay/${matchId}`), 4_000);
      await carol.page.getByTestId('replay-bar').waitFor({ timeout: 30_000 });
      await shotSizes(carol.page, 'replay', { area: 'spectator', route: '#/replay/<id>', state: 'replay with its transport bar' }, { small: true, landscape: true });
    });
    await attempt('stats with a game', async () => {
      await go(alice.page, at(stack, '#/stats'), 2_500);
      await shot(alice.page, 'stats-played', { area: 'stats', route: '#/stats', state: 'your stats after a game' }, { full: true });
      await go(carol.page, at(stack, ''), 3_000);
      await shot(carol.page, 'front-after', { area: 'front', route: '#/', state: 'front page after a finished match (replay card if any)' }, { full: true });
    });
  } finally {
    await stack.stop();
  }
});

/* ── scenario matches, both seats on phones ─────────────────────────────── */

async function phoneScenario(browser: import('@playwright/test').Browser, stack: PlayStack, name: string, seats: [string, string] = ['alice', 'bob']): Promise<{ alice: Friend; bob: Friend; matchId: string }> {
  const scenario = readScenario(name);
  const alice = await openPhone(browser, seats[0]);
  const bob = await openPhone(browser, seats[1]);
  const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, { data: { opponent: 'human', decks: [null, null], names: ['Alice', 'Bob'], scenario } });
  if (res.status() !== 201) throw new Error(`scenario ${name}: ${res.status()} ${await res.text()}`);
  const { matchId } = (await res.json()) as { matchId: string };
  await alice.page.goto(matchUrl(stack.origin, matchId));
  await alice.page.locator('[aria-label="Game board"]').waitFor({ timeout: 60_000 });
  await bob.page.goto(matchUrl(stack.origin, matchId));
  await bob.page.locator('[aria-label="Game board"]').waitFor({ timeout: 60_000 });
  await keepBothHands(alice, bob, /^activeplayer=ai$/m.test(scenario) ? bob : alice);
  const want = /^humanhand=(.*)$/m.exec(scenario)?.[1]?.split(';').filter((n) => n !== '')[0];
  if (want !== undefined) {
    const deadline = Date.now() + 30_000;
    while ((await handCardNamed(alice.page, want)) === undefined && Date.now() < deadline) await alice.page.waitForTimeout(200);
  }
  await alice.page.waitForTimeout(1_500);
  return { alice, bob, matchId };
}

const okOn = (page: Page) => page.locator('[data-testid="live-decision-ok"]:enabled');
async function pressIfThere(l: import('@playwright/test').Locator): Promise<void> {
  if ((await l.count()) > 0) await l.first().click({ timeout: 1_000 }).catch(() => undefined);
}
async function until(what: string, step: () => Promise<boolean>, timeout = 90_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await step())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const sheet = (page: Page) => page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();
const tiles = (page: Page) =>
  sheet(page).locator('[data-testid="prompt-cards"] > li[data-card-id]').evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
async function pick(page: Page, ids: number[]): Promise<void> {
  // A DOM click, not a tap: at phone width a long sheet leaves its tiles where a finger cannot reach (the tour's finding).
  const reached: string[] = [];
  for (const id of ids) {
    const label = sheet(page).locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"] label`);
    const box = await label.boundingBox().catch(() => null);
    reached.push(box === null ? 'none' : `${Math.round(box.y)}`);
    await label.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  console.log(`[tour] pick: tile tops ${reached.join(',')}`);
  // Only the sheet still showing these tiles: a maxed pick answers itself, and the next sheet is another question.
  await page.waitForTimeout(400);
  const done = page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .filter({ has: page.locator(ids.map((id) => `[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).join(', ')) })
    .locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled')
    .first();
  if ((await done.count()) > 0) {
    console.log(`[tour] pick: done button box ${JSON.stringify(await done.boundingBox())}`);
    await done.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
}
async function castByTap(page: Page, name: string): Promise<void> {
  let id: number | undefined;
  await until(`${name} is offered`, async () => (id = await offeredNamed(page, name)) !== undefined, 60_000);
  // On touch a tap on a hand card opens its card view, and the view's own Cast action casts it.
  await page.locator(`[data-board-card="${id}"] button`).first().tap();
  const view = page.getByTestId('card-view');
  await view.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  if (!viewed.has(name)) {
    viewed.add(name);
    await shot(page, `scn-cardview-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, { area: 'match', route: '#/match/<id>', state: `a hand card tapped: ${name}'s card view, with its Cast action` });
  }
  await view.locator('[data-testid="card-view-action"][data-verb="cast"]').tap();
}
const viewed = new Set<string>();
const face = (page: Page) => page.locator('[data-player-face]:not([data-viewer])').first();
/** The opponent's face as a target: a DOM click, since at phone width the trigger tiles can cover it (the tour's finding). */
async function faceTap(page: Page): Promise<void> {
  const target = page.locator('[data-player-face]:not([data-viewer]) button').first();
  await target.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
}

test('scenario: board, card inspector, target question, stack with arrows, sheets, game result (Valakut)', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await phoneScenario(browser, stack, 'promo-valakut');
    const page = alice.page;
    const M = (state: string) => ({ area: 'match', route: '#/match/<id>', state });
    await shotSizes(page, 'scn-board', M('a full board, own turn, main phase (scenario: 11 lands vs a Jund board)'), { small: true, landscape: true });
    await shotSizes(bob.page, 'scn-board-opp', M('the same board from the waiting seat'), { landscape: true });

    await attempt('the action menu open', async () => {
      await (await inMore(page, 'action-menu')).tap();
      await page.waitForTimeout(500);
      await shot(page, 'scn-bar-menu', M('the action menu open: the bar stays on the bottom edge'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }, page);

    await attempt('a lane with hidden cards both ways', async () => {
      const lands = page.getByTestId('lane-my-lands');
      await lands.evaluate((el) => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      });
      await page.waitForTimeout(400);
      await shot(page, 'scn-lane-chevrons', M('my lands scrolled to the middle: a ‹ and a › on the lane’s edges'));
      await lands.evaluate((el) => {
        el.scrollLeft = 0;
      });
    }, page);

    await attempt('a tap on a permanent, a long press reads it', async () => {
      // On a permanent a tap is the card's own click: my Forest taps for mana, no card view.
      let forest: number | undefined;
      await until('a Forest is offered', async () => (forest = await offeredNamed(page, 'Forest')) !== undefined, 20_000);
      await page.locator(`[data-board-card="${forest}"] button`).first().tap();
      await page.waitForTimeout(900);
      await shot(page, 'scn-perm-tap', M('a tap on my own Forest: it taps for mana, no card view'));
      // A long press is how a permanent is read.
      const goyf = await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]').evaluateAll(
        (els) => els.find((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Tarmogoyf')?.getAttribute('data-board-card') ?? null,
      );
      if (goyf === null) throw new Error('no Tarmogoyf on the opponent’s side');
      await longPressCard(page, Number(goyf));
      await page.getByTestId('card-view').waitFor({ timeout: 5_000 });
      await page.waitForTimeout(400);
      await shot(page, 'scn-perm-read', M('a long press on the opponent’s Tarmogoyf: the card view'));
      await page.getByTestId('card-view').tap({ position: { x: 8, y: 8 } });
      await page.waitForTimeout(500);
    }, page);

    await attempt('target question + stack arrow', async () => {
      await castByTap(page, 'Lightning Bolt');
      let shotTarget = false;
      let shotPay = false;
      await until('Bolt is on the stack', async () => {
        if (!shotPay && (await page.getByTestId('live-payment-ok').count()) > 0) {
          shotPay = true;
          await page.waitForTimeout(500);
          await shot(page, 'scn-pay', M('a mana payment, docked over the hand (Lightning Bolt)'));
        }
        await pressPaymentAuto(page);
        if (/target/i.test(await says(page)) && !shotTarget) {
          shotTarget = true;
          await shotSizes(page, 'scn-target', M('a target question (Lightning Bolt)'), { small: true, landscape: true });
          await face(page).click({ timeout: 2_000 }).catch(() => undefined);
        }
        return (await stackCount(page)) > 0;
      });
      await page.waitForTimeout(800);
      await shotSizes(page, 'scn-stack-one', M('one spell on the stack with its arrow (caster)'), { landscape: true });
      await shotSizes(bob.page, 'scn-decision', M('the decision card: opponent holds priority over the Bolt'), { small: true, landscape: true });
      // The opponent's life: on its seat chip in portrait, in its seat on a wider screen.
      const life = page.locator('[data-testid="seat-chip-opp"] [data-testid="life"], .seat:not([data-viewer]) [data-testid="life"]').first();
      await until('the Bolt resolves', async () => {
        await pressIfThere(okOn(bob.page));
        if ((await stackCount(page)) > 0) await pressIfThere(okOn(page));
        return (await stackCount(page)) === 0 && (await life.textContent()) !== '20';
      }, 60_000);
    }, page);

    await attempt('Scapeshift sheets', async () => {
      await castByTap(page, 'Scapeshift');
      let shotConfirm = false;
      await until('the sacrifice sheet', async () => {
        if ((await tiles(page)).length >= 11) return true;
        await pressPaymentAuto(page);
        if (!shotConfirm && (await page.locator('[data-testid="prompt-confirm-yes"]:enabled').count()) > 0) {
          shotConfirm = true;
          await page.waitForTimeout(500);
          await shot(page, 'scn-confirm', M('a yes/no question, docked over the hand (Scapeshift: sacrifice?)'));
        }
        await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
        await pressIfThere(okOn(bob.page));
        return false;
      });
      await page.waitForTimeout(600);
      await shotSizes(page, 'scn-sheet-sacrifice', M('a selection sheet: sacrifice any number of lands (11 tiles)'), { small: true, landscape: true });
      await pick(page, (await tiles(page)).map((t) => t.id));
      await until('the search sheet', async () => {
        if ((await tiles(page)).some((t) => /Valakut/.test(t.text))) return true;
        await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
        await pressIfThere(okOn(bob.page));
        return false;
      });
      await page.waitForTimeout(600);
      await shotSizes(page, 'scn-sheet-search', M('a library search sheet (pick Valakut and ten Mountains)'), { landscape: true });
      const library = await tiles(page);
      await pick(page, [...library.filter((t) => /Valakut/.test(t.text)), ...library.filter((t) => t.text.startsWith('Mountain'))].map((t) => t.id));
    }, page);

    await attempt('Valakut target sheet + stack of triggers', async () => {
      const same = page.getByTestId('live-same-target');
      await until('the first Valakut target question', async () => {
        const text = await says(page);
        if (/Valakut/.test(text) && (await same.count()) > 0) return true;
        await answerPrompt(page).catch(() => null);
        await pressIfThere(okOn(bob.page));
        return false;
      });
      await page.waitForTimeout(700);
      await shotSizes(page, 'scn-target-sheet', M('the target sheet with "same target for all" (ten Valakut triggers)'), { small: true, landscape: true });
      await same.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      await shot(page, 'scn-target-sheet-checked', M('"same target for all" ticked: the triggers waiting for a target'));
      await faceTap(page);
      await until('several triggers on the stack', async () => {
        if ((await stackCount(page)) >= 3) return true;
        await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
        if (/Valakut/.test(await says(page))) await faceTap(page);
        return false;
      }, 60_000);
      await page.waitForTimeout(900);
      await shotSizes(page, 'scn-stack-many', M('a deep stack of triggers, each with an arrow'), { small: true, landscape: true });
      await shot(bob.page, 'scn-stack-many-opp', M('the deep stack from the target’s seat'));
      await attempt('stack expanded', async () => {
        // Portrait's stack is its chip in the top band; a wider screen's is the stack zone.
        const zone = page.locator('[data-testid="stack-chip"], [data-zone="stack"]').first();
        await zone.tap();
        await page.waitForTimeout(800);
        await shot(page, 'scn-stack-tapped', M('the stack tapped'));
      });
    }, page);

    await attempt('game result after lethal', async () => {
      await until('a result', async () => {
        if ((await page.getByTestId('game-result').count()) > 0) return true;
        await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
        if (/Valakut/.test(await says(page))) await faceTap(page);
        for (const p of [page, bob.page]) await pressIfThere(okOn(p));
        return false;
      }, 150_000);
      await page.waitForTimeout(1_500);
      await shot(page, 'scn-result', M('game result after a lethal stack (Bo1, no room)'));
      await shot(bob.page, 'scn-result-opp', M('game result, the losing seat'));
    }, page);
  } finally {
    await stack.stop();
  }
});

test('scenario2: combat blocks, mistake bubble', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const M = (state: string) => ({ area: 'match', route: '#/match/<id>', state });
    await attempt('mistake bubble', async () => {
      const { alice, bob } = await phoneScenario(browser, stack, 'af409-second-land');
      const forest = await handCardNamed(alice.page, 'Forest');
      const mountain = await handCardNamed(alice.page, 'Mountain');
      await clickHandCard(alice.page, forest!);
      await until('the Forest lands', async () => (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').count()) > 0, 20_000);
      await clickHandCard(alice.page, mountain!);
      await alice.page.locator('[data-testid="mistake-bubble"]').waitFor({ timeout: 10_000 });
      await shotSizes(alice.page, 'scn-mistake', M('the mistake bubble (a second land this turn)'), { small: true, landscape: true });
      await alice.context.close();
      await bob.context.close();
    });
    await attempt('a big board', async () => {
      // Five lands, seven creatures and tokens a side (two Soldiers alike): lands behind, the rest in front, the tokens stacked.
      const { alice, bob } = await phoneScenario(browser, stack, 'tr-bigboard');
      await alice.page.waitForTimeout(800);
      await shot(alice.page, 'scn-bigboard', M('a big board: nonlands in front, lands behind, the two Soldier tokens one pile'));
      await alice.context.close();
      await bob.context.close();
    });
    await attempt('combat', async () => {
      const { alice, bob } = await phoneScenario(browser, stack, 'w54-b-two-blockers');
      await until('the block window', async () => {
        if (/block/i.test(await says(alice.page))) return true;
        await pressIfThere(okOn(bob.page));
        await answerPrompt(bob.page).catch(() => null);
        return false;
      }, 90_000);
      await alice.page.waitForTimeout(800);
      await shotSizes(alice.page, 'scn-combat-block', M('combat: declare blockers, two attackers coming'), { small: true, landscape: true });
      await shotSizes(bob.page, 'scn-combat-attacker', M('combat from the attacking seat'), { landscape: true });
      const blocker = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card][data-selectable]').first();
      if ((await blocker.count()) > 0) {
        await blocker.tap({ timeout: 3_000 }).catch(() => undefined);
        await alice.page.waitForTimeout(800);
        await shot(alice.page, 'scn-combat-blocker-picked', M('combat: a blocker picked (pick its attacker)'));
      }
      const minimize = alice.page.getByTestId('decision-minimize');
      if ((await minimize.count()) > 0) {
        await minimize.tap({ timeout: 3_000 });
        await alice.page.waitForTimeout(600);
        await shot(alice.page, 'scn-combat-pill', M('combat: the decision shrunk to a pill'));
        await alice.page.getByTestId('decision-pill').tap({ timeout: 3_000 });
      }
    });
  } finally {
    await stack.stop();
  }
});

/* ── Gauntlet, tournaments, drafts ─────────────────────────────────────── */

async function api<T>(stack: PlayStack, f: Friend, method: 'POST' | 'PATCH' | 'GET', path: string, data?: unknown): Promise<T> {
  const res = await f.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, ...(method === 'GET' ? {} : { data: data ?? {} }) });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

test('gauntlet: reveal, ban and pick on a phone, result', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openPhone(browser, 'alice');
    const page = alice.page;
    const G = (state: string) => ({ area: 'gauntlet', route: '#/room/<id>', state });
    const { id: roomId } = await api<{ id: string }>(stack, alice, 'POST', '/rooms', { name: `Gauntlet night ${Date.now() % 1000}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    await go(page, at(stack, `#/room/${roomId}`), 2_000);
    await shotSizes(page, 'gauntlet-room', G('Gauntlet room before ready'), { small: true, full: true });
    await api(stack, alice, 'POST', `/tables/rooms/${roomId}/sit`, {});
    await api(stack, alice, 'POST', `/tables/rooms/${roomId}/gauntlet/ready`, { ready: true, ai: true });
    await attempt('reveal', async () => {
      await page.getByTestId('gauntlet-title').waitFor({ timeout: 30_000 });
      await shot(page, 'gauntlet-reveal', G('the reveal: era title, decks falling in'), { settle: 300 });
      await page.locator('[data-testid="gauntlet"]:not([data-revealing])').waitFor({ timeout: 30_000 });
      await shotSizes(page, 'gauntlet-board', G('pick/ban board after the reveal'), { small: true, landscape: true, full: true });
    }, page);
    await attempt('ban and pick', async () => {
      const banner = page.getByTestId('gauntlet-turn');
      let acts = 0;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && (await page.getByTestId('gauntlet-pool').count()) > 0) {
        if ((await banner.getAttribute('data-you').catch(() => null)) === 'true') {
          const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
          if ((await open.count()) === 0) break;
          const verb = ((await banner.textContent()) ?? '').trim();
          await open.tap();
          acts += 1;
          await page.waitForTimeout(900);
          if (acts <= 2) await shot(page, `gauntlet-act-${acts}`, G(`after a ${/ban/i.test(verb) ? 'ban' : 'pick'} (tapped): ${verb.slice(0, 40)}`), { full: true });
        }
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1_500);
      await shotSizes(page, 'gauntlet-result', G('the Gauntlet once every ban and pick is made'), { small: true, full: true });
    }, page);
  } finally {
    await stack.stop();
  }
});

test('tournament: lobby, face-off, hub and bracket, standings', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openPhone(browser, 'alice');
    const bob = await openPhone(browser, 'bob');
    const T = (route: string, state: string) => ({ area: 'tournament', route, state });
    await go(alice.page, at(stack, ''));
    const { id: roomId } = await api<{ id: string }>(stack, alice, 'POST', '/rooms', { name: `Sunday cup ${Date.now() % 1000}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    await api(stack, alice, 'PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } });
    await api(stack, bob, 'POST', `/rooms/${roomId}/join`);
    await api(stack, alice, 'POST', `/rooms/${roomId}/pod/sit`, { seat: 0 });
    await api(stack, bob, 'POST', `/rooms/${roomId}/pod/sit`, { seat: 1 });
    for (const seat of [2, 3]) await api(stack, alice, 'POST', `/rooms/${roomId}/pod/ai`, { seat, on: true });
    await go(alice.page, at(stack, `#/room/${roomId}`), 2_500);
    await shotSizes(alice.page, 'tourney-lobby', T('#/room/<id>', 'tournament lobby: four seats, two AI'), { small: true, landscape: true, full: true });
    await attempt('match rules popover', async () => {
      await alice.page.getByTestId('match-rules').tap();
      await alice.page.waitForTimeout(600);
      await shot(alice.page, 'tourney-rules', T('#/room/<id>', 'the leader’s Match rules popover'), { full: true });
      await alice.page.getByTestId('match-rules-popover-close').tap();
    }, alice.page);
    await api(stack, bob, 'POST', `/rooms/${roomId}/ready`, { ready: true });
    await alice.page.getByTestId('ready-toggle').tap();
    await attempt('face-off', async () => {
      await alice.page.getByTestId('table-seats').waitFor({ timeout: 30_000 });
      await shot(alice.page, 'tourney-faceoff-reveal', T('#/room/<id>/table/<t>', 'face-off, mid reveal'), { settle: 200 });
      await alice.page.locator('[data-testid="table-seats"]:not([data-revealing])').waitFor({ timeout: 30_000 });
      await shotSizes(alice.page, 'tourney-faceoff', T('#/room/<id>/table/<t>', 'the table page: face-off at rest'), { small: true, landscape: true, full: true });
    }, alice.page);
    await attempt('table ready → gauntlet box', async () => {
      await alice.page.getByTestId('ready-toggle').tap();
      await alice.page.getByTestId('tournament-gauntlet').waitFor({ timeout: 30_000 });
      await alice.page.waitForTimeout(1_500);
      await shotSizes(alice.page, 'tourney-table-gauntlet', T('#/room/<id>/table/<t>', 'the table page after Ready: its Gauntlet box'), { small: true, full: true });
    }, alice.page);
    await attempt('hub', async () => {
      await alice.page.getByTestId('table-hub').tap();
      await alice.page.getByTestId('pod-tables-row').first().waitFor({ timeout: 30_000 });
      await alice.page.waitForTimeout(1_500);
      await shotSizes(alice.page, 'tourney-hub', T('#/room/<id>', 'the hub: table strips and bracket'), { small: true, landscape: true, full: true });
      const more = alice.page.locator('[data-testid="pod-tables"] button', { hasText: '⋯' }).first();
      if ((await more.count()) > 0) {
        await more.tap();
        await alice.page.waitForTimeout(600);
        await shot(alice.page, 'tourney-hub-more', T('#/room/<id>', 'a table strip’s ⋯ menu'));
        await alice.page.keyboard.press('Escape');
      }
    }, alice.page);
    await attempt('bob’s table', async () => {
      await go(bob.page, at(stack, `#/room/${roomId}`), 3_000);
      await shot(bob.page, 'tourney-bob', T('#/room/<id>', 'the other human entrant’s view'), { full: true });
    }, bob.page);

    // Standings: a second, two-human Classic tournament settled by concession (`e2e/tournament.spec.ts`'s path).
    await attempt('standings', async () => {
      const { id: r2 } = await api<{ id: string }>(stack, alice, 'POST', '/rooms', { name: `Quick cup ${Date.now() % 1000}`, gameType: 'constructed-1v1', mode: 'classic' });
      await api(stack, alice, 'PATCH', `/rooms/${r2}`, { settings: { tournament: true } });
      await api(stack, bob, 'POST', `/rooms/${r2}/join`);
      const url = at(stack, `#/room/${r2}`);
      for (const [f, seat] of [[alice, 0], [bob, 1]] as const) {
        await go(f.page, url, 2_000);
        await sitPodAt(f.page, seat);
        await f.page.getByTestId('seat-stand').waitFor({ timeout: 30_000 });
        await f.page.getByTestId('deck-mine').getByTestId('deck-option').first().tap();
        await f.page.locator('[data-testid="ready-toggle"]:enabled').waitFor({ timeout: 30_000 });
      }
      await shot(alice.page, 'tourney2-lobby-deck', T('#/room/<id>', 'Classic tournament lobby, deck chosen'), { full: true });
      for (const f of [alice, bob]) await f.page.getByTestId('ready-toggle').tap();
      const matchRe = /#\/match\/m-[0-9a-f]{12}$/;
      for (const f of [alice, bob]) await f.page.waitForURL(matchRe, { timeout: 60_000 });
      for (let game = 0; game < 2; game++) {
        await openActionMenuIfPresent(bob.page);
        await bob.page.getByTestId('live-concede').tap();
        await bob.page.getByTestId('live-concede-yes').tap();
        await alice.page.getByTestId('game-result').waitFor({ timeout: 30_000 });
        if (game === 1) break;
        for (const f of [alice, bob]) {
          await f.page.getByTestId('game-result-next').tap({ timeout: 30_000 });
          await f.page.getByTestId('sideboard-ready').waitFor({ timeout: 30_000 });
        }
        await shot(alice.page, 'tourney2-sideboard', T('#/match/<id>', 'tournament Bo3: the sideboard step between games'), { full: true });
        for (const f of [alice, bob]) await f.page.getByTestId('sideboard-ready').tap();
        for (const f of [alice, bob]) await f.page.waitForURL(matchRe, { timeout: 60_000 });
        await alice.page.locator('[aria-label="Game board"]').waitFor({ timeout: 60_000 });
      }
      await go(alice.page, url, 3_000);
      await alice.page.getByTestId('pod-standings').waitFor({ timeout: 30_000 });
      await shotSizes(alice.page, 'tourney2-standings', T('#/room/<id>', 'standings after the round'), { small: true, landscape: true, full: true });
      await go(alice.page, at(stack, '#/tournaments'), 2_500);
      await shot(alice.page, 'tournaments-played', T('#/tournaments', 'past tournaments after one'), { full: true });
    }, alice.page);
  } finally {
    await stack.stop();
  }
});

test('draft: nine-seat lobby, split, the draft, deck building, decks', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openPhone(browser, 'alice');
    const bob = await openPhone(browser, 'bob');
    const D = (route: string, state: string) => ({ area: 'draft', route, state });
    await go(alice.page, at(stack, ''));
    await submitCreateRoom(alice.page, { name: `Cube night ${Date.now() % 1000}`, gameType: 'draft' });
    await alice.page.waitForURL(/#\/room\//, { timeout: 30_000 });
    const roomId = alice.page.url().split('/room/')[1]!;
    await alice.page.getByTestId('draft-lobby').waitFor({ timeout: 30_000 });
    await alice.page.waitForTimeout(1_500);
    await shotSizes(alice.page, 'draft-lobby', D('#/room/<id>', 'draft pod lobby, leader, empty seats'), { small: true, landscape: true, full: true });
    await attempt('pick timer', async () => {
      const rule = alice.page.getByTestId('pick-timer');
      await rule.tap();
      await alice.page.getByTestId('pick-timer-speed').locator('input[value="4"]').evaluate((el) => (el as HTMLElement).click());
      await alice.page.waitForTimeout(800);
      await shot(alice.page, 'draft-timer-on', D('#/room/<id>', 'pick timer on, fastest speed'), { full: true });
    }, alice.page);
    await go(bob.page, at(stack, `#/room/${roomId}`), 2_000);
    await sitPodAt(alice.page, 0);
    await sitPodAt(bob.page, 1);
    for (let i = 3; i <= 9; i++) {
      const name = `drafter${i}`;
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'cardtable_e2e_session', value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
      for (const [path, data] of [['join', {}], ['pod/sit', {}], ['ready', { ready: true }]] as const) {
        const res = await ctx.request.post(`${stack.origin}${PREFIX}/api/rooms/${roomId}/${path}`, { data });
        if (!res.ok()) throw new Error(`${name} ${path}: ${res.status()}`);
      }
    }
    await alice.page.getByTestId('pod-seat-8').waitFor({ timeout: 30_000 });
    await alice.page.waitForTimeout(1_500);
    await shotSizes(alice.page, 'draft-nine', D('#/room/<id>', 'nine seated: one list of seats'), { small: true, landscape: true, full: true });
    await shot(bob.page, 'draft-nine-bob', D('#/room/<id>', 'nine seated, a non-leader'), { full: true });
    await readyPod(bob.page);
    await readyPod(alice.page);
    await attempt('split', async () => {
      await alice.page.getByTestId('pod-split').waitFor({ timeout: 30_000 });
      await shot(alice.page, 'draft-split-ready', D('#/room/<id>', 'everyone ready: Split & randomize'), { full: true });
      await alice.page.getByTestId('pod-split').tap();
      await alice.page.getByTestId('pod-split-pods').waitFor({ timeout: 30_000 });
      await alice.page.waitForTimeout(1_000);
      await shotSizes(alice.page, 'draft-split', D('#/room/<id>', 'split into pods: Start draft'), { small: true, full: true });
      await shot(bob.page, 'draft-split-bob', D('#/room/<id>', 'split into pods, a non-leader'), { full: true });
      await alice.page.getByTestId('pod-split-start').tap();
    }, alice.page);
    await attempt('the draft', async () => {
      await alice.page.getByTestId('pod').waitFor({ timeout: 30_000 });
      await alice.page.locator('[data-testid="pack"] button[data-testid="card"]').first().waitFor({ timeout: 30_000 });
      await alice.page.waitForTimeout(1_500);
      await shotSizes(alice.page, 'draft-pack', D('#/room/<id>', 'the draft: first pack (default layout)'), { small: true, landscape: true, full: true });
      const grid = alice.page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
      if ((await grid.count()) > 0) {
        await grid.tap();
        await alice.page.waitForTimeout(800);
        await shotSizes(alice.page, 'draft-pack-grid', D('#/room/<id>', 'the draft: pack as a grid'), { landscape: true, full: true });
      }
      await alice.page.getByTestId('pick-rope').waitFor({ timeout: 30_000 });
      await shot(alice.page, 'draft-rope', D('#/room/<id>', 'the pick timer’s rope, last third of a pick'), { settle: 100 });
      for (let n = 0; n < 3; n++) {
        const card = alice.page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
        await card.waitFor({ timeout: 30_000 });
        await card.tap();
        await alice.page.waitForTimeout(700);
      }
      await shotSizes(alice.page, 'draft-pool', D('#/room/<id>', 'the draft a few picks in (pool growing)'), { full: true });
    }, alice.page);
    await alice.context.close();
    await bob.context.close();

    // Deck building: a solo pod (alice and seven bots), drafted to the end.
    const solo = await openPhone(browser, 'carol');
    await attempt('deck building', async () => {
      const p = solo.page;
      await go(p, at(stack, ''));
      await submitCreateRoom(p, { name: `Solo cube ${Date.now() % 1000}`, gameType: 'draft' });
      await p.getByTestId('draft-lobby').waitFor({ timeout: 30_000 });
      await sitPodAt(p, 0);
      await readyPod(p);
      await fillWithAi(p, 30_000);
      const deadline = Date.now() + 8 * 60_000;
      while (!p.url().includes('#/deck/') && Date.now() < deadline) {
        const card = p.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
        if ((await card.count()) > 0) await card.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
        await p.waitForTimeout(450);
      }
      await p.getByTestId('deck-editor').waitFor({ timeout: 60_000 });
      await p.waitForTimeout(2_000);
      await shotSizes(p, 'deck-editor', D('#/deck/<id>', 'deck building after the draft'), { small: true, landscape: true, full: true });
      const draftId = p.url().split('#/deck/')[1]!;
      await go(p, at(stack, '#/decks'), 2_000);
      await shotSizes(p, 'decks-list', D('#/decks', 'your decks, one drafted'), { small: true, full: true });
      await go(p, at(stack, `#/decks/${draftId}`), 2_500);
      await shot(p, 'decks-edit', D('#/decks/<id>', 'that deck in the editor, outside any game'), { full: true });
      await go(p, at(stack, `#/room/${draftId}`), 2_500);
      await shot(p, 'draft-room-after', D('#/room/<id>', 'the pod’s room after the draft'), { full: true });
    }, solo.page);
  } finally {
    await stack.stop();
  }
});

test('rope: the draft pick timer on a phone', async ({ browser }) => {
  if (!forge.ok) throw new Error(forge.reason);
  const stack = await startPlayStack(forge);
  try {
    const f = await openPhone(browser, 'carol');
    const p = f.page;
    const D = (state: string) => ({ area: 'draft', route: '#/room/<id>', state });
    await go(p, at(stack, ''));
    await submitCreateRoom(p, { name: `Timed cube ${Date.now() % 1000}`, gameType: 'draft' });
    await p.getByTestId('draft-lobby').waitFor({ timeout: 30_000 });
    const rule = p.getByTestId('pick-timer');
    await rule.waitFor({ timeout: 30_000 });
    await rule.click();
    await expect(rule).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    const speed = p.getByTestId('pick-timer-speed').locator('input[value="4"]');
    await speed.click({ force: true });
    await expect(speed).toBeChecked({ timeout: 15_000 });
    await shot(p, 'draft-timer-on', D('pick timer on, fastest speed'), { full: true });
    await sitPodAt(p, 0);
    await readyPod(p);
    await fillWithAi(p, 30_000);
    await attempt('rope', async () => {
      await p.getByTestId('pick-rope').waitFor({ timeout: 40_000 });
      await p.waitForTimeout(600);
      await shotSizes(p, 'draft-rope', D('the pick timer’s rope, last third of a pick'), { landscape: true });
      for (let n = 0; n < 4; n++) {
        const card = p.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first();
        await card.waitFor({ timeout: 30_000 });
        await card.tap();
        await p.waitForTimeout(900);
      }
      await shot(p, 'draft-pool', D('the draft a few picks in (pool growing)'), { full: true });
    }, p);
  } finally {
    await stack.stop();
  }
});
