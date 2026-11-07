/**
 * The operator, 2026-11-06: *"i saw two targeter arrows being displayed briefly when i played inquisition
 * of kozilek. lets look into if that's just a mobile bug or if it happens in both."*
 *
 * Real Forge, scenario `two-arrows`: alice casts two Inquisitions of Kozilek, Thoughtseize, Duress and a
 * Lightning Bolt at bob, one at a time, by click (a tap on a phone) and by drag. A recorder in her page
 * samples every arrow on the board on every animation frame, from the press that starts the cast until the
 * spell has resolved, and the spec fails if any frame draws more than one arrow at bob.
 *
 * Shared by `two-arrows.spec.ts` (desktop) and `two-arrows.phone.spec.ts` (portrait phone).
 */
import { expect, type Browser, type Page } from '@playwright/test';

import { clickHandCard, dragHandCard, enabledOk, livePrompt, offeredNamed, pressPaymentAuto } from './play/board.ts';
import { startPlayStack } from './play/harness.ts';
import { isPhone, raiseHand, touchDrag } from './play/phone.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

/** One arrow as one frame drew it. */
interface DrawnArrow {
  /** `data-testid`: `targeter`, `targeter-committed`, `stack-target-arrow` or `placed-arrow`. */
  id: string;
  key: string;
  ghost: boolean;
  opacity: number;
  from: [number, number];
  tip: [number, number];
  /** The tip lands on bob's face. */
  atBob: boolean;
}

interface ArrowFrame {
  t: number;
  arrows: DrawnArrow[];
}

declare global {
  interface Window {
    __arrowFrames?: ArrowFrame[];
    __arrowStop?: () => void;
  }
}

/** Start sampling every arrow on every frame; a frame is kept only when what it draws changed. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__arrowStop?.();
    const frames: ArrowFrame[] = [];
    window.__arrowFrames = frames;
    let last = '';
    let live = true;
    const opacityOf = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden') return 0;
        o *= Number(s.opacity);
      }
      return o;
    };
    const client = (path: SVGGeometryElement, at: number): [number, number] => {
      const p = path.getPointAtLength(at);
      const m = path.getScreenCTM();
      if (m === null) return [Number.NaN, Number.NaN];
      return [Math.round(m.a * p.x + m.c * p.y + m.e), Math.round(m.b * p.x + m.d * p.y + m.f)];
    };
    const step = (): void => {
      if (!live) return;
      const face = document.querySelector('[data-player-face]:not([data-viewer])')?.getBoundingClientRect();
      const arrows: DrawnArrow[] = [];
      for (const svg of document.querySelectorAll<SVGSVGElement>('svg.arrow')) {
        const spine = svg.querySelector<SVGPathElement>('path.arrow__spine');
        if (spine === null || (spine.getAttribute('d') ?? '') === '') continue;
        const length = spine.getTotalLength();
        const tip = client(spine, length);
        const pad = 16;
        const atBob = face !== undefined && tip[0] >= face.left - pad && tip[0] <= face.right + pad && tip[1] >= face.top - pad && tip[1] <= face.bottom + pad;
        arrows.push({
          id: svg.getAttribute('data-testid') ?? '',
          key: svg.getAttribute('data-key') ?? '',
          ghost: svg.hasAttribute('data-ghost'),
          opacity: Math.round(opacityOf(svg) * 100) / 100,
          from: client(spine, 0),
          tip,
          atBob,
        });
      }
      const sig = arrows.map((a) => `${a.id}|${a.key}|${a.ghost}|${a.opacity > 0}|${a.atBob}`).join(';');
      if (sig !== last) {
        last = sig;
        frames.push({ t: Math.round(performance.now()), arrows });
      }
      requestAnimationFrame(step);
    };
    window.__arrowStop = () => {
      live = false;
    };
    requestAnimationFrame(step);
  });
}

async function stopRecording(page: Page): Promise<ArrowFrame[]> {
  return page.evaluate(() => {
    window.__arrowStop?.();
    return window.__arrowFrames ?? [];
  });
}

/** The largest number of visible arrows at bob in any one frame, and the frames that drew more than one. */
export function arrowsAtBob(frames: readonly ArrowFrame[]): { most: number; doubled: ArrowFrame[] } {
  let most = 0;
  const doubled: ArrowFrame[] = [];
  for (const f of frames) {
    const n = f.arrows.filter((a) => a.atBob && a.opacity > 0).length;
    most = Math.max(most, n);
    if (n > 1) doubled.push(f);
  }
  return { most, doubled };
}

