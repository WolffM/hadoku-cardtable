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
 *     inside the viewport, with `live-button-ok` and `live-button-cancel` in it
 *     and NO text row (wave 25 §C took Forge's line and the log out of the
 *     corner), and that box is at the SAME place and size in every frame at a
 *     given window size — a fixed home, not a bar on demand;
 *   - an open prompt lies inside the viewport and above the bar;
 *   - no battlefield or hand has to scroll internally to show its cards —
 *     the layout FITS them rather than hiding the overflow a level down.
 *
 * ## What the match is driven through, so the frames are the ones that matter
 *
 *   1. the opening prompt (the coin toss) and the mulligan decisions, each
 *      answered by clicking OK on the BOARD of whichever seat Forge asked;
 *   2. real play, until turn 12 AND a battlefield of 8, under a hard cap:
 *      `play/hands.ts` plays lands and spells for both seats, and every ask
 *      the game raises is answered on the board (`play/prompts.ts`), so
 *      battlefields fill up and turns change;
 *   2b. the player arranges their own battlefield: a real permanent dragged
 *      into another row with the browser's own drag events, asserted card by
 *      card, and asserted AGAIN after step 3 has re-rendered the board — the
 *      arrangement is the player's and nothing the engine does may take it
 *      away (wave 20 §A.2);
 *   3. a question open on each side — Forge's own `showConfirmDialog` through
 *      the probe route — with the page measured while it is up;
 *   4. the window sizes swapped, and measured again.
 *
 * Then the samples are read back and asserted, with minimums (frames sampled,
 * turns seen, cards on a battlefield, prompts seen) so a sampler that looked
 * at nothing, or a game that never got past the coin toss, cannot pass.
 *
 * ## The static canvas, and a crowded table (the second test)
 *
 * The second test parks a live match on its first keep-or-mulligan question
 * and runs two DOM-only layout probes, at both window sizes from both seats.
 *
 * The first **fills the stack** to 0, 1, 5 and 12 items and measures every
 * slot on the board — the bar, both seats, the centre band, every zone, both
 * player faces and the overlay root. Every one of those boxes must be the
 * same number at all four. The operator, 2026-09-24: *"the location for the
 * stack causes the field to change in size. this can never happen. the entire
 * canvas must be fully static at all times."* What does not fit goes sideways
 * inside the stack's own slot, never downward and never into a neighbour. It
 * also checks that the overlay root covers the board exactly, that a face is
 * big enough to aim at, that the two faces are at OPPOSITE ENDS of the canvas
 * with the stack's band between them (wave 20 §A.3), that the battlefield
 * draws its four rows in order, that the hand and the battlefield are not
 * painted the same, and that no empty-state text came back.
 *
 * The second **fills the table**:
 *
 * a real game reaches 8–11 permanents a side by turn 12, so the first test
 * cannot promise to have seen a crowd — and an 11-card battlefield at
 * 1280×800 was exactly what broke (a status chip wider than the shrunken card
 * made the zone scroll sideways). So it fills both battlefields to 8, 11, 16
 * and 20 cards and the hand to 10, asserting that no zone scrolls, the page
 * does not, and no card is narrower than its floor.
 *
 * The crowd is spread over the battlefield's four rows the way a real board
 * fills up — mostly lands and creatures — so three rows are occupied at the
 * small steps and all four at the big ones, which is the case where the rows
 * share the slot most thinly. No ROW may scroll either, the rows that hold
 * cards share the slot equally, and a row that holds nothing is a label strip.
 * A grouped card's floor is lower than a single row's and says why
 * (`MIN_GROUPED_CARD_PX`).
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
/** Play at least this far, so the check has seen many turn transitions. */
const MIN_TURN = 12;
/**
 * And until each page has seen a battlefield this big, so the fit is measured
 * on a crowded table rather than an empty one. A real game reaches it at a
 * turn that varies with the shuffle, so the spec PLAYS until it does.
 */
const MIN_BATTLEFIELD = 8;
/**
 * The hard cap on that: past this turn, or this long, the run fails and says
 * how far it got. Setup (~30 s), the opening (≤ 90 s) and the checks after
 * play (~30 s) plus this budget stay inside the 10-minute test timeout.
 */
const MAX_TURN = 40;
const PLAY_BUDGET_MS = 6 * 60_000;
/** How long Forge may wait on one question before the board answers it itself. */
const STUCK_MS = 5_000;
const SIZES = { alice: { width: 1280, height: 800 }, bob: { width: 1366, height: 768 } } as const;
const SHOTS = process.env.CARDTABLE_E2E_TABLE_SHOTS ?? '';

const forge = forgeAvailability();
const TITLE = forge.ok
  ? 'a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window'
  : `a live match fits 1280×800 and 1366×768 in every frame — SKIPPED: ${forge.reason}`;
