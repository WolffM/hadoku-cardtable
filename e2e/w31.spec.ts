/**
 * Wave 31: what the second play test found, in a real browser against a real Forge.
 *
 * Four things, each its own match so one red does not hide another:
 *
 *  1. **A reload with a selection open (P10).** The London bottom pick is a
 *     SELECTION, not an ask: Forge publishes `setSelectables` and waits. `play.spec.ts`
 *     covers an open ask across a refresh; before wave 31 a selection did not
 *     survive one (the server re-sent asks, buttons and the prompt and nothing
 *     else, and the client nulled `selectables` on the premise that it would not
 *     be re-sent), so the page came back with a prompt it could not answer and
 *     Forge waiting. The spec opens one, reloads the page, and then ANSWERS it.
 *  2. **A second browser on a held seat is a spectator.** Operator, 2026-09-30:
 *     *"it would be really messy if two clients were capable of performing game
 *     actions."* The second context is told so, cannot act (by the page, and by the
 *     wire: a raw socket that sends an OK anyway is refused and the controller's
 *     question stays open), and is promoted when the first context closes. A
 *     REFRESH is the same path and must never lock a player out of their own seat.
 *  3. **A match that is gone** shows the server's sentence and a way back, with no
 *     board chrome and nothing shaped like a Join.
 *  4. **The rail and the log (P1, P12).** Combat is one step outside combat and
 *     six inside, without the rail moving; a card name in the log is enlarged by
 *     the ONE inspector the board already has, not a hover surface of its own.
 *  5. **Concede after the end (P18).** Nothing to concede once the game is over.
 *  6. **The board in a light theme** follows the theme (P4) and its text is legible.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`) like
 * `play.spec.ts`; without one each test SKIPS and its title says why. Serves the
 * prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type ElementHandle, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmYes } from './play/confirm.ts';
import { connectHands } from './play/hands.ts';
import { answerPrompt } from './play/prompts.ts';
import { enterMatch, enabledOk, makeTitled, offered, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { connectSio } from './play/sio.ts';
import { TURN_TEXT } from './play/turn.ts';

test.describe.configure({ mode: 'serial' });

const PREFIX = '/cardtable';
const forge = forgeAvailability();
const titled = makeTitled(forge);

/* ── what a page shows ───────────────────────────────────────────────── */

/**
 * The coin toss / play-draw question's own control (R2, wave 35) — NOT
 * `enabledOk`: Forge's button one is drawn nowhere else while this question
 * is open (`playFirst`'s own comment), so a check built on it can never see
 * count 1 here. `LiveBoard.tsx`'s `playOrDraw` gate is `!spectator &&
 * !askOpen && isPlayOrDrawPrompt(bar)` — a SPECTATOR never gets this
 * component mounted at all, so "no enabled play-or-draw in the spectator
 * window" is a plain `toHaveCount(0)` on this same locator, same as it
 * always was on `enabledOk`.
 */
const playOrDrawPlay = (page: Page) => page.getByTestId('live-play-or-draw-play');
const handCards = (page: Page) => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]');

async function boardUp(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 30_000 });
}

/**
 * Alice wins the toss on this seed: press Play, and wait for her keep-or-mulligan.
 *
 * Wave 35 R2 moved this question off the control bar into its own decision
 * area (`live-play-or-draw-host`, lane G's `PlayOrDrawPrompt`, wired by lane
 * L), so the old bar click hung forever once that landed. Click the new
 * button instead.
 */
async function playFirst(alice: Friend): Promise<void> {
  await expect(alice.page.getByTestId('live-says')).toContainText(/play or draw/i, { timeout: 30_000 });
  await alice.page.getByTestId('live-play-or-draw-play').click();
  await expect(alice.page.getByTestId('live-says')).toContainText(/keep your hand/i, { timeout: 30_000 });
}

const matchUrl = (origin: string, matchId: string): string => `${origin}${PREFIX}/#/match/${matchId}`;

/* ── 1. a reload with a selection open ───────────────────────────────── */

