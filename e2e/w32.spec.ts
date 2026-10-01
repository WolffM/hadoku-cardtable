/**
 * Wave 32: what the third play test found, in a real browser against a real Forge.
 *
 *  1. **The start of the game reads `Start`, not `0 Nobody` (Q1), and an End Turn
 *     passes the skipped phases at once (Q5) while an ordinary pass keeps Forge's
 *     own pace.** Operator: *"only when 'end turn' is clicked."* The rail's phase
 *     changes are timestamped in the page, so the gap measured is the one a person
 *     watching would see.
 *  2. **No creatures, no block (Q10), and a Mana Leak with one spell on the stack
 *     answers itself (Q7).** Neither can be staged: a blocker window needs an attack
 *     into a creature-less seat, and a counterspell needs a particular hand. So one
 *     long game is played by both hands and WATCHED: every Declare Blockers window a
 *     seat with no creature was stopped at is a violation, and every ask that
 *     offers stack items while the stack holds exactly one is one too. The counts of
 *     windows seen are reported, because a run that never met the situation proved
 *     nothing about it (`measurement pending` in the closing note, with this command).
 *  3. **An avatar change reaches the board (Q6).** The watchparty picker saves into
 *     the prefs SDK's write-through cache (`prefs-cache:<user>:watchparty`); the page
 *     writes that row the way the SDK does, and BOTH boards must redraw that seat's
 *     face within a few seconds, with no reload.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`) like
 * `play.spec.ts`; without one each test SKIPS and its title says why. Serves the
 * prebuilt `apps/ui/dist`: rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { openFriend, type Friend } from './play/browser.ts';
import { enterMatch } from './play/enter.ts';
import { connectHands } from './play/hands.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { turnNumber } from './play/turn.ts';

test.describe.configure({ mode: 'serial' });

const forge = forgeAvailability();
const titled = (t: string): string => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

/** Forge's own pace at a phase it is not set up to skip (`FControlGamePlayback.phasesDelay`), about 205 ms in the w31 log. */
const FORGE_PACE_MS = 205;

/* ── what a page shows ───────────────────────────────────────────────── */

const says = async (page: Page): Promise<string> => (await page.getByTestId('live-says').textContent()) ?? '';
const enabledOk = (page: Page) => page.locator('[data-testid="live-button-ok"]:enabled');
const secondButton = async (page: Page): Promise<string | null> => {
  const b = page.getByTestId('live-button-cancel');
  return (await b.count()) > 0 && (await b.isEnabled()) ? ((await b.textContent()) ?? '').trim() : null;
};

interface PhaseEntry {
  t: number;
  phase: string;
  whose: string;
  turn: string;
}

/** Timestamp every change of the rail's phase, in the page, so a gap is the page's own. */
async function watchPhases(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __phases?: PhaseEntry[] };
    w.__phases = [];
    const rail = document.querySelector<HTMLElement>('[data-testid="live-phases"]');
    if (rail === null) throw new Error('no phase rail to watch');
    let last = rail.dataset.phase ?? '';
    new MutationObserver(() => {
      const phase = rail.dataset.phase ?? '';
      if (phase === last) return;
      last = phase;
      w.__phases!.push({ t: performance.now(), phase, whose: rail.dataset.whose ?? '', turn: document.querySelector('[data-testid="live-turn-n"]')?.textContent ?? '' });
    }).observe(rail, { attributes: true, attributeFilter: ['data-phase'] });
  });
}

const phasesOf = (page: Page): Promise<PhaseEntry[]> =>
  page.evaluate(() => [...((window as unknown as { __phases?: PhaseEntry[] }).__phases ?? [])]);
const mark = (page: Page): Promise<number> => page.evaluate(() => performance.now());

const gaps = (entries: PhaseEntry[]): number[] => entries.slice(1).map((e, i) => Math.round(e.t - entries[i]!.t));
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** Both keep their hands; returns once someone holds priority in their own precombat main with an End Turn button. */
async function toFirstPriority(alice: Friend, bob: Friend): Promise<Friend> {
  for (let i = 0; i < 120; i++) {
    for (const f of [alice, bob]) {
      await answerPrompt(f.page);
      const text = await says(f.page);
      if (/play or draw/i.test(text) && (await enabledOk(f.page).count()) > 0) await enabledOk(f.page).click();
      else if (/keep your hand/i.test(text) && (await enabledOk(f.page).count()) > 0) await enabledOk(f.page).click();
      else if ((await secondButton(f.page)) === 'End Turn') return f;
    }
    await alice.page.waitForTimeout(250);
  }
  throw new Error(`nobody reached priority with End Turn offered; alice: ${await says(alice.page)} | bob: ${await says(bob.page)}`);
}

/* ── 1. Start, and End Turn ──────────────────────────────────────────── */