const CROWD_TITLE = forge.ok
  ? 'the canvas is static as the stack fills, and a crowded table fits too: 8, 11, 16 and 20 permanents a side and a hand of 10, at 1280×800 and 1366×768, with no zone scrolling'
  : `the canvas is static and a crowded table fits too — SKIPPED: ${forge.reason}`;

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
        const tall = el.scrollHeight > el.clientHeight + 1;
        const wide = el.scrollWidth > el.clientWidth + 1;
        if (tall || wide) {
          // Which axis, by how much, and WHAT stuck out: "overflows its box"
          // alone names neither the dimension nor the element, and this box has
          // the whole match in it.
          const by = tall ? `${el.scrollHeight}h > ${el.clientHeight}h` : `${el.scrollWidth}w > ${el.clientWidth}w`;
          const box = el.getBoundingClientRect();
          let worst = '?';
          let over = 0;
          /*
           * Only elements nothing CLIPS can grow `el`'s scroll box. A card tile
           * whose rules text overflows its own box has a rect far below the
           * window and is invisible — four runs of this spec blamed one of those
           * for a prompt's overflow before this check was here.
           *
           * And the walk is up the CONTAINING BLOCK, not up the parents: an
           * `overflow` ancestor does not clip a positioned descendant unless it
           * is in that descendant's containing-block chain. Walking parents
           * calls such an element clipped when the browser does not — which is
           * how a visually-hidden `position: absolute` input inside a scrolling
           * sheet grew the match shell while every candidate this loop could
           * name came back "clipped" and the blame fell on an innocent card
           * tile. `offsetParent` IS that chain: for a positioned box it is the
           * nearest positioned ancestor, which is the only ancestor below which
           * nothing clips it.
           */
          const clipped = (node: HTMLElement): boolean => {
            for (let cur = node; ; ) {
              const position = getComputedStyle(cur).position;
              // A fixed box is in the viewport's coordinate space and grows no
              // ancestor's scroll box at all, so it can never be the answer.
              if (position === 'fixed') return true;
              const up = position === 'absolute' ? cur.offsetParent : cur.parentElement;
              if (!(up instanceof HTMLElement) || up === el) return false;
              if (getComputedStyle(up).overflow !== 'visible') return true;
              cur = up;
            }
          };
          // With its ancestry, up to the match: the element that sticks out is
          // often a card tile, and WHOSE tile is the whole question.
          const path = (kid: HTMLElement): string => {
            const where: string[] = [];
            for (let up: HTMLElement | null = kid; up !== null && up !== el && where.length < 9; up = up.parentElement) {
              const zone = up.dataset.zone === undefined ? '' : `[${up.dataset.owner ?? '?'}/${up.dataset.zone}]`;
              where.push(`${up.tagName.toLowerCase()}.${up.className.replace(/\s+/g, '.')}${zone}`);
            }
            return where.reverse().join(' > ');
          };
          let anyWorst = 'nothing hangs below';
          let anyOver = 0;
          for (const kid of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
            const r = kid.getBoundingClientRect();
            const out = tall ? r.bottom - box.bottom : r.right - box.right;
            if (out > anyOver) {
              anyOver = out;
              anyWorst = path(kid);
            }
            if (out > over && !clipped(kid)) {
              over = out;
              // Its `position`, and what holds it if it is positioned: a box
              // that escaped a scroller's clip did so by being positioned
              // against something further out, and naming that is the fix.
              const where = getComputedStyle(kid).position;
              const holder = kid.offsetParent;
              worst =
                where === 'static'
                  ? path(kid)
                  : `${path(kid)} (${where} in ${holder === null ? 'the viewport' : `${holder.tagName.toLowerCase()}.${holder.className.replace(/\s+/g, '.')}`})`;
            }
          }
          // Both, because the clipped one is the more readable answer when
          // nothing unclipped sticks out at all.
          const blame = over > 0 ? `${worst} +${Math.round(over)}` : `clipped: ${anyWorst} +${Math.round(anyOver)}`;
          // And which question was open, if one was: a prompt is the usual
          // reason a fixed canvas suddenly has more in it than it can hold.
          const asking =
            document.querySelector<HTMLElement>('[data-testid="live-prompt"]')?.dataset.method ??
            (document.querySelector('[data-testid="live-payment-host"]') === null ? 'none' : 'a payment');
          breach(
            `${el.className === '' ? el.tagName.toLowerCase() : el.className} overflows its box (${by}, ${blame}, asking ${asking})`,
          );
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
          for (const id of ['live-button-ok', 'live-button-cancel']) {
            if (bar.querySelector(`[data-testid="${id}"]`) === null) breach(`button bar without ${id}`);
          }
          /*
           * Wave 25 §C: *"i mostly hate all the text in the bottom right it's
           * totally useless"*. Forge's line and the log are in `live-logbook`
           * now, so a corner with either of them back in it is the regression —
           * and it is asserted on every frame, like the box itself.
           */
          for (const id of ['live-says', 'live-log']) {
            if (bar.querySelector(`[data-testid="${id}"]`) !== null) breach(`the corner is talking again (${id})`);
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
        /*
         * The two overlays wave 25 §C moved, measured on every frame like the
         * cluster: the logbook must stay in the window and clear of the cluster's
         * home, and the phase rail's current-step NAME must stay in the window —
         * the rail moved to the right edge, and a name that still hung out to the
         * right of it would run off the screen. That is the whole failure mode of
         * §C.4 and this is where it would be caught.
         */
        const logbook = document.querySelector<HTMLElement>('[data-testid="live-logbook"]');
        if (logbook !== null && !logbook.hidden) {
          const r = logbook.getBoundingClientRect();
          if (!inside(r)) breach('the logbook is not wholly inside the window');
          if (barBox !== null && r.right > barBox.left + 0.5 && r.bottom > barBox.top + 0.5) {
            breach('the logbook reaches the control cluster');
          }
        }
        const stepName = document.querySelector('.live__step[data-current] .live__step-name');
        if (stepName !== null && !inside(stepName.getBoundingClientRect())) {
          breach('the current step’s name is not wholly inside the window');
        }
        const turn = document.querySelector('[data-testid="turn"]')?.textContent ?? '';
        if (turn !== '' && !fit.turns.includes(turn)) fit.turns.push(turn);
        // Forge's own line, read from its new home in the logbook (wave 25 §C):
        // the element moved out of the corner and kept the id it is found by.
        const says = document.querySelector('[data-testid="live-logbook"] [data-testid="live-says"]')?.textContent ?? '';
        if (says !== '' && fit.says.length < 400 && !fit.says.includes(says)) fit.says.push(says);
      }

      /*
       * An open question, and the payment window is one (wave 25 §C.2): the
       * payment carries its OWN id rather than `live-prompt`, because that id
       * means "one of Forge's fifteen asks" to `e2e/play/prompts.ts` and to the
       * stuck detector below. It gets the same two measurements — inside the
       * window, and clear of the cluster's home.
       */
      for (const id of ['live-prompt', 'live-payment-host']) {
        const prompt = document.querySelector(`[data-testid="${id}"]`);
        if (prompt === null) continue;
        fit.promptFrames += 1;
        const r = prompt.getBoundingClientRect();
        if (!inside(r)) breach(`${id} not wholly inside the window`);
        if (barBox !== null && r.bottom > barBox.top + 0.5) breach(`${id} covers the button bar`);
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

/* ── the player's own arrangement, on a real board ────────────────────── */

interface RowCards {
  row: string;
  cards: number[];
}

/** The viewer's own battlefield, row by row: the ids each row draws, in order. */
async function rowsOf(f: Friend): Promise<RowCards[]> {
  return f.page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.seat[data-viewer] > [data-zone="battlefield"] [data-board-row]'),
    ).map((row) => ({
      row: row.dataset.boardRow ?? '?',
      cards: Array.from(row.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li.board-card')).map((c) =>
        Number(c.dataset.cardId),
      ),
    })),
  );
}

