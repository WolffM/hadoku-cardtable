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
 *   - **no label in the chrome is CLIPPED** (wave 27 §B.3). This is the one
 *     failure every check above is blind to by construction: a button whose
 *     label ellipsizes has a box exactly as wide as the stylesheet said, sits
 *     wholly inside the window, scrolls nothing and moves no neighbour. It is
 *     the TEXT that does not fit, and the only thing that knows is
 *     `scrollWidth > clientWidth`. Wave 26 shipped `Full c…` and `Conc…` at
 *     1280×800 through a green run of this very spec
 *     (`docs/planning/wave26-question-panel-1280x800.png`);
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
 *      into another row with a real pointer drag (wave 32 Q4: the board's own
 *      ghost and target indicator, not the browser's HTML5 drag), asserted card by
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
 * The third **asks a real question** (wave 27 §B.2). The only question either
 * test above ever opens is a `showConfirmDialog` — two lines of prose and two
 * buttons — which fits any column anyone has ever drawn. What the operator's
 * 24.1% has to earn is a REVEAL GRID, and at the table's real width (960 at a
 * 1280 viewport, not 1280) that column is ~227px. So a twelve-card choice is
 * built out of `ChoicePrompts`' own markup and real `CardTile`s and measured
 * there: inside the window, inside its own column, scrolling downward and never
 * sideways, and drawing more than one column of cards.
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
import { turnNumber } from './play/turn.ts';
import { chooseLanes, DRAG_HOOKS, endOfSlot, pointerDrag, touchDrag, viewerSlot } from './play/w32.ts';

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
  ? 'the canvas is static as the stack fills, a crowded table fits too (8, 11, 16 and 20 permanents a side and a hand of 10, at 1280×800 and 1366×768, with no zone scrolling), and a 12-card question fits its column'
  : `the canvas is static, a crowded table fits and a question fits its column — SKIPPED: ${forge.reason}`;

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
        // The rail's own row, which reads "14yours": `.board__bar` carried the
        // turn before wave 26 §A deleted it, and the rail is the only indicator
        // left (§B.2).
        turn: document.querySelector('[data-testid="live-turn"]')?.textContent ?? null,
      });
    }
  };
  const inside = (r: DOMRect): boolean =>
    r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  /** Two boxes share pixels. Both axes, because the overlays are a column now. */
  const overlaps = (a: DOMRect, b: DOMRect): boolean =>
    a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;

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
          // Wave 32 Q15b: Cancel is drawn only while Forge enables it, so only OK is always home.
          if (bar.querySelector('[data-testid="live-button-ok"]') === null) breach('button bar without live-button-ok');
          if (document.querySelectorAll('[data-testid="live-button-cancel"]').length > 1) breach('more than one live-button-cancel');
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
        for (const zone of Array.from(document.querySelectorAll<HTMLElement>('.seat [data-zone="battlefield"], .seat[data-viewer] [data-zone="hand"]'))) {
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
          if (barBox !== null && overlaps(r, barBox)) breach('the logbook reaches the control cluster');
        }
        const stepName = document.querySelector('.live__step[data-current] .live__step-name');
        if (stepName !== null && !inside(stepName.getBoundingClientRect())) {
          breach('the current step’s name is not wholly inside the window');
        }
        /*
         * And no label in the chrome is CLIPPED (wave 27 §B.3).
         *
         * Every other check on this page is about a BOX, and a clipped label
         * breaches none of them: `text-overflow: ellipsis` makes the text fit the
         * box the stylesheet gave it, so the box is the right size, inside the
         * window, clear of its neighbours and identical in every frame. The
         * element that knows is the element itself — `scrollWidth` is what the
         * text needed, `clientWidth` is what it got.
         *
         * Wave 26 shipped `Full c…` and `Conc…` through a green run of this spec
         * for exactly that reason: 112px in two columns is a 39px label slot, and
         * `Full control` needs 62. §B.1 made the cluster one column of five.
         *
         * The rail's thirteen step names are in it too: §B.2 widened the rail from
         * 32px to 108 *so that all thirteen would be read*, and a rail that
         * ellipsizes one of them has quietly undone that.
         */
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid="live-buttons"] button, [data-testid="live-log-toggle"], .live__step-name',
          ),
        )) {
          if (el.scrollWidth <= el.clientWidth + 1) continue;
          const what = el.dataset.testid ?? (el.className === '' ? el.tagName.toLowerCase() : el.className);
          breach(`the label ${JSON.stringify(el.textContent)} is clipped (${what}: needs ${el.scrollWidth}w, has ${el.clientWidth}w)`);
        }
        const turn = document.querySelector('[data-testid="live-turn"]')?.textContent ?? '';
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
        /*
         * It must not reach the cluster's home. That used to be a check on the
         * bottom edge alone, because the host was the whole room ABOVE the
         * cluster; wave 26 §B.1 gave the question a fixed COLUMN at 59.4% across
         * and the cluster sits in the gutter past 84%, so the two clear each
         * other sideways and a vertical-only check would fail a layout that is
         * correct. What the operator asked for is that a question never lands on
         * the controls, and that is an intersection, in both axes.
         */
        if (barBox !== null && overlaps(r, barBox)) breach(`${id} covers the button bar`);
        // And the log's own button, which is in the same gutter (§B.4).
        const logButton = document.querySelector('[data-testid="live-log-toggle"]');
        if (logButton !== null && overlaps(r, logButton.getBoundingClientRect())) {
          breach(`${id} covers the log button`);
        }
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
  // `live-turn-n` is Forge's own counter and nothing else, which is why §B.2 gave
  // it an id of its own: the row around it reads "14yours".
  return turnNumber(await f.page.getByTestId('live-turn-n').textContent());
}

async function samples(f: Friend): Promise<FitSamples> {
  const got = await f.page.evaluate(() => window.__fit ?? null);
  if (got === null) throw new Error(`${f.name}: the sampler never ran on this page`);
  return got;
}

/**
 * The words the chrome's own controls say, and nothing about Forge's two — the
 * cluster's OK and Cancel carry `label1`/`label2` off the wire, which have been
 * `OK`, `Cancel`, `Auto`, `Play` and `Draw` and are not this file's to predict.
 *
 * These four ARE, and they are asserted as strings rather than only measured,
 * because `scrollWidth` alone would pass a stylesheet that fitted the box by
 * shortening the word — which is the same loss the ellipsis was, spelled
 * differently. The rendered text must be the whole intended text (wave 27 §B).
 */
