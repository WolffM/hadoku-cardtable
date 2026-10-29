/**
 * Replays, played back from a real game — wave 81. The operator, 2026-10-28: *"the replay feature
 * just doesn't really work at all. that's gonna need a full overhaul and some proper e2e tests:
 * 'stopped after 3 resyncs in a row that did not catch up — the server's snapshot cursor is behind
 * its own stream'"*. And: *"double connecting? … ideally the user doesn't have to sit through the
 * loading. maybe we can take advantage of cache so this can load faster"*.
 *
 * `w81-replay.state`: bob attacks with Runeclaw Bear, alice blocks with Grizzly Bears and both die;
 * in bob's second main phase he puts Memnite and Dark Ritual on the stack together; alice draws on
 * turn 2, bob on turn 3, and bob concedes. Both live seats' boards are read at marked moments, each
 * when it has stood still, and the replay must land on each of them:
 *
 * - `#/replay/<id>`: a seek to the middle, the start, the end, and the other marks, each the board
 *   both seats had at that moment, card id by card id per zone, both hands face up, every face's
 *   art decoded; 1×, 2× and 4× each play the whole game with no error. Never "Connecting".
 * - the front page's card: loops the replay at least three times with no error and never a frame
 *   reading "Connecting"; its first drawn frame timed cold and warm, the warm one with no network
 *   fetch of the replay (the browser's cache serves it).
 *
 * `[w81]` lines are the evidence.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { enabledOk, makeTitled, nextPhaseLive, says } from './play/board.ts';
import { grindPriority, handCardNamed, stackTwoSpells } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { assignBlock, passDeclareAttackers, railAt } from './play/combat.ts';
import { forgeAvailability, PLAY_EDGE_ORIGIN, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every zone a board draws, by its label (`<player> <Zone>`): how many cards, and the ids drawn face up. */
type Board = Record<string, { count: number; ids: number[] }>;

const ZONES = /^(.+) (Hand|Battlefield|Graveyard|Exile)$/;

function readBoard(): Board {
  const out: Record<string, { count: number; ids: number[] }> = {};
  for (const zone of Array.from(document.querySelectorAll<HTMLElement>('section[data-zone][aria-label]'))) {
    const label = zone.getAttribute('aria-label')!;
    if (!/^(.+) (Hand|Battlefield|Graveyard|Exile)$/.test(label)) continue;
    const ids = Array.from(zone.querySelectorAll('[data-board-card]'), (e) => Number(e.getAttribute('data-board-card'))).sort((a, b) => a - b);
    out[label] = {
      count: Number(zone.getAttribute('data-count') ?? ids.length),
      ids,
    };
  }
  return out;
}

const board = (page: Page): Promise<Board> => page.evaluate(readBoard);

interface Mark {
  name: string;
  /** Wall-clock ms: the board stood still across it on both seats. */
  at: number;
  alice: Board;
  bob: Board;
}

/** Both seats' boards once neither has changed for 700 ms either side of the mark. */
async function mark(name: string, alice: Page, bob: Page): Promise<Mark> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const before = JSON.stringify([await board(alice), await board(bob)]);
    await alice.waitForTimeout(700);
    const at = Date.now();
    const a = await board(alice);
    const b = await board(bob);
    await alice.waitForTimeout(700);
    const after = JSON.stringify([await board(alice), await board(bob)]);
    if (before === JSON.stringify([a, b]) && after === before) {
      console.log(`[w81] mark ${name} at ${at}: alice ${JSON.stringify(a)} bob ${JSON.stringify(b)}`);
      return { name, at, alice: a, bob: b };
    }
  }
  throw new Error(`mark ${name}: the boards never stood still`);
}

/** `page`'s board once it has not changed for 700 ms: a card still flying to its pile is not there yet. */
async function still(page: Page): Promise<Board> {
  let last = JSON.stringify(await board(page));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(700);
    const now = JSON.stringify(await board(page));
    if (now === last && now !== '{}') return JSON.parse(now) as Board;
    last = now;
  }
  throw new Error('the replay board never stood still');
}

