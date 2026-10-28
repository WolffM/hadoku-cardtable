/**
 * Seats and watchers at a two-seat table with more than two people in the room
 * (`docs/requests/WATCHPARTY_SEATS_AND_SPECTATORS.md`, 2026-10-12).
 *
 * 1. The lobby: sitting is its own action, a seat can be given back before the
 *    match, and a third person with the table full is told they are watching.
 * 2. The match: the third person sees the game live with no game controls,
 *    and — the operator, 2026-10-28: *"the spectator impersonates the view of
 *    the active player … with the small added benefit of seeing the hidden
 *    cards"* — both hands face up, and on the wire no library card that no
 *    player was shown. Their input is dropped by the server.
 * 3. The board follows both seats and the turn: whoever's turn it is is at the
 *    bottom, and where each player puts their own cards is where the watcher
 *    sees them. (The first party, 2026-10-12: *"card placement on board doesnt
 *    update as players move things around"* — every echo went to the top side.)
 * 4. What the active player is shown, the watcher is shown: Goblin Guide's
 *    reveal reaches the watcher, and the card under it never does.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { messages, openFriend, type Friend } from './play/browser.ts';
import { enterMatch, grindPriority, pressOffered, resizeWindow, serverLog } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { unseenNamed } from './play/isolation.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { matchUrl, startScenarioMatch } from './play/scenario.ts';
import { connectSio } from './play/sio.ts';

test.describe.configure({ mode: 'serial' });

const PREFIX = '/cardtable';
/**
 * Every card face in what a socket was sent. A face is a tracked object whose
 * `_type` is not a player's (1 — players carry a `Name` too) with a `Name`,
 * which Forge sends TYPED (`{ t: 'str', v }`, `packages/forge-wire/src/tier-c.ts`)
 * and a fixture may send plain, or a card a game log line names (`message`'s
 * `log.cards`). Walked, not grepped: a string match for `"Name":"…"` cannot see
 * a typed value and so could never fail.
 */
function faceNames(payloads: unknown[]): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.method === 'message' && typeof o.log === 'object' && o.log !== null) {
      for (const c of (o.log as { cards?: { name?: unknown }[] }).cards ?? []) if (typeof c.name === 'string') names.push(c.name);
    }
    if ('Name' in o && o._type !== 1) {
      const n = o.Name;
      const v = typeof n === 'string' ? n : typeof n === 'object' && n !== null && typeof (n as { v?: unknown }).v === 'string' ? (n as { v: string }).v : null;
      if (v !== null) names.push(v);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(payloads);
  return names;
}

const forge = forgeAvailability();

const seatSit = (page: Page) => page.getByTestId('seat-sit');
const seatStand = (page: Page) => page.getByTestId('seat-stand');
const viewerName = (page: Page) => page.locator('[data-testid="player"][data-viewer] .face__name');
/** The battlefield cards of one side, in DOM order. */
const fieldOrder = (page: Page, side: 'you' | 'them'): Promise<number[]> =>
  page
    .locator(`${side === 'you' ? '.seat[data-viewer]' : '.seat:not([data-viewer])'} [data-zone="battlefield"] li.board-card[data-card-id]`)
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
const gaps = (page: Page, side: 'you' | 'them') => page.locator(`${side === 'you' ? '.seat[data-viewer]' : '.seat:not([data-viewer])'} [data-zone="battlefield"] li.zone__gap`);

async function createConstructedRoom(alice: Friend, origin: string): Promise<string> {
  await alice.page.goto(`${origin}${PREFIX}/`);
  await submitCreateRoom(alice.page, { name: `e2e seats ${Date.now()}` });
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  return alice.page.url();
}

/* ── 1. the lobby ───────────────────────────────────────────────────── */