/**
 * Drag one permanent into one of the battlefield's rows, with the browser's
 * own drag events and a real `DataTransfer`. Runs in the page.
 *
 * Dispatched rather than mouse-driven because an HTML5 drag is a sequence of
 * four events and this asserts what the BOARD does with them, not what the
 * platform's drag-and-drop feels like. `Board.tsx` remembers the dragged card
 * itself, so the transfer is a courtesy; it is passed anyway, because a real
 * browser passes it.
 */
function dragBetweenRows({ cardId, row }: { cardId: number; row: string }): void {
  const field = document.querySelector('.seat[data-viewer] > [data-zone="battlefield"]');
  if (field === null) throw new Error('no battlefield of your own to arrange');
  // By VALUE: `CardTile` draws its own `data-card-id`, in the `w<id>` namespace.
  const card = field.querySelector<HTMLElement>(`li.board-card[data-card-id="${cardId}"]`);
  const target = field.querySelector<HTMLElement>(`[data-board-row="${row}"]`);
  if (card === null) throw new Error(`no card ${cardId} on your battlefield`);
  if (target === null) throw new Error(`no ${row} row on your battlefield`);
  const dataTransfer = new DataTransfer();
  const fire = (el: Element, type: string): void => {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  };
  fire(card, 'dragstart');
  fire(target, 'dragover');
  fire(target, 'drop');
  fire(card, 'dragend');
}

/** What a page is showing right now, for a failure message. */
async function stateOf(f: Friend): Promise<Record<string, unknown>> {
  return {
    name: f.name,
    turn: await f.page.getByTestId('turn').textContent(),
    phase: await f.page.getByTestId('phase').textContent(),
    // Forge's own line, in the logbook now (wave 25 §C) — same id, new home.
    says: await f.page.getByTestId('live-says').textContent(),
    ok: await f.page.getByTestId('live-button-ok').isEnabled(),
    cancel: await f.page.getByTestId('live-button-cancel').isEnabled(),
    prompt: await f.page.getByTestId('live-prompt').evaluateAll((els) => els.map((e) => e.getAttribute('data-method'))),
    // `evaluateAll`, not `textContent`: it resolves at once with nothing when the
    // window is closed, where `textContent` would wait out its whole timeout in
    // the one place that must not be slow — the failure message.
    payment: await f.page.getByTestId('live-payment').evaluateAll((els) => els.map((e) => e.textContent)),
    error: await f.page.getByTestId('live-error').allTextContents(),
  };
}

/**
 * Into a match, through the product: alice creates a room, bob opens it, each
 * loads their own deck and readies, and the server starts the match. Returns
 * with both boards drawn.
 */