test(titled('the turn reads Start with no name under it (Q1); End Turn passes skipped phases at once, an ordinary pass keeps Forge\'s pace (Q5)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await enterMatch(alice, bob, stack.origin);

    // Q1: before turn 1 the rail says Start, and the name that sat under it is gone.
    for (const f of [alice, bob]) {
      await expect(f.page.getByTestId('live-turn-n'), `${f.name}: turn 0 reads Start`).toHaveText('Start');
      expect(turnNumber(await f.page.getByTestId('live-turn-n').textContent()), 'Start is turn 0').toBe(0);
      await expect(f.page.locator('.live__turn-who'), `${f.name}: no name under the turn counter`).toHaveCount(0);
      await expect(f.page.getByTestId('live-phases'), `${f.name}: data-whose stays for the specs`).toHaveAttribute('data-whose', /^(yours|theirs|nobody)$/);
    }

    for (const f of [alice, bob]) await watchPhases(f.page);
    const first = await toFirstPriority(alice, bob);
    const second = first === alice ? bob : alice;
    await expect(first.page.getByTestId('live-turn-n'), 'turn 1 has a number').toHaveText(/^\d+$/);

    // ── End Turn: every phase the seat is not stopped at passes without Forge's pause.
    const clicked = await mark(first.page);
    await first.page.getByTestId('live-button-cancel').click();
    await expect
      .poll(async () => (await phasesOf(first.page)).filter((e) => e.t > clicked && e.whose === 'theirs').length, { timeout: 60_000, message: 'the End Turn ran the turn out' })
      .toBeGreaterThan(0);
    const own = (await phasesOf(first.page)).filter((e) => e.t > clicked);
    const endTurnGaps = gaps(own.filter((e) => e.whose === 'yours'));
    const withClick = [clicked - 0, ...own.filter((e) => e.whose === 'yours').map((e) => e.t)];
    console.log(`[w32 q5] End Turn: ${own.filter((e) => e.whose === 'yours').map((e) => e.phase).join(' > ')}; gaps ${endTurnGaps.join(', ')} ms; click to first ${Math.round(withClick[1]! - withClick[0]!)} ms`);
    expect(endTurnGaps.length, 'an End Turn passes through several phases to measure').toBeGreaterThanOrEqual(3);
    expect(median(endTurnGaps), `End Turn: the median gap between auto-passed phases (${endTurnGaps.join(', ')} ms)`).toBeLessThan(60);
    expect(Math.max(...endTurnGaps), 'End Turn: no phase waits out Forge\'s own pause').toBeLessThan(FORGE_PACE_MS - 60);

    // ── A pass that is NOT an End Turn: the other seat, on its own turn, presses OK at
    // its main phase; the phases it passes through keep Forge's pace.
    for (let i = 0; i < 120 && (await secondButton(second.page)) !== 'End Turn'; i++) {
      for (const f of [alice, bob]) await answerPrompt(f.page);
      // The first seat is not the one being measured: pass whatever stops it.
      if ((await enabledOk(first.page).count()) > 0 && (await secondButton(first.page)) === null) await enabledOk(first.page).click();
      await first.page.waitForTimeout(150);
    }
    expect(await secondButton(second.page), `${second.name} reached its own main phase`).toBe('End Turn');
    const passed = await mark(second.page);
    await enabledOk(second.page).click();
    await expect
      .poll(async () => {
        for (const f of [alice, bob]) await answerPrompt(f.page);
        return (await phasesOf(second.page)).filter((e) => e.t > passed).length;
      }, { timeout: 60_000, message: 'an ordinary pass moved the game on' })
      .toBeGreaterThanOrEqual(3);
    const passes = (await phasesOf(second.page)).filter((e) => e.t > passed && e.whose === 'yours');
    const passGaps = gaps(passes);
    console.log(`[w32 q5] plain pass: ${passes.map((e) => e.phase).join(' > ')}; gaps ${passGaps.join(', ')} ms`);
    expect(passGaps.length, 'an ordinary pass runs through phases to measure').toBeGreaterThanOrEqual(2);
    expect(median(passGaps), `an ordinary pass keeps Forge's pace (${passGaps.join(', ')} ms)`).toBeGreaterThan(120);
  } finally {
    await stack.stop();
  }
});

/* ── 2. no creatures no block, and one spell on the stack ─────────────── */