/**
 * The replay's board against both live seats': every zone but a hand is the same on all three; a
 * hand has the same count everywhere, and its ids are its owner's own, face up in the replay.
 */
function expectSameBoard(replay: Board, live: Mark, owners: Record<string, Board>): void {
  const labels = new Set([...Object.keys(live.alice), ...Object.keys(live.bob), ...Object.keys(replay)]);
  const none = { count: 0, ids: [] as number[] };
  for (const label of labels) {
    const [, player, zone] = ZONES.exec(label)!;
    const r = replay[label] ?? none;
    if (zone === 'Hand') {
      const own = owners[player!]![label] ?? none;
      expect(r.count, `${live.name}: ${label} holds as many cards as it did live`).toBe(own.count);
      expect(r.ids, `${live.name}: ${label} is face up, card for card its owner's`).toEqual(own.ids);
      continue;
    }
    expect(r, `${live.name}: ${label}, as alice saw it`).toEqual(live.alice[label] ?? none);
    expect(r, `${live.name}: ${label}, as bob saw it`).toEqual(live.bob[label] ?? none);
  }
}

/** Watches the page for any text reading "Connecting" and for the board's error alert, from its first frame. */
async function watchForTrouble(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __w81: { connecting: string[]; errors: string[] };
    };
    w.__w81 = { connecting: [], errors: [] };
    const scan = (): void => {
      const text = document.body?.innerText ?? '';
      if (/Connecting/.test(text)) w.__w81.connecting.push(text.slice(0, 200));
      for (const el of Array.from(document.querySelectorAll('[data-testid="live-error"]'))) w.__w81.errors.push(el.textContent ?? '');
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

const trouble = (page: Page): Promise<{ connecting: string[]; errors: string[] }> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __w81: { connecting: string[]; errors: string[] };
        }
      ).__w81,
  );

/** The art hosts, answered with a stand-in: an e2e browser reaches nothing off `127.0.0.1` (`play/browser.ts`). */
const ART_HOSTS = /^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//;
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';
async function serveArt(page: Page): Promise<void> {
  await page.route(ART_HOSTS, (route) => route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN }));
}

/** Moves the replay's scrubber to `ms`, as a drag ending there would. */
async function seek(page: Page, ms: number): Promise<void> {
  await page.getByTestId('replay-bar-scrub').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, ms);
}

/** Every face on the page has its art decoded (or has none to decode), and at least one does. */
async function expectArtDecoded(page: Page, what: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-board-card] img.card__art'));
          return {
            faces: imgs.length,
            pending: imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.src),
          };
        }),
      { timeout: 30_000, message: `${what}: every face's art is decoded` },
    )
    .toMatchObject({ pending: [] });
  const faces = await page.locator('[data-board-card] img.card__art').count();
  expect(faces, `${what}: faces are drawn with art`).toBeGreaterThan(0);
}

/** The active player moves their pointer across their own hand and battlefield, as a player looking things over does. */
async function sweep(page: Page): Promise<void> {
  for (const zone of ['hand', 'battlefield']) {
    const box = await page.locator(`.seat[data-viewer] [data-zone="${zone}"]`).first().boundingBox();
    if (box === null) continue;
    for (let i = 0; i <= 8; i += 1) {
      await page.mouse.move(box.x + (box.width * i) / 16, box.y + box.height / 2, { steps: 2 });
      await page.waitForTimeout(120);
    }
  }
}

/**
 * The active player parks their pointer over the far side of the table (reading the other player's
 * board) for longer than a pointer stays drawn without a move, then rests it in their own hand.
 */