const describe = (f: ArrowFrame, t0: number): string =>
  `+${f.t - t0}ms ${f.arrows.map((a) => `${a.id}${a.key === '' ? '' : `[${a.key}]`}${a.ghost ? '~' : ''} ${a.from.join(',')}→${a.tip.join(',')}${a.atBob ? '@bob' : ''} o${a.opacity}`).join(' | ') || '(none)'}`;

const bobFace = (page: Page) => page.locator('[data-player-face]:not([data-viewer])').first();

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const b = await page.locator(selector).first().boundingBox();
  if (b === null) throw new Error(`no box for ${selector}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** What is on the stack: Forge's own count where the board carries it, else the placed items drawn. */
const stackCount = async (page: Page): Promise<number> => {
  const zone = page.locator('[data-zone="stack"]');
  if ((await zone.count()) > 0) return Number((await zone.first().getAttribute('data-count')) ?? '0');
  return page.locator('[data-placed-spell]:not([data-placed-leaving])').count();
};

/**
 * Wait until Forge either offers bob as a target, or has taken the only legal one itself (Duress's "target
 * opponent" with one opponent): true when there is a target to choose.
 */
async function asksForBob(page: Page): Promise<boolean> {
  let asked = false;
  await expect
    .poll(
      async () => {
        asked = (await bobFace(page).getAttribute('data-selectable')) !== null;
        return asked || (await stackCount(page)) > 0;
      },
      { timeout: 20_000, message: 'Forge asks for the target player, or chose the only one' },
    )
    .toBe(true);
  return asked;
}

/** A point `n` even steps along the line from `a` to `b`. */
const line = (a: { x: number; y: number }, b: { x: number; y: number }, n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));

/** Cast `id` and aim it at bob: by a click (a tap) on his face, or by a drag onto it. */
async function castAtBob(page: Page, id: number, how: 'click' | 'drag'): Promise<void> {
  const phone = isPhone();
  if (how === 'click') {
    expect(await clickHandCard(page, id), 'the cast started').toBe(true);
    if (!(await asksForBob(page))) return;
    const face = await centreOf(page, '[data-player-face]:not([data-viewer])');
    if (phone) {
      await fingerTap(page, face);
    } else {
      // A player moves to the face before pressing it: the targeter follows the pointer there. A hand is
      // never still: the pointer drifts a few pixels after the click, before Forge has answered it.
      await page.mouse.move(face.x, face.y, { steps: 8 });
      await page.mouse.click(face.x, face.y);
      await page.mouse.move(face.x + 3, face.y + 2);
      await page.mouse.move(face.x + 5, face.y + 3);
    }
    return;
  }
  if (phone) {
    // A finger parks the spell on the table, then carries the arrow from it onto the target.
    await raiseHand(page, id);
    expect(await dragHandCard(page, id, await centreOf(page, '[data-testid="lane-my-permanents"]')), 'the finger lifted the card').toBe(true);
    if (!(await asksForBob(page))) return;
    const parked = await centreOf(page, `[data-cast-ghost="${id}"], [data-board-card="${id}"]`);
    await touchDrag(page, parked, line(parked, await centreOf(page, '[data-player-face]:not([data-viewer])'), 14));
    return;
  }
  // A mouse lets go over the face: the cast parks there, Forge asks for the target, and the press it is
  // already over answers it.
  const face = await centreOf(page, '[data-player-face]:not([data-viewer])');
  expect(await dragHandCard(page, id, face), 'the drag armed the cast').toBe(true);
  if (!(await asksForBob(page))) return;
  await page.mouse.move(face.x + 2, face.y + 2, { steps: 2 });
  await page.mouse.click(face.x, face.y);
  await page.mouse.move(face.x + 4, face.y + 3);
}

/** A finger's tap: down, the pixel of travel a real fingertip makes, and up. */
async function fingerTap(page: Page, at: { x: number; y: number }): Promise<void> {
  await touchDrag(page, at, [{ x: at.x + 1, y: at.y + 1 }]);
}

/** Answer everything until the spell has resolved: pay, let bob pass, and pick the first card offered to discard. */
async function resolve(alice: Page, bob: Page, id: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await pressPaymentAuto(alice);
        const choice = livePrompt(alice).locator('[data-testid="prompt-choice"]');
        if ((await choice.count()) > 0) {
          await choice.first().click({ force: true }).catch(() => undefined);
          await livePrompt(alice).getByTestId('prompt-submit').click({ timeout: 1_000 }).catch(() => undefined);
        } else if ((await livePrompt(alice).count()) > 0) {
          await answerPrompt(alice).catch(() => null);
        }
        if ((await stackCount(bob)) > 0) await enabledOk(bob).click({ timeout: 1_000 }).catch(() => undefined);
        const onStack = await stackCount(alice);
        // Anywhere but a graveyard: in hand, parked, carried or on the stack, the spell has not resolved.
        const live = await alice.evaluate(
          (id) =>
            [...document.querySelectorAll(`[data-board-card="${id}"], [data-placed-spell="${id}"], [data-cast-ghost="${id}"]`)].filter((el) => el.closest('[data-zone="graveyard"]') === null).length,
          id,
        );
        return live === 0 && onStack === 0 && (await livePrompt(alice).count()) === 0;
      },
      { timeout: 60_000, intervals: [250], message: 'the spell resolved' },
    )
    .toBe(true);
  // Every arrow's own leave has run.
  await alice.waitForTimeout(1_200);
}

const CASTS = [
  { name: 'Inquisition of Kozilek', how: 'click' },
  { name: 'Inquisition of Kozilek', how: 'drag' },
  { name: 'Thoughtseize', how: 'click' },
  { name: 'Duress', how: 'drag' },
  { name: 'Lightning Bolt', how: 'click' },
] as const;

/** Every cast in `CASTS`, each recorded from its first press until it has resolved. */
export async function twoArrowsScenario(browser: Browser, forge: { jar: string; res: string }): Promise<void> {
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'two-arrows');
    const results: { cast: string; most: number }[] = [];
    for (const { name, how } of CASTS) {
      let id: number | undefined;
      await expect.poll(async () => (id = await offeredNamed(alice.page, name, 'hand')), { timeout: 45_000, message: `alice is offered ${name}` }).not.toBeUndefined();
      await record(alice.page);
      let most = 0;
      try {
        await castAtBob(alice.page, id!, how);
        await resolve(alice.page, bob.page, id!);
      } finally {
        const frames = await stopRecording(alice.page);
        const found = arrowsAtBob(frames);
        most = found.most;
        const t0 = frames[0]?.t ?? 0;
        console.log(`[two-arrows] ${name} by ${how}: ${frames.length} distinct frames, at most ${most} arrow(s) at bob at once`);
        for (const f of frames) console.log(`[two-arrows]   ${describe(f, t0)}`);
        if (found.doubled.length > 0) console.log(`[two-arrows]   DOUBLED from ${describe(found.doubled[0]!, t0)}`);
      }
      results.push({ cast: `${name} by ${how}`, most });
    }
    expect(results.filter((r) => r.most > 1), 'no frame draws more than one arrow at the target player').toEqual([]);
  } finally {
    await stack.stop();
  }
}