const OUR_LABELS: Record<string, string> = {
  'live-leave': 'Leave',
  'live-full-control': 'Full control',
  'live-concede': 'Concede',
  'live-log-toggle': 'Log',
};

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
      turn: document.querySelector('[data-testid="live-turn"]')?.textContent ?? null,
      battlefields: Array.from(document.querySelectorAll<HTMLElement>('.seat [data-zone="battlefield"]')).map((z) => Number(z.dataset.count)),
      /*
       * What every label in the chrome says and what room it had to say it in
       * (wave 27 §B.3). `scrollWidth` is what the text needed and `clientWidth`
       * is what the box gave it, so a label clipped by `text-overflow: ellipsis`
       * — which breaches no box and so passes every other check on this page —
       * is the one where the two differ.
       */
      labels: Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="live-buttons"] button, [data-testid="live-log-toggle"], .live__step-name',
        ),
      ).map((el) => ({
        id: el.dataset.testid ?? el.className,
        text: (el.textContent ?? '').trim(),
        needs: el.scrollWidth,
        has: el.clientWidth,
      })),
    };
  });
  const where = `${f.name} at ${m.size.join('×')}, ${moment}`;
  expect(m.scroll[1], `${where}: the page scrolls vertically`).toBeLessThanOrEqual(m.size[1]);
  expect(m.scroll[0], `${where}: the page scrolls sideways`).toBeLessThanOrEqual(m.size[0]);
  expect(m.bar, `${where}: no button bar`).not.toBeNull();
  expect(m.bar!.height, `${where}: the button bar has no height`).toBeGreaterThan(0);
  expect(m.bar!.bottom, `${where}: the button bar is below the window`).toBeLessThanOrEqual(m.size[1]);
  /*
   * §B.3, from outside and by name. The sampler catches a clip in any frame;
   * this says which control and what it was supposed to say, which is the
   * difference between a red that names the bug and one that names a symptom.
   */
  const clipped = m.labels.filter((l) => l.needs > l.has + 1);
  expect(clipped, `${where}: a label is clipped — ${JSON.stringify(clipped)}`).toEqual([]);
  for (const [id, intended] of Object.entries(OUR_LABELS)) {
    const label = m.labels.find((l) => l.id === id);
    if (label === undefined) continue;
    expect(label.text, `${where}: ${id} says its whole word`).toBe(intended);
  }
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
      document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] [data-board-row]'),
    ).map((row) => ({
      row: row.dataset.boardRow ?? '?',
      cards: Array.from(row.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li.board-card')).map((c) =>
        Number(c.dataset.cardId),
      ),
    })),
  );
}