async function enterMatch(alice: Friend, bob: Friend, origin: string, summary: Record<string, unknown>): Promise<string> {
  const friends = [alice, bob];
  const choice = await twoLegalDecks(alice.context.request, origin);
  summary.choice = choice;
  await alice.page.goto(`${origin}${PREFIX}/`);
  await alice.page.getByTestId('room-create-name').fill(`e2e table fit ${Date.now()}`);
  await alice.page.getByTestId('room-create-type').selectOption('constructed-1v1');
  await alice.page.getByTestId('room-create-submit').click();
  await alice.page.waitForURL(/#\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
  await bob.page.goto(alice.page.url());
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('constructed')).toBeVisible();
    await f.page.getByTestId('format').selectOption(choice.format);
    // Choosing the deck IS loading it: there is no Load button any more (wave
    // 22 §B). The picker is dead until the era's own legality sweep answers,
    // and it then offers only the decks that era holds — so wait for it to
    // come alive rather than selecting into the last era's list.
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    await f.page.getByTestId('deck-mine').selectOption(deck);
    await expect(f.page.getByTestId('verdict-mine'), `${f.name}: their own deck is legal`).toContainText('Legal in');
  }
  await alice.page.getByTestId('ready-toggle').click();
  await expect(alice.page.getByTestId('ready-toggle')).toHaveAttribute('aria-pressed', 'true');
  // The room's table with one seat ready and one not, for a person to look at:
  // both states of both pills are on this screen at once (wave 20 §A.4).
  if (SHOTS !== '') {
    mkdirSync(SHOTS, { recursive: true });
    await bob.page.screenshot({ path: resolve(SHOTS, 'room-table-bob.png') });
  }
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
  /*
   * Open the log on both pages (wave 25 §C.3).
   *
   * Forge's own message used to be a permanent row in the control cluster and
   * this spec drove the whole game off it. The operator's complaint was exactly
   * that it was always on screen, so it is collapsed now and the cluster's own
   * `Log` toggle is how it comes back — a real press on a real control. Opening
   * it here keeps the signal this spec polls (`live-says`, in its new home) and
   * puts the panel on screen for every frame the sampler measures, which is what
   * proves the new overlay fits too.
   */
  for (const f of friends) {
    const toggle = f.page.getByTestId('live-log-toggle');
    await expect(toggle, `${f.name}: the log is collapsed by default`).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(f.page.getByTestId('live-logbook'), `${f.name}: the log opened`).toBeVisible();
  }
  return matchId;
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

    const matchId = await enterMatch(alice, bob, origin, summary);

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
    const attempts = new Map<string, number>();
    // The largest battlefield each PAGE's sampler has seen — the number the
    // assertion below reads — so the loop stops on exactly what is asserted.
    const largestSeen = async (): Promise<number> => Math.min(...(await Promise.all(friends.map(async (f) => (await samples(f)).maxBattlefield))));
    const farEnough = async (): Promise<boolean> => (await turnOf(alice)) >= MIN_TURN && (await largestSeen()) >= MIN_BATTLEFIELD;
    const howFar = async (): Promise<string> =>
      `turn ${await turnOf(alice)} (wanted >= ${MIN_TURN}), largest battlefield seen ${await largestSeen()} (wanted >= ${MIN_BATTLEFIELD})`;
    while (!(await farEnough())) {
      checkPrompts();
      if (Date.now() > playDeadline || (await turnOf(alice)) > MAX_TURN) {
        throw new Error(
          `the play cap was hit (${PLAY_BUDGET_MS} ms or turn ${MAX_TURN}) at ${await howFar()}; ` +
            `state: ${JSON.stringify(await Promise.all(friends.map(stateOf)))}; ` +
            `hands: ${hands.map((h) => h.log.slice(-6).join(' | ')).join(' || ')}`,
        );
      }
      if ((await alice.page.locator('.board__over').count()) > 0) throw new Error(`the game ended before the table was full, at ${await howFar()}`);
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
      // board, clicks a card Forge marked selectable, or presses Cancel,
      // rotating through those while the same question stays open.
      for (const f of friends) {
        const says = (await f.page.getByTestId('live-says').textContent()) ?? '';
        const seen = waiting.get(f.name);
        if (seen === undefined || seen.says !== says) {
          waiting.set(f.name, { says, since: Date.now() });
          continue;
        }
        if (Date.now() - seen.since < STUCK_MS || (await f.page.getByTestId('live-prompt').count()) > 0) continue;
        // Each time the SAME question is still there, try the next thing: a
        // click that changed nothing (a fetch land offered while Forge wants
        // blue mana) must not be the only thing ever tried.
        const key = `${f.name}\n${says}`;
        const attempt = attempts.get(key) ?? 0;
        attempts.set(key, attempt + 1);
        const selectable = f.page.locator('[aria-label="Game board"] li[data-selectable] button');
        const cancel = f.page.locator('[data-testid="live-button-cancel"]:enabled');
        const options = [];
        if ((await enabledOk(f).count()) > 0) options.push(enabledOk(f));
        const choices = await selectable.count();
        if (choices > 0) options.push(selectable.nth(Math.floor(attempt / 2) % choices));
        if ((await cancel.count()) > 0) options.push(cancel);
        if (options.length === 0) continue;
        const press = options[attempt % options.length];
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
    summary.playedTo = await howFar();
    summary.discardsOnTheBoard = discards;
    summary.boardAnswersWhenHandsStalled = unstuck;
    for (const h of hands) h.pause();
    await new Promise((r) => setTimeout(r, 2_000));
    for (const g of friends) moments.push(await fitsNow(g, 'mid-game'));

    /* ── 2b. the player arranges their own battlefield ─────────────── */

    /*
     * §A.2: a permanent is dragged within and between rows, the arrangement is
     * the player's, and it survives what the engine does next. Here it is on a
     * REAL board — the permanents are the ones the game put there, the drag is
     * the browser's own HTML5 drag, and the only thing that may change is
     * which row draws which card.
     *
     * `hands.ts` is paused, so no frame arrives while the drag happens; the
     * arrangement is checked again after step 3, which re-renders the board
     * around an open question. Nothing is sent to Forge by any of it.
     */
    const arrangements: { who: string; moved: number; from: string; to: string; before: RowCards[]; after: RowCards[] }[] = [];
    for (const f of friends) {
      const before = await rowsOf(f);
      const source = [...before].sort((a, b) => b.cards.length - a.cards.length)[0]!;
      const target = before.find((r) => r.row !== source.row)!;
      const moved = source.cards[source.cards.length - 1]!;
      await f.page.evaluate(dragBetweenRows, { cardId: moved, row: target.row });
      const after = await rowsOf(f);
      const want = {
        [source.row]: source.cards.slice(0, -1),
        [target.row]: [...target.cards, moved],
      };
      arrangements.push({ who: f.name, moved, from: source.row, to: target.row, before, after });
      for (const row of after) {
        const expected = want[row.row] ?? before.find((r) => r.row === row.row)!.cards;
        expect(row.cards, `${f.name}: the ${row.row} row after dragging ${moved} to ${target.row}`).toEqual(expected);
      }
      // The view the engine sent is untouched: the zone still counts the same
      // cards, and nothing left the board.
      expect(
        after.reduce((n, r) => n + r.cards.length, 0),
        `${f.name}: the battlefield still holds every permanent`,
      ).toBe(before.reduce((n, r) => n + r.cards.length, 0));
      moments.push(await fitsNow(f, 'battlefield arranged'));
    }
    summary.arrangements = arrangements;

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

    /* ── 3b. and the arrangement survived the re-render ─────────────── */

    for (const [i, f] of friends.entries()) {
      const now = await rowsOf(f);
      expect(now, `${f.name}: the arrangement survived a question, an answer and a redraw`).toEqual(
        arrangements[i]!.after,
      );
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
      expect(s.maxBattlefield, `${f.name}: the largest battlefield seen`).toBeGreaterThanOrEqual(MIN_BATTLEFIELD);
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

/* ── the crowd probe: big zones, deterministically ───────────────────── */

/**
 * How many cards each zone is filled to, step by step. A real game reaches
 * 8–11 permanents by turn 12 and rarely more, so the test above can never
 * promise it has seen a crowded table. This one builds the crowd itself.
 */
const CROWD_STEPS = [
  { battlefield: 8, hand: 7, backs: 7 },
  { battlefield: 11, hand: 8, backs: 8 },
  { battlefield: 16, hand: 10, backs: 10 },
  { battlefield: 20, hand: 10, backs: 10 },
] as const;
/** Cards may shrink to fit, but not to nothing: a fit that makes a card unreadable is not a fit. */
const MIN_CARD_PX = 36;
/**
 * And the floor for a card on a GROUPED battlefield (wave 20 §A.1), where four
 * labelled lanes divide the slot's WIDTH — 840px at 1280×800 — in proportion to
 * what each holds, at the full height of the slot. That is why it is a floor at
 * all and not a cliff: this measured 21px when the same four groups were bands
 * stacked down the slot's 130px of height, and `board.css` carries the
 * arithmetic that moved them onto the other axis.
 */
const MIN_GROUPED_CARD_PX = 30;
/** The rows a battlefield draws, in the order `Board.tsx` draws them. */
const BOARD_ROWS = ['lands', 'artifacts', 'creatures', 'other'] as const;

interface RowFit {
  row: string;
  cards: number;
  empty: boolean;
  box: [number, number];
  scroll: [number, number];
  cardW: [number, number];
}

interface ZoneFit {
  zone: string;
  viewer: boolean;
  cards: number;
  rows: string;
  box: [number, number];
  scroll: [number, number];
  cardW: [number, number];
  cardH: number;
  /** A battlefield's four rows; empty for every other zone. */
  groups: RowFit[];
}

interface CrowdFit {
  size: string;
  page: [number, number];
  overflowing: string[];
  zones: ZoneFit[];
}

/**
 * Fill every zone on this page to the given counts and measure it. Runs in
 * the page.
 *
 * DOM ONLY — a pure layout probe. It copies the viewer's own dealt hand cards
 * (real `CardTile`s, with their art and rules text, as the board drew them)
 * into both battlefields and the hand, and copies card backs into the
 * opponent's hidden hand. On a battlefield every third copy is tapped and every
 * fifth carries status chips, because those change a card's box — and the
 * chips were what broke at 11. Nothing is sent to Forge
 * and nothing enters React's state. The copies are marked `data-probe` and
 * removed by `clearCrowd`. The page is left alone between steps: Forge is
 * parked on a keep-or-mulligan question, so no frame arrives and React does
 * not redraw the zones under the copies.
 */
function fillCrowd(counts: { battlefield: number; hand: number; backs: number }): Promise<CrowdFit> {
  const source = Array.from(document.querySelectorAll<HTMLElement>('.seat[data-viewer] > [data-zone="hand"] li.board-card')).filter(
    (li) => !li.hasAttribute('data-probe'),
  );
  if (source.length === 0) throw new Error('no dealt hand to copy cards from');
  // Every zone renders its list whether or not it holds anything (`Board.tsx`,
  // the static-canvas rule), so this finds one rather than making one.
  const listIn = (zone: HTMLElement, cls: string): HTMLElement => {
    const have = zone.querySelector<HTMLElement>(`:scope > ul.${cls}`);
    if (have !== null) return have;
    const ul = document.createElement('ul');
    ul.className = cls;
    ul.setAttribute('data-probe', '');
    zone.appendChild(ul);
    return ul;
  };
  const fillTo = (ul: HTMLElement, n: number, onBattlefield: boolean): void => {
    let i = 0;
    while (ul.children.length < n) {
      const copy = source[i % source.length].cloneNode(true) as HTMLElement;
      copy.setAttribute('data-probe', '');
      copy.removeAttribute('data-selectable');
      if (onBattlefield && i % 3 === 1) copy.setAttribute('data-tapped', 'true');
      if (onBattlefield && i % 5 === 2) {
        const chips = document.createElement('ul');
        chips.className = 'board-card__chips';
        chips.innerHTML = '<li class="board-card__chip">summoning sick</li><li class="board-card__chip">2 damage</li>';
        copy.appendChild(chips);
      }
      ul.appendChild(copy);
      i += 1;
    }
  };
  /*
   * A battlefield is four labelled rows (`Board.tsx`), so the crowd is spread
   * over them the way a real board fills up: mostly lands and creatures, a
   * couple of artifacts, one of everything else — which also means all four
   * rows are occupied at the biggest step, the case where the rows share the
   * slot most thinly. The rows are found, never made: all four are always in
   * the markup.
   */
  const share = (n: number): number[] => {
    const lands = Math.max(1, Math.round(n * 0.45));
    const creatures = Math.max(1, Math.round(n * 0.4));
    const artifacts = Math.max(1, Math.min(2, n - lands - creatures));
    return [lands, artifacts, creatures, Math.max(0, n - lands - creatures - artifacts)];
  };
  for (const zone of Array.from(document.querySelectorAll<HTMLElement>('.seat > [data-zone="battlefield"]'))) {
    const rows = Array.from(zone.querySelectorAll<HTMLElement>('[data-board-row]'));
    if (rows.length !== 4) throw new Error(`a battlefield has ${rows.length} rows, not 4`);
    const want = share(counts.battlefield);
    rows.forEach((row, i) => {
      const ul = row.querySelector<HTMLElement>(':scope > ul.zone__cards');
      if (ul === null) throw new Error(`the ${row.dataset.boardRow ?? '?'} row has no list of its own`);
      fillTo(ul, want[i], true);
      /*
       * `data-empty` and the lane's `flex-grow` are React's, and both are
       * derived from the card count — so a probe that puts cards in a lane owes
       * it both. Without the grow a filled lane is 0 wide (its cards with it),
       * which is what a first run of this probe measured.
       */
      if (want[i] > 0) row.removeAttribute('data-empty');
      row.style.flexGrow = String(want[i]);
    });
  }
  const hand = document.querySelector<HTMLElement>('.seat[data-viewer] > [data-zone="hand"]');
  if (hand !== null) fillTo(listIn(hand, 'zone__cards'), counts.hand, false);
  const backs = document.querySelector<HTMLElement>('.seat:not([data-viewer]) > [data-zone="hand"] ul.card-backs');
  if (backs !== null && backs.children.length > 0) {
    while (backs.children.length < counts.backs) {
      const back = backs.children[0].cloneNode(true) as HTMLElement;
      back.setAttribute('data-probe', '');
      backs.appendChild(back);
    }
  }

  return new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const page = document.scrollingElement ?? document.documentElement;
        const overflowing: string[] = [];
        const over = (el: HTMLElement): boolean => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
        const match = document.querySelector<HTMLElement>('[data-testid="match"]');
        for (let el: HTMLElement | null = match; el !== null && el !== document.documentElement; el = el.parentElement) {
          if (over(el)) overflowing.push(el.className === '' ? el.tagName.toLowerCase() : el.className);
        }
        const widthsOf = (cards: HTMLElement[]): [number, number] =>
          cards.length === 0
            ? [0, 0]
            : [
                Math.round(Math.min(...cards.map((c) => c.getBoundingClientRect().width))),
                Math.round(Math.max(...cards.map((c) => c.getBoundingClientRect().width))),
              ];
        const zones = Array.from(document.querySelectorAll<HTMLElement>('.board [data-zone]')).map((zone): ZoneFit => {
          // A battlefield keeps its cards one level down, in its four rows.
          const groups = Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__rows > li[data-board-row]')).map(
            (row): RowFit => {
              const inRow = Array.from(row.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li'));
              if (over(row)) overflowing.push(`the ${row.dataset.boardRow ?? '?'} row of ${inRow.length}`);
              return {
                row: row.dataset.boardRow ?? '?',
                cards: inRow.length,
                empty: row.hasAttribute('data-empty'),
                box: [row.clientWidth, row.clientHeight],
                scroll: [row.scrollWidth, row.scrollHeight],
                cardW: widthsOf(inRow),
              };
            },
          );
          const cards =
            groups.length > 0
              ? Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__rows > li > ul.zone__cards > li'))
              : Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li'));
          const ul = zone.querySelector<HTMLElement>(
            groups.length > 0 ? ':scope > ul.zone__rows > li:not([data-empty]) > ul.zone__cards' : ':scope > ul.zone__cards',
          );
          const fit: ZoneFit = {
            zone: zone.dataset.zone ?? '?',
            viewer: zone.closest('.seat[data-viewer]') !== null,
            cards: cards.length,
            rows: ul === null ? '' : getComputedStyle(ul).getPropertyValue('--rows').trim(),
            box: [zone.clientWidth, zone.clientHeight],
            scroll: [zone.scrollWidth, zone.scrollHeight],
            cardW: widthsOf(cards),
            cardH: Math.round(Math.max(0, ...cards.map((c) => c.getBoundingClientRect().height))),
            groups,
          };
          if (over(zone)) overflowing.push(`${fit.viewer ? 'your' : 'their'} ${fit.zone} of ${fit.cards}`);
          return fit;
        });
        done({ size: `${innerWidth}x${innerHeight}`, page: [page.scrollWidth, page.scrollHeight], overflowing, zones });
      }),
    ),
  );
}

