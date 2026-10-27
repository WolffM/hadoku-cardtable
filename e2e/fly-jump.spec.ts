/**
 * The operator, 2026-10-23, on a live match: *"i notice the normal flying animation and then roughly every
 * ~1.5s the creature repositions in a random direction"* (Narcomoeba). `card.css`'s loop is one steady
 * 5.6 s path from a fixed negative delay, so the card can only jump when that animation starts again:
 * its `<li>` remounted or moved in the DOM, `data-flying` dropped and came back, or the animation
 * itself replaced.
 *
 * Plays the AI's turn (`fly-jump`: it casts a creature and attacks with a Serra Angel) while alice's
 * flyers are drawn, and records on her screen, every animation frame: each flyer's art centre against
 * its own face, which carries the loop and nothing else (the face itself rises when the card may
 * attack); the loop moves it under 0.1 px a frame, so a step over 2 px is a jump. And every
 * `<li>` added or removed, every `data-flying` change and every new fly animation, with when. Every
 * finding prints one `[flyjump]` line.
 *
 * Runs in Firefox (`playwright.config.ts`): the operator's browser, where the loop jumped on a 1.4 s grid
 * (2.6 px, then 7.9 px) with no remount, move or new animation, while Chromium drew it smoothly.
 *
 * Wave 76 §C (AF405): the same frames also measure the red attacking outline against the art, for
 * whichever flyer is declared attacking in the own-turn test below — the operator, 2026-10-26, *"red
 * attacking outline should hover with flying creatures"*. `getComputedStyle(face, '::before')` is the
 * one way to read a pseudo-element's own live-animated value (a pseudo has no box
 * `getBoundingClientRect` can read); both engines resolve it to the ANIMATED value of `translate`,
 * the same property the art's `.card` animates, from the identical `--fly-path`/`--fly-start`
 * (`card.css`). So the two strings are expected to be equal on every sampled frame once the outline
 * rides the same keyframes, and this test also runs in Chromium — the outline fix touches both
 * engines even though the jump bug this file was built for was Firefox-only.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, ownNamed } from './play/board.ts';
import { clickCard, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'fly-jump';
const MINE = 'fly-jump-mine';
const log = (step: string, data: unknown): void => console.log(`[flyjump] ${JSON.stringify({ step, data })}`);

interface Event {
  t: number;
  what: string;
  id: string;
  detail?: string;
}

interface Watch {
  events: Event[];
  /** Per card id, its face's offset against its `<li>` each frame: [t, dx, dy]. */
  path: Record<string, [number, number, number][]>;
  /**
   * AF405. Per ATTACKING flyer's id, each frame it was sampled: [t, the outline `::before`'s own
   * live `translate`, the art's own]. The claim is that these two strings are the SAME on every
   * frame — the outline riding the identical `--fly-path` the art does, read with
   * `getComputedStyle(el, pseudoElt)`, the one way to read a pseudo-element's animated value (it has
   * no box of its own for `getBoundingClientRect`).
   */
  outline: Record<string, [number, string, string][]>;
}

