/**
 * The operator, 2026-10-23, on a live match: *"i notice the normal flying animation and then roughly every
 * ~1.5s the creature repositions in a random direction"* (Narcomoeba). `card.css`'s loop is one steady
 * 5.6 s path from a fixed negative delay, so the card can only jump when that animation starts again:
 * its `<li>` remounted or moved in the DOM, `data-flying` dropped and came back, or the animation
 * itself replaced.
 *
 * Plays the AI's turn (`fly-jump`: it casts a creature and attacks with a Serra Angel) while alice's
 * flyers are drawn, and records on her screen, every animation frame: each flyer face's centre against
 * its own `<li>` (the loop moves it under 0.1 px a frame, so a step over 2 px is a jump), and every
 * `<li>` added or removed, every `data-flying` change and every new fly animation, with when. Every
 * finding prints one `[flyjump]` line.
 *
 * Runs in Firefox (`playwright.config.ts`): the operator's browser, where the loop jumped on a 1.4 s grid
 * (2.6 px, then 7.9 px) with no remount, move or new animation, while Chromium drew it smoothly.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
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
}

/** Starts recording on `page`: every flyer's path each frame, and everything that could restart its loop. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = { events: [] as { t: number; what: string; id: string; detail?: string }[], path: {} as Record<string, [number, number, number][]> };
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
        const card = li.querySelector<HTMLElement>(':scope > .board-card__face > .card');
        if (card === null) continue;
        const l = li.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        (w.path[id] ??= []).push([now(), c.left + c.width / 2 - (l.left + l.width / 2), c.top + c.height / 2 - (l.top + l.height / 2)]);
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

/** Prints what was recorded on `page` and fails on any frame a flyer stepped more than 2 px (the loop moves it under 0.1 px a frame). */
async function judge(page: Page, when: string): Promise<void> {
  // Taken and emptied in one go, so each call judges only what happened since the last.
  const w = await page.evaluate(() => {
    const held = (window as unknown as { __flyjump: Watch }).__flyjump;
    const out = { events: held.events.splice(0), path: { ...held.path } };
    for (const id of Object.keys(held.path)) held.path[id] = held.path[id]!.slice(-1);
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
  log(`${when}: frames`, Object.fromEntries(Object.entries(w.path).map(([id, p]) => [`${names[id] ?? '?'} ${id}`, p.length])));
  log(`${when}: jumps`, jumps);
  // What happened to a card in the 100 ms before each of its jumps.
  for (const j of jumps) log(`${when}: before jump`, { ...j, events: w.events.filter((e) => e.id === j.id && e.t <= j.t && e.t > j.t - 100) });
  log(`${when}: events`, w.events);
  expect(Object.keys(w.path).length, `${when}: flyers were sampled`).toBeGreaterThan(0);
  expect.soft(jumps, `${when}: no flyer steps more than 2 px in a frame`).toEqual([]);
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
    await page.waitForTimeout(6_000);
    await judge(page, 'attack window');
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});
