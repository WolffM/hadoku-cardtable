/**
 * The table never scrolls — measured on a LIVE match, in every frame.
 *
 * The operator, 2026-09-19: *"this module can NEVER require a scroll bar."*
 * And the button bar *"appearing and disappearing"* was called out as ugly.
 * Both are claims about every frame of a real game, not about a screenshot of
 * one, so this measures them that way.
 *
 * ## What runs
 *
 * The same stack `play.spec.ts` uses — the REAL built server, a real Forge in
 * a child JVM, two browser contexts behind the stand-in edge — and the same
 * product path into the match: alice creates a room, bob opens it, each loads
 * their own deck and readies, and the server starts the match. Alice's window
 * is 1280×800 and bob's is 1366×768, so one match covers both sizes; late in
 * the game they swap, so each size is also seen from the other seat.
 *
 * ## How it measures: a sampler in the page, on every animation frame
 *
 * An init script runs `requestAnimationFrame` for the life of each page. A
 * rAF callback runs after the frame's tasks and before its paint, so what it
 * reads is what that frame shows. On every frame of the match route it
 * records, and on any breach it keeps the first few examples:
 *
 *   - `document.scrollingElement.scrollHeight <= innerHeight` and
 *     `scrollWidth <= innerWidth` — the page itself cannot scroll — and the
 *     same of the match's own box and every box around it, because
 *     watchparty's room frame scrolls on its own and would otherwise hide a
 *     scrollbar from the page-level check;
 *   - once the board is drawn, `live-buttons` has a nonzero box that lies
 *     inside the viewport, with `live-button-ok`, `live-button-cancel` and
 *     `live-says` in it, and that box is at the SAME place and size in every
 *     frame at a given window size — a fixed home, not a bar on demand;
 *   - an open prompt lies inside the viewport and above the bar;
 *   - no battlefield or hand has to scroll internally to show its cards —
 *     the layout FITS them rather than hiding the overflow a level down.
 *
 * ## What the match is driven through, so the frames are the ones that matter
 *
 *   1. the opening prompt (the coin toss) and the mulligan decisions, each
 *      answered by clicking OK on the BOARD of whichever seat Forge asked;
 *   2. several turns of real play: `play/hands.ts` plays lands and spells for
 *      both seats, and every ask the game raises is answered on the board
 *      (`play/prompts.ts`), so battlefields fill up and turns change;
 *   3. a question open on each side — Forge's own `showConfirmDialog` through
 *      the probe route — with the page measured while it is up;
 *   4. the window sizes swapped, and measured again.
 *
 * Then the samples are read back and asserted, with minimums (frames sampled,
 * turns seen, cards on a battlefield, prompts seen) so a sampler that looked
 * at nothing, or a game that never got past the coin toss, cannot pass.
 *
 * Needs a Forge build, exactly as `play.spec.ts`: `CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`. Without them it SKIPS and its title says why, so the
 * Playwright summary reports a skip rather than a silent pass. CI sets both.
 *
 * `CARDTABLE_E2E_TABLE_SHOTS=<dir>` also saves a screenshot of each page at
 * each moment above, for a person to look at. Off by default; nothing is ever
 * written into the repo.
 *
 * Evidence (gitignored, text only): `e2e/.run/table-fit-summary.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { connectHands, type Hands } from './play/hands.ts';
import { forgeAvailability, RUN_DIR, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';

const PREFIX = '/cardtable';
/** Play at least this far, so both battlefields hold a real board. */
const MIN_TURN = 12;
const PLAY_BUDGET_MS = 4 * 60_000;
/** How long Forge may wait on one question before the board answers it itself. */
const STUCK_MS = 5_000;
const SIZES = { alice: { width: 1280, height: 800 }, bob: { width: 1366, height: 768 } } as const;
const SHOTS = process.env.CARDTABLE_E2E_TABLE_SHOTS ?? '';

const forge = forgeAvailability();
const TITLE = forge.ok
  ? 'a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window'
  : `a live match fits 1280×800 and 1366×768 in every frame — SKIPPED: ${forge.reason}`;