test('a seat is taken and given back on purpose; the third person with the table full is watching', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const carol = await openFriend(browser, 'carol');
    const roomUrl = await createConstructedRoom(alice, stack.origin);
    for (const f of [bob, carol]) {
      await f.page.goto(roomUrl);
      await expect(f.page.getByTestId('constructed'), `${f.name} is in the room`).toBeVisible({ timeout: 30_000 });
    }
    // Two empty seats, each with its own Sit here, for everyone.
    await expect(seatSit(carol.page), 'two empty seats offer Sit here').toHaveCount(2);
    await expect(seatStand(carol.page), 'nobody unseated has Stand up').toHaveCount(0);

    // Carol sits: her row holds the seat, she may stand, nobody may sit in it.
    await seatSit(carol.page).first().click();
    await expect(seatStand(carol.page), 'carol holds a seat').toBeVisible({ timeout: 15_000 });
    await expect(seatSit(carol.page), 'the other seat is drawn, and a seated player cannot take it').toHaveCount(1);
    await expect(seatSit(carol.page)).toBeDisabled();
    await expect(seatSit(alice.page), 'one seat left for alice').toHaveCount(1, { timeout: 15_000 });
    await expect(carol.page.getByTestId('deck-mine'), 'the deck picker appears once seated').toBeVisible();

    // Carol stands: the seat is free again.
    await seatStand(carol.page).click();
    await expect(seatSit(alice.page), 'both seats free again').toHaveCount(2, { timeout: 15_000 });
    await expect(seatSit(carol.page)).toHaveCount(2);

    // Alice and bob sit; carol is the third person and is told so.
    await seatSit(alice.page).first().click();
    await expect(seatStand(alice.page)).toBeVisible({ timeout: 15_000 });
    await seatSit(bob.page).first().click();
    await expect(seatStand(bob.page)).toBeVisible({ timeout: 15_000 });
    await expect(seatSit(carol.page), 'no seat left').toHaveCount(0, { timeout: 15_000 });
    await expect(carol.page.getByTestId('room-spectator')).toBeVisible();
    await expect(carol.page.getByTestId('deck-mine'), 'no deck picker for the unseated').toHaveCount(0);

    // The server, not the button, is the refusal: a third sit with the table full is a 409.
    const res = await carol.context.request.post(`${stack.origin}${PREFIX}/api/tables/rooms/${roomUrl.split('/room/')[1]}/sit`, { data: {} });
    expect(res.status(), 'a third sit is refused by the server').toBe(409);
  } finally {
    await stack.stop();
  }
});

/* ── 2. the match ───────────────────────────────────────────────────── */