/** What a page is showing right now, for a failure message. */
async function stateOf(f: Friend): Promise<Record<string, unknown>> {
  return {
    name: f.name,
    turn: await f.page.getByTestId('live-turn').textContent(),
    // The phase off the rail's own dataset — the bar that used to say it is gone.
    phase: await f.page.getByTestId('live-phases').getAttribute('data-phase'),
    // Forge's own line, in the logbook now (wave 25 §C) — same id, new home.
    says: await f.page.getByTestId('live-says').textContent(),
    ok: await f.page.getByTestId('live-button-ok').isEnabled(),
    cancel: (await f.page.getByTestId('live-button-cancel').count()) > 0,
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
  /*
   * The pool is the TABLE's and the leader is the one who moves it (wave 25 §B).
   * Alice made the room, so it is hers; bob has no `format` control at all, and
   * driving one on his page is a twenty-second wait for an element that is not
   * coming. The wait is on the select reading its value back, which means the
   * room record is on it — the control is bound to the room, so a refused write
   * snaps it back.
   */
  await expect(alice.page.getByTestId('constructed')).toBeVisible();
  await alice.page.getByTestId('format').selectOption(choice.format);
  await expect(alice.page.getByTestId('format'), 'the room is on the pool alice chose').toHaveValue(choice.format);
  await expect(bob.page.getByTestId('format-fixed'), "bob's screen follows it").toHaveAttribute(
    'data-format',
    choice.format,
  );
  for (const [f, deck] of [
    [alice, choice.decks[0]],
    [bob, choice.decks[1]],
  ] as const) {
    await expect(f.page.getByTestId('constructed')).toBeVisible();
    // Choosing the deck IS loading it: there is no Load button any more (wave
    // 22 §B). The picker is dead until the pool's own legality sweep answers,
    // and it then offers only the decks that pool holds — so wait for it to
    // come alive rather than selecting into the last pool's list.
    await expect(f.page.getByTestId('deck-mine')).toBeEnabled();
    // Wave 28 §C replaced the `<select>` with a `role="radiogroup"` of `role="radio"`
    // buttons (*"we cannot use a standard dropdown for this"*), so `selectOption`
    // throws `Element is not a <select> element`. `deck-mine` is still the root and
    // every row still carries its library id, so picking a deck is still one line:
    // `docs/planning/wave28-evidence/C-deck-chooser-e2e-recipe.md` is where that
    // shape was promised, and this is it taken up. Neither spec is any lane's, so
    // the manager took them once §C had landed.
    await f.page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
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
  /*
   * Live, and the signal is the BOXES this spec exists to measure (wave 26 §B.5:
   * `Seat N, live.` is deleted, and each spec picks its own signal).
   *
   * The sampler reads the viewer's own seat and its two zones on every animation
   * frame. If this spec ran on a page that never got seated, every one of those
   * lookups would find nothing, the sampler would measure nothing at all, and the
   * run would go green having checked no box — which is the one failure a fit spec
   * cannot afford. So waiting on exactly those elements is what earns the rest of
   * the run: `data-viewer` is on the seat only when the snapshot named THIS
   * client's own player, so it cannot be satisfied by a page that merely loaded.
   */
  for (const f of friends) {
    await expect(f.page.locator('[aria-label="Game board"]')).toBeVisible();
    await expect(f.page.locator('.seat[data-viewer]'), `${f.name}: their own seat is on the table`).toHaveCount(1, {
      timeout: 30_000,
    });
    for (const zone of ['battlefield', 'hand'] as const) {
      await expect(
        f.page.locator(`.seat[data-viewer] [data-zone="${zone}"]`),
        `${f.name}: their own ${zone} is a box the sampler can measure`,
      ).toHaveCount(1, { timeout: 30_000 });
    }
  }
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

    for (const [seat, f] of friends.entries()) hands.push(await connectHands(f, seat));
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

    // Wave 32 Q13: power/toughness is in the bottom-right corner of the card. Only a
    // game that has put an untapped creature on the table can show it, so a game
    // that has not is reported, not failed.
    const ptChecked: Record<string, number> = {};
    for (const f of friends) {
      const pt = await f.page.evaluate(ptCorners);
      ptChecked[f.name] = pt.checked;
      expect(pt.misplaced, `${f.name}: every untapped creature's P/T is in its card's bottom-right corner`).toEqual([]);
    }
    summary.ptCornerChecked = ptChecked;
    if (Object.values(ptChecked).every((n) => n === 0)) console.log('[table-fit Q13] no untapped creature on either table: P/T corner NOT measured this run');

    /* ── 2a. wave 32 Q4a / Q4b: the default placement, and a card goes ANYWHERE ── */

    /*
     * The default board is two tiers: lands in the BACK row, everything else in the
     * FRONT row, each filled left to right (the opponent's is the vertical mirror).
     * That is a default, not a bucket: any card may be put in any slot of either row,
     * an empty one included — here a card is dragged into the OTHER tier with a real
     * pointer and must land there, at its end.
     */
    const placements: Record<string, unknown>[] = [];
    for (const f of friends) {
      const read = () =>
        f.page.evaluate(() => {
          const tier = (root: ParentNode, slot: string) =>
            Array.from(root.querySelectorAll<HTMLElement>(`[data-zone="battlefield"] [data-tier="${slot}"] li.board-card`)).map((li) => {
              const r = li.getBoundingClientRect();
              return { id: Number(li.dataset.cardId), land: /\bland\b/i.test(li.querySelector('.card__type')?.textContent ?? ''), left: r.left, top: r.top, width: r.width };
            });
          const slotLeft = (root: ParentNode, slot: string) => root.querySelector(`[data-zone="battlefield"] [data-tier="${slot}"]`)?.getBoundingClientRect().left ?? NaN;
          const seat = (sel: string) => {
            const root = document.querySelector(sel);
            if (root === null) throw new Error(`no ${sel}`);
            return { back: tier(root, 'back'), front: tier(root, 'front'), backLeft: slotLeft(root, 'back'), frontLeft: slotLeft(root, 'front') };
          };
          return { you: seat('.seat[data-viewer]'), them: seat('.seat:not([data-viewer])') };
        });
      const seats = await read();
      for (const side of ['you', 'them'] as const) {
        const s = seats[side];
        const w = `${f.name}, ${side}`;
        expect(s.back.filter((c) => !c.land).map((c) => c.id), `${w}: the back row holds lands only`).toEqual([]);
        expect(s.front.filter((c) => c.land).map((c) => c.id), `${w}: the front row holds no land`).toEqual([]);
        for (const [name, row, left] of [['back', s.back, s.backLeft], ['front', s.front, s.frontLeft]] as const) {
          const lefts = row.map((c) => c.left);
          expect(lefts, `${w}: the ${name} row fills left to right`).toEqual([...lefts].sort((a, b) => a - b));
          if (row.length > 0) expect(row[0]!.left - left, `${w}: the ${name} row starts at its left edge`).toBeLessThanOrEqual(row[0]!.width);
        }
      }
      // The opponent's tiers are the vertical mirror: their back row is above their front row; yours is below.
      const y = (cs: { top: number }[]) => (cs.length === 0 ? null : cs[0]!.top);
      if (y(seats.you.back) !== null && y(seats.you.front) !== null) expect(y(seats.you.front)!, `${f.name}: your front row is nearer the centre (above your back row)`).toBeLessThan(y(seats.you.back)!);
      if (y(seats.them.back) !== null && y(seats.them.front) !== null) expect(y(seats.them.back)!, `${f.name}: their back row is above their front row`).toBeLessThan(y(seats.them.front)!);

      // Complete freedom: a land goes to the front row's end, then back.
      const land = seats.you.back[0];
      if (land === undefined) continue;
      const card = f.page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${land.id}"]`);
      const trace = await pointerDrag(f.page, card, await endOfSlot(viewerSlot(f.page, 'front')));
      expect(trace.midway.ghost + trace.midway.indicator, `${f.name}: the ghost and the indicator were drawn`).toBe(2);
      const after = await read();
      expect(after.you.front.map((c) => c.id), `${f.name}: a land can be dropped in the front row`).toContain(land.id);
      expect(after.you.back.map((c) => c.id), `${f.name}: and has left the back row`).not.toContain(land.id);
      // Touch works: the same card is carried back to the back row by a finger.
      const touched = await touchDrag(f.page, card, await endOfSlot(viewerSlot(f.page, 'back')));
      expect(touched.midway.ghost + touched.midway.indicator, `${f.name}: a touch drag draws the ghost and the indicator too`).toBe(2);
      const back = await read();
      expect(back.you.back.map((c) => c.id), `${f.name}: a touch drag put the land back in the back row`).toContain(land.id);
      placements.push({ who: f.name, moved: land.id, front: after.you.front.map((c) => c.id), back: after.you.back.map((c) => c.id) });
      moments.push(await fitsNow(f, 'default board arranged'));
    }
    summary.defaultPlacements = placements;

    /*
     * Everything up to here was played on the default single board, and the
     * sampler held it to the fit rule on every frame. Rows are the four-lane
     * layout's, so the rest of the game switches to it and is held to the same
     * rule there.
     */
    for (const f of friends) await chooseLanes(f);
    for (const g of friends) moments.push(await fitsNow(g, 'lanes chosen'));

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
      // Wave 32 Q4: a POINTER drag of our own, not the browser's HTML5 drag. The card
      // is carried to the right of the target row's last card (the end slot) with a
      // real mouse; the ghost and the target indicator are on screen halfway.
      const cardEl = f.page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${moved}"]`);
      expect(await cardEl.getAttribute('draggable'), `${f.name}: the card is the board's own drag source (the seam marker)`).toBe('true');
      const to = await endOfSlot(viewerSlot(f.page, target.row));
      const trace = await pointerDrag(f.page, cardEl, to);
      expect(trace.midway.pickedUp, `${f.name}: the board is in a drag mid-drag`).toBe(1);
      expect(trace.midway.ghost, `${f.name}: our own ghost follows the pointer mid-drag`).toBe(1);
      expect(trace.midway.indicator, `${f.name}: a target indicator marks where the card will land mid-drag`).toBe(1);
      await expect(f.page.locator(DRAG_HOOKS.ghost), `${f.name}: the ghost is gone after the drop`).toHaveCount(0);
      await expect(f.page.locator(DRAG_HOOKS.indicator), `${f.name}: so is the target indicator`).toHaveCount(0);
      expect(await cardEl.evaluate((el) => el.hasAttribute('data-arrange-dragging')), `${f.name}: nothing is left picked up`).toBe(false);
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
  /**
   * The lane's own `--cols` as the BROWSER resolves it. `board.css:825` takes
   * the lane's share of the width from this and `--rows` and nothing else
   * (wave 27 §A.1), so reading it back is what proves this probe is driving the
   * product's own path rather than a width it set for itself.
   */
  cols: number;
  /**
   * And the rows the lane's list actually laid out, which is `--rows` — the
   * ZONE's one decision, inherited into all four lanes. Counted off the RESOLVED
   * `grid-template-rows` (`repeat(var(--rows), auto)` with `grid-auto-flow:
   * column`), not off the custom property: an unregistered custom property
   * inherits as its token stream, so `--rows` reads back as the literal
   * `calc(1 + clamp(…))` it is declared as and `Number()` of it is `NaN`.
   */
  rows: number;
  box: [number, number];
  scroll: [number, number];
  cardW: [number, number];
  /** `flex-grow` as the stylesheet computed it: `ceil(cols / rows)`. */
  grow: number;
}

interface ZoneFit {
  zone: string;
  viewer: boolean;
  cards: number;
  /**
   * The rows the zone settled on, counted off the RESOLVED `grid-template-rows`
   * of the list that holds the cards. Read off the `--rows` custom property
   * until wave 27 §A.1 made it a `calc()` of `--cols`: an unregistered custom
   * property inherits as its token stream, so that read came back as the literal
   * `calc(1 + clamp(…))` rather than a number.
   */
  rows: number;
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
  const source = Array.from(document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="hand"] li.board-card')).filter(
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
      /*
       * Wave 28 §A deleted `.board-card__chips`: a card's state is DRAWN now — a
       * quarter turn, a desaturated face, corner marks, a badge — and not written
       * as a list of words. This probe used to append that list by hand to crowd
       * the zone, which after §A appends markup no stylesheet claims, so it lands
       * IN FLOW, adds height to the copied card and can breach the zone's own
       * `scrollHeight` check — a probe failing on its own scaffolding.
       *
       * Nothing replaces it here, because the clause it served is now asserted
       * where it belongs and more directly: `Board.test.ts`'s *"nothing the state
       * layer draws can change a card's box"* (`:2980`). The state layer is out of
       * flow and clipped by construction, so crowding it is not a thing a card's
       * box can be made to feel.
       */
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
  for (const zone of Array.from(document.querySelectorAll<HTMLElement>('.seat [data-zone="battlefield"]'))) {
    const rows = Array.from(zone.querySelectorAll<HTMLElement>('[data-board-row]'));
    const tiers = Array.from(zone.querySelectorAll<HTMLElement>(':scope > .zone__tiers > ul[data-tier]'));
    if (rows.length === 0 && tiers.length === 2) {
      // Wave 32: a board that is not in the lane layout is two tiers (the opponent's always is),
      // lands behind and the rest in front, each drawing `--cols` columns of the busier one.
      const lands = share(counts.battlefield)[0]!;
      const split: Record<string, number> = { back: lands, front: counts.battlefield - lands };
      const cols = Math.max(...Object.values(split));
      for (const ul of tiers) {
        fillTo(ul, split[ul.dataset.tier ?? '']!, true);
        ul.style.setProperty('--cols', String(cols));
      }
      continue;
    }
    if (rows.length !== 4) throw new Error(`a battlefield has ${rows.length} rows and ${tiers.length} tiers, not 4 rows or 2 tiers`);
    const want = share(counts.battlefield);
    /*
     * `data-empty` and `--cols` are React's, and a probe that puts cards in a
     * lane owes it both (wave 27 §A.1). `--cols` is a COUNT and not a width:
     * `board.css:825` derives the lane's share from it as
     * `flex-grow: round(up, var(--cols) / var(--rows), 1)` — the columns a lane
     * draws, not the piles it holds — and `:977` derives `--rows` itself from
     * the count on `.zone__rows`. So the zone-wide total has to be written too,
     * and it has to be written THERE: a lane is `contain: size`, so no selector
     * can sum across the four.
     *
     * This probe used to write `row.style.flexGrow` directly, which was wave
     * 26's behaviour and is an inline style, so it beat the stylesheet and
     * pinned the very defect §A.1 fixed — the spec went green while measuring a
     * layout the product no longer produces. Setting the counts and letting
     * `board.css` do the arithmetic is the whole point.
     */
    const rowsList = zone.querySelector<HTMLElement>(':scope > ul.zone__rows');
    if (rowsList === null) throw new Error('a battlefield has no row list of its own');
    rowsList.style.setProperty('--cols', String(want.reduce((a, b) => a + b, 0)));
    rows.forEach((row, i) => {
      const ul = row.querySelector<HTMLElement>(':scope > ul.zone__cards');
      if (ul === null) throw new Error(`the ${row.dataset.boardRow ?? '?'} row has no list of its own`);
      fillTo(ul, want[i], true);
      if (want[i] > 0) row.removeAttribute('data-empty');
      row.style.setProperty('--cols', String(want[i]));
    });
  }
  const hand = document.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"]');
  if (hand !== null) {
    // The hand is ONE list and keeps its own row decision, from its own zone
    // (`board.css`, the `--rows` block), so its count goes on the list itself.
    const list = listIn(hand, 'zone__cards');
    fillTo(list, counts.hand, false);
    list.style.setProperty('--cols', String(counts.hand));
  }
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
          const tierLists = Array.from(zone.querySelectorAll<HTMLElement>(':scope > .zone__tiers > ul[data-tier]'));
          const tierGroups = tierLists.map(
            (list): RowFit => ({
              row: list.dataset.tier ?? '?',
              cards: list.children.length,
              empty: list.children.length === 0,
              cols: Number(list.style.getPropertyValue('--cols')),
              rows: getComputedStyle(list).gridTemplateRows.trim().split(/\s+/).filter((t) => t !== 'none' && t !== '').length,
              box: [list.clientWidth, list.clientHeight],
              scroll: [list.scrollWidth, list.scrollHeight],
              cardW: widthsOf(Array.from(list.children) as HTMLElement[]),
              grow: 0,
            }),
          );
          const groups = tierGroups.length > 0 ? tierGroups : Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__rows > li[data-board-row]')).map(
            (row): RowFit => {
              const inRow = Array.from(row.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li'));
              if (over(row)) overflowing.push(`the ${row.dataset.boardRow ?? '?'} row of ${inRow.length}`);
              const style = getComputedStyle(row);
              const list = row.querySelector<HTMLElement>(':scope > ul.zone__cards');
              const tracks = list === null ? '' : getComputedStyle(list).gridTemplateRows;
              return {
                row: row.dataset.boardRow ?? '?',
                cards: inRow.length,
                empty: row.hasAttribute('data-empty'),
                cols: Number(style.getPropertyValue('--cols').trim()),
                rows: tracks === '' || tracks === 'none' ? 0 : tracks.trim().split(/\s+/).length,
                box: [row.clientWidth, row.clientHeight],
                scroll: [row.scrollWidth, row.scrollHeight],
                cardW: widthsOf(inRow),
                grow: Number(style.flexGrow),
              };
            },
          );
          const cards =
            tierGroups.length > 0
              ? Array.from(zone.querySelectorAll<HTMLElement>(':scope > .zone__tiers > ul > li'))
              : groups.length > 0
                ? Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__rows > li > ul.zone__cards > li'))
                : Array.from(zone.querySelectorAll<HTMLElement>(':scope > ul.zone__cards > li'));
          const ul = zone.querySelector<HTMLElement>(
            tierGroups.length > 0
              ? ':scope > .zone__tiers > ul:not(:empty)'
              : groups.length > 0
                ? ':scope > ul.zone__rows > li:not([data-empty]) > ul.zone__cards'
                : ':scope > ul.zone__cards',
          );
          const fit: ZoneFit = {
            zone: zone.dataset.zone ?? '?',
            viewer: zone.closest('.seat[data-viewer]') !== null,
            cards: cards.length,
            rows: ul === null ? 0 : getComputedStyle(ul).gridTemplateRows.trim().split(/\s+/).length,
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
 * Take every probe copy back out, and put back what React would have written —
 * the `data-empty` the probe took off the rows it filled, so a row that is empty
 * again is a label strip again, and the `--cols` counts it wrote beside it
 * (wave 27 §A.1: the lane's, and the zone-wide total on `.zone__rows`, which is
 * what `board.css` reads `--rows` from). Runs in the page.
 */
function clearCrowd(): void {
  for (const el of Array.from(document.querySelectorAll('[data-probe]'))) el.remove();
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-board-row]'))) {
    const cards = row.querySelectorAll('.board-card').length;
    if (cards === 0) row.setAttribute('data-empty', 'true');
    row.style.setProperty('--cols', String(cards));
  }
  for (const list of Array.from(document.querySelectorAll<HTMLElement>('.board [data-zone="battlefield"] > ul.zone__rows'))) {
    list.style.setProperty('--cols', String(list.querySelectorAll('.board-card').length));
  }
  for (const list of Array.from(
    document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="hand"] > ul.zone__cards'),
  )) {
    list.style.setProperty('--cols', String(list.querySelectorAll('.board-card').length));
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
 * Wave 32 Q13: a creature's power/toughness sits in the bottom-RIGHT corner of its
 * card. Runs in the page. Reports each tile's P/T against the tile's own box.
 */
function ptCorners(): { checked: number; misplaced: string[] } {
  const misplaced: string[] = [];
  let checked = 0;
  for (const li of Array.from(document.querySelectorAll<HTMLElement>('.board [data-zone="battlefield"] li.board-card'))) {
    const pt = li.querySelector<HTMLElement>('.board-card__pt');
    const art = li.querySelector<HTMLElement>('[data-testid="card"]') ?? li;
    if (pt === null) continue;
    const a = art.getBoundingClientRect();
    const p = pt.getBoundingClientRect();
    if (a.width === 0 || p.width === 0) continue;
    // A tapped card is turned a quarter, so only untapped ones have a stable "bottom-right".
    if (li.hasAttribute('data-tapped') || li.hasAttribute('data-attacking')) continue;
    checked += 1;
    const inRight = p.left + p.width / 2 > a.left + a.width / 2;
    const inBottom = p.top + p.height / 2 > a.top + a.height / 2;
    const inside = p.right <= a.right + 2 && p.bottom <= a.bottom + 2;
    if (!(inRight && inBottom && inside)) misplaced.push(`${li.dataset.cardId}: pt ${[p.left, p.top, p.right, p.bottom].map(Math.round)} in card ${[a.left, a.top, a.right, a.bottom].map(Math.round)}`);
  }
  return { checked, misplaced };
}

/** One seat's left column, measured. All boxes are viewport rects. */
interface SeatColumn {
  seat: Box4;
  face: Box4;
  handCount: Box4;
  libraryCount: Box4;
  graveyard: Box4;
  /** Null while exile holds nothing: the strip is drawn only while it holds a card. */
  exile: (Box4 & { count: number }) | null;
  /** Exile zones that are DISPLAYED with `data-count="0"` (the product hides an empty one with display: none): there must be none. */
  emptyExileDrawn: number;
  /** Elements in the seat drawn mirrored (a negative scale on x or y): there must be none. */
  mirrored: string[];
  /** The 1 px-rounded layout size of the first card in the hand / the opponent's card backs. */
  handCard: [number, number] | null;
}
interface Box4 {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Wave 32 Q9, Q2: measure each seat's left column (avatar, the two counts, the
 * graveyard) and the hand's card size. Runs in the page. `offsetWidth` for the
 * cards, not a bounding rect, so a fan's rotation does not change what is compared.
 */
function measureColumns(): { you: SeatColumn; them: SeatColumn } {
  const box = (el: Element): Box4 => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const one = (seat: Element, what: string): SeatColumn => {
    const find = (sel: string): Element => {
      const el = seat.querySelector(sel);
      if (el === null) throw new Error(`${what}: no ${sel} in the seat`);
      return el;
    };
    const exile = seat.querySelector<HTMLElement>('[data-zone="exile"]');
    const mirrored: string[] = [];
    for (const el of Array.from(seat.querySelectorAll<HTMLElement>('*'))) {
      const t = getComputedStyle(el).transform;
      if (t === 'none') continue;
      const m = /^matrix\(([^)]+)\)$/.exec(t);
      if (m === null) continue;
      const [a, , , d] = m[1]!.split(',').map(Number);
      if (a! < 0 || d! < 0) mirrored.push(el.className === '' ? el.tagName.toLowerCase() : String(el.className));
    }
    const card = what === 'you'
      ? seat.querySelector<HTMLElement>('[data-zone="hand"] li.board-card')
      : seat.querySelector<HTMLElement>('[data-zone="hand"] ul.card-backs > li');
    return {
      seat: box(seat),
      face: box(find('[data-player-face]')),
      handCount: box(find('[data-testid="hand-count"]')),
      libraryCount: box(find('[data-testid="library-count"]')),
      graveyard: box(find('[data-zone="graveyard"]')),
      exile: exile === null || getComputedStyle(exile).display === 'none' ? null : { ...box(exile), count: Number(exile.dataset.count ?? '0') },
      emptyExileDrawn: Array.from(seat.querySelectorAll<HTMLElement>('[data-zone="exile"]')).filter((e) => Number(e.dataset.count ?? '0') === 0 && getComputedStyle(e).display !== 'none').length,
      mirrored,
      handCard: card === null ? null : [card.offsetWidth, card.offsetHeight],
    };
  };
  const you = document.querySelector('.seat[data-viewer]');
  const them = document.querySelector('.seat:not([data-viewer])');
  if (you === null || them === null) throw new Error('a seat is missing');
  return { you: one(you, 'you'), them: one(them, 'them') };
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
  const art = document.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="hand"] li.board-card [data-testid="card"]');
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
          // No `bar`: wave 26 §A deleted `.board__bar`, and the turn it carried is
          // the phase rail's — an overlay, not a slot on the canvas.
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
          ['battlefield', '.seat[data-viewer] [data-zone="battlefield"]'],
          ['hand', '.seat[data-viewer] [data-zone="hand"]'],
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
            board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] [data-board-row]'),
          ).map((r) => r.dataset.boardRow ?? '?'),
        });
      }),
    ),
  );
}