async function parkAway(page: Page): Promise<void> {
  const far = await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').first().boundingBox();
  const hand = await page.locator('.seat[data-viewer] [data-zone="hand"]').first().boundingBox();
  if (far === null || hand === null) throw new Error('no board to park the pointer on');
  await page.mouse.move(far.x + far.width * 0.85, far.y + far.height * 0.5, { steps: 8 });
  await page.waitForTimeout(8_000);
  await page.mouse.move(hand.x + hand.width * 0.15, hand.y + hand.height * 0.5, { steps: 8 });
  await page.waitForTimeout(3_000);
}

/** Who each recorded `PlayerTurn` names, from when: the recording's own turn changes. */
function turnsOf(envs: { at: number; env: unknown }[]): { at: number; player: number }[] {
  const out: { at: number; player: number }[] = [];
  for (const { at, env } of envs) {
    const m = /"PlayerTurn":\{"t":"int","v":(\d+)\}/.exec(JSON.stringify(env));
    if (m !== null && out.at(-1)?.player !== Number(m[1])) out.push({ at, player: Number(m[1]) });
  }
  return out;
}

/**
 * The turn a board draws and the player at its bottom (by the name on their hand), read together
 * off the board itself: the card's title follows the match at once, the board a paced beat later.
 */
const drawnTurn = (scope: Page, within: string): Promise<{ turn: number; bottom: string }> =>
  scope.evaluate((root) => {
    const board = document.querySelector(root);
    return {
      turn: Number(board?.querySelector('[data-testid="live-phases"]')?.getAttribute('data-turn') ?? 0),
      bottom: (board?.querySelector('.seat[data-viewer] section[data-zone="hand"][aria-label]')?.getAttribute('aria-label') ?? '').replace(/ Hand$/, ''),
    };
  }, within);