/* ── the sampler, which runs inside each page ────────────────────────── */

interface Breach {
  t: number;
  what: string;
  size: string;
  turn: string | null;
}

interface FitSamples {
  frames: number;
  matchFrames: number;
  boardFrames: number;
  promptFrames: number;
  breaches: Record<string, number>;
  examples: Breach[];
  /** Per window size: every distinct box the bar was drawn in, as "top,left,width,height". */
  barBoxes: Record<string, string[]>;
  turns: string[];
  says: string[];
  maxBattlefield: number;
  maxHand: number;
}

declare global {
  interface Window {
    __fit?: FitSamples;
  }
}

/** Installed with `addInitScript`, so it is serialised: everything it uses is inside it. */
function installSampler(): void {
  const fit: FitSamples = {
    frames: 0,
    matchFrames: 0,
    boardFrames: 0,
    promptFrames: 0,
    breaches: {},
    examples: [],
    barBoxes: {},
    turns: [],
    says: [],
    maxBattlefield: 0,
    maxHand: 0,
  };
  window.__fit = fit;
  const breach = (what: string): void => {
    fit.breaches[what] = (fit.breaches[what] ?? 0) + 1;
    if (fit.examples.length < 25) {
      fit.examples.push({
        t: Date.now(),
        what,
        size: `${innerWidth}x${innerHeight}`,
        turn: document.querySelector('[data-testid="turn"]')?.textContent ?? null,
      });
    }
  };
  const inside = (r: DOMRect): boolean =>
    r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;

  const tick = (): void => {
    fit.frames += 1;
    const match = document.querySelector<HTMLElement>('[data-testid="match"]');
    if (match !== null) {
      fit.matchFrames += 1;
      const page = document.scrollingElement ?? document.documentElement;
      if (page.scrollHeight > innerHeight) breach(`page scrolls vertically (${page.scrollHeight} > ${innerHeight})`);
      if (page.scrollWidth > innerWidth) breach(`page scrolls sideways (${page.scrollWidth} > ${innerWidth})`);
      // Not only the page: watchparty's room frame, which the match sits in,
      // is `overflow: auto`, so a match taller than the frame would show a
      // scrollbar THERE while the page measured clean. The match's own box
      // and every box around it must hold what is in them.
      for (let el: HTMLElement | null = match; el !== null && el !== document.documentElement; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
          breach(`${el.className === '' ? el.tagName.toLowerCase() : el.className} overflows its box`);
        }
      }

      const board = document.querySelector('[aria-label="Game board"]');
      const bar = document.querySelector('[data-testid="live-buttons"]');
      let barBox: DOMRect | null = null;
      if (board !== null) {
        fit.boardFrames += 1;
        if (bar === null) breach('no button bar');
        else {
          barBox = bar.getBoundingClientRect();
          if (!inside(barBox)) breach('button bar not wholly inside the window');
          for (const id of ['live-button-ok', 'live-button-cancel', 'live-says']) {
            if (bar.querySelector(`[data-testid="${id}"]`) === null) breach(`button bar without ${id}`);
          }
          const size = `${innerWidth}x${innerHeight}`;
          const box = [barBox.top, barBox.left, barBox.width, barBox.height].map((n) => Math.round(n)).join(',');
          const seen = (fit.barBoxes[size] ??= []);
          if (!seen.includes(box)) seen.push(box);
        }
        for (const zone of Array.from(document.querySelectorAll<HTMLElement>('.seat > [data-zone="battlefield"], .seat[data-viewer] > [data-zone="hand"]'))) {
          const kind = zone.dataset.zone ?? '?';
          const count = Number(zone.dataset.count ?? 0);
          if (kind === 'battlefield') fit.maxBattlefield = Math.max(fit.maxBattlefield, count);
          else fit.maxHand = Math.max(fit.maxHand, count);
          if (zone.scrollHeight > zone.clientHeight + 1 || zone.scrollWidth > zone.clientWidth + 1) {
            breach(`${kind} of ${count} cards scrolls inside itself`);
          }
        }
        const turn = document.querySelector('[data-testid="turn"]')?.textContent ?? '';
        if (turn !== '' && !fit.turns.includes(turn)) fit.turns.push(turn);
        const says = bar?.querySelector('[data-testid="live-says"]')?.textContent ?? '';
        if (says !== '' && fit.says.length < 400 && !fit.says.includes(says)) fit.says.push(says);
      }

      const prompt = document.querySelector('[data-testid="live-prompt"]');
      if (prompt !== null) {
        fit.promptFrames += 1;
        const r = prompt.getBoundingClientRect();
        if (!inside(r)) breach('prompt not wholly inside the window');
        if (barBox !== null && r.bottom > barBox.top + 0.5) breach('prompt covers the button bar');
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ── driving ─────────────────────────────────────────────────────────── */

/** A format and two library decks legal in it, the way the room's picker would offer them. */
async function twoLegalDecks(api: APIRequestContext, origin: string): Promise<{ format: string; decks: [string, string] }> {
  const base = `${origin}${PREFIX}/api/tables`;
  const formats = ((await (await api.get(`${base}/formats`)).json()) as { formats: { id: string }[] }).formats;
  const decks = ((await (await api.get(`${base}/decks`)).json()) as { decks: { id: string; name: string }[] }).decks;
  // Draw-go decks first, as `play.spec.ts` does: they cast spells that ASK.
  decks.sort((a, b) => Number(/Caw/.test(b.name)) - Number(/Caw/.test(a.name)));
  for (const f of formats) {
    const legal: string[] = [];
    for (const d of decks) {
      const res = await api.post(`${base}/check`, { data: { deck: { library: d.id }, rules: { kind: 'standard', format: f.id } } });
      if (res.status() === 200 && ((await res.json()) as { legal: boolean }).legal) legal.push(d.id);
      if (legal.length === 2) return { format: f.id, decks: [legal[0], legal[1]] };
    }
  }
  throw new Error(`no format has two legal library decks (${formats.length} formats, ${decks.length} decks)`);
}

async function turnOf(f: Friend): Promise<number> {
  return Number(/Turn (\d+)/.exec((await f.page.getByTestId('turn').textContent()) ?? '')?.[1] ?? 0);
}

async function samples(f: Friend): Promise<FitSamples> {
  const got = await f.page.evaluate(() => window.__fit ?? null);
  if (got === null) throw new Error(`${f.name}: the sampler never ran on this page`);
  return got;
}

/** The same checks the sampler makes, made once from outside at a named moment. */
async function fitsNow(f: Friend, moment: string): Promise<Record<string, unknown>> {
  const m = await f.page.evaluate(() => {
    const page = document.scrollingElement ?? document.documentElement;
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r === undefined ? null : { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    return {
      size: [innerWidth, innerHeight],
      scroll: [page.scrollWidth, page.scrollHeight],
      bar: box('[data-testid="live-buttons"]'),
      prompt: box('[data-testid="live-prompt"]'),
      turn: document.querySelector('[data-testid="turn"]')?.textContent ?? null,
      battlefields: Array.from(document.querySelectorAll<HTMLElement>('.seat > [data-zone="battlefield"]')).map((z) => Number(z.dataset.count)),
    };
  });
  const where = `${f.name} at ${m.size.join('×')}, ${moment}`;
  expect(m.scroll[1], `${where}: the page scrolls vertically`).toBeLessThanOrEqual(m.size[1]);
  expect(m.scroll[0], `${where}: the page scrolls sideways`).toBeLessThanOrEqual(m.size[0]);
  expect(m.bar, `${where}: no button bar`).not.toBeNull();
  expect(m.bar!.height, `${where}: the button bar has no height`).toBeGreaterThan(0);
  expect(m.bar!.bottom, `${where}: the button bar is below the window`).toBeLessThanOrEqual(m.size[1]);
  if (SHOTS !== '') {
    mkdirSync(SHOTS, { recursive: true });
    await f.page.screenshot({ path: resolve(SHOTS, `${moment.replace(/[^a-z0-9]+/gi, '-')}-${f.name}-${m.size.join('x')}.png`) });
  }
  return { moment, ...m };
}

/** What a page is showing right now, for a failure message. */
async function stateOf(f: Friend): Promise<Record<string, unknown>> {
  return {
    name: f.name,
    turn: await f.page.getByTestId('turn').textContent(),
    phase: await f.page.getByTestId('phase').textContent(),
    says: await f.page.getByTestId('live-says').textContent(),
    ok: await f.page.getByTestId('live-button-ok').isEnabled(),
    cancel: await f.page.getByTestId('live-button-cancel').isEnabled(),
    prompt: await f.page.getByTestId('live-prompt').evaluateAll((els) => els.map((e) => e.getAttribute('data-method'))),
    error: await f.page.getByTestId('live-error').allTextContents(),
  };
}

/* ── the test ────────────────────────────────────────────────────────── */

test(TITLE, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);

  const stack = await startPlayStack(forge);
  const hands: Hands[] = [];
  const friends: Friend[] = [];
  const moments: Record<string, unknown>[] = [];
  const summary: Record<string, unknown> = {};
  let promptLoop: Promise<void> | null = null;
  let prompting = false;
  /** A failure inside the background prompt loop, rethrown at the next checkpoint. */
  let promptError: unknown = null;
  const checkPrompts = (): void => {
    if (promptError !== null) throw promptError;
  };

  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    friends.push(alice, bob);
    for (const f of friends) {
      await f.page.setViewportSize(SIZES[f.name as keyof typeof SIZES]);
      await f.context.addInitScript(installSampler);
    }
    const origin = stack.origin;

    /* ── into a match, through the product ─────────────────────────── */

    const choice = await twoLegalDecks(alice.context.request, origin);
    summary.choice = choice;
    await alice.page.goto(`${origin}${PREFIX}/`);
    await alice.page.getByTestId('room-create-name').fill(`e2e table fit ${Date.now()}`);
    await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
    await alice.page.getByTestId('room-create-submit').click();
    await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    const roomUrl = alice.page.url();
    await bob.page.goto(roomUrl);
    for (const [f, deck] of [
      [alice, choice.decks[0]],
      [bob, choice.decks[1]],
    ] as const) {
      await expect(f.page.getByTestId('constructed')).toBeVisible();
      await f.page.getByTestId('format').selectOption(choice.format);
      await f.page.getByTestId('deck-mine').selectOption(deck);
      await f.page.getByTestId('load-deck').click();
      await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
    }
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
    await bob.page.getByTestId('ready-toggle').click();
    const matchUrl = /#\/match\/(m-[0-9a-f]{12})$/;
    await alice.page.waitForURL(matchUrl, { timeout: 120_000 });
    await bob.page.waitForURL(matchUrl, { timeout: 120_000 });
    const matchId = matchUrl.exec(alice.page.url())?.[1];
    if (matchId === undefined) throw new Error(`no match id in ${alice.page.url()}`);
    summary.matchId = matchId;
    await expect(alice.page.getByTestId('live-status')).toHaveText('Seat 1, live.', { timeout: 30_000 });
    await expect(bob.page.getByTestId('live-status')).toHaveText('Seat 2, live.', { timeout: 30_000 });
    for (const f of friends) await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();

    // Asks the game raises are the board's to answer, whenever they come.
    prompting = true;
    promptLoop = (async () => {
      try {
        while (prompting) {
          for (const f of friends) await answerPrompt(f.page);
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (err) {
        promptError = err;
      }
    })();

    /* ── 1. the coin toss and the mulligans, on the board ──────────── */

    const enabledOk = (f: Friend) => f.page.locator('[data-testid="live-button-ok"]:enabled');
    const opening: { who: string; says: string | null }[] = [];
    const openingDeadline = Date.now() + 90_000;
    while ((await turnOf(alice)) < 1) {
      checkPrompts();
      if (Date.now() > openingDeadline) throw new Error(`the game never reached turn 1; answered on the board: ${JSON.stringify(opening)}`);
      for (const f of friends) {
        if ((await enabledOk(f).count()) === 0) continue;
        const says = await f.page.getByTestId('live-says').textContent();
        for (const g of friends) moments.push(await fitsNow(g, `opening ${opening.length + 1}`));
        await enabledOk(f).click();
        opening.push({ who: f.name, says });
        // Wait for Forge to move on before looking again: an OK that is still
        // enabled because the next updateButtons has not landed yet would
        // answer the NEXT question.
        await expect
          .poll(async () => (await enabledOk(f).count()) === 0 || (await f.page.getByTestId('live-says').textContent()) !== says, {
            timeout: 30_000,
            message: `${f.name}: Forge never moved on from ${JSON.stringify(says)}`,
          })
          .toBe(true);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    summary.opening = opening;
    console.log(`[table-fit] the opening, answered on the board: ${JSON.stringify(opening)}`);
    expect(opening.length, 'the coin toss and at least one keep were answered on the board').toBeGreaterThanOrEqual(2);

    /* ── 2. real play, until both battlefields are a board ─────────── */

    for (const f of friends) hands.push(await connectHands(origin, f.name, matchId));
    const playDeadline = Date.now() + PLAY_BUDGET_MS;
    let lastTurn = await turnOf(alice);
    const discards: { who: string; turn: number }[] = [];
    const unstuck: { who: string; says: string; pressed: string }[] = [];
    const waiting = new Map<string, { says: string; since: number }>();
    while ((await turnOf(alice)) < MIN_TURN) {
      checkPrompts();
      if (Date.now() > playDeadline) {
        throw new Error(
          `within ${PLAY_BUDGET_MS} ms the game reached turn ${await turnOf(alice)}, wanted ${MIN_TURN}; ` +
            `state: ${JSON.stringify(await Promise.all(friends.map(stateOf)))}; ` +
            `hands: ${hands.map((h) => h.log.slice(-6).join(' | ')).join(' || ')}`,
        );
      }
      if ((await alice.page.locator('.board__over').count()) > 0) throw new Error(`the game ended at turn ${await turnOf(alice)}`);
      // The cleanup discard, clicked on the BOARD: Forge marks the hand
      // selectable and says so. (`hands.ts` remembers a discard by its
      // message, so from the second identical one on it would wait forever.)
      for (const f of friends) {
        const says = (await f.page.getByTestId('live-says').textContent()) ?? '';
        if (!/discard/i.test(says)) continue;
        const card = f.page.locator('.seat[data-viewer] [data-zone="hand"] li[data-selectable] button').first();
        if ((await card.count()) === 0) continue;
        await card.click();
        discards.push({ who: f.name, turn: await turnOf(f) });
        await expect
          .poll(async () => (await f.page.getByTestId('live-says').textContent()) !== says, {
            timeout: 30_000,
            message: `${f.name}: Forge never moved on from the discard`,
          })
          .toBe(true);
      }
      // And when `hands.ts` has lost track — it can, mid mana payment, or
      // aiming a creature-only effect at a player — the person does what a
      // person would once Forge has waited a while: presses OK on their own
      // board, or else clicks a card Forge marked selectable, or else Cancel.
      for (const f of friends) {
        const says = (await f.page.getByTestId('live-says').textContent()) ?? '';
        const seen = waiting.get(f.name);
        if (seen === undefined || seen.says !== says) {
          waiting.set(f.name, { says, since: Date.now() });
          continue;
        }
        if (Date.now() - seen.since < STUCK_MS || (await f.page.getByTestId('live-prompt').count()) > 0) continue;
        const selectable = f.page.locator('[aria-label="Game board"] li[data-selectable] button');
        const cancel = f.page.locator('[data-testid="live-button-cancel"]:enabled');
        const press = (await enabledOk(f).count()) > 0 ? enabledOk(f) : (await selectable.count()) > 0 ? selectable.first() : cancel;
        if ((await press.count()) === 0) continue;
        const pressed = (await press.getAttribute('data-testid')) ?? (await press.getAttribute('aria-label')) ?? '?';
        await press.click();
        unstuck.push({ who: f.name, says, pressed });
        waiting.delete(f.name);
      }
      const turn = await turnOf(alice);
      if (turn !== lastTurn) {
        lastTurn = turn;
        for (const g of friends) moments.push(await fitsNow(g, `turn ${turn}`));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    summary.discardsOnTheBoard = discards;
    summary.boardAnswersWhenHandsStalled = unstuck;
    for (const h of hands) h.pause();
    await new Promise((r) => setTimeout(r, 2_000));
    for (const g of friends) moments.push(await fitsNow(g, 'mid-game'));

    /* ── 3. a question open on each side ───────────────────────────── */

    prompting = false;
    await promptLoop;
    promptLoop = null;
    checkPrompts();
    const probe = (seat: number) =>
      alice.context.request.post(`${origin}${PREFIX}/api/play/matches/${matchId}/probe`, {
        data: { seat, message: 'e2e table fit: is this question inside the window?' },
        timeout: 120_000,
      });
    for (const [f, seat] of [
      [alice, 0],
      [bob, 1],
    ] as const) {
      const pending = probe(seat);
      const dialog = f.page.getByTestId('confirm-dialog');
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(f.page.getByTestId('live-button-ok'), `${f.name}: the bar stays, disabled, under an open question`).toBeDisabled();
      moments.push(await fitsNow(f, 'question open'));
      await dialog.locator('[data-answer="yes"]').click();
      expect((await pending).status(), `${f.name}: Forge got the answer`).toBe(200);
    }

    /* ── 4. the other window size, from each seat ──────────────────── */

    await alice.page.setViewportSize(SIZES.bob);
    await bob.page.setViewportSize(SIZES.alice);
    await new Promise((r) => setTimeout(r, 1_000));
    for (const g of friends) moments.push(await fitsNow(g, 'sizes swapped'));

    /* ── what every frame said ─────────────────────────────────────── */

    const fit: Record<string, FitSamples> = {};
    for (const f of friends) fit[f.name] = await samples(f);
    summary.samples = fit;
    summary.moments = moments;
    for (const f of friends) {
      const s = fit[f.name];
      console.log(
        `[table-fit] ${f.name}: ${s.matchFrames} match frames, ${s.boardFrames} with the board, ${s.promptFrames} with a prompt; ` +
          `turns ${s.turns.length}; largest battlefield ${s.maxBattlefield}, hand ${s.maxHand}; bar boxes ${JSON.stringify(s.barBoxes)}; ` +
          `breaches ${JSON.stringify(s.breaches)}`,
      );
    }

    for (const f of friends) {
      const s = fit[f.name];
      // The sampler looked at a real game, not at nothing.
      expect(s.boardFrames, `${f.name}: frames sampled with the board drawn`).toBeGreaterThan(500);
      expect(s.promptFrames, `${f.name}: frames sampled with a question open`).toBeGreaterThan(0);
      expect(s.turns.length, `${f.name}: distinct turns seen`).toBeGreaterThanOrEqual(MIN_TURN);
      expect(s.maxBattlefield, `${f.name}: the largest battlefield seen`).toBeGreaterThanOrEqual(8);
      expect(Object.keys(s.barBoxes).sort(), `${f.name}: both window sizes were sampled`).toEqual(['1280x800', '1366x768']);
      // And in every one of those frames:
      expect(s.breaches, `${f.name}: every frame fits (first breaches: ${JSON.stringify(s.examples.slice(0, 5))})`).toEqual({});
      for (const [size, boxes] of Object.entries(s.barBoxes)) {
        expect(boxes, `${f.name} at ${size}: the button bar has one home`).toHaveLength(1);
      }
    }
  } finally {
    prompting = false;
    // The loop keeps its own failure in `promptError`, so this never rejects.
    if (promptLoop !== null) await promptLoop;
    for (const h of hands) await h.close();
    for (const h of hands) writeFileSync(resolve(RUN_DIR, `table-fit-seat${h.seat}.hands.log`), h.log.join('\n'));
    for (const f of friends) await f.context.close();
    await stack.stop();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(resolve(RUN_DIR, 'table-fit-summary.json'), JSON.stringify(summary, null, 2));
  }
});
