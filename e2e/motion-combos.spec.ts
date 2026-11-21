/**
 * Every combination of the motion switches and Game speed draws the site whole (operator, 2026-11-21: "we do
 * need to e2e test to make sure each combination of these things doesn't break the way the site displays
 * things").
 *
 * The switches (`@hadoku/ui-shell/motion`): Card animations, Screen shake, Looping animations, and the front
 * page's match; Game speed is Normal, Fast or Instant. Each is set the way a player sets it, through the
 * settings, and applies live, so one page walks through every combination without a reload.
 *
 *   - **The board**, one match per speed, eight Lava Axes at the AI's face (`motion-combos.state`), one cast
 *     per combination of the three board switches. A sampler in the page reads every animation frame: the
 *     page never scrolls, the button bar stays inside the window, the table shakes only with Card animations
 *     AND Screen shake on, the bolt flies only with Card animations on, and it flies at the speed's tempo
 *     (Fast twice as quick; Normal and Instant at 1×, each repeat of a spell in a turn quicker by
 *     `tempo.ts`'s step). Between casts the flyer's and the hexproof sweep's endless loops run, or stand still
 *     (paused, or drawn in their reduced-motion look), as Looping animations says.
 *   - **The front page**, with a replay kept: all 48 combinations, at a desktop window and a phone's. The
 *     featured card is in the grid exactly when Front page match is on, its pause button stills it and play
 *     starts it again, and with Looping animations off every endless loop the app's own sheets draw is paused.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { PREFIX, SESSION_COOKIE } from './identities.ts';
import { castUntilOnStack, handCardNamed, lifeOf, makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { setGameSpeed, type GameSpeed } from './play/prefs.ts';
import { startScenarioMatch, startScenarioVsAi } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';
import { keepPrefsLocal } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Board {
  cardMotion: boolean;
  screenShake: boolean;
  ambientMotion: boolean;
}
interface Front extends Board {
  frontMatch: boolean;
}

const SWITCH_IDS: Record<keyof Front, string> = {
  cardMotion: 'settings-card-motion',
  screenShake: 'settings-screen-shake',
  ambientMotion: 'settings-ambient-motion',
  frontMatch: 'settings-front-match',
};
const SPEEDS: readonly GameSpeed[] = ['normal', 'fast', 'instant'];

const bits = (n: number, names: readonly string[]): Record<string, boolean> => Object.fromEntries(names.map((name, i) => [name, (n & (1 << i)) !== 0]));
const BOARD_COMBOS = Array.from({ length: 8 }, (_, n) => bits(n, ['cardMotion', 'screenShake', 'ambientMotion']) as unknown as Board);
const FRONT_COMBOS = Array.from({ length: 16 }, (_, n) => bits(n, ['cardMotion', 'screenShake', 'ambientMotion', 'frontMatch']) as unknown as Front);
const label = (c: Partial<Front>): string => Object.entries(c).map(([k, v]) => `${k}:${v ? 'on' : 'off'}`).join(' ');

/** Set every switch named in `combo` through the Display tab, clicking only those that differ, and see each take. */
async function setSwitches(page: Page, combo: Partial<Front>): Promise<void> {
  const panel = await openSettings(page, 'Display');
  for (const [name, on] of Object.entries(combo) as [keyof Front, boolean][]) {
    const box = panel.getByTestId(SWITCH_IDS[name]);
    if ((await box.isChecked()) !== on) await box.click();
    await expect(box, `${name} reads ${on ? 'on' : 'off'}`).toBeChecked({ checked: on });
  }
  await closeSettings(page);
}

/** The attributes the sheets read, as the page wrote them. */
async function expectRootAttrs(page: Page, combo: Board, where: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => ['motion', 'shake', 'ambient'].map((k) => document.documentElement.getAttribute(`data-${k}`))), { message: `${where}: the root's motion attributes` })
    .toEqual([combo.cardMotion ? 'full' : 'reduce', combo.screenShake ? 'on' : 'off', combo.ambientMotion ? 'on' : 'off']);
}

/*
 * The sampler: one rAF loop for the page's life, reset per cast. It keeps the first few breaches of each
 * kind, the most shake animations seen at once, and each bolt's ball (`.effect-hit`, not its trail or burst) time on screen.
 */