/** Presses on through every priority stop until `until`. */
const grind = (alice: Friend, bob: Friend, until: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> => grindPriority([alice.page, bob.page], until, { timeoutMs });

test(
  titled('a real game replays: every seek lands on the live board, every speed plays through, both hands face up with art, and the front page loops it from cache without ever connecting'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(15 * 60_000);
    const stack = await startPlayStack(forge);
    const opened: BrowserContext[] = [];
    try {
      const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'w81-replay');
      const marks: Mark[] = [await mark('start', alice.page, bob.page)];
      const owners = (m: Mark): Record<string, Board> => ({
        Alice: m.alice,
        Bob: m.bob,
      });

      // Combat: Runeclaw Bear attacks, Grizzly Bears blocks, both die.
      const attacker = Number(await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card', { hasText: 'Runeclaw Bear' }).first().getAttribute('data-board-card'));
      const blocker = Number(await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card', { hasText: 'Grizzly Bears' }).first().getAttribute('data-board-card'));
      await passDeclareAttackers(bob.page);
      // alice holds Lightning Bolt and a Mountain, so she is asked at Declare Attackers Step first. Only
      // that pass is pressed (`nextPhaseLive`): a blanket OK can land on the block window and declare none.
      await expect
        .poll(
          async () => {
            if (/select creatures to block/i.test(await says(alice.page))) return true;
            await nextPhaseLive(alice.page)
              .first()
              .click({ timeout: 1_000 })
              .catch(() => undefined);
            return false;
          },
          { timeout: 60_000, message: 'the block window is open for alice' },
        )
        .toBe(true);
      // A drag made the instant the window opens can land before the board takes it: drag again until it shows.
      await expect
        .poll(
          async () => {
            if ((await alice.page.locator(`[data-board-card="${blocker}"][data-blocking="true"]`).count()) > 0) return true;
            await assignBlock(alice.page, blocker, attacker);
            await alice.page.waitForTimeout(1_000);
            return (await alice.page.locator(`[data-board-card="${blocker}"][data-blocking="true"]`).count()) > 0;
          },
          { timeout: 20_000, message: 'Grizzly Bears blocks Runeclaw Bear' },
        )
        .toBe(true);
      await enabledOk(alice.page).click();
      const memnite = async (): Promise<number | undefined> => handCardNamed(bob.page, 'Memnite');
      await grind(alice, bob, async () => {
        const at = await railAt(bob.page);
        const offered = await bob.page.locator(`[data-board-card="${await memnite()}"][data-selectable]`).count();
        return at?.phase === 'MAIN2' && offered > 0;
      });
      marks.push(await mark('combat', alice.page, bob.page));
      const dead = marks.at(-1)!.alice;
      expect((dead['Alice Graveyard']?.count ?? 0) + (dead['Bob Graveyard']?.count ?? 0), 'both bears died').toBe(2);

      // A stack of two: Memnite, and Dark Ritual over it; both resolve.
      await stackTwoSpells(alice.page, bob.page);
      marks.push(await mark('stack', alice.page, bob.page));
      await grind(alice, bob, async () => (await alice.page.locator('[data-zone="stack"]').getAttribute('data-count')) === '0');

      // Turns pass: alice draws on turn 2, bob on turn 3. The server passes every stop a seat has nothing
      // to do at, so presses stop the moment the turn is reached: each then holds a land to play, and waits.
      await grind(alice, bob, async () => ((await railAt(alice.page))?.turn ?? 0) >= 2);
      marks.push(await mark('turn 2', alice.page, bob.page));
      // Each player looks over their own side on their own turn; the other moves too, and is not recorded.
      await Promise.all([sweep(alice.page), sweep(bob.page)]);
      await grind(alice, bob, async () => ((await railAt(alice.page))?.turn ?? 0) >= 3);
      marks.push(await mark('turn 3', alice.page, bob.page));
      await Promise.all([sweep(bob.page), sweep(alice.page)]);
      await parkAway(bob.page);

      await bob.page.getByTestId('live-concede').click();
      await bob.page.getByTestId('live-concede-yes').click();
      await expect(alice.page.getByTestId('game-result'), 'alice sees the result').toBeVisible({ timeout: 30_000 });
      const end = await mark('end', alice.page, bob.page);
      marks.push(end);

      // The recording is written when the game ends.
      const api = alice.context.request;
      let startedAt = 0;
      let durationMs = 0;
      let recorded: { envs: { at: number; env: unknown }[]; presence: { at: number; seat: number; playerId: number; presence: { held: boolean } }[] } = { envs: [], presence: [] };
      await expect
        .poll(
          async () => {
            const res = await api.get(`${stack.origin}${PREFIX}/api/replays/${matchId}`);
            if (!res.ok()) return res.status();
            const body = (await res.json()) as {
              header: { startedAt: string };
              envs: { at: number; env: unknown }[];
              presence: { at: number; seat: number; playerId: number; presence: { held: boolean } }[];
            };
            recorded = body;
            startedAt = Date.parse(body.header.startedAt);
            durationMs = body.envs.at(-1)?.at ?? 0;
            console.log(`[w81] recording ${matchId}: ${body.envs.length} frames over ${durationMs} ms; cache-control ${res.headers()['cache-control']}`);
            return res.status();
          },
          { timeout: 30_000, message: 'the recording is served' },
        )
        .toBe(200);

      // The pointer kept is the active player's only: every line names the player whose turn it was.
      const turns = turnsOf(recorded.envs);
      const activeAt = (at: number): number | undefined => turns.filter((t) => t.at <= at).at(-1)?.player;
      const pointerPlayers = [...new Set(recorded.presence.map((p) => p.playerId))];
      console.log(`[w81] pointer: ${recorded.presence.length} lines, players ${JSON.stringify(pointerPlayers)}, held ${recorded.presence.filter((p) => p.presence.held).length}; turns ${JSON.stringify(turns)}`);
      expect(recorded.presence.filter((p) => p.playerId !== activeAt(p.at)), 'every recorded pointer is the active player’s').toEqual([]);
      expect(pointerPlayers.length, 'both players’ turns carry their pointer').toBe(2);
      expect(recorded.presence.some((p) => p.presence.held), 'a drag (a card held) is in the recording').toBe(true);
      const gaps = recorded.presence.slice(1).map((p, i) => p.at - recorded.presence[i]!.at);
      expect(recorded.presence.length / (durationMs / 1000), 'at most ~10 a second on average').toBeLessThanOrEqual(12);
      console.log(`[w81] pointer gaps: min ${Math.min(...gaps)} ms`);

      // ── #/replay/<id> ────────────────────────────────────────────────
      const carol = await openFriend(browser, 'carol');
      await watchForTrouble(carol.page);
      await serveArt(carol.page);
      await carol.page.goto(`${stack.origin}${PREFIX}/#/replay/${matchId}`);
      await expect(carol.page.getByTestId('replay-bar'), 'the transport bar').toBeVisible({ timeout: 30_000 });
      await carol.page.getByTestId('replay-bar-play').click(); // pause
      await expect(carol.page.getByTestId('replay-bar-play')).toHaveText('▶');

      const byName = Object.fromEntries(marks.map((m) => [m.name, m]));
      for (const name of ['stack', 'start', 'end', 'combat', 'turn 2', 'turn 3']) {
        const m = byName[name]!;
        const target = name === 'end' ? durationMs : m.at - startedAt;
        await seek(carol.page, target);
        const replay = await still(carol.page);
        console.log(`[w81] seek ${name} (${target} ms): ${JSON.stringify(replay)}`);
        expectSameBoard(replay, m, owners(m));
      }
      await expectArtDecoded(carol.page, 'the end, seeked');

      // Played back, the active player's cursor is drawn on their own side: the bottom of the board.
      const cursorSeen: { y: number; boardTop: number; boardBottom: number; name: string }[] = [];
      for (const speed of [1, 2, 4] as const) {
        await seek(carol.page, 0);
        await carol.page.getByTestId(`replay-bar-speed-${speed}`).click();
        const started = Date.now();
        await carol.page.getByTestId('replay-bar-play').click();
        if (speed === 1) {
          await expect
            .poll(
              async () => {
                const seen = await carol.page.evaluate(() => {
                  const cursor = document.querySelector('.presence');
                  const overlay = document.querySelector('[data-board-overlay]');
                  if (cursor === null || overlay === null) return null;
                  const c = cursor.getBoundingClientRect();
                  const o = overlay.getBoundingClientRect();
                  return { y: c.top, boardTop: o.top, boardBottom: o.bottom, name: cursor.querySelector('.presence__name')?.textContent ?? '' };
                });
                // Distinct places only: a cursor standing still is one sample, however long it stands.
                if (seen !== null && cursorSeen.at(-1)?.y !== seen.y) cursorSeen.push(seen);
                return (await carol.page.getByTestId('replay-bar-play').textContent()) === '↺';
              },
              { timeout: durationMs + 30_000, intervals: [50], message: 'the replay plays to its end' },
            )
            .toBe(true);
          console.log(`[w81] cursor places: ${JSON.stringify(cursorSeen.map((c) => Math.round(c.y)))}`);
          expect(cursorSeen.length, 'the recorded cursor moves while the replay plays').toBeGreaterThanOrEqual(10);
          const below = cursorSeen.filter((c) => c.y > (c.boardTop + c.boardBottom) / 2).length;
          console.log(`[w81] cursor on the replay: ${below}/${cursorSeen.length} samples in the bottom half; first ${JSON.stringify(cursorSeen[0])}`);
          expect(below / cursorSeen.length, 'the active player’s cursor is on their own side, the bottom half').toBeGreaterThanOrEqual(0.8);
          expect([...new Set(cursorSeen.map((c) => c.name))], 'no name tag: it is the bottom player’s own pointer').toEqual(['']);
        }
        await expect(carol.page.getByTestId('replay-bar-play'), `${speed}× plays to the end`).toHaveText('↺', { timeout: durationMs / speed + 30_000 });
        console.log(`[w81] ${speed}×: played ${durationMs} ms of game in ${Date.now() - started} ms`);
        expectSameBoard(await still(carol.page), end, owners(end));
      }
      await expectArtDecoded(carol.page, 'the end, played');
      const replayTrouble = await trouble(carol.page);
      console.log(`[w81] #/replay trouble: ${JSON.stringify(replayTrouble)}`);
      expect(replayTrouble.errors, 'no error on the replay board').toEqual([]);
      expect(replayTrouble.connecting, 'a replay never reads Connecting').toEqual([]);

      // ── The front page's card ────────────────────────────────────────
      // A visitor's own context: `openFriend`'s routes would turn the browser's HTTP cache off (Playwright
      // disables it for a routed context), which is the thing measured here. Off-origin requests are
      // blocked by CDP instead, which leaves the cache alone; the app is plain http on 127.0.0.1.
      const visitor = await browser.newContext();
      opened.push(visitor);
      await visitor.addCookies([
        {
          name: SESSION_COOKIE,
          value: 'carol',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      await keepPrefsLocal(visitor, PLAY_EDGE_ORIGIN);
      const front = await visitor.newPage();
      await watchForTrouble(front);
      const cdp = await visitor.newCDPSession(front);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
      const fetched: { url: string; cached: boolean }[] = [];
      const fromCache = new Set<string>();
      const said: string[] = [];
      let navigated = 0;
      cdp.on('Network.requestServedFromCache', (e) => fromCache.add(e.requestId));
      cdp.on('Network.responseReceived', (e) => {
        if (e.response.url.includes('/api/')) said.push(`${Date.now() - navigated} ms ${e.response.status} ${e.response.url}`);
        if (!e.response.url.includes(`/api/replays/${matchId}`)) return;
        fetched.push({
          url: e.response.url,
          cached: fromCache.has(e.requestId) || e.response.fromDiskCache === true || e.response.fromPrefetchCache === true,
        });
      });
      front.on('console', (m) => said.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
      const firstFrame = async (): Promise<number> => {
        navigated = Date.now();
        await front.goto(`${stack.origin}${PREFIX}/`);
        return front
          .waitForFunction(() => (document.querySelector('[data-testid="featured-match"] [data-testid="player"]') === null ? null : performance.now()), null, { timeout: 30_000, polling: 'raf' })
          .then((h) => h.jsonValue() as Promise<number>)
          .finally(() => console.log(`[w81] front page requests: ${JSON.stringify(said.splice(0))}`));
      };
      const cold = await firstFrame();
      const coldFetches = fetched.splice(0);
      const warm = await firstFrame();
      const warmFetches = fetched.splice(0);
      console.log(`[w81] front card first frame: cold ${cold.toFixed(0)} ms (${JSON.stringify(coldFetches)}), warm ${warm.toFixed(0)} ms (${JSON.stringify(warmFetches)})`);
      expect(coldFetches.length, 'the cold load fetched the replay').toBeGreaterThan(0);
      expect(
        warmFetches.filter((f) => !f.cached),
        'the warm load fetched nothing over the network',
      ).toEqual([]);
      await expect(front.getByTestId('featured-match-tag')).toHaveText('REPLAY');
      // The card is a square window onto the board's bottom-left 540 board pixels (of 1280×800).
      const fit = await front.locator('.featured-match__viewport').evaluate((viewport) => {
        const frame = viewport.querySelector('.featured-match__frame')!.getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        return { frame: { left: frame.left, bottom: frame.bottom, width: frame.width }, box: { left: box.left, bottom: box.bottom, width: box.width, height: box.height } };
      });
      console.log(`[w81] front card window: ${JSON.stringify(fit)}`);
      expect(Math.abs(fit.box.width - fit.box.height), 'the card is square').toBeLessThanOrEqual(1);
      expect(Math.abs(fit.frame.width - (fit.box.width * 1280) / 540), 'the board at 540 board pixels to the card’s side').toBeLessThanOrEqual(2);
      expect(Math.abs(fit.frame.left - fit.box.left), 'its left edge is the board’s').toBeLessThanOrEqual(1);
      expect(Math.abs(fit.frame.bottom - fit.box.bottom), 'its bottom edge is the board’s').toBeLessThanOrEqual(1);
      await expect(front.getByTestId('featured-match-watch')).toHaveAttribute('href', `#/replay/${matchId}`);

      // Three loops, on the page's own clock run fast.
      const looper = await visitor.newPage();
      await watchForTrouble(looper);
      await looper.clock.install();
      await looper.goto(`${stack.origin}${PREFIX}/`);
      await expect(looper.locator('[data-testid="featured-match"] [data-testid="player"]').first()).toBeVisible({ timeout: 30_000 });
      let loops = 0;
      let lastTurn = 0;
      /** Each turn's bottom player on the card: whose turn it is (bob on 1 and 3, alice on 2). */
      const bottomByTurn = new Map<number, Set<string>>();
      /** Turn 3's capture regions, in order (one entry per change), and whether the cursor showed while temporary. */
      const regions: string[] = [];
      let cursorShownAway = false;
      for (let ran = 0; ran < durationMs * 3.5 && loops < 3; ran += 500) {
        await looper.clock.runFor(500);
        const turn = Number(/Turn (\d+)/.exec((await looper.getByTestId('featured-match').textContent()) ?? '')?.[1] ?? 0);
        if (turn < lastTurn) loops += 1;
        lastTurn = turn;
        const drawn = await drawnTurn(looper, '[data-testid="featured-match"]');
        if (drawn.turn > 0) bottomByTurn.set(drawn.turn, (bottomByTurn.get(drawn.turn) ?? new Set()).add(drawn.bottom));
        if (turn === 3) {
          const seen = await looper.locator('.featured-match__viewport').evaluate((viewport) => {
            const box = viewport.getBoundingClientRect();
            const tip = viewport.querySelector('.presence')?.getBoundingClientRect();
            const shown = tip !== undefined && tip.left >= box.left && tip.left <= box.right && tip.top >= box.top && tip.top <= box.bottom;
            return { region: (viewport as HTMLElement).dataset.captureRegion ?? '', shown };
          });
          if (regions.at(-1) !== seen.region) regions.push(seen.region);
          if (seen.region === 'temporary' && seen.shown) cursorShownAway = true;
        }
      }
      console.log(`[w81] front card, turn 3 capture regions: ${JSON.stringify(regions)}; cursor shown in the temporary region: ${cursorShownAway}`);
      expect(regions.join(' '), 'bob parks away: a temporary capture region opens, then retires to the default once he is back').toMatch(/default temporary default/);
      expect(cursorShownAway, 'the temporary region shows his cursor').toBe(true);
      const flips = Object.fromEntries([...bottomByTurn].map(([t, names]) => [t, [...names]]));
      console.log(`[w81] front card, bottom player by turn: ${JSON.stringify(flips)}`);
      expect(flips, 'the card flips to the active player at every turn').toEqual({ 1: ['Bob'], 2: ['Alice'], 3: ['Bob'] });
      const frontTrouble = await trouble(looper);
      console.log(`[w81] front card: ${loops} loops; trouble ${JSON.stringify(frontTrouble)}`);
      expect(loops, 'the card loops the replay at least three times').toBeGreaterThanOrEqual(3);
      expect(frontTrouble.errors, 'no error on the card').toEqual([]);
      expect(frontTrouble.connecting, 'the card never reads Connecting').toEqual([]);
      expect((await trouble(front)).connecting, 'nor while loading').toEqual([]);
    } finally {
      await Promise.all(opened.map((c) => c.close()));
      await stack.stop();
    }
  },
);