test(titled('a seat with no creatures is never stopped at Declare Blockers (Q10); an ask over a lone stack spell never reaches the player (Q7)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(8 * 60_000);
  const stack = await startPlayStack(forge);
  const hands: Awaited<ReturnType<typeof connectHands>>[] = [];
  const seen = { blockerWindows: 0, blockerStops: 0, stopsWithoutCreatures: [] as string[], stackAsks: 0, loneStackAsks: [] as string[] };
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await enterMatch(alice, bob, stack.origin);
    // Both hands play the game: lands, spells, passes. The watcher below only reads.
    const first = await toFirstPriority(alice, bob);
    void first;
    hands.push(await connectHands(alice, 0), await connectHands(bob, 1));

    const look = (f: Friend) =>
      f.page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('[data-testid="live-phases"]');
        const mine = Array.from(document.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] li.board-card'));
        const creatures = mine.filter((li) => /creature/i.test(li.querySelector('.card__type')?.textContent ?? '')).length;
        const prompt = document.querySelector<HTMLElement>('[data-testid="live-prompt"]');
        return {
          phase: rail?.dataset.phase ?? '',
          whose: rail?.dataset.whose ?? '',
          turn: Number(rail?.dataset.turn ?? '0'),
          creatures,
          okEnabled: document.querySelector('[data-testid="live-button-ok"]:enabled') !== null,
          fullControl: document.querySelector('[data-testid="live-full-control"]')?.getAttribute('aria-pressed') === 'true',
          askMethod: prompt?.dataset.method ?? null,
          // A getChoices with ONE choice that names the spell on the stack is the Mana Leak question.
          askLoneStackChoice: (() => {
            if (prompt === null) return false;
            const choices = prompt.querySelectorAll('[data-testid="prompt-choice"]');
            const source = document.querySelector('[data-zone="stack"] .stack__item .stack__source')?.textContent?.trim() ?? '';
            return choices.length === 1 && source !== '' && (prompt.textContent ?? '').includes(source);
          })(),
          stackItems: document.querySelectorAll('[data-zone="stack"] .stack__item').length,
        };
      });

    const deadline = Date.now() + 6 * 60_000;
    let turn = 0;
    while (turn < 14 && Date.now() < deadline) {
      for (const f of [alice, bob]) {
        const s = await look(f);
        turn = Math.max(turn, s.turn);
        if (s.phase === 'COMBAT_DECLARE_BLOCKERS' && s.whose === 'theirs') {
          seen.blockerWindows += 1;
          // A stop is an enabled OK (priority) or an ask; a seat with no creature must have neither.
          if (s.creatures === 0 && s.okEnabled && !s.fullControl) {
            seen.blockerStops += 1;
            seen.stopsWithoutCreatures.push(`${f.name} turn ${s.turn}`);
          }
        }
        if (s.askMethod === 'getChoices' && s.askLoneStackChoice && s.stackItems === 1) {
          seen.stackAsks += 1;
          if (!s.fullControl) seen.loneStackAsks.push(`${f.name} turn ${s.turn}`);
        }
      }
      await alice.page.waitForTimeout(40);
    }
    console.log(`[w32 q10/q7] to turn ${turn}: Declare Blockers windows seen ${seen.blockerWindows}, stops without creatures ${seen.blockerStops}; stack asks seen ${seen.stackAsks}, lone-spell asks ${seen.loneStackAsks.length}`);
    expect(seen.stopsWithoutCreatures, 'no stop at Declare Blockers for a seat with no creature that could block').toEqual([]);
    expect(seen.loneStackAsks, 'no one-spell stack target question reaches the player: the only target answers itself').toEqual([]);
  } finally {
    for (const h of hands) await h.close();
    await stack.stop();
  }
});

/* ── 3. an avatar change reaches the board ───────────────────────────── */

test(titled('changing the saved avatar mid-match redraws that seat\'s face on both boards, with no reload (Q6)'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const bob = await openFriend(browser, 'bob');
    await enterMatch(alice, bob, stack.origin);

    const key = 'prefs-cache:e2e-alice-id:watchparty';
    const save = (page: Page, sprite: string) =>
      page.evaluate(
        ([k, id]) => localStorage.setItem(k!, JSON.stringify({ blob: { sprite: id }, userVersion: 1, deviceVersion: 1, cachedAt: Date.now() })),
        [key, sprite],
      );
    // Alice's face, on her own board and on bob's.
    const faceOf = (f: Friend) => (f === alice ? f.page.locator('[data-player-face][data-viewer]') : f.page.locator('[data-player-face]:not([data-viewer])'));
    const navigations: string[] = [];
    for (const f of [alice, bob]) f.page.on('framenavigated', (fr) => fr === f.page.mainFrame() && navigations.push(`${f.name}: ${fr.url()}`));
    const before = navigations.length;

    for (const sprite of ['e2e-sprite-one', 'e2e-sprite-two']) {
      await save(alice.page, sprite);
      for (const f of [alice, bob]) {
        await expect(faceOf(f), `${f.name}: alice's face is redrawn with ${sprite}`).toHaveAttribute('data-avatar', sprite, { timeout: 20_000 });
        await expect(faceOf(f).getByTestId('seat-avatar'), `${f.name}: the face draws that avatar's image`).toHaveAttribute('src', new RegExp(`square_${sprite}\\.png$`));
      }
    }
    expect(navigations.length, 'the pages were not reloaded to show it').toBe(before);
  } finally {
    await stack.stop();
  }
});