test('a third person watches the match with no controls, sees both hands, and no library card reaches them on the wire', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId, roomUrl } = await enterMatch(alice, bob, stack.origin);
    await expect(alice.page.getByTestId('live-says')).toContainText(/play or draw/i, { timeout: 30_000 });

    // The seats are locked once the match is live.
    const roomId = roomUrl.split('/room/')[1];
    const stand = await alice.context.request.post(`${stack.origin}${PREFIX}/api/tables/rooms/${roomId}/stand`, { data: {} });
    expect(stand.status(), 'a player cannot stand up mid-match').toBe(409);

    // Carol arrives at the room and is carried to the match, as a watcher.
    const carol = await openFriend(browser, 'carol');
    await carol.page.goto(roomUrl);
    await carol.page.waitForURL(new RegExp(`#/match/${matchId}$`), { timeout: 60_000 });
    await expect(carol.page.locator('[aria-label="Game board"]'), 'a board, not a refusal').toBeVisible({ timeout: 30_000 });
    await expect(carol.page.locator('.live[data-role="watcher"]'), 'the board root says watcher').toBeVisible({ timeout: 30_000 });
    await expect(carol.page.getByTestId('watcher-status')).toBeVisible();
    for (const id of ['live-concede', 'live-button-end-turn', 'live-play-or-draw-play']) {
      await expect(carol.page.getByTestId(id), `${id} is not drawn for a watcher`).toHaveCount(0);
    }
    await expect(carol.page.getByTestId('player'), 'both seats are drawn').toHaveCount(2);
    await expect(carol.page.getByTestId('perspective-flip'), 'the table follows the turn: nothing to flip').toHaveCount(0);

    // The payload: what a watcher's socket is actually sent.
    const raw = await connectSio(stack.origin, 'carol');
    try {
      const roles: unknown[] = [];
      const frames: unknown[] = [];
      raw.on('forge:role', (p) => roles.push(p));
      raw.on('forge:s2c', (p) => frames.push(p));
      const ack = (await raw.request('forge:join', { matchId })) as Record<string, unknown>;
      expect(ack, 'the join is a snapshot, not a refusal').not.toHaveProperty('error');
      expect(ack.seat, 'oriented by seat 0').toBe(0);
      await expect.poll(() => roles, { timeout: 10_000 }).toContainEqual({ matchId, role: 'watcher' });
      await carol.page.waitForTimeout(3000);
      const everything = JSON.stringify([ack, ...frames]);
      // At the toss nothing is on the table, so a watcher may be sent no face at
      // all. (The control that makes this zero mean something is below, once the
      // hands are dealt: the same probe on a player's own socket finds hers.)
      const names = faceNames([ack, ...frames]);
      expect(names, `no card face reaches a watcher before a card is played: ${names.slice(0, 5).join(', ')}`).toEqual([]);
      expect(everything, 'no prompt frame reaches a watcher').not.toMatch(/"kind":"(prompt|window|ask)"/);
      // And its input is dropped by the server.
      raw.emit('forge:c2s', { matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
      await expect
        .poll(() => serverLog(stack).filter((l) => l.evt === 'c2s-watcher' && l.matchId === matchId).length, { timeout: 10_000, message: 'the drop is logged' })
        .toBeGreaterThan(0);
    } finally {
      await raw.close();
    }
    await alice.page.waitForTimeout(1000);
    await expect(alice.page.getByTestId('live-says'), 'the watcher changed nothing for the players').toContainText(/play or draw/i);
    await expect(alice.page.getByTestId('live-play-or-draw-play')).toBeEnabled();

    // ── The hands, once dealt: both face up on a watcher's board, and the
    // bottom one drawn the way the top one is — as tall as its slot allows, one
    // row that fits — not the half-size flex row the operator saw at the first
    // party ("weirdly squished"). Hands are dealt after play-or-draw, so alice
    // answers it; the keep question stays open.
    await alice.page.getByTestId('live-play-or-draw-play').click();
    await expect
      .poll(async () => (await carol.page.locator('[data-zone="hand"]').evaluateAll((zs) => zs.map((z) => Number(z.getAttribute('data-count'))))), { timeout: 60_000, message: 'both hands dealt on the watcher’s board' })
      .toEqual([7, 7]);

    // The wire, with fourteen faces in play: a watcher's socket carries both
    // hands and nothing more — exactly the faces the two players' own sockets
    // carry between them, so no library card either was not shown. Watchparty's
    // production run (§10 of the request doc) found an earlier regex here could
    // not fail: Forge's values are typed, `"Name":{"t":"str","v":…}`.
    const probe = async (session: string): Promise<string[]> => {
      const sock = await connectSio(stack.origin, session);
      try {
        const got: unknown[] = [];
        sock.on('forge:s2c', (p) => got.push(p));
        const joined = (await sock.request('forge:join', { matchId })) as Record<string, unknown>;
        expect(joined, `${session}'s join is a snapshot`).not.toHaveProperty('error');
        await carol.page.waitForTimeout(2000);
        return faceNames([joined, ...got]);
      } finally {
        await sock.close();
      }
    };
    const watcherFaces = await probe('carol');
    const aliceFaces = await probe('alice');
    const bobFaces = await probe('bob');
    console.log(`[watcher wire] faces after the deal: watcher=${watcherFaces.length} alice=${aliceFaces.length} bob=${bobFaces.length}`);
    expect(aliceFaces.length, 'the probe finds a player’s own dealt hand').toBeGreaterThanOrEqual(7);
    expect(bobFaces.length).toBeGreaterThanOrEqual(7);
    expect(new Set(watcherFaces), 'the watcher is sent exactly what the two players are sent between them').toEqual(new Set([...aliceFaces, ...bobFaces]));
    const bottomHand = carol.page.locator('.seat[data-viewer] > [data-zone="hand"]');
    const topHand = carol.page.locator('.seat:not([data-viewer]) > [data-zone="hand"]');
    await expect(bottomHand, 'the bottom hand is the viewer side’s, as the rest of that seat is').toHaveAttribute('data-owner', 'you');
    await expect(topHand).toHaveAttribute('data-owner', 'them');
    await expect(bottomHand.locator('[data-board-card]'), 'seven faces at the bottom').toHaveCount(7);
    await expect(topHand.locator('[data-board-card]'), 'seven faces at the top').toHaveCount(7);
    await expect(carol.page.locator('[data-zone="hand"] .card-back'), 'no backs: the watcher sees every hand').toHaveCount(0);
    const geometry = async (zone: Locator) => {
      const card = await zone.locator('.card-backs > li').first().boundingBox();
      const box = await zone.boundingBox();
      const overflow = await zone.evaluate((el) => el.scrollWidth - el.clientWidth);
      if (card === null || box === null) throw new Error('the hand or its first card has no box');
      return { card, box, overflow };
    };
    const bottom = await geometry(bottomHand);
    const top = await geometry(topHand);
    console.log(`[watcher hand] bottom card ${bottom.card.width.toFixed(1)}x${bottom.card.height.toFixed(1)} in ${bottom.box.width.toFixed(0)}x${bottom.box.height.toFixed(0)} overflow ${bottom.overflow}; top card ${top.card.width.toFixed(1)}x${top.card.height.toFixed(1)} in ${top.box.width.toFixed(0)}x${top.box.height.toFixed(0)} overflow ${top.overflow}`);
    expect(bottom.card.height, 'a bottom card is as tall as its slot allows, like the top ones').toBeGreaterThan(bottom.box.height * 0.6);
    expect(Math.abs(bottom.card.height - top.card.height), 'the two strips draw their cards at one size').toBeLessThanOrEqual(4);
    expect(bottom.overflow, 'the bottom strip fits its slot').toBeLessThanOrEqual(1);
  } finally {
    await stack.stop();
  }
});