/**
 * Take every probe copy back out, and hand the rows the `data-empty` React
 * would have given them — the probe took it off the rows it filled, and a row
 * that is empty again must be a label strip again. Runs in the page.
 */
function clearCrowd(): void {
  for (const el of Array.from(document.querySelectorAll('[data-probe]'))) el.remove();
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-board-row]'))) {
    const cards = row.querySelectorAll('.board-card').length;
    if (cards === 0) row.setAttribute('data-empty', 'true');
    row.style.flexGrow = String(cards);
  }
}

/* ── the canvas is static: the stack fills, and nothing else moves ───── */

/**
 * The operator, 2026-09-24: *"the location for the stack causes the field to
 * change in size. this can never happen. the entire canvas must be fully
 * static at all times."*
 *
 * `Board.test.ts` holds the markup and the stylesheet's tracks; jsdom lays
 * nothing out, so the boxes themselves are measured here, in a browser that
 * does. Every slot on the board is measured with the stack holding 0, 1, 5 and
 * 12 items, and every one of those boxes must be the same number in all four.
 */
const STACK_STEPS = [0, 1, 5, 12] as const;
/** A face has to be worth aiming at. */
const MIN_FACE_PX = 28;

interface StaticShot {
  size: string;
  items: number;
  /** name → "left,top,width,height", rounded. */
  boxes: Record<string, string>;
  page: [number, number];
  /** The stack's list: overflow may go sideways INSIDE it, never downward. */
  stackScroll: [number, number];
  stackClient: [number, number];
  /** Hand and battlefield must not be painted the same (#3). */
  surfaces: Record<string, string>;
  prose: number;
  /**
   * Ours and theirs, "left,top,width,height": item 11 puts them at opposite
   * ends of the canvas, so which is which is a matter of where you look.
   */
  faces: { you: string; them: string };
  /** The battlefield rows, in the order they are drawn: the grouping, in a browser. */
  rows: string[];
}