/** Starts recording on `page`: every flyer's path each frame, and everything that could restart its loop. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = {
      events: [] as { t: number; what: string; id: string; detail?: string }[],
      path: {} as Record<string, [number, number, number][]>,
      outline: {} as Record<string, [number, string, string][]>,
    };
    (window as unknown as { __flyjump: typeof w }).__flyjump = w;
    const now = (): number => Math.round(performance.now());
    const idOf = (n: Node): string | null => (n instanceof HTMLElement ? n.getAttribute('data-board-card') : null);
    const seen = new WeakSet<Animation>();
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          const el = r.target instanceof HTMLElement ? r.target : null;
          const li = el?.closest<HTMLElement>('[data-board-card]') ?? null;
          const id = li === null || (el !== li && el!.parentElement !== li) ? null : li.getAttribute('data-board-card');
          if (id !== null) w.events.push({ t: now(), what: `attr ${el === li ? '' : 'face '}${r.attributeName}`, id, detail: `${r.oldValue} -> ${el!.getAttribute(r.attributeName!)}` });
          continue;
        }
        for (const n of r.removedNodes) {
          const id = idOf(n);
          if (id !== null) w.events.push({ t: now(), what: 'li removed', id, detail: n.isConnected ? 'moved' : 'gone' });
        }
        for (const n of r.addedNodes) {
          const id = idOf(n);
          if (id !== null) w.events.push({ t: now(), what: 'li added', id });
        }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
    const frame = (): void => {
      for (const li of document.querySelectorAll<HTMLElement>('[data-board-card][data-flying]')) {
        const id = li.getAttribute('data-board-card')!;
        const face = li.querySelector<HTMLElement>(':scope > .board-card__face');
        const card = face?.querySelector<HTMLElement>(':scope > .card') ?? null;
        if (face == null || card === null) continue;
        const l = face.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        (w.path[id] ??= []).push([now(), c.left + c.width / 2 - (l.left + l.width / 2), c.top + c.height / 2 - (l.top + l.height / 2)]);
        // AF405: while this flyer is attacking, the outline's own `::before` should be animating the
        // SAME `translate` the art does — both driven by the identical `--fly-path`/`--fly-start`.
        if (li.hasAttribute('data-attacking')) {
          const outlineTranslate = getComputedStyle(face, '::before').translate;
          const cardTranslate = getComputedStyle(card).translate;
          (w.outline[id] ??= []).push([now(), outlineTranslate, cardTranslate]);
        }
        for (const a of li.getAnimations()) {
          if (seen.has(a)) continue;
          seen.add(a);
          const name = a instanceof CSSAnimation ? a.animationName : a.constructor.name;
          w.events.push({ t: now(), what: 'animation', id, detail: name });
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Prints what was recorded on `page` and fails on any frame a flyer stepped more than 2 px (the loop
 * moves it under 0.1 px a frame), or on any frame an attacking flyer's outline read a different
 * `translate` than its own art (AF405). Returns how many outline frames were sampled, so a caller
 * that put a flyer into combat can assert the check actually ran rather than passing vacuously.
 */
async function judge(page: Page, when: string): Promise<{ outlineSamples: number }> {
  // Taken and emptied in one go, so each call judges only what happened since the last.
  const w = await page.evaluate(() => {
    const held = (window as unknown as { __flyjump: Watch }).__flyjump;
    const out = { events: held.events.splice(0), path: { ...held.path }, outline: { ...held.outline } };
    for (const id of Object.keys(held.path)) held.path[id] = held.path[id]!.slice(-1);
    for (const id of Object.keys(held.outline)) held.outline[id] = [];
    return out;
  });
  const names = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-board-card]')].map((e) => [e.getAttribute('data-board-card'), e.querySelector('.card__name')?.textContent?.trim() ?? ''])),
  );
  const jumps: { id: string; name: string; t: number; step: number }[] = [];
  for (const [id, path] of Object.entries(w.path)) {
    for (let i = 1; i < path.length; i++) {
      const [t, x, y] = path[i]!;
      const [, px, py] = path[i - 1]!;
      const step = Math.hypot(x - px, y - py);
      if (step > 2) jumps.push({ id, name: names[id] ?? '?', t, step: Math.round(step * 10) / 10 });
    }
  }
  // AF405: every sampled frame of an attacking flyer whose outline did not read the same `translate` as its art.
  const outlineMismatches: { id: string; name: string; t: number; outline: string; card: string }[] = [];
  let outlineSamples = 0;
  for (const [id, samples] of Object.entries(w.outline)) {
    for (const [sampleT, outline, card] of samples) {
      outlineSamples++;
      if (outline !== card) outlineMismatches.push({ id, name: names[id] ?? '?', t: sampleT, outline, card });
    }
  }
  log(`${when}: frames`, Object.fromEntries(Object.entries(w.path).map(([id, p]) => [`${names[id] ?? '?'} ${id}`, p.length])));
  log(`${when}: jumps`, jumps);
  // What happened to a card in the 100 ms before each of its jumps.
  for (const j of jumps) log(`${when}: before jump`, { ...j, events: w.events.filter((e) => e.id === j.id && e.t <= j.t && e.t > j.t - 100) });
  log(`${when}: events`, w.events);
  log(`${when}: outline samples`, outlineSamples);
  log(`${when}: outline mismatches`, outlineMismatches.slice(0, 5));
  expect(Object.keys(w.path).length, `${when}: flyers were sampled`).toBeGreaterThan(0);
  expect.soft(jumps, `${when}: no flyer steps more than 2 px in a frame`).toEqual([]);
  expect.soft(outlineMismatches, `${when}: an attacking flyer's outline reads the same translate as its art, every frame`).toEqual([]);
  return { outlineSamples };
}