interface Sample {
  frames: number;
  breaches: string[];
  shakeMax: number;
  bolts: number[];
}
async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    type W = { __mc?: Sample & { open: Map<Element, number> } };
    const w = window as unknown as W;
    const fresh = (): W['__mc'] => ({ frames: 0, breaches: [], shakeMax: 0, bolts: [], open: new Map() });
    w.__mc = fresh();
    (window as unknown as { __mcReset: () => void }).__mcReset = () => void (w.__mc = fresh());
    const breach = (s: NonNullable<W['__mc']>, what: string): void => void (s.breaches.length < 12 && s.breaches.push(what));
    const step = (): void => {
      const s = w.__mc!;
      s.frames++;
      const doc = document.scrollingElement!;
      if (doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1) breach(s, `page scrolls: ${doc.scrollWidth}×${doc.scrollHeight} in ${innerWidth}×${innerHeight}`);
      const bar = document.querySelector('[data-testid="live-buttons"]')?.getBoundingClientRect();
      if (bar !== undefined && (bar.width === 0 || bar.left < -1 || bar.top < -1 || bar.right > innerWidth + 1 || bar.bottom > innerHeight + 1)) breach(s, `button bar outside the window: ${Math.round(bar.left)},${Math.round(bar.top)} ${Math.round(bar.width)}×${Math.round(bar.height)}`);
      const shaking = document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.composite === 'add' && a.id === 'beat').length;
      s.shakeMax = Math.max(s.shakeMax, shaking);
      const now = performance.now();
      const seen = new Set(document.querySelectorAll('.effect-hit[data-projectile="bolt"]'));
      for (const el of seen) if (!s.open.has(el)) s.open.set(el, now);
      for (const [el, at] of s.open) if (!seen.has(el)) {
        s.bolts.push(Math.round(now - at));
        s.open.delete(el);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
const sample = (page: Page): Promise<Sample> => page.evaluate(() => {
  const s = (window as unknown as { __mc: Sample }).__mc;
  return { frames: s.frames, breaches: s.breaches, shakeMax: s.shakeMax, bolts: s.bolts };
});

/** The endless loops on the viewer's flyer and hexproof creature: how many, and how many run. */
const loopsOnCreatures = (page: Page): Promise<{ loops: number; running: number }> =>
  page.evaluate(() => {
    const loops = [...document.querySelectorAll('.seat[data-viewer] .board-card[data-flying], .seat[data-viewer] .board-card__protection')]
      .flatMap((el) => el.getAnimations({ subtree: true }))
      .filter((a) => a.effect?.getComputedTiming().iterations === Infinity);
    return { loops: loops.length, running: loops.filter((a) => a.playState === 'running').length };
  });

/** `tempo.ts`'s `tempoOf`: the `n`th Lava Axe of the turn, at `speed`. */
const tempoOf = (n: number, speed: GameSpeed): number => Math.min(2.5, 1 + 0.25 * (n - 1)) * (speed === 'fast' ? 2 : 1);
/** `motion.ts`'s `HIT_MS`: a bolt's flight at 1×. */
const HIT_MS = 850;

for (const speed of SPEEDS) {
  test(titled(`motion switches on the board at ${speed} speed: every combination keeps the table whole, and shakes, throws and loops as it says`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioVsAi(browser, stack, 'motion-combos', { fastMode: false });
      const page = alice.page;
      await resizeWindow(page, { width: 1280, height: 800 });
      await setGameSpeed(page, speed);
      await installSampler(page);
      const them = lifeOf(page, 'opp');
      let life = 200;
      for (const [i, combo] of BOARD_COMBOS.entries()) {
        const where = `${speed}, ${label(combo)}`;
        await setSwitches(page, combo);
        await expectRootAttrs(page, combo, where);

        // Loops answer to Looping animations alone: Card animations off stills some (the flyer's), not all (the sweep).
        const loops = await loopsOnCreatures(page);
        console.log(`[motion-combos] ${where}: creature loops ${loops.running}/${loops.loops} running`);
        if (!combo.ambientMotion) expect(loops.running, `${where}: looping animations off, each loop paused or drawn still`).toBe(0);
        else {
          expect(loops.loops, `${where}: the creatures loop`).toBeGreaterThan(0);
          expect(loops.running, `${where}: looping animations run`).toBe(loops.loops);
        }

        await page.evaluate(() => (window as unknown as { __mcReset: () => void }).__mcReset());
        await expect.poll(() => handCardNamed(page, 'Lava Axe'), { timeout: 30_000, message: `${where}: a Lava Axe in hand` }).not.toBeUndefined();
        const axe = (await handCardNamed(page, 'Lava Axe'))!;
        await castUntilOnStack(page, stack, axe, [page.locator('[data-player-face]:not([data-viewer])')]);
        life -= 5;
        await expect.poll(() => them.textContent(), { timeout: 30_000, message: `${where}: the Lava Axe resolved` }).toBe(String(life));
        // Every beat of the blow played out: the bolt, its burst and the shake end well inside this.
        await page.waitForTimeout(2_500);

        const seen = await sample(page);
        console.log(`[motion-combos] ${where}: ${seen.frames} frames, shake ${seen.shakeMax}, bolts ${JSON.stringify(seen.bolts)}, breaches ${seen.breaches.length}`);
        expect(seen.breaches, `${where}: the table never scrolls and its buttons stay in the window`).toEqual([]);
        expect(seen.shakeMax > 0, `${where}: the table ${combo.cardMotion && combo.screenShake ? 'shakes' : 'stays still'}`).toBe(combo.cardMotion && combo.screenShake);
        expect(seen.bolts.length > 0, `${where}: the bolt ${combo.cardMotion ? 'flies' : 'is not thrown'}`).toBe(combo.cardMotion);
        if (combo.cardMotion) {
          const expected = HIT_MS / tempoOf(i + 1, speed);
          const flight = seen.bolts[0]!;
          expect(flight, `${where}: the ${i + 1}th bolt's flight (${flight} ms) at its tempo's ${Math.round(expected)} ms`).toBeGreaterThan(expected * 0.6);
          expect(flight, `${where}: the ${i + 1}th bolt's flight (${flight} ms) at its tempo's ${Math.round(expected)} ms`).toBeLessThan(expected * 1.6 + 100);
        }
      }
    } finally {
      await stack.stop();
    }
  });
}