/* ── 3. the board follows both seats ───────────────────────────────── */

test('a watcher sees each side as its owner arranged it, with whoever’s turn it is at the bottom', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Three lands each, nobody's turn to do anything (w67's fixture).
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'w67-outlines');
    const carol = await openFriend(browser, 'carol');
    for (const p of [alice.page, bob.page, carol.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await carol.page.goto(matchUrl(stack.origin, matchId));
    await expect(carol.page.locator('.live[data-role="watcher"]'), 'carol watches').toBeVisible({ timeout: 60_000 });
    const own = (f: Friend) => f.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(own(alice), 'alice has her three lands').toHaveCount(3, { timeout: 60_000 });
    await expect(own(bob), 'bob has his three').toHaveCount(3, { timeout: 30_000 });
    await expect(carol.page.locator('[data-zone="battlefield"] li.board-card'), 'carol sees all six').toHaveCount(6, { timeout: 30_000 });
    const before = { alice: await fieldOrder(alice.page, 'you'), bob: await fieldOrder(bob.page, 'you') };

    // Each player carries their FIRST land to the far end of its row: the order changes and a gap is left.
    const carry = async (f: Friend): Promise<void> => {
      const first = (await own(f).first().boundingBox())!;
      const row = (await f.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot]').first().boundingBox())!;
      await f.page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
      await f.page.mouse.down();
      await f.page.mouse.move(first.x + 20, first.y + 20, { steps: 3 });
      await f.page.mouse.move(row.x + row.width - 30, first.y + first.height / 2, { steps: 12 });
      await f.page.mouse.up();
      await f.page.mouse.move(5, 5);
    };
    await carry(bob);
    await expect.poll(() => fieldOrder(bob.page, 'you'), { timeout: 10_000, message: 'bob moved a land' }).not.toEqual(before.bob);
    await carry(alice);
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 10_000, message: 'alice moved a land' }).not.toEqual(before.alice);
    const after = { alice: await fieldOrder(alice.page, 'you'), bob: await fieldOrder(bob.page, 'you') };
    console.log(`[watcher arrangement] alice ${before.alice.join(',')} -> ${after.alice.join(',')}; bob ${before.bob.join(',')} -> ${after.bob.join(',')}`);

    // Alice's turn: she is at the bottom, her side in her order, his in his — the bottom side moves too.
    await expect(viewerName(carol.page), 'alice’s turn: alice at the bottom').toHaveText('e2e-alice');
    await expect.poll(() => fieldOrder(carol.page, 'you'), { timeout: 10_000, message: 'the bottom side (alice) is as alice arranged it' }).toEqual(after.alice);
    await expect.poll(() => fieldOrder(carol.page, 'them'), { timeout: 10_000, message: 'the top side (bob) is as bob arranged it' }).toEqual(after.bob);
    await expect(gaps(carol.page, 'you'), 'her gap is drawn on the bottom side').not.toHaveCount(0);
    await expect(gaps(carol.page, 'them'), 'his gap is drawn on the top side').not.toHaveCount(0);

    // The turn passes to bob: the watcher's table turns with it, each side still as its owner arranged it.
    await grindPriority([alice.page, bob.page], async () => (await alice.page.locator('.seat[data-active]:not([data-viewer])').count()) === 1, { timeoutMs: 90_000 });
    await expect(viewerName(carol.page), 'bob’s turn: bob at the bottom').toHaveText('e2e-bob', { timeout: 15_000 });
    await expect(carol.page.locator('.seat[data-viewer][data-active]'), 'the bottom side is the active one').toHaveCount(1);
    await expect.poll(() => fieldOrder(carol.page, 'you'), { timeout: 10_000, message: 'turned: the bottom side (bob) is as bob arranged it' }).toEqual(after.bob);
    await expect.poll(() => fieldOrder(carol.page, 'them'), { timeout: 10_000, message: 'turned: the top side (alice) is as alice arranged it' }).toEqual(after.alice);

    // A move made AFTER the turn passed reaches the side it belongs to.
    await carry(alice);
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 10_000, message: 'alice moved again' }).not.toEqual(after.alice);
    const again = await fieldOrder(alice.page, 'you');
    await expect.poll(() => fieldOrder(carol.page, 'them'), { timeout: 10_000, message: 'her second move reaches the top side' }).toEqual(again);
    await expect.poll(() => fieldOrder(carol.page, 'you'), { timeout: 5_000, message: 'and bob’s side did not move' }).toEqual(after.bob);

    // A watcher arriving now is drawn from bob's side and sent both arrangements on joining.
    const dave = await openFriend(browser, 'carol');
    await resizeWindow(dave.page, { width: 1280, height: 800 });
    await dave.page.goto(matchUrl(stack.origin, matchId));
    await expect(dave.page.locator('.live[data-role="watcher"]')).toBeVisible({ timeout: 60_000 });
    await expect(viewerName(dave.page), 'a late watcher: bob’s turn, bob at the bottom').toHaveText('e2e-bob', { timeout: 30_000 });
    await expect.poll(() => fieldOrder(dave.page, 'you'), { timeout: 30_000, message: 'a late watcher: bob’s side as he left it' }).toEqual(after.bob);
    await expect.poll(() => fieldOrder(dave.page, 'them'), { timeout: 10_000, message: 'a late watcher: alice’s side as she left it' }).toEqual(again);
  } finally {
    await stack.stop();
  }
});