test(titled("a flyer keeps its loop through the other seat's turn: no jump, no remount, no restart"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let alice: Awaited<ReturnType<typeof startScenarioVsAi>>['alice'] | null = null;
  try {
    ({ alice } = await startScenarioVsAi(browser, stack, SCENARIO, { fastMode: false, beforeKeep: (f) => watch(f.page) }));
    const page = alice.page;
    await expect.poll(() => page.locator('[data-zone="battlefield"][data-owner="you"] [data-flying]').count(), { timeout: 30_000, message: 'alice’s flyers are drawn' }).toBeGreaterThan(0);
    // The AI's whole turn and into alice's: a creature cast, a death, an attack.
    await page.waitForTimeout(25_000);

    await judge(page, 'their turn');
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});

test(titled('a flyer keeps its loop through its own turn: priority, the pointer over it and the board, the attack window'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let alice: Awaited<ReturnType<typeof startScenarioVsAi>>['alice'] | null = null;
  try {
    ({ alice } = await startScenarioVsAi(browser, stack, MINE, { fastMode: false, beforeKeep: (f) => watch(f.page) }));
    const page = alice.page;
    const flyers = page.locator('[data-zone="battlefield"][data-owner="you"] [data-flying]');
    await expect.poll(() => flyers.count(), { timeout: 30_000, message: 'alice’s flyers are drawn' }).toBe(4);
    // Her priority, with plays on offer.
    await page.waitForTimeout(6_000);
    await judge(page, 'priority');
    // The pointer resting on a flyer, then sweeping the board.
    await flyers.first().hover();
    await page.waitForTimeout(5_000);
    await judge(page, 'hover');
    const board = await page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox();
    for (let i = 0; i <= 40 && board !== null; i++) {
      await page.mouse.move(board.x + (board.width * i) / 40, board.y + board.height / 2, { steps: 4 });
      await page.waitForTimeout(100);
    }
    await judge(page, 'sweep');
    await passToDeclareAttackers(page);
    // AF405: a flyer declared attacking — Serra Angel, who stays untapped (vigilance) so the "turned"
    // rule never muddies the geometry — so the frames below sample the outline against the art while
    // both are live. `clickCard` is the SAME click `attack-window.spec.ts`'s `attackWithBears` uses:
    // the sole opponent is already Forge's current defender, so one click per attacker declares it.
    const serraAngel = (await ownNamed(page, 'Serra Angel'))[0];
    expect(serraAngel, 'alice controls Serra Angel').toBeDefined();
    await clickCard(page, serraAngel!);
    await expect(page.locator(`[data-board-card="${serraAngel}"]`), 'Serra Angel is declared attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await page.waitForTimeout(6_000);
    const { outlineSamples } = await judge(page, 'attack window');
    expect(outlineSamples, 'the attacking flyer’s outline was actually sampled').toBeGreaterThan(0);
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});