test(titled('reload with a selection open: the London bottom pick survives a refresh and can be answered (P10)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);
    await playFirst(alice);

    // Mulligan. Whichever order Forge asks in (wave 31 §F moved the bottom pick to
    // AFTER the keep), the seat ends at "Return N card(s) to the bottom" with its
    // hand offered: that is a selection, and it is what must survive.
    //
    // Wave 36 T4: Keep/Mulligan is a yes/no `ConfirmPrompt` now, not the
    // control bar — Mulligan is button 2 (`prompt-confirm-no`).
    await answerConfirm(alice.page, 'no');
    const bottom = alice.page.getByTestId('live-says');
    // Bob keeps whatever he is dealt when he is asked; alice keeps the new seven.
    // Wave 36 T4: bob's own "keep your hand?" moved off the bar into its own
    // `ConfirmPrompt` pop-up too — this loop's `enabledOk` click for him was
    // missed blast radius (only alice's explicit Mulligan/Keep sites above
    // were moved): his own Keep is button 1, `confirmYes`.
    for (let i = 0; i < 60 && !/return \d+ card/i.test(await says(alice.page)); i++) {
      for (const f of [alice, bob]) {
        if (/keep your hand/i.test(await says(f.page)) && (await confirmYes(f.page).count()) > 0) await answerConfirm(f.page, 'yes');
      }
      await alice.page.waitForTimeout(500);
    }
    await expect(bottom).toContainText(/return \d+ card/i);
    const before = { says: await says(alice.page), ids: await offered(alice.page), hand: await handCards(alice.page).count() };
    expect(before.ids.length, 'the bottom pick offers her hand').toBeGreaterThan(0);

    await alice.page.reload();
    await boardUp(alice.page);
    await expect(bottom, 'the same question is on the page after the reload').toContainText(/return \d+ card/i, { timeout: 30_000 });
    await expect
      .poll(() => offered(alice.page), { timeout: 30_000, message: 'the same cards are offered after the reload — the selection was re-sent' })
      .toEqual(before.ids);
    expect(await handCards(alice.page).count(), 'the hand is the same hand').toBe(before.hand);

    // And it is answerable: pick a card, OK, and Forge moves on with one fewer in hand.
    await alice.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${before.ids[0]}"] button`).click();
    await expect(enabledOk(alice.page)).toHaveCount(1, { timeout: 15_000 });
    await enabledOk(alice.page).click();
    await expect(bottom, 'Forge took the answer and moved on').not.toContainText(/return \d+ card/i, { timeout: 30_000 });
    await expect(handCards(alice.page)).toHaveCount(before.hand - 1, { timeout: 30_000 });
    // The rules' London mulligan DECIDES first and bottoms after (wave 31 §F, P7):
    // once the card is back nothing asks her to keep again. Forge did it the other
    // way round, so the operator saw mulligan, put one back, "keep?" again.
    // Bob still has to keep his own hand; alice must not be asked again meanwhile.
    // Wave 36 T4: both sides' "keep your hand?" is a `ConfirmPrompt` pop-up now.
    let askedAgain = false;
    for (let i = 0; i < 60 && !/^Priority: /.test(await says(alice.page)); i++) {
      if (/keep your hand/i.test(await says(alice.page))) {
        askedAgain = true;
        if ((await confirmYes(alice.page).count()) > 0) await answerConfirm(alice.page, 'yes');
      }
      if (/keep your hand/i.test(await says(bob.page)) && (await confirmYes(bob.page).count()) > 0) await answerConfirm(bob.page, 'yes');
      await alice.page.waitForTimeout(250);
    }
    expect(askedAgain, 'no second keep-or-mulligan after the bottom pick').toBe(false);
    await expect(bottom, 'the game began for alice').toContainText(/^Priority: /);
  } finally {
    await stack.stop();
  }
});

/* ── 2. a second browser spectates ───────────────────────────────────── */

test(titled('a second browser on a held seat is a spectator: inert, refused by the server, promoted when the first leaves'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await expect(alice.page.getByTestId('live-says')).toContainText(/play or draw/i, { timeout: 30_000 });
    await expect(playOrDrawPlay(alice.page), 'the first window holds the question').toBeEnabled();

    // The second window: same account, same seat.
    const second = await openFriend(browser, 'alice');
    await second.page.goto(matchUrl(stack.origin, matchId));
    await boardUp(second.page);
    const banner = (f: Friend) => f.page.getByText(/watching/i);
    await expect(banner(second), 'the second window is told it is watching').toBeVisible({ timeout: 30_000 });
    expect(await banner(alice).count(), 'the controlling window is not').toBe(0);
    // It can SEE the same question, and cannot answer it.
    await expect(second.page.getByTestId('live-says')).toContainText(/play or draw/i);
    await expect(playOrDrawPlay(second.page), 'no play-or-draw control in the spectator window').toHaveCount(0);
    await expect(second.page.getByTestId('live-concede')).not.toBeEnabled();

    // The page is not the enforcement: a raw socket for the same seat sends the
    // OK anyway. The server refuses it, says so in its log, and the controller's
    // question is still open.
    const raw = await connectSio(stack.origin, 'alice');
    try {
      const roles: unknown[] = [];
      raw.on('forge:role', (p) => roles.push(p));
      await raw.request('forge:join', { matchId });
      await expect.poll(() => roles, { timeout: 10_000 }).toContainEqual({ matchId, role: 'spectator' });
      raw.emit('forge:c2s', { matchId, frame: { kind: 'act', method: 'selectButtonOk' } });
      await expect
        .poll(() => serverLog(stack).filter((l) => l.evt === 'c2s-spectator' && l.matchId === matchId).length, { timeout: 10_000, message: 'the refusal is logged' })
        .toBeGreaterThan(0);
    } finally {
      await raw.close();
    }
    await alice.page.waitForTimeout(1500);
    await expect(alice.page.getByTestId('live-says'), 'the refused OK did not answer the toss').toContainText(/play or draw/i);
    await expect(playOrDrawPlay(alice.page)).toBeEnabled();

    // The first window closes: the second is promoted, without a reload, and can act.
    await alice.context.close();
    await expect(banner(second), 'promotion lifts the banner').toHaveCount(0, { timeout: 30_000 });
    await expect(playOrDrawPlay(second.page), 'and hands it the question').toBeEnabled({ timeout: 30_000 });
    await playOrDrawPlay(second.page).click();
    await expect(second.page.getByTestId('live-says')).toContainText(/keep your hand/i, { timeout: 30_000 });

    // A REFRESH is the same path: the new socket can open before the old one's
    // disconnect lands, spectates for a moment, and must then be promoted.
    await second.page.reload();
    await boardUp(second.page);
    await expect(banner(second), 'a refresh never leaves the player locked out of their own seat').toHaveCount(0, { timeout: 30_000 });
    // Wave 36 T4: "keep your hand?" is a `ConfirmPrompt` pop-up now, not the bar.
    await expect(confirmYes(second.page)).toHaveCount(1, { timeout: 30_000 });
    await answerConfirm(second.page, 'yes');
    await expect(second.page.getByTestId('live-says'), 'and the keep went through').not.toContainText(/keep your hand/i, { timeout: 30_000 });
  } finally {
    await stack.stop();
  }
});