/** Every endless loop drawn by the app's own sheets that still runs (the fleet's header keeps its own). */
const runningLoops = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.playState === 'running')
      .map((a) => ({ a, el: (a.effect as KeyframeEffect | null)?.target ?? null }))
      .filter(({ el }) => el !== null && el.closest('header') === null)
      .map(({ a, el }) => `${(a as CSSAnimation).animationName ?? a.id} on ${el!.className}`),
  );

async function frontPageSweep(browser: Browser, stack: PlayStack, viewport: { width: number; height: number }): Promise<void> {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, stack.origin);
  const page = await context.newPage();
  await page.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: 'e2e-carol-id', userType: 'guest', name: 'e2e-carol' } }));
  await page.goto(`${stack.origin}${PREFIX}/`);
  await expect(page.getByTestId('featured-match-tag'), 'the kept replay plays on the front page').toBeVisible({ timeout: 30_000 });
  const size = `${viewport.width}×${viewport.height}`;
  for (const speed of SPEEDS) {
    await setGameSpeed(page, speed);
    for (const combo of FRONT_COMBOS) {
      const where = `front ${size}, ${speed}, ${label(combo)}`;
      await setSwitches(page, combo);
      await expectRootAttrs(page, combo, where);
      const slot = page.getByTestId('front-live-slot');
      await expect(slot, `${where}: the featured card ${combo.frontMatch ? 'is' : 'is not'} in the grid`).toHaveAttribute('data-present', String(combo.frontMatch), { timeout: 30_000 });
      if (combo.frontMatch) {
        await expect(page.getByTestId('featured-match-tag'), `${where}: the replay is drawn`).toBeVisible({ timeout: 30_000 });
        const pause = page.getByTestId('featured-match-pause');
        await pause.click();
        await expect(page.getByTestId('featured-match')).toHaveAttribute('data-paused', 'true');
        const frame = page.locator('.featured-match__frame');
        const still = (): Promise<{ moving: number; at: string }> =>
          frame.evaluate((el) => ({ moving: el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length, at: (el as HTMLElement).style.transform }));
        await expect.poll(async () => (await still()).moving, { timeout: 2_000, message: `${where}: paused, nothing in the card moves` }).toBe(0);
        const before = await still();
        await page.waitForTimeout(1_200);
        expect(await still(), `${where}: paused, the camera stays put`).toEqual(before);
        await pause.click();
        await expect(page.getByTestId('featured-match'), `${where}: play starts it again`).not.toHaveAttribute('data-paused');
      }
      if (combo.cardMotion && !combo.ambientMotion) expect(await runningLoops(page), `${where}: looping animations off, none of ours runs`).toEqual([]);
      const scroll = await page.evaluate(() => ({ w: document.scrollingElement!.scrollWidth, inner: innerWidth }));
      expect(scroll.w, `${where}: the front page never scrolls sideways`).toBeLessThanOrEqual(scroll.inner + 1);
    }
  }
  await context.close();
}

test(titled('motion switches on the front page: all 48 combinations, at a desktop window and a phone’s'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(12 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // A real match, ended at once, kept as the replay the front page plays (`front-skeleton.spec.ts`'s own way).
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-outlines');
    await bob.page.getByTestId('live-concede').click();
    await bob.page.getByTestId('live-concede-yes').click();
    await expect(alice.page.getByTestId('game-result')).toBeVisible({ timeout: 30_000 });
    await frontPageSweep(browser, stack, { width: 1280, height: 800 });
    await frontPageSweep(browser, stack, { width: 390, height: 844 });
  } finally {
    await stack.stop();
  }
});