/**
 * Put `n` items on the stack, DOM only, and measure every slot on the board.
 * Runs in the page.
 *
 * The items are built from the same classes `Board.tsx` renders, with a real
 * `CardTile` cloned out of the viewer's dealt hand for the art, so what is
 * measured is the stylesheet doing its job rather than a stand-in. Nothing is
 * sent to Forge and nothing enters React's state; the match is parked on a
 * keep-or-mulligan question, so no frame redraws the list under the copies.
 */
function fillStack(n: number): Promise<StaticShot> {
  const board = document.querySelector<HTMLElement>('.board');
  if (board === null) throw new Error('no board on the page');
  const list = board.querySelector<HTMLElement>('[data-zone="stack"] > ol.stack__items');
  if (list === null) throw new Error('the stack has no list of its own — an empty stack must still render its slot');
  const art = document.querySelector<HTMLElement>('.seat[data-viewer] > [data-zone="hand"] li.board-card [data-testid="card"]');
  if (art === null) throw new Error('no dealt hand to copy a card from');

  for (const el of Array.from(list.querySelectorAll('[data-probe]'))) el.remove();
  while (list.querySelectorAll('[data-probe]').length < n) {
    const li = document.createElement('li');
    li.className = 'stack__item';
    li.setAttribute('data-probe', '');
    const body = document.createElement('span');
    body.className = 'stack__body';
    const wrap = document.createElement('span');
    wrap.className = 'stack__art';
    wrap.appendChild(art.cloneNode(true));
    const what = document.createElement('span');
    what.className = 'stack__what';
    what.innerHTML =
      '<span class="stack__source">Probe<span class="stack__kind"> · ability</span></span>' +
      '<span class="stack__controller">someone</span>' +
      '<span class="stack__text">deals 2 damage to any target, and a second line of text so the item is as tall as one ever gets</span>';
    body.append(wrap, what);
    li.appendChild(body);
    list.appendChild(li);
  }

  return new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const rect = (el: Element): string => {
          const r = el.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height].map((x) => Math.round(x)).join(',');
        };
        const boxes: Record<string, string> = { board: rect(board) };
        for (const [name, sel] of [
          ['bar', '.board__bar'],
          ['them', '.board__opponents'],
          ['mid', '.board__mid'],
          ['overlay', '[data-board-overlay]'],
          ['you', ':scope > .seat[data-viewer]'],
        ] as const) {
          const el = board.querySelector(sel);
          if (el === null) throw new Error(`the board has no ${name} (${sel})`);
          boxes[name] = rect(el);
        }
        for (const z of Array.from(board.querySelectorAll<HTMLElement>('[data-zone]'))) {
          boxes[`${z.dataset.owner ?? '?'}/${z.dataset.zone ?? '?'}`] = rect(z);
        }
        for (const f of Array.from(board.querySelectorAll<HTMLElement>('[data-player-face]'))) {
          boxes[`face/${f.dataset.playerId ?? '?'}`] = rect(f);
        }
        const surfaces: Record<string, string> = {};
        for (const [name, sel] of [
          ['battlefield', '.seat[data-viewer] > [data-zone="battlefield"]'],
          ['hand', '.seat[data-viewer] > [data-zone="hand"]'],
        ] as const) {
          const el = board.querySelector(sel);
          if (el === null) throw new Error(`no ${name} to read a surface from`);
          const s = getComputedStyle(el);
          surfaces[name] = `${s.backgroundColor} | ${s.backgroundImage} | ${s.boxShadow}`;
        }
        const ours = board.querySelector('[data-player-face][data-viewer]');
        const theirs = board.querySelector('[data-player-face]:not([data-viewer])');
        if (ours === null || theirs === null) throw new Error('a seat has no face of its own');
        const page = document.scrollingElement ?? document.documentElement;
        done({
          size: `${innerWidth}x${innerHeight}`,
          items: n,
          boxes,
          page: [page.scrollWidth, page.scrollHeight],
          stackScroll: [list.scrollWidth, list.scrollHeight],
          stackClient: [list.clientWidth, list.clientHeight],
          surfaces,
          // No empty-state text, no hidden-hand sentence, no hint (#4).
          prose: board.querySelectorAll('.zone__empty, .zone__hidden, .stack__hint').length,
          faces: { you: rect(ours), them: rect(theirs) },
          rows: Array.from(
            board.querySelectorAll<HTMLElement>('.seat[data-viewer] > [data-zone="battlefield"] [data-board-row]'),
          ).map((r) => r.dataset.boardRow ?? '?'),
        });
      }),
    ),
  );
}

