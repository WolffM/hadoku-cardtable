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
 * attack), with the loop animation's own `currentTime` and the document timeline's. And every
 * `<li>` added or removed, every `data-flying` change and every new fly animation, with when. Every
 * finding prints one `[flyjump]` line.
 *
 * Judged in the loop's own time, never by how far the art moved between two frames of wall clock: a
 * host that drops frames for half a second lets the art travel 2 px between two honest frames
 * (the path's fastest stretch is about 0.004 px a millisecond). So each recorded frame is replayed
 * at judge time — every loop on that `.card` seeked to the `currentTime` it had then — and a frame
 * whose recorded move differs from the loop's own move between the same two times by over 2 px is a
 * jump. And the loop itself must never restart: the same animation every frame, its `currentTime`
 * advancing exactly as the document timeline does.
 *
 * Runs in Firefox (`playwright.config.ts`): the operator's browser, where the loop jumped on a 1.4 s grid
 * (2.6 px, then 7.9 px) with no remount, move or new animation, while Chromium drew it smoothly.
 *
 * Wave 76 §C: the same frames also measure the red attacking outline against the art, for
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

import { boardCard, makeTitled, ownNamed } from './play/board.ts';
import { clickCombat, passToDeclareAttackers } from './play/combat.ts';
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

/**
 * One recorded frame of a flyer: [t, dx, dy, ct, tl, loop] — the art's centre against its face, the
 * `fly-figure` animation's `currentTime`, the document timeline's, and which animation object it was
 * (a serial, so a replaced loop shows).
 */
type PathFrame = [number, number, number, number, number, number];

interface Watch {
  events: Event[];
  /** Per card id, each frame it was sampled. */
  path: Record<string, PathFrame[]>;
  /**
   * Per ATTACKING flyer's id, each frame it was sampled: [t, the outline `::before`'s own
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
      path: {} as Record<string, PathFrame[]>,
      outline: {} as Record<string, [number, string, string][]>,
    };
    (window as unknown as { __flyjump: typeof w }).__flyjump = w;
    const now = (): number => Math.round(performance.now());
    const idOf = (n: Node): string | null => (n instanceof HTMLElement ? n.getAttribute('data-board-card') : null);
    const seen = new WeakSet<Animation>();
    const serials = new WeakMap<Animation, number>();
    let nextSerial = 0;
    const serialOf = (a: Animation): number => {
      if (!serials.has(a)) serials.set(a, nextSerial++);
      return serials.get(a)!;
    };
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
        const loop = card.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === 'fly-figure');
        const ct = loop?.currentTime ?? null;
        const tl = document.timeline.currentTime;
        if (loop === undefined || ct === null || tl === null) continue;
        const l = face.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        (w.path[id] ??= []).push([now(), c.left + c.width / 2 - (l.left + l.width / 2), c.top + c.height / 2 - (l.top + l.height / 2), Number(ct), Number(tl), serialOf(loop)]);
        // While this flyer is attacking, the outline's own `::before` should be animating the
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
 * Prints what was recorded on `page` and fails on any frame a flyer's art moved more than 2 px away
 * from where its own loop puts it, on any frame its loop restarted, or on any frame an attacking
 * flyer's outline read a different `translate` than its own art. Returns how many outline frames
 * were sampled, so a caller that put a flyer into combat can assert the check actually ran rather
 * than passing vacuously.
 */
async function judge(page: Page, when: string): Promise<{ outlineSamples: number }> {
  // Taken and emptied in one go, so each call judges only what happened since the last; and, in the
  // same task (no frame can run between), each frame replayed: every infinite loop on the card's
  // `.card` seeked to where it was at that frame's `currentTime`, the offset read, the loops put back.
  const w = await page.evaluate(() => {
    const held = (window as unknown as { __flyjump: Watch }).__flyjump;
    const out = { events: held.events.splice(0), path: { ...held.path }, outline: { ...held.outline }, replay: {} as Record<string, [number, number][]> };
    for (const id of Object.keys(held.path)) held.path[id] = held.path[id]!.slice(-1);
    for (const id of Object.keys(held.outline)) held.outline[id] = [];
    for (const [id, path] of Object.entries(out.path)) {
      const face = document.querySelector<HTMLElement>(`[data-board-card="${id}"][data-flying] > .board-card__face`);
      const card = face?.querySelector<HTMLElement>(':scope > .card') ?? null;
      const loops = card?.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.currentTime !== null) ?? [];
      const figure = loops.find((a) => a instanceof CSSAnimation && a.animationName === 'fly-figure');
      if (face == null || card === null || figure === undefined) continue;
      const saved = loops.map((a) => Number(a.currentTime));
      const at = Number(figure.currentTime);
      out.replay[id] = path.map(([, , , ct]) => {
        loops.forEach((a, i) => void (a.currentTime = ct + saved[i]! - at));
        const l = face.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return [c.left + c.width / 2 - (l.left + l.width / 2), c.top + c.height / 2 - (l.top + l.height / 2)];
      });
      loops.forEach((a, i) => void (a.currentTime = saved[i]!));
    }
    return out;
  });
  const names = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-board-card]')].map((e) => [e.getAttribute('data-board-card'), e.querySelector('.card__name')?.textContent?.trim() ?? ''])),
  );
  // A jump: between two frames of the same loop, the art moved more than 2 px differently from how the
  // loop itself moves between those two `currentTime`s — however long the host took between them.
  // A restart: the loop replaced, or its time not advancing with the document timeline's.
  const jumps: { id: string; name: string; t: number; off: number }[] = [];
  const restarts: { id: string; name: string; t: number; loopMs: number; timelineMs: number; replaced: boolean }[] = [];
  let unreplayed = 0;
  for (const [id, path] of Object.entries(w.path)) {
    const replay = w.replay[id];
    const current = path.at(-1)![5];
    for (let i = 1; i < path.length; i++) {
      const [t, x, y, ct, tl, serial] = path[i]!;
      const [, px, py, pct, ptl, pserial] = path[i - 1]!;
      const loopMs = ct - pct;
      const timelineMs = tl - ptl;
      // A millisecond of clock rounding each side (Firefox coarsens both); a restart moves the loop by seconds.
      if (serial !== pserial || Math.abs(loopMs - timelineMs) > 2) {
        restarts.push({ id, name: names[id] ?? '?', t, loopMs: Math.round(loopMs), timelineMs: Math.round(timelineMs), replaced: serial !== pserial });
        continue;
      }
      if (replay === undefined || serial !== current) {
        unreplayed++;
        continue;
      }
      const [rx, ry] = replay[i]!;
      const [prx, pry] = replay[i - 1]!;
      const off = Math.hypot(x - px - (rx - prx), y - py - (ry - pry));
      if (off > 2) jumps.push({ id, name: names[id] ?? '?', t, off: Math.round(off * 10) / 10 });
    }
  }
  // Every sampled frame of an attacking flyer whose outline did not read the same `translate` as its art.
  const outlineMismatches: { id: string; name: string; t: number; outline: string; card: string }[] = [];
  let outlineSamples = 0;
  for (const [id, samples] of Object.entries(w.outline)) {
    for (const [sampleT, outline, card] of samples) {
      outlineSamples++;
      if (outline !== card) outlineMismatches.push({ id, name: names[id] ?? '?', t: sampleT, outline, card });
    }
  }
  log(`${when}: frames`, Object.fromEntries(Object.entries(w.path).map(([id, p]) => [`${names[id] ?? '?'} ${id}`, p.length])));
  log(`${when}: frames left by the board before they could be replayed`, unreplayed);
  log(`${when}: jumps`, jumps);
  log(`${when}: restarts`, restarts);
  // What happened to a card in the 100 ms before each of its jumps.
  for (const j of jumps) log(`${when}: before jump`, { ...j, events: w.events.filter((e) => e.id === j.id && e.t <= j.t && e.t > j.t - 100) });
  log(`${when}: events`, w.events);
  log(`${when}: outline samples`, outlineSamples);
  log(`${when}: outline mismatches`, outlineMismatches.slice(0, 5));
  expect(Object.keys(w.path).length, `${when}: flyers were sampled`).toBeGreaterThan(0);
  expect.soft(jumps, `${when}: no flyer's art moves more than 2 px off its own loop between two frames`).toEqual([]);
  expect.soft(restarts, `${when}: no flyer's loop restarts`).toEqual([]);
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
    // A flyer declared attacking — Serra Angel, who stays untapped (vigilance) so the "turned"
    // rule never muddies the geometry — so the frames below sample the outline against the art while
    // both are live. `clickCombat` is the SAME two clicks `attack-window.spec.ts`'s `attackWithBears` uses:
    // the sole opponent is already Forge's current defender, so a click and a click on it declare it.
    const serraAngel = (await ownNamed(page, 'Serra Angel'))[0];
    expect(serraAngel, 'alice controls Serra Angel').toBeDefined();
    await clickCombat(boardCard(page, serraAngel!));
    await expect(page.locator(`[data-board-card="${serraAngel}"]`), 'Serra Angel is declared attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    await page.waitForTimeout(6_000);
    const { outlineSamples } = await judge(page, 'attack window');
    expect(outlineSamples, 'the attacking flyer’s outline was actually sampled').toBeGreaterThan(0);
  } finally {
    await alice?.context.close();
    await stack.stop();
  }
});