/**
 * Wave 32 (w31's open stack item): with a question up, the stack band must not clip
 * an effect's text (Ponder's is the operator's own example). Reads the board in the
 * asked state, with the stack filled with long-text probes, and reports every text the
 * band cuts off, by its own scroll box or by any clipping ancestor up to the band.
 * The caller has a REAL question open (the probe route): React owns `data-question`
 * and strips a hand-set one at the next frame. Runs in the page; the caller clears the probes.
 */
function stackTextClipped(): Promise<{ texts: number; clipped: string[]; asked: string }> {
  const mid = document.querySelector<HTMLElement>('.board__mid');
  if (mid === null) throw new Error('no stack band');
  const list = mid.querySelector<HTMLElement>('[data-zone="stack"] > ol.stack__items');
  if (list === null) throw new Error('no stack list');
  const sample = list.querySelector<HTMLElement>('.stack__item[data-probe]');
  if (sample === null) throw new Error('fillStack has not put a probe on the stack');
  return new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const clipped: string[] = [];
        const texts = Array.from(mid.querySelectorAll<HTMLElement>('.stack__text'));
        for (const t of texts) {
          const r = t.getBoundingClientRect();
          let why = t.scrollHeight > t.clientHeight + 1 ? `its own box (${t.scrollHeight}>${t.clientHeight})` : '';
          for (let a = t.parentElement; why === '' && a !== null && a !== mid.parentElement; a = a.parentElement) {
            const cs = getComputedStyle(a);
            // Only the vertical axis: the stack scrolls SIDEWAYS inside its slot by design.
            if (cs.overflowY === 'visible') continue;
            const ar = a.getBoundingClientRect();
            if (r.bottom > ar.bottom + 1 || r.top < ar.top - 1) why = `${a.className || a.tagName} (text ${Math.round(r.top)}-${Math.round(r.bottom)}, box ${Math.round(ar.top)}-${Math.round(ar.bottom)})`;
          }
          if (why !== '') clipped.push(`${t.textContent?.slice(0, 40)}: clipped by ${why}`);
        }
        done({ texts: texts.length, clipped, asked: `${getComputedStyle(mid).getPropertyValue('--mid-h')} asked=${mid.hasAttribute('data-question')} band=${Math.round(mid.getBoundingClientRect().height)}px what=${Array.from(mid.querySelectorAll('.stack__what')).map((i) => i.clientHeight + '/' + i.scrollHeight).join(',')}` });
      }),
    ),
  );
}