/** Take the probe items back off the stack. Runs in the page. */
function clearStack(): void {
  for (const el of Array.from(document.querySelectorAll('[data-zone="stack"] [data-probe]'))) el.remove();
}

test(CROWD_TITLE, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);

  const stack = await startPlayStack(forge);
  const friends: Friend[] = [];
  const summary: Record<string, unknown> = {};
  const steps: (CrowdFit & { who: string; step: string })[] = [];
  const staticShots: (StaticShot & { who: string })[] = [];
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    friends.push(alice, bob);
    for (const f of friends) await f.page.setViewportSize(SIZES[f.name as keyof typeof SIZES]);
    await enterMatch(alice, bob, stack.origin, summary);

    // Answer the coin toss on the board, so hands are dealt; then Forge parks
    // on the first keep-or-mulligan question and nothing moves.
    const enabledOk = (f: Friend) => f.page.locator('[data-testid="live-button-ok"]:enabled');
    await expect.poll(async () => (await enabledOk(alice).count()) + (await enabledOk(bob).count()), { timeout: 30_000 }).toBe(1);
    const decider = (await enabledOk(alice).count()) > 0 ? alice : bob;
    await enabledOk(decider).click();
    for (const f of friends) {
      await expect
        .poll(async () => f.page.locator('.seat[data-viewer] > [data-zone="hand"] li.board-card').count(), {
          timeout: 30_000,
          message: `${f.name}: no opening hand was dealt`,
        })
        .toBeGreaterThan(0);
    }
    await expect.poll(async () => /keep your hand/i.test((await decider.page.getByTestId('live-says').textContent()) ?? ''), { timeout: 30_000 }).toBe(true);

    for (const sizes of [SIZES, { alice: SIZES.bob, bob: SIZES.alice }]) {
      for (const f of friends) await f.page.setViewportSize(sizes[f.name as keyof typeof SIZES]);
      for (const f of friends) {
        /* ── the canvas is static: fill the stack, and nothing else may move ── */
        const shots: StaticShot[] = [];
        for (const n of STACK_STEPS) shots.push(await f.page.evaluate(fillStack, n));
        await f.page.evaluate(clearStack);
        staticShots.push(...shots.map((s) => ({ who: f.name, ...s })));
        const base = shots[0]!;
        const where = `${f.name} at ${base.size}`;
        console.log(
          `[table-fit static] ${where}: ${shots.map((s) => `${s.items} on the stack → mid ${s.boxes.mid}, you/battlefield ${s.boxes['you/battlefield']}`).join('; ')}`,
        );
        // The board really was measured: every slot, and a face per player.
        expect(Object.keys(base.boxes).sort(), `${where}: every slot measured`).toEqual([
          'bar',
          'board',
          'face/0',
          'face/1',
          'mid',
          'overlay',
          'table/stack',
          'them',
          'them/battlefield',
          'them/exile',
          'them/graveyard',
          'them/hand',
          'you',
          'you/battlefield',
          'you/exile',
          'you/graveyard',
          'you/hand',
        ]);
        // The overlay root covers the canvas exactly — it is where the
        // interaction lane draws, and an arrow aimed through a box that is not
        // the board's lands somewhere else.
        expect(base.boxes.overlay, `${where}: the overlay covers the board exactly`).toBe(base.boxes.board);
        // A face is a thing you can hit.
        for (const id of ['face/0', 'face/1']) {
          const [, , w, h] = base.boxes[id]!.split(',').map(Number);
          expect(Math.min(w!, h!), `${where}: ${id} is worth aiming at`).toBeGreaterThanOrEqual(MIN_FACE_PX);
        }
        /*
         * The faces anchor the table (item 11): theirs at the top of the
         * canvas, ours at the bottom, with the stack's band between them. The
         * operator could not tell the two apart when both sat in that band.
         */
        {
          const at = (box: string) => {
            const [left, top, w, h] = box.split(',').map(Number);
            return { left: left!, top: top!, bottom: top! + h!, mid: top! + h! / 2, width: w! };
          };
          const board = at(base.boxes.board!);
          const mid = at(base.boxes.mid!);
          const you = at(base.faces.you);
          const them = at(base.faces.them);
          const third = (board.bottom - board.top) / 3;
          expect(them.mid, `${where}: their face is in the top third of the canvas`).toBeLessThan(board.top + third);
          expect(you.mid, `${where}: our face is in the bottom third of the canvas`).toBeGreaterThan(board.bottom - third);
          expect(them.bottom, `${where}: their face is above the stack's band`).toBeLessThanOrEqual(mid.top);
          expect(you.top, `${where}: our face is below the stack's band`).toBeGreaterThanOrEqual(mid.bottom);
          // And the grouping is there, in the order it is drawn.
          expect(base.rows, `${where}: the battlefield's rows`).toEqual([...BOARD_ROWS]);
        }
        // Hand and battlefield are different places, at a glance (#3).
        expect(base.surfaces.hand, `${where}: the hand is not painted like the battlefield`).not.toBe(base.surfaces.battlefield);
        for (const s of shots) {
          const at = `${where}, ${s.items} on the stack`;
          // Every box, identical. This is the whole rule.
          expect(s.boxes, `${at}: no slot moved`).toEqual(base.boxes);
          expect(s.page[1], `${at}: the page scrolls vertically`).toBeLessThanOrEqual(Number(s.size.split('x')[1]));
          expect(s.page[0], `${at}: the page scrolls sideways`).toBeLessThanOrEqual(Number(s.size.split('x')[0]));
          // What does not fit goes sideways INSIDE the stack's own slot.
          expect(s.stackScroll[1], `${at}: the stack overflows downward instead of sideways`).toBeLessThanOrEqual(s.stackClient[1] + 1);
          expect(s.prose, `${at}: empty-state text, a hidden-hand sentence or a hint came back`).toBe(0);
        }
        // And it really did get crowded: 12 items do not fit across the band.
        const full = shots.at(-1)!;
        expect(full.stackScroll[0], `${where}: 12 items are more than the band is wide`).toBeGreaterThan(full.stackClient[0]);

        for (const counts of CROWD_STEPS) {
          const step = `battlefields ${counts.battlefield}, hand ${counts.hand}`;
          const got = await f.page.evaluate(fillCrowd, counts);
          steps.push({ who: f.name, step, ...got });
          const bf = got.zones.filter((z) => z.zone === 'battlefield');
          console.log(
            `[table-fit crowd] ${f.name} ${got.size} ${step}: overflowing ${JSON.stringify(got.overflowing)}; ` +
              got.zones
                .filter((z) => z.cards > 0)
                .map(
                  (z) =>
                    `${z.viewer ? 'your' : 'their'} ${z.zone} ${z.cards} rows ${z.rows} box ${z.box.join('x')} scroll ${z.scroll.join('x')} card ${z.cardW.join('-')}w ${z.cardH}h` +
                    (z.groups.length === 0 ? '' : ` [${z.groups.map((g) => `${g.row} ${g.cards}@${g.box[1]}px`).join(' | ')}]`),
                )
                .join('; '),
          );
          if (SHOTS !== '' && (counts.battlefield === 8 || counts.battlefield === 20)) {
            mkdirSync(SHOTS, { recursive: true });
            await f.page.screenshot({ path: resolve(SHOTS, `crowd-${counts.battlefield}-${f.name}-${got.size}.png`) });
          }
          const where = `${f.name} at ${got.size}, ${step}`;
          // The probe put the cards where it meant to — a probe that filled nothing cannot pass.
          expect(bf.map((z) => z.cards), `${where}: both battlefields filled`).toEqual([counts.battlefield, counts.battlefield]);
          expect(got.zones.find((z) => z.zone === 'hand' && z.viewer)?.cards, `${where}: the hand filled`).toBe(counts.hand);
          expect(got.page[1], `${where}: the page scrolls vertically`).toBeLessThanOrEqual(Number(got.size.split('x')[1]));
          expect(got.page[0], `${where}: the page scrolls sideways`).toBeLessThanOrEqual(Number(got.size.split('x')[0]));
          expect(got.overflowing, `${where}: every zone and every box around the match holds what is in it`).toEqual([]);
          for (const z of got.zones.filter((zz) => zz.cards > 0 && zz.zone !== 'graveyard' && zz.zone !== 'exile')) {
            // A grouped battlefield's floor is lower, and deliberately so.
            const floor = z.zone === 'battlefield' ? MIN_GROUPED_CARD_PX : MIN_CARD_PX;
            expect(z.cardW[0], `${where}: ${z.viewer ? 'your' : 'their'} ${z.zone}'s narrowest card`).toBeGreaterThanOrEqual(floor);
          }
          /*
           * The grouping, measured: four rows in order on both sides, a row
           * that holds cards is not a label strip, the rows that hold cards
           * share the slot equally, and NO row scrolls — the whole point of
           * four fixed rows is that what does not fit shrinks rather than
           * hides.
           */
          for (const z of bf) {
            const side = z.viewer ? 'your' : 'their';
            expect(z.groups.map((g) => g.row), `${where}: ${side} battlefield's rows`).toEqual([...BOARD_ROWS]);
            const filled = z.groups.filter((g) => g.cards > 0);
            expect(filled.length, `${where}: ${side} battlefield spread over rows`).toBeGreaterThanOrEqual(3);
            expect(
              z.groups.reduce((n, g) => n + g.cards, 0),
              `${where}: every card of ${side} battlefield is in a row`,
            ).toBe(counts.battlefield);
            for (const g of z.groups) {
              expect(g.empty, `${where}: ${side} ${g.row} of ${g.cards} marks itself empty`).toBe(g.cards === 0);
              expect(g.scroll[0], `${where}: ${side} ${g.row} scrolls sideways`).toBeLessThanOrEqual(g.box[0] + 1);
              expect(g.scroll[1], `${where}: ${side} ${g.row} scrolls downward`).toBeLessThanOrEqual(g.box[1] + 1);
            }
            // Every lane is the full height of the slot: they divide its width.
            const heights = filled.map((g) => g.box[1]);
            expect(Math.max(...heights) - Math.min(...heights), `${where}: ${side} lanes are one height`).toBeLessThanOrEqual(2);
            expect(Math.min(...heights), `${where}: ${side} lanes take the slot's height`).toBeGreaterThanOrEqual(z.box[1] - 4);
            // And the width each took is what it holds, so one card width fits
            // the whole battlefield: the widest card is no more than half again
            // the narrowest, whatever the split.
            expect(z.cardW[1], `${where}: ${side} cards are one size across the lanes`).toBeLessThanOrEqual(
              Math.round(z.cardW[0] * 2.2),
            );
          }
        }
        await f.page.evaluate(clearCrowd);
      }
    }
    summary.crowd = steps;
    summary.staticCanvas = staticShots;
  } finally {
    for (const f of friends) await f.context.close();
    await stack.stop();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      resolve(RUN_DIR, 'table-fit-crowd-summary.json'),
      JSON.stringify({ ...summary, crowd: steps, staticCanvas: staticShots }, null, 2),
    );
  }
});