/* ── 4. what the active player is shown ─────────────────────────────── */

test('a watcher is shown the active player’s reveal: Goblin Guide’s top card, and never the card under it', async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Alice's Goblin Guide attacks on her turn 1; bob reveals Lightning Bolt off his library, Shock under it.
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'af29-goblin-guide');
    const carol = await openFriend(browser, 'carol');
    await resizeWindow(carol.page, { width: 1280, height: 800 });
    await carol.page.goto(matchUrl(stack.origin, matchId));
    await expect(carol.page.locator('.live[data-role="watcher"]'), 'carol watches').toBeVisible({ timeout: 60_000 });
    await expect(viewerName(carol.page), 'alice’s turn: alice at the bottom').toHaveText('e2e-alice', { timeout: 30_000 });

    const guide = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').filter({ hasText: 'Goblin Guide' });
    await expect(guide, 'Goblin Guide is on her battlefield').toHaveCount(1, { timeout: 60_000 });
    await passToDeclareAttackers(alice.page);
    await expect(guide, 'Goblin Guide is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    expect(await pressOffered(guide), 'Goblin Guide pressed').toBe(true);

    const bobsTop = (page: typeof carol.page) => page.locator('.seat:not([data-viewer]) [data-library-top] .card__name');
    await grindPriority([alice.page, bob.page], async () => (await bobsTop(alice.page).count()) > 0, { timeoutMs: 45_000 });
    await expect(bobsTop(carol.page), 'carol’s board draws the revealed Lightning Bolt on bob’s library').toHaveText('Lightning Bolt', { timeout: 10_000 });
    // The reveal itself, as alice was shown it: a display-only envelope on carol's own socket.
    const reveals = carol.captures.filter((c) => c.dir === 'in' && c.text.includes('"displayOnly":true'));
    console.log(`[watcher reveal] ${reveals.length} display-only frame(s) to carol: ${reveals.map((r) => r.text.slice(0, 160)).join(' | ')}`);
    expect(reveals.some((r) => r.text.includes('Lightning Bolt')), 'the reveal reached the watcher, display-only').toBe(true);
    expect(unseenNamed(messages(carol), ['Shock']).violations, 'the card under it never reaches the watcher').toEqual([]);
  } finally {
    await stack.stop();
  }
});
