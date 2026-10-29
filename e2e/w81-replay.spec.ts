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
      await grind(alice, bob, async () => ((await railAt(alice.page))?.turn ?? 0) >= 3);
      marks.push(await mark('turn 3', alice.page, bob.page));

      await bob.page.getByTestId('live-concede').click();
      await bob.page.getByTestId('live-concede-yes').click();
      await expect(alice.page.getByTestId('game-result'), 'alice sees the result').toBeVisible({ timeout: 30_000 });
      const end = await mark('end', alice.page, bob.page);
      marks.push(end);

      // The recording is written when the game ends.
      const api = alice.context.request;
      let startedAt = 0;
      let durationMs = 0;
      await expect
        .poll(
          async () => {
            const res = await api.get(`${stack.origin}${PREFIX}/api/replays/${matchId}`);
            if (!res.ok()) return res.status();
            const body = (await res.json()) as {
              header: { startedAt: string };
              envs: { at: number }[];
            };
            startedAt = Date.parse(body.header.startedAt);
            durationMs = body.envs.at(-1)?.at ?? 0;
            console.log(`[w81] recording ${matchId}: ${body.envs.length} frames over ${durationMs} ms; cache-control ${res.headers()['cache-control']}`);
            return res.status();
          },
          { timeout: 30_000, message: 'the recording is served' },
        )
        .toBe(200);

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

      for (const speed of [1, 2, 4] as const) {
        await seek(carol.page, 0);
        await carol.page.getByTestId(`replay-bar-speed-${speed}`).click();
        const started = Date.now();
        await carol.page.getByTestId('replay-bar-play').click();
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
    const fit = await front.locator('.featured-match__viewport').evaluate((viewport) => {
      const frame = viewport.querySelector('.featured-match__frame')!.getBoundingClientRect();
      const box = viewport.getBoundingClientRect();
      return { frame: [Math.round(frame.width), Math.round(frame.height)], box: [Math.round(box.width), Math.round(box.height)] };
    });
    console.log(`[w81] front card fit: ${JSON.stringify(fit)}`);
    expect(fit.frame[0], 'the board is scaled down into the card, never cropped').toBeLessThanOrEqual(fit.box[0] + 1);
    expect(fit.frame[1], 'the board is scaled down into the card, never cropped').toBeLessThanOrEqual(fit.box[1] + 1);
      await expect(front.getByTestId('featured-match-watch')).toHaveAttribute('href', `#/replay/${matchId}`);

      // Three loops, on the page's own clock run fast.
      const looper = await visitor.newPage();
      await watchForTrouble(looper);
      await looper.clock.install();
      await looper.goto(`${stack.origin}${PREFIX}/`);
      await expect(looper.locator('[data-testid="featured-match"] [data-testid="player"]').first()).toBeVisible({ timeout: 30_000 });
      let loops = 0;
      let lastTurn = 0;
      for (let ran = 0; ran < durationMs * 3.5 && loops < 3; ran += 500) {
        await looper.clock.runFor(500);
        const turn = Number(/Turn (\d+)/.exec((await looper.getByTestId('featured-match').textContent()) ?? '')?.[1] ?? 0);
        if (turn < lastTurn) loops += 1;
        lastTurn = turn;
      }
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