/** Take the probe items back off the stack. Runs in the page. */
function clearStack(): void {
  for (const el of Array.from(document.querySelectorAll('[data-zone="stack"] [data-probe]'))) el.remove();
}

/* ── a real question, in the column it actually gets ─────────────────── */

/**
 * How many cards the probe question offers. Forge's reveals and searches run
 * this big — a library search over a fetch land, `Squadron Hawk`'s "up to three
 * cards", a scry-and-reveal — and twelve is where a narrow column stops being a
 * theory.
 */
const QUESTION_CARDS = 12;
/**
 * And the grid must draw at least this many columns. Wave 27 §B.2: the question
 * column is 24.1% of a table that is 960 at a 1280 viewport, so the sheet's own
 * content box is ~200px, and `prompts.css`'s `--card-w: 7rem` floor (112px)
 * resolves `repeat(auto-fill, minmax(112px, 1fr))` to ONE column there — a
 * twelve-card reveal as a twelve-row scroll two cards tall. `live.css` asks the
 * same grid at 5rem inside the live column, which is two.
 */
const MIN_QUESTION_COLUMNS = 2;
/** What watchparty's `.wp-room-chrome` aside takes, and never gives back. */
const CHAT_ASIDE_PX = 320;
/**
 * The page's own inset, both sides together (wave 31 P6, `live.css`): the table's
 * left edge and the chat's right edge are the header's (`2rem` each), so a match
 * page is 64px narrower than "viewport less the aside" (896 at 1280, 982 at 1366;
 * it was 16px of shell padding, 944 and 1030, until then).
 * `docs/planning/wave31-evidence/p6-boundary.md` measured it.
 */
