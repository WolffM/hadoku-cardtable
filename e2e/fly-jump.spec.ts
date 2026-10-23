/**
 * The operator, 2026-10-23, on a live match: *"i notice the normal flying animation and then roughly every
 * ~1.5s the creature repositions in a random direction"* (Narcomoeba). `card.css`'s loop is one steady
 * 5.6 s path from a fixed negative delay, so the card can only jump when that animation starts again:
 * its `<li>` remounted or moved in the DOM, `data-flying` dropped and came back, or the animation
 * itself replaced.
 *
 * Plays the AI's turn (`fly-jump`: it casts a creature and attacks with a Serra Angel) while alice's
 * flyers are drawn, and records on her screen, every animation frame: each flyer face's centre against
 * its own `<li>` (the loop moves it under 0.1 px a frame, so a step over 1 px is a jump), and every
 * `<li>` added or removed, every `data-flying` change and every new fly animation, with when. Every
 * finding prints one `[flyjump]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'fly-jump';
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
          const id = idOf(r.target);
          if (id !== null) w.events.push({ t: now(), what: `attr ${r.attributeName}`, id, detail: `${r.oldValue} -> ${(r.target as HTMLElement).getAttribute(r.attributeName!)}` });
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
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-flying', 'style', 'data-board-card'] });
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

    const w = await page.evaluate(() => (window as unknown as { __flyjump: Watch }).__flyjump);
    const names = await page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('[data-board-card]')].map((e) => [e.getAttribute('data-board-card'), e.querySelector('.card__name')?.textContent?.trim() ?? ''])),
    );
    const jumps: { id: string; name: string; t: number; step: number }[] = [];
    for (const [id, path] of Object.entries(w.path)) {
      for (let i = 1; i < path.length; i++) {
        const [t, x, y] = path[i]!;
        const [, px, py] = path[i - 1]!;
        const step = Math.hypot(x - px, y - py);
        if (step > 1) jumps.push({ id, name: names[id] ?? '?', t, step: Math.round(step * 10) / 10 });
      }
    }
    log('frames', Object.fromEntries(Object.entries(w.path).map(([id, p]) => [`${names[id] ?? '?'} ${id}`, p.length])));
    log('jumps', jumps);
    // What happened to a card in the 100 ms before each of its jumps.
    for (const j of jumps) log('before jump', { ...j, events: w.events.filter((e) => e.id === j.id && e.t <= j.t && e.t > j.t - 100) });
    log('events', w.events.filter((e) => e.what !== 'attr style'));
    log('style changes', w.events.filter((e) => e.what === 'attr style').length);

    expect(Object.keys(w.path).length, 'flyers were sampled').toBeGreaterThan(0);
    expect(jumps, 'no flyer steps more than 1 px in a frame').toEqual([]);
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});