/* ── 3. a match that is gone ─────────────────────────────────────────── */

test(titled('a match that is gone shows the reason and a way back, with no board and no Join'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.page.goto(matchUrl(stack.origin, 'm-000000000000'));
    await expect(alice.page.getByText(/no longer running/i), "the server's own sentence").toBeVisible({ timeout: 30_000 });
    expect(await alice.page.locator('[aria-label="Game board"]').count(), 'no board').toBe(0);
    for (const id of ['live-buttons', 'live-phases', 'live-concede']) {
      expect(await alice.page.getByTestId(id).count(), `no ${id} chrome`).toBe(0);
    }
    expect(await alice.page.getByRole('button', { name: /join/i }).count(), 'nothing join-shaped').toBe(0);
    expect(await alice.page.getByRole('link', { name: /join/i }).count(), 'nothing join-shaped').toBe(0);
    // One way back.
    const back = alice.page.getByRole('link', { name: /room|lobby|back|tables/i }).first();
    await expect(back).toBeVisible();
    await back.click();
    await expect(alice.page).not.toHaveURL(/#\/match\//);
  } finally {
    await stack.stop();
  }
});

/* ── 4. the phase rail and the log ──────────────────────────────────── */

test(titled('combat is one rail step outside combat and six inside; the rail GROWS into combat and shrinks after, centred and un-bulleted, same row height; a log name opens the one inspector (P1, P12, w32 Q3)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const hands: Awaited<ReturnType<typeof connectHands>>[] = [];
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    // BOTH seats, not just alice: the "outside" row-height sample is always
    // read off alice's page, but the "inside" one is read off WHICHEVER seat
    // (`combat.who`) the in-page recorder below sees settle in combat first — Forge's own
    // RNG decides that, not this test. Leaving bob at Playwright's unset
    // default (1280×720, `docClientH` 80px shorter than alice's 1280×800)
    // is exactly what produced the tracker's 2.16px "row height" gap: it was
    // two different viewports, not two different row heights — confirmed by
    // `railDiag`'s own `docClientH` field on a failing run (800 outside,
    // 720 inside, same run, same formula).
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await bob.page.setViewportSize({ width: 1280, height: 800 });
    await enterMatch(alice, bob, stack.origin);
    const rows = alice.page.locator('.live__step');
    const names = async (f: Friend): Promise<string[]> => (await f.page.locator('.live__step-name').allTextContents()).map((n) => n.trim());
    const railBox = async (f: Friend) => f.page.getByTestId('live-phases').boundingBox();
    // Wave 33 §L1 follow-up: the operator's tracker measured a 2.16px gap
    // between the out-of-combat and in-combat row heights on a real run —
    // under `--rail-row-h`'s own formula ((0.35·H − 29)/13) that is explained
    // entirely by `.live`'s OWN measured height differing by about 80px
    // between the two samples (something took vertical space from it — a
    // wrapping header, a banner, a scrollbar). This captures exactly what a
    // failure needs to say what moved: `.live`'s height, `.app-header`'s
    // height, the viewport's `clientHeight`, and `.live`'s parent's box plus
    // every sibling's box, at the SAME instant each row height is measured.
    const railDiag = async (f: Friend) =>
      f.page.evaluate(() => {
        const live = document.querySelector<HTMLElement>('.live');
        const header = document.querySelector<HTMLElement>('.app-header');
        const liveBox = live?.getBoundingClientRect() ?? null;
        const headerBox = header?.getBoundingClientRect() ?? null;
        const parent = live?.parentElement ?? null;
        const parentBox = parent?.getBoundingClientRect() ?? null;
        const siblings = parent
          ? Array.from(parent.children).map((el) => {
              const b = el.getBoundingClientRect();
              return { tag: el.tagName.toLowerCase(), cls: String((el as HTMLElement).className).slice(0, 60), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
            })
          : [];
        return {
          liveH: liveBox === null ? null : Math.round(liveBox.height * 100) / 100,
          headerH: headerBox === null ? null : Math.round(headerBox.height * 100) / 100,
          docClientH: document.documentElement.clientHeight,
          parentBox: parentBox === null ? null : { x: Math.round(parentBox.x), y: Math.round(parentBox.y), w: Math.round(parentBox.width), h: Math.round(parentBox.height) },
          siblings,
        };
      });

    // Wave 35 §E2: the rail's growth is a CSS transition (`live.css`'s
    // `transition: height 0.3s ease`), so its height is read only once it has
    // stopped moving — two reads that agree — never after a guessed sleep.
    //
    // Wave 38: those reads happen IN the page, every animation frame, not from
    // here. Combat with no attackers is on screen for about a tenth of a
    // second: on the seeded game this spec plays, the server auto-passes every
    // combat step of all three turns (`auto-passed`, both seats, no ask in
    // between — the bots never get to hold it open) in 80–110 ms, and the game
    // is over on turn 4. A Node-side read — the watcher's 100 ms loop, or one
    // made after the poll below notices combat — lands after combat has gone,
    // reads `[data-combat]` as null every time, and threw "the rail's height
    // never stabilized (last read: null)" on every run. A frame loop
    // advances on the same clock as the transition, so "the previous frame
    // read the same height" is the settled rail at any host speed, and the
    // first such frame is kept: the rail as it stood inside combat, read while
    // it still was.
    type RailSample = { names: string[]; rows: number; box: number[]; rowH: number[]; diag: { liveH: number | null; headerH: number | null; docClientH: number } };
    const recordCombatRail = (f: Friend) =>
      f.page.evaluate(() => {
        const rec: { stable: RailSample | null; maxH: number } = { stable: null, maxH: 0 };
        (window as unknown as { __combatRail: typeof rec }).__combatRail = rec;
        let prev: number | null = null;
        const tick = () => {
          const rail = document.querySelector('[data-testid="live-phases"][data-combat]');
          if (rail === null) prev = null;
          else {
            const b = rail.getBoundingClientRect();
            rec.maxH = Math.max(rec.maxH, b.height);
            if (prev !== null && Math.abs(b.height - prev) <= 0.01) {
              const h = (sel: string) => {
                const el = document.querySelector(sel);
                return el === null ? null : Math.round(el.getBoundingClientRect().height * 100) / 100;
              };
              rec.stable = {
                names: Array.from(rail.querySelectorAll('.live__step-name')).map((n) => n.textContent?.trim() ?? ''),
                rows: rail.querySelectorAll('.live__step').length,
                box: [b.x, b.y, b.width, b.height],
                rowH: Array.from(rail.querySelectorAll('.live__step')).map((e) => e.getBoundingClientRect().height),
                diag: { liveH: h('.live'), headerH: h('.app-header'), docClientH: document.documentElement.clientHeight },
              };
              return;
            }
            prev = b.height;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    // Whichever seat settled in combat first — Forge's RNG decides that, not this test.
    const settledCombatRail = async () => {
      for (const f of [alice, bob]) {
        const rec = await f.page.evaluate(() => (window as unknown as { __combatRail?: { stable: RailSample | null; maxH: number } }).__combatRail ?? null);
        if (rec?.stable) return { who: f.name, maxH: rec.maxH, ...rec.stable };
      }
      return null;
    };

    // Before the game has a phase at all: combat is ONE row.
    const outside = await names(alice);
    expect(outside.filter((n) => /combat/i.test(n)), 'one combat row outside combat').toEqual(['Combat']);
    const outsideCount = await rows.count();
    const outsideBoxes = { alice: await railBox(alice), bob: await railBox(bob) };
    // Wave 32 Q3: the names are not bulleted and are centred, and a row is as
    // tall outside combat as inside it (w31's collapse had left the rail at the
    // six-step height, stretching the rows).
    const rowLook = async (f: Friend) =>
      f.page.evaluate(() => {
        const step = document.querySelector<HTMLElement>('.live__step');
        const name = document.querySelector<HTMLElement>('.live__step-name');
        if (step === null || name === null) return null;
        const list = step.closest('ol,ul') ?? step.parentElement!;
        const align = (el: Element): string => {
          const cs = getComputedStyle(el);
          // `start`/`left` are left-justified; a flex row justifies by `justify-content`.
          return `${cs.textAlign}|${cs.display.includes('flex') ? cs.justifyContent : '-'}`;
        };
        return {
          bullet: [getComputedStyle(list).listStyleType, getComputedStyle(step).listStyleType, getComputedStyle(step, '::marker').content],
          alignStep: align(step),
          alignName: align(name),
          rowHeights: Array.from(document.querySelectorAll('.live__step')).map((e) => e.getBoundingClientRect().height),
        };
      });
    const outsideLook = await rowLook(alice);
    const outsideDiag = await railDiag(alice);
    expect(outsideLook, 'the rail has rows to inspect').not.toBeNull();
    for (const kind of outsideLook!.bullet.slice(0, 2)) expect(kind, 'phase names are not bulleted').toBe('none');
    // The ledger's wording ("phase names centred and un-bulleted") is read as lane L read it: the
    // names are centred, with no bullet. (If the operator meant left-justified, this is the line.)
    expect(outsideLook!.alignName, 'phase names are centred in their row').toMatch(/center/);
    expect(outsideBoxes.alice, 'the rail has a box to keep').not.toBeNull();

    for (const f of [alice, bob]) await recordCombatRail(f);
    await playFirst(alice);
    await answerConfirm(alice.page, 'yes'); // keep — wave 36 T4: Keep/Mulligan is a ConfirmPrompt now
    hands.push(await connectHands(alice, 0), await connectHands(bob, 1));

    // Combat is MEASURED from here on by `recordCombatRail`, in the page; this
    // loop only answers the asks the game raises (a scry), as every spec does.
    const seen: { error: unknown } = { error: null };
    const got: { rail: Awaited<ReturnType<typeof settledCombatRail>> } = { rail: null };
    let watching = true;
    const watcher = (async () => {
      try {
        while (watching) {
          for (const f of [alice, bob]) await answerPrompt(f.page);
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        seen.error = err;
      }
    })();

    try {
      // P12: a log line names a card the board has drawn; hovering the NAME enlarges
      // that tile through the document inspector. Wait for a name, THEN open the log.
      //
      // The log stays CLOSED for this wait: `hands` (the bots) are what
      // actually plays the cards this log needs something to name, and the
      // logbook is now a wide overlay that covers the board while open —
      // leaving it open blocks every hand-card click the bots make
      // (silently; they catch and retry forever), starving the log of card
      // content. Its own content is in the DOM regardless of whether the
      // panel is open — `[hidden]` only changes layout/paint — so the wait
      // below finds a name just as well closed as open; opening is deferred
      // until right before the hover, which does need the panel visible.
      //
      // NOT paused yet either: pausing before this wait also starves the
      // log of content and times out at 90s.
      // `inspectedCardFrom` (`inspect/index.ts`) only shows a log name whose
      // id STILL has a board tile — "a card with no tile drawn... enlarges
      // nothing". A spell that already resolved and left play (an instant,
      // most often) still carries `data-inspect-ids` but names nothing the
      // inspector can show, so `.first()` of every named log line is not
      // good enough: measured directly, it picked "Incinerate" — cast,
      // resolved, gone to the graveyard (shown there as a count, no
      // `[data-card-id]` tile) — and the inspector correctly opened nothing
      // at all, read as a false failure before this was understood. Filter
      // for a name whose id the PAGE ITSELF can still resolve to a tile — a
      // land is certain to qualify, since nothing this spec does removes one
      // from the battlefield.
      const hasTile = async (): Promise<ElementHandle<HTMLElement> | null> =>
        alice.page.evaluateHandle(() => {
          const spans = Array.from(document.querySelectorAll<HTMLElement>('[data-log-card][data-inspect-ids]:not([data-inspect-ids=""])'));
          for (const span of spans) {
            const ids = (span.getAttribute('data-inspect-ids') ?? '').split(',');
            if (ids.some((id: string) => id !== '' && document.querySelector(`[data-card-id="${id}"]`) !== null)) return span;
          }
          return null;
        }, undefined).then(async (h) => {
          const el = h.asElement() as ElementHandle<HTMLElement> | null;
          if (el === null) await h.dispose();
          return el;
        });
      let logNameHandle: ElementHandle<HTMLElement> | null = null;
      await expect
        .poll(
          async () => {
            logNameHandle = await hasTile();
            return logNameHandle !== null;
          },
          { timeout: 90_000, message: 'a log line names a card that still has a tile on the page' },
        )
        .toBe(true);
      expect(await alice.page.getByTestId('live-log-peek').count(), 'there is no second hover surface in the log').toBe(0);
      // Paused for this whole precision window — BEFORE resolving the
      // element handle, not after reading its text (a second draft of this
      // fix put the pause there instead and still hit the race below, by
      // one tick: `named` was read, then an ALREADY-IN-FLIGHT bot tick's own
      // settle-move landed, before `.hover()` ever ran). `await`ed: wave 35
      // R7's `clickCard` can make a single tick span more than one await, so
      // a synchronous `pause()` only stops the NEXT tick — `play/hands.ts`'s
      // own `pause()` now waits out a tick already running too, which is
      // what actually closes this. `hands[0]` (alice's own bot) clicks cards
      // on this SAME page to keep the game moving; wave 35 R7 means a card
      // click can now move ALICE'S OWN MOUSE (settling an Arena-cast
      // gesture) — a real, measured race against this block's own
      // `logNameHandle.hover()` / `mouse.move(2, 2)` (4 of 5 runs failed here
      // with no pause at all; `wave35-evidence/e-runs.md`). `pause()`/
      // `resume()` is this file's own documented tool for exactly this ("hold
      // it still while a spec measures the board" — `play/hands.ts`'s header).
      for (const h of hands) await h.pause();
      // Open the log now: both bots are paused (no more card clicks for the
      // wide overlay to block), and the hover below needs the panel actually
      // visible, not just present in the DOM.
      await alice.page.getByTestId('live-log-toggle').click();
      await expect(alice.page.getByTestId('live-logbook'), 'the log opened').toBeVisible();
      // Re-resolved ONE more time, now that both bots are paused — the poll
      // above can leave `logNameHandle` pointing at a span from a moment ago,
      // and even with a tile-backed name (a land) the earlier text-vs-element
      // race is still real: `.live__log` is pinned-to-bottom
      // (`justify-content: flex-end`), so a line arriving while bots were
      // still live could have shifted everything up, or React could have
      // reused this exact node for a different line (both measured directly
      // against the OLD, hover-based version of this block: a pre-hover
      // snapshot went stale once, a post-hover one still raced a reflow the
      // next time). Both are moot now: fetched fresh after the pause, with
      // both bots confirmed idle, nothing is left to move it.
      const fresh = await hasTile();
      if (fresh !== null) logNameHandle = fresh;
      if (logNameHandle === null) throw new Error('the log name vanished between becoming visible and being handled');
      const named = ((await logNameHandle.textContent()) ?? '').trim();
      // The fix for the inspector's own race (not this spec's precondition):
      // `.hover()` hit-tests PIXELS, and even a tile-backed name's line can
      // still slide out from under a remembered bounding box while the panel
      // reflows (`.live__log`'s `flex-end` again). `inspect/index.ts`'s own
      // header: "the keyboard gets what the pointer gets: a card name in the
      // log is a tab stop, and focusing it shows the card the same way
      // hovering it does" (`onFocusIn` reads `event.target` directly, no
      // coordinate hit-test at all) — `.focus()`/`.blur()` on this SAME
      // pinned handle exercises that already-supported keyboard path instead
      // of working around the pointer one.
      await logNameHandle.focus();
      const inspected = alice.page.locator('[data-board-overlay] [data-inspect]');
      await expect(inspected, 'the inspector the board already has opens on the log name').toHaveCount(1, { timeout: 5_000 });
      await expect(inspected).toContainText(named);
      await logNameHandle.evaluate((el) => el.blur());
      await expect(inspected, 'and closes when focus leaves').toHaveCount(0, { timeout: 5_000 });
      for (const h of hands) h.resume();

      // Into combat: the six steps are there, in place of the one, and the rail did not move.
      await expect
        .poll(async () => (got.rail = await settledCombatRail()) !== null || seen.error !== null, {
          timeout: 120_000,
          message: 'the game reached a combat step and the rail settled in it',
        })
        .toBe(true);
    } finally {
      watching = false;
      await watcher;
    }
    if (seen.error !== null) throw seen.error;
    const combat = got.rail!;
    expect(combat.names.filter((n) => /combat|attackers|blockers|damage/i.test(n)).length, `six combat steps in combat (${combat.names.join(', ')})`).toBe(6);
    expect(combat.names, 'the one "Combat" row is gone while they show').not.toContain('Combat');
    expect(combat.rows, 'the rail grows by the five extra rows').toBe(outsideCount + 5);
    const before = outsideBoxes[combat.who as 'alice' | 'bob']!;
    // Wave 32 Q3 reverses w31's "the rail never moves": it is an overlay in the reserved
    // right gutter, so it GROWS when combat begins (taller, same column) and moves no card.
    expect(combat.box[0], 'the rail keeps its column when combat expands it').toBeCloseTo(before.x, 0);
    expect(combat.box[2], 'and its width').toBeCloseTo(before.width, 0);
    expect(Math.max(combat.box[3]!, combat.maxH), 'the rail is taller in combat than out of it (its tallest, once the transition settled)').toBeGreaterThan(before.height + 20);
    const insideRow = Math.max(...combat.rowH); // the settled frame, not a mid-transition one
    const outsideRow = Math.max(...outsideLook!.rowHeights);
    // Taken in the SAME frame as `combat.rowH`, inside combat.
    const insideDiag = combat.diag;
    // Wave 34 §E2: a cross-state tolerance alone does not catch `.live__step`
    // going back to `flex: 1 1 0` (`wave33-evidence/m-ci-and-mutations.md`: "the
    // e2e rail test still PASSES 3/3" against that exact revert) — the drift a
    // shared-flex-total split produces is sampled across two DIFFERENT moments
    // (an early, pre-combat read and a mid/post-transition one), so its size
    // depends on how much the live chrome drifted between those two reads, not
    // on whether the bug is present; `wave33-evidence/l1-rail-rows.md` measured
    // that drift anywhere from ~0.19px to ~2.16px on the same fixed code, which
    // straddles any single cross-state tolerance that still leaves headroom for
    // real measurement noise.
    //
    // What `--rail-row-h` actually changed, and what a revert cannot fake: each
    // row reads ONE shared CSS value — not a fraction of whatever height
    // `.live__steps` happens to have RIGHT NOW split `n` ways — so every row
    // inside a single, unchanging state (sampled at one instant, no cross-state
    // timing involved at all) must read the bit-identical number. `flex: 1 1 0`
    // cannot do that: it distributes the container's leftover whole pixels
    // across siblings unevenly, which is why l1-rail-rows.md measured real
    // intra-state spread on the old code (8 rows spanning 18.84–19.84px, 13
    // rows spanning 19.02–20.03px) and exactly 0.000px on the fixed one, twice,
    // by two independent methods. This is the assertion that actually isolates
    // L's fix from the sampling noise above.
    const outsideSpread = Math.max(...outsideLook!.rowHeights) - Math.min(...outsideLook!.rowHeights);
    const insideRowHeights = combat.rowH;
    const insideSpread = Math.max(...insideRowHeights) - Math.min(...insideRowHeights);
    expect(
      outsideSpread,
      `every row OUTSIDE combat reads the same height, not a share of the rail's current total — heights ${JSON.stringify(outsideLook!.rowHeights)}`,
    ).toBeLessThanOrEqual(0.02);
    expect(
      insideSpread,
      `every row INSIDE combat reads the same height too — heights ${JSON.stringify(insideRowHeights)}`,
    ).toBeLessThanOrEqual(0.02);
    // The original cross-state claim, kept, and tightened from the old 1px
    // tolerance (itself loosened from 2px by §L1) to 0.02px: `--rail-row-h`
    // does not depend on the row COUNT (it is a fixed `/13` in the formula,
    // not `/var(--rail-rows)`), so the fixed code reads the identical number
    // whether 8 or 13 rows are showing — not merely a close one. When this
    // misses, the diff is explained by `.live` itself having a different
    // measured height between the two samples (formula: row = (0.35·liveH -
    // 29) / 13) — these numbers say what moved it.
    expect(
      Math.abs(insideRow - outsideRow),
      `a rail row is as tall out of combat (${outsideRow}) as in it (${insideRow}) — ` +
        `outside: ${JSON.stringify(outsideDiag)} — inside: ${JSON.stringify(insideDiag)}`,
    ).toBeLessThanOrEqual(0.02);
    // ... and it shrinks afterwards, by CSS alone (the box is measured, not a class).
    await expect
      .poll(async () => {
          const f = combat.who === 'alice' ? alice : bob;
          await answerPrompt(f.page); // the game must keep moving for combat to end
          return (await railBox(f))!.height;
        }, {
        timeout: 120_000,
        message: 'the rail shrinks back to its out-of-combat height when combat is over',
      })
      .toBeLessThanOrEqual(before.height + 1);
  } finally {
    for (const h of hands) await h.close();
    await stack.stop();
  }
});

/* ── 5. nothing to concede once it is over ───────────────────────────── */

test(titled('concede ends the game, and after the end Concede is off on both boards and the server refuses another (P18)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    const { matchId } = await enterMatch(alice, bob, stack.origin);
    await playFirst(alice);
    for (const f of [alice, bob]) await expect(f.page.getByTestId('live-concede'), `${f.name}: Concede is on while the game is`).toBeEnabled();

    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    for (const f of [alice, bob]) {
      await expect(f.page.locator('.board__over'), `${f.name}: the board says the game is over`).toBeVisible({ timeout: 30_000 });
      await expect(f.page.getByTestId('live-concede'), `${f.name}: Concede is off after the end`).toBeDisabled();
    }

    // The page is not the enforcement: another concede from alice's seat is
    // refused. Alice's window closes first, so the raw socket is the one that
    // CONTROLS the seat (a spectator's act would be refused for that reason instead).
    await alice.context.close();
    const raw = await connectSio(stack.origin, 'alice');
    try {
      const roles: unknown[] = [];
      raw.on('forge:role', (p) => roles.push(p));
      await raw.request('forge:join', { matchId });
      await expect.poll(() => roles, { timeout: 15_000 }).toContainEqual({ matchId, role: 'player' });
      raw.emit('forge:c2s', { matchId, frame: { kind: 'act', method: 'concede' } });
      await expect
        .poll(() => serverLog(stack).filter((l) => l.evt === 'concede-refused' && l.matchId === matchId).length, {
          timeout: 10_000,
          message: 'the server logged a refused concede for the ended match',
        })
        .toBeGreaterThan(0);
    } finally {
      await raw.close();
    }
  } finally {
    await stack.stop();
  }
});

/* ── 6. the board in a light theme ───────────────────────────────────── */

/** WCAG relative-luminance contrast of every drawn piece of text against what is behind it. */
function measureContrast(root: string): {
  bodyLuminance: number;
  checked: number;
  skipped: number;
  worst: { ratio: number; text: string; fg: string; bg: string; where: string }[];
} {
  type Rgba = [number, number, number, number];
  const parse = (css: string): Rgba => {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (m === null) return [0, 0, 0, 0];
    const p = m[1]!.split(/[ ,/]+/).filter((x) => x !== '').map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const lum = ([r, g, b]: Rgba): number => {
    const f = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: 0 | 1 | 2): number => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  /** The colour behind an element, or null when a picture is (art, canvas), which is data. */
  const behind = (el: Element): Rgba | null => {
    const stack: Rgba[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage.includes('url(')) return null;
      if (n.tagName === 'IMG' || n.tagName === 'CANVAS' || n.tagName === 'SVG') return null;
      stack.push(parse(cs.backgroundColor));
      if (stack[stack.length - 1]![3] === 1) break;
    }
    let out: Rgba = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (out[3] < 1) out = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i]!, out);
    return out;
  };

  const scope = document.querySelector(root) ?? document.body;
  const worst: { ratio: number; text: string; fg: string; bg: string; where: string }[] = [];
  let checked = 0;
  let skipped = 0;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    const el = node.parentElement;
    if (text === '' || el === null) continue;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || box.width === 0 || box.height === 0) continue;
    if (el.closest('[aria-hidden="true"], script, style') !== null && el.closest('[aria-hidden="true"]') !== null) continue;
    const bg = behind(el);
    if (bg === null) {
      skipped += 1;
      continue;
    }
    const fg = over(parse(cs.color), bg);
    const [l1, l2] = [lum(fg), lum(bg)];
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    checked += 1;
    worst.push({
      ratio: Math.round(ratio * 100) / 100,
      text: text.slice(0, 40),
      fg: cs.color,
      bg: `rgb(${bg.slice(0, 3).map(Math.round).join(' ')})`,
      where: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`,
    });
  }
  worst.sort((a, b) => a.ratio - b.ratio);
  return { bodyLuminance: lum(parse(getComputedStyle(document.body).backgroundColor)), checked, skipped, worst: worst.slice(0, 12) };
}

/** Below this a person cannot be expected to read it (WCAG AA for large text; body text asks 4.5). */
const MIN_CONTRAST = 3;

for (const theme of ['light', 'ocean-light'] as const) {
test(titled(`the board in the ${theme} theme follows the theme and its text is legible (P4)`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    // `@wolffm/themes` restores the last theme from storage on a cold load.
    await alice.context.addInitScript((name: string) => {
      try {
        localStorage.setItem('hadoku-theme', name);
        sessionStorage.setItem('hadoku-theme', name);
      } catch {
        /* a context that refuses storage is reported by the theme assertion below */
      }
    }, theme);
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await enterMatch(alice, bob, stack.origin);
    // `light` is the package's default and is painted as NO attribute at all
    // (`setTheme` in `@wolffm/themes`), so the attribute is only asserted for the other.
    if (theme === 'light') await expect(alice.page.locator('html')).not.toHaveAttribute('data-theme', /./);
    else await expect(alice.page.locator('html')).toHaveAttribute('data-theme', theme);
    // Let the opening question and the hand settle so the measured board is a full one.
    await playFirst(alice);
    await expect(handCards(alice.page)).toHaveCount(7, { timeout: 30_000 });

    const board = await alice.page.evaluate(measureContrast, '[data-testid="match"]');
    console.log(`[w31] ${theme}: ${board.checked} text runs measured, ${board.skipped} over pictures; worst: ${JSON.stringify(board.worst.slice(0, 6))}`);
    expect(board.checked, 'the measurement looked at real text').toBeGreaterThan(30);
    expect(board.bodyLuminance, 'the page itself is light, so the theme reached the board').toBeGreaterThan(0.5);
    const unreadable = board.worst.filter((w) => w.ratio < MIN_CONTRAST);
    expect(unreadable, `text under ${MIN_CONTRAST}:1 against its background: ${JSON.stringify(unreadable)}`).toEqual([]);
  } finally {
    await stack.stop();
  }
});
}