const PAGE_INSET_PX = 64;

interface QuestionFit {
  size: string;
  /** `.live`'s own box — the TABLE, which is the viewport less the chat aside. */
  live: [number, number];
  host: [number, number, number, number];
  sheet: { width: number; height: number; scrollW: number; scrollH: number; clientW: number; clientH: number };
  inside: boolean;
  sheetInsideHost: boolean;
  columns: number;
  cardW: number;
  page: [number, number];
  overflowing: string[];
}

/**
 * Put a REAL question in the question column and measure it. Runs in the page,
 * DOM only.
 *
 * The probe asks with the markup `ChoicePrompts` renders — `PromptShell`'s
 * `.prompt` around a `.prompt__cards` grid of real `CardTile`s cloned out of the
 * dealt hand — because the claim is about the STYLESHEET at this width and
 * nothing about the wire. The match is parked on a keep-or-mulligan question, so
 * React redraws nothing under it; `clearQuestion` takes it back out.
 *
 * The question that `play.spec.ts` and the first test above raise is a
 * `showConfirmDialog`: two lines of prose and two buttons, which fits any column
 * ever drawn. A reveal grid is the case the operator's 24.1% has to earn, and it
 * had never been measured at the table's real width.
 */
function askQuestion(cards: number): Promise<QuestionFit> {
  const live = document.querySelector<HTMLElement>('.live');
  if (live === null) throw new Error('no .live to put a question in');
  const source = Array.from(
    document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="hand"] li.board-card [data-testid="card"]'),
  );
  if (source.length === 0) throw new Error('no dealt hand to copy cards from');
  for (const el of Array.from(live.querySelectorAll('[data-question-probe]'))) el.remove();

  const host = document.createElement('div');
  host.className = 'live__prompt';
  host.setAttribute('data-question-probe', '');
  const sheet = document.createElement('section');
  sheet.className = 'prompt';
  sheet.setAttribute('data-prompt', 'getChoices');
  const title = document.createElement('h3');
  title.className = 'prompt__title';
  title.textContent = 'Reveal cards from your library and put one into your hand';
  const hint = document.createElement('p');
  hint.className = 'prompt__hint';
  hint.textContent = 'Choose exactly 1.';
  const grid = document.createElement('ul');
  grid.className = 'prompt__cards';
  for (let i = 0; i < cards; i += 1) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const tile = document.createElement('span');
    tile.className = 'prompt__tile';
    tile.appendChild(source[i % source.length].cloneNode(true));
    label.appendChild(tile);
    li.appendChild(label);
    grid.appendChild(li);
  }
  const actions = document.createElement('div');
  actions.className = 'prompt__actions';
  for (const word of ['Cancel', 'OK']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'prompt__submit';
    b.textContent = word;
    actions.appendChild(b);
  }
  sheet.append(title, hint, grid, actions);
  host.appendChild(sheet);
  live.appendChild(host);

  return new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const page = document.scrollingElement ?? document.documentElement;
        const over = (el: HTMLElement): boolean => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
        const overflowing: string[] = [];
        const match = document.querySelector<HTMLElement>('[data-testid="match"]');
        for (let el: HTMLElement | null = match; el !== null && el !== document.documentElement; el = el.parentElement) {
          if (over(el)) overflowing.push(el.className === '' ? el.tagName.toLowerCase() : el.className);
        }
        const h = host.getBoundingClientRect();
        const s = sheet.getBoundingClientRect();
        const tiles = Array.from(grid.children).map((li) => li.getBoundingClientRect());
        done({
          size: `${innerWidth}x${innerHeight}`,
          live: [live.clientWidth, live.clientHeight],
          host: [h.left, h.top, h.width, h.height].map((n) => Math.round(n)) as [number, number, number, number],
          sheet: {
            width: Math.round(s.width),
            height: Math.round(s.height),
            scrollW: sheet.scrollWidth,
            scrollH: sheet.scrollHeight,
            clientW: sheet.clientWidth,
            clientH: sheet.clientHeight,
          },
          inside: h.top >= 0 && h.left >= 0 && h.bottom <= innerHeight + 0.5 && h.right <= innerWidth + 0.5,
          sheetInsideHost:
            s.top >= h.top - 0.5 && s.bottom <= h.bottom + 0.5 && s.left >= h.left - 0.5 && s.right <= h.right + 0.5,
          columns: new Set(tiles.map((r) => Math.round(r.left))).size,
          cardW: Math.round(Math.min(...tiles.map((r) => r.width))),
          page: [page.scrollWidth, page.scrollHeight],
          overflowing,
        });
      }),
    ),
  );
}

/** Take the probe question back off the page. Runs in the page. */
function clearQuestion(): void {
  for (const el of Array.from(document.querySelectorAll('[data-question-probe]'))) el.remove();
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
  const questions: (QuestionFit & { who: string })[] = [];
  const columnShots: Record<string, unknown>[] = [];
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
        .poll(async () => f.page.locator('.seat[data-viewer] [data-zone="hand"] li.board-card').count(), {
          timeout: 30_000,
          message: `${f.name}: no opening hand was dealt`,
        })
        .toBeGreaterThan(0);
    }
    await expect.poll(async () => /keep your hand/i.test((await decider.page.getByTestId('live-says').textContent()) ?? ''), { timeout: 30_000 }).toBe(true);
    // The crowd probe fills the four lanes, which the default single board does not have.
    for (const f of friends) await chooseLanes(f);

    for (const sizes of [SIZES, { alice: SIZES.bob, bob: SIZES.alice }]) {
      for (const f of friends) await f.page.setViewportSize(sizes[f.name as keyof typeof SIZES]);
      for (const f of friends) {
        /* ── the canvas is static: fill the stack, and nothing else may move ── */
        const shots: StaticShot[] = [];
        for (const n of STACK_STEPS) shots.push(await f.page.evaluate(fillStack, n));
        // The asked band: a long effect is readable with a REAL question up (w31 left this open).
        // The question is Forge's own, through the probe route, so `data-question` is React's.
        {
          const pending = alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches/${summary.matchId}/probe`, {
            data: { seat: f === alice ? 0 : 1, message: 'e2e table fit: is the stack readable under a question?' },
            timeout: 120_000,
          });
          pending.catch(() => undefined); // an assertion below must not be masked by the disposed context
          await expect(f.page.getByTestId('confirm-dialog')).toBeVisible({ timeout: 60_000 });
          await f.page.evaluate(fillStack, 2);
          const asked = await f.page.evaluate(stackTextClipped);
          if (SHOTS !== '') await f.page.screenshot({ path: resolve(SHOTS, `stack-asked-${f.name}-${f.page.viewportSize()!.width}.png`) });
          await f.page.evaluate(clearStack);
          expect(asked.asked, `${f.name}: the board is in its asked state (${asked.asked})`).toContain('asked=true');
          expect(asked.texts, `${f.name}: the asked stack band measured the effect texts`).toBeGreaterThan(0);
          expect.soft(asked.clipped, `${f.name}: with a question up the stack band clips no effect text (${asked.asked})`).toEqual([]);
          await f.page.getByTestId('confirm-dialog').locator('[data-answer="yes"]').click();
          expect((await pending).status(), `${f.name}: Forge got the answer`).toBe(200);
        }
        staticShots.push(...shots.map((s) => ({ who: f.name, ...s })));
        const base = shots[0]!;
        const where = `${f.name} at ${base.size}`;
        console.log(
          `[table-fit static] ${where}: faces you ${base.faces.you} them ${base.faces.them}; ` +
            shots.map((s) => `${s.items} on the stack → mid ${s.boxes.mid}, you/battlefield ${s.boxes['you/battlefield']}`).join('; '),
        );
        // The board really was measured: every slot, and a face per player.
        // Wave 32 Q9: exile is drawn only while it holds a card, so it is not a slot
        // every seat has. Whatever exile boxes there are are checked in the column block.
        expect(Object.keys(base.boxes).filter((k) => !k.endsWith('/exile')).sort(), `${where}: every slot measured`).toEqual([
          'board',
          'face/0',
          'face/1',
          'mid',
          'overlay',
          'table/stack',
          'them',
          'them/battlefield',
          'them/graveyard',
          'them/hand',
          'you',
          'you/battlefield',
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
         * The faces anchor the table (item 11): theirs at the top of the canvas,
         * ours at the bottom, and neither of them anywhere near the stack. The
         * operator could not tell the two apart when both sat in the stack's band.
         *
         * Wave 26 re-blocked the table and the stack stopped being a BAND: it is
         * the operator's own column now (`.board__mid`, measured at 59.4% across
         * and a ninth of the canvas' height — `board-layout-2026-09-27.md`), with
         * the faces in the ~5.6% left column of each seat. So "above the band" and
         * "below the band" are not what the geometry says any more, and asserting
         * them would fail a layout the operator drew. What the complaint was about
         * survives exactly, as two claims that hold under either blocking: the two
         * faces do not share space with each other, and neither shares space with
         * the stack.
         */
        {
          const at = (box: string) => {
            const [left, top, w, h] = box.split(',').map(Number);
            return { left: left!, top: top!, right: left! + w!, bottom: top! + h!, mid: top! + h! / 2, width: w! };
          };
          const board = at(base.boxes.board!);
          const stack = at(base.boxes.mid!);
          const you = at(base.faces.you);
          const them = at(base.faces.them);
          const third = (board.bottom - board.top) / 3;
          /*
           * Wave 20 put the faces at opposite ENDS of the canvas and asserted each
           * sat in its own outer third. Wave 28 item 10 reversed that on the
           * operator's instruction — *"avatars a looking awkward in that position.
           * lets push them closer together. bottom avatar anchored top of that box,
           * top avatar anchored bottom of that box"* — so the outer-third claims are
           * now false BY DESIGN (measured after §A: mid 351 and 429, against thirds
           * at 267 and 533). Asserting them would pin the layout the operator asked
           * us to leave.
           *
           * What item 10 actually asks for is the positive claim, so that is what is
           * asserted: the two faces are CLOSER together than a third of the canvas.
           * The two properties that outlived the move — theirs finishes before ours
           * starts, and neither touches the stack — are just below, unchanged.
           */
          expect(you.mid - them.mid, `${where}: the two faces are closer together than a third of the canvas`).toBeLessThan(third);
          // Opposite ends, with nothing shared: theirs finishes before ours starts.
          expect(them.bottom, `${where}: their face is wholly above ours`).toBeLessThanOrEqual(you.top);
          // And neither face shares a pixel with the stack.
          type Box = ReturnType<typeof at>;
          const clear = (a: Box, b: Box): boolean =>
            a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right;
          for (const [whose, face] of [['their', them], ['our', you]] as const) {
            expect(clear(face, stack), `${where}: ${whose} face is clear of the stack (${base.boxes.mid})`).toBe(true);
          }
          // And the grouping is there, in the order it is drawn.
          expect(base.rows, `${where}: the battlefield's rows`).toEqual([...BOARD_ROWS]);
        }

        /* ── wave 32 Q9 / Q2: the left column, and the opponent's hand ──── */
        {
          const cols = await f.page.evaluate(measureColumns);
          const tol = 3;
          // Measured 24 px: the graveyard pile's own margin under the counts row. Anything near the
          // avatar's height (~60) would be a second cell, which is the w26 layout this retires.
          const GAP_MAX = 32;
          const overlapX = (a: Box4, b: Box4): boolean => a.left < b.right - 1 && b.left < a.right - 1;
          for (const side of ['you', 'them'] as const) {
            const c = cols[side];
            const w = `${where}, ${side}'s column`;
            // One column: the avatar, the counts and the graveyard share horizontal space.
            for (const [name, b] of [['hand count', c.handCount], ['library count', c.libraryCount], ['graveyard', c.graveyard]] as const) {
              expect(overlapX(c.face, b), `${w}: the avatar and the ${name} share a column`).toBe(true);
            }
            // Order along the column: yours reads down (avatar, counts, graveyard), theirs is the vertical mirror.
            const counts = { top: Math.min(c.handCount.top, c.libraryCount.top), bottom: Math.max(c.handCount.bottom, c.libraryCount.bottom) };
            if (side === 'you') {
              expect(c.face.bottom, `${w}: the avatar is above the counts`).toBeLessThanOrEqual(counts.top + tol);
              expect(counts.bottom, `${w}: the counts are above the graveyard`).toBeLessThanOrEqual(c.graveyard.top + tol);
              // The graveyard takes what is left: it starts where the counts end ...
              expect(c.graveyard.top - counts.bottom, `${w}: nothing but the counts sits between them and the graveyard (a pile's own margin at most)`).toBeLessThanOrEqual(GAP_MAX);
              // ... and runs to the column's end (the exile strip, when there is one, is below it).
              const floor = c.exile === null ? c.seat.bottom : c.exile.top;
              expect(floor - c.graveyard.bottom, `${w}: the graveyard runs to the end of the column`).toBeLessThanOrEqual(tol * 3);
            } else {
              expect(c.graveyard.bottom, `${w}: the graveyard is above the counts`).toBeLessThanOrEqual(counts.top + tol);
              expect(counts.bottom, `${w}: the counts are above the avatar`).toBeLessThanOrEqual(c.face.top + tol);
              expect(counts.top - c.graveyard.bottom, `${w}: nothing but the counts sits between them and the graveyard (a pile's own margin at most)`).toBeLessThanOrEqual(GAP_MAX);
              const roof = c.exile === null ? c.seat.top : c.exile.bottom;
              expect(c.graveyard.top - roof, `${w}: the graveyard runs to the end of the column`).toBeLessThanOrEqual(tol * 3);
            }
            // The graveyard is the tall one: taller than the avatar and the counts together.
            expect(c.graveyard.bottom - c.graveyard.top, `${w}: the graveyard takes the rest`).toBeGreaterThan(
              c.face.bottom - c.face.top + counts.bottom - counts.top,
            );
            expect(c.emptyExileDrawn, `${w}: exile is drawn only while it holds a card`).toBe(0);
            expect(c.mirrored, `${w}: nothing is drawn mirrored or upside down`).toEqual([]);
            console.log(
              `[table-fit column] ${w} at ${base.size}: graveyard ${Math.round(c.graveyard.bottom - c.graveyard.top)}px of the seat's ` +
                `${Math.round(c.seat.bottom - c.seat.top)}px (${(((c.graveyard.bottom - c.graveyard.top) / (c.seat.bottom - c.seat.top)) * 100).toFixed(1)}%, information only)`,
            );
          }
          // Mirrored vertically across the table: theirs is above yours.
          expect(cols.them.seat.bottom, `${where}: their seat is wholly above yours`).toBeLessThanOrEqual(cols.you.seat.top + tol);
          // Q2: the opponent's hand is drawn at the card size of yours.
          expect(cols.you.handCard, `${where}: you hold cards`).not.toBeNull();
          expect(cols.them.handCard, `${where}: they hold card backs`).not.toBeNull();
          expect(
            Math.abs(cols.them.handCard![0] - cols.you.handCard![0]) <= 1 && Math.abs(cols.them.handCard![1] - cols.you.handCard![1]) <= 1,
            `${where}: their hand's card (${cols.them.handCard}) is the size of yours (${cols.you.handCard})`,
          ).toBe(true);
          columnShots.push({ who: f.name, size: base.size, ...cols });
          // Q16: the z-order scale is on :root, in the order popovers over overlays over badges over the board.
          const z = await f.page.evaluate(() =>
            ['--z-board', '--z-card-badge', '--z-overlay', '--z-popover'].map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()),
          );
          expect(z, `${where}: the z-order scale`).toEqual(['0', '1', '20', '40']);
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

        /* ── a real question, in the column the operator drew (§B.2) ──── */
        const q = await f.page.evaluate(askQuestion, QUESTION_CARDS);
        await f.page.evaluate(clearQuestion);
        questions.push({ who: f.name, ...q });
        console.log(
          `[table-fit question] ${f.name} ${q.size}: table ${q.live.join('x')}; host ${q.host.join(',')}; ` +
            `sheet ${q.sheet.width}x${q.sheet.height} scroll ${q.sheet.scrollW}x${q.sheet.scrollH} in ${q.sheet.clientW}x${q.sheet.clientH}; ` +
            `${q.columns} columns of ${q.cardW}px; overflowing ${JSON.stringify(q.overflowing)}`,
        );
        {
          const qw = `${f.name} at ${q.size}, a ${QUESTION_CARDS}-card question`;
          /*
           * The settled width, asserted rather than assumed: the table is the
           * viewport less watchparty's pinned 320px aside, less the page's own
           * 2rem inset on each side (`PAGE_INSET_PX`, wave 31 P6). 960 → 896 at
           * 1280, 1046 → 982 at 1366. Wave 26's blocking was applied as if the
           * table had the whole 1280, and this is the line that says out loud
           * that it does not.
           */
          const viewportW = Number(q.size.split('x')[0]);
          expect(q.live[0], `${qw}: the table is the viewport less the chat aside and the page inset`).toBeLessThanOrEqual(
            viewportW - CHAT_ASIDE_PX - PAGE_INSET_PX,
          );
          expect(q.live[0], `${qw}: and not much less than that`).toBeGreaterThanOrEqual(viewportW - CHAT_ASIDE_PX - PAGE_INSET_PX - 24);
          // It is in the window, the sheet is inside its host rather than
          // hanging out of it, and nothing around the match grew.
          expect(q.inside, `${qw}: the question is wholly inside the window (${q.host.join(',')})`).toBe(true);
          expect(q.sheetInsideHost, `${qw}: the sheet stays inside the column it was given`).toBe(true);
          expect(q.overflowing, `${qw}: the match and every box around it holds what is in it`).toEqual([]);
          expect(q.page[1], `${qw}: the page scrolls vertically`).toBeLessThanOrEqual(Number(q.size.split('x')[1]));
          expect(q.page[0], `${qw}: the page scrolls sideways`).toBeLessThanOrEqual(viewportW);
          /*
           * What does not fit scrolls DOWNWARD inside the sheet and never
           * sideways: a card grid a player has to scroll left and right is how a
           * reveal loses the card it was about.
           */
          expect(q.sheet.scrollW, `${qw}: the sheet scrolls sideways`).toBeLessThanOrEqual(q.sheet.clientW + 1);
          // And the grid is worth reading at this width (§B.2).
          expect(q.columns, `${qw}: the reveal grid's columns`).toBeGreaterThanOrEqual(MIN_QUESTION_COLUMNS);
          expect(q.cardW, `${qw}: the narrowest card in the question`).toBeGreaterThanOrEqual(MIN_GROUPED_CARD_PX);
        }

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
                    (z.groups.length === 0
                      ? ''
                      : ` [${z.groups.map((g) => `${g.row} ${g.cards}c/${g.rows}r grow ${g.grow} ${g.box[0]}x${g.box[1]}px card ${g.cardW[0]}-${g.cardW[1]}w`).join(' | ')}]`),
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
            if (z.groups.every((g) => g.row === 'front' || g.row === 'back')) {
              // Not in the lane layout (the opponent's never is): two tiers, lands behind, the rest in front.
              expect(z.groups.map((g) => g.row).sort(), `${where}: ${side} battlefield's tiers`).toEqual(['back', 'front']);
              expect(z.groups.reduce((n, g) => n + g.cards, 0), `${where}: every card of ${side} battlefield is in a tier`).toBe(counts.battlefield);
              for (const g of z.groups) {
                expect(g.scroll[0], `${where}: ${side} ${g.row} tier scrolls sideways`).toBeLessThanOrEqual(g.box[0] + 1);
                expect(g.scroll[1], `${where}: ${side} ${g.row} tier scrolls downward`).toBeLessThanOrEqual(g.box[1] + 1);
              }
              continue;
            }
            expect(z.groups.map((g) => g.row), `${where}: ${side} battlefield's rows`).toEqual([...BOARD_ROWS]);
            const filled = z.groups.filter((g) => g.cards > 0);
            expect(filled.length, `${where}: ${side} battlefield spread over rows`).toBeGreaterThanOrEqual(3);
            expect(
              z.groups.reduce((n, g) => n + g.cards, 0),
              `${where}: every card of ${side} battlefield is in a row`,
            ).toBe(counts.battlefield);
            /*
             * The probe drove the product's OWN sizing path (wave 27 §A.1), and
             * this is the line that says so: the lane's `--cols` as the browser
             * resolved it is the count the probe set, `--rows` is one number for
             * the whole zone, and `flex-grow` is `board.css`'s own
             * `ceil(cols / rows)` rather than anything this file chose.
             *
             * It is asserted because the failure it guards against is silent:
             * this probe used to write `flex-grow` inline, which beat the
             * stylesheet, so it went on measuring wave 26's rule after §A.1
             * replaced it. A green spec that tests a layout the product does not
             * produce is worse than a red one.
             */
            const zoneRows = [...new Set(filled.map((g) => g.rows))];
            expect(zoneRows, `${where}: ${side} battlefield settles ONE row count for every lane that holds cards`).toHaveLength(1);
            const perZone = zoneRows[0]!;
            expect(perZone, `${where}: ${side} battlefield draws at least one row`).toBeGreaterThanOrEqual(1);
            for (const g of z.groups) {
              expect(g.empty, `${where}: ${side} ${g.row} of ${g.cards} marks itself empty`).toBe(g.cards === 0);
              expect(g.cols, `${where}: ${side} ${g.row}'s --cols is the count it holds`).toBe(g.cards);
              expect(g.grow, `${where}: ${side} ${g.row} grows by the COLUMNS it draws, not the piles it holds`).toBe(
                Math.ceil(g.cards / perZone),
              );
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
    summary.seatColumns = columnShots;
    summary.questions = questions;
  } finally {
    for (const f of friends) await f.context.close();
    await stack.stop();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      resolve(RUN_DIR, 'table-fit-crowd-summary.json'),
      JSON.stringify({ ...summary, crowd: steps, staticCanvas: staticShots, questions }, null, 2),
    );
  }
});
