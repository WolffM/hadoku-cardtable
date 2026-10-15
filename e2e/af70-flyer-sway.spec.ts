/**
 * The operator, 2026-10-15, once the stack's cards hovered: *"we need a different effect for flying
 * creatures then. i think flying creatures should sway from left to right"* — and on seeing the first
 * cut: *"too 'jittery'. for the card movement i'm envisioning a side-ways 8 pattern. it should be a
 * consistent movement sway, however still subtle. the card distortion should be a diagonal tilt, so
 * squish and zoomout one corner while zoomin stretch another corner"*.
 *
 * Measured on a live match from both screens, over one whole loop: a flyer's face travels further
 * across than up and down, and rises and falls twice for every once across (a sideways 8, not an
 * oval); it tilts in depth about both axes, each tilt swinging both ways (one corner forward, then
 * the other); two flyers side by side are never in step, the shadow under a flyer moves with it, a
 * creature without flying holds still, and a reduced-motion screen holds a flyer still and flat.
 * The face is sampled on every animation frame as its box against its own `<li>`'s, which never
 * moves.
 *
 * Scenario: `kw-granted-tags` (bob's Serra Angel flies by print, his Grizzly Bears by Arcane Flight,
 * his Hill Giant does not). Every step prints one `[af70]` line, green or red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'kw-granted-tags';
const log = (step: string, data: unknown): void => console.log(`[af70] ${JSON.stringify({ step, data })}`);

/** The battlefield card of this name on `owner`'s side as `page` draws it, by id. */
async function battlefieldNamed(page: Page, owner: 'you' | 'them', name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on the ${owner} battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

interface Track {
  /** The face's centre against its `<li>`'s, every frame (px). */
  dx: number[];
  dy: number[];
  /** Its 3D tilt from the computed `rotate` (degrees about the screen's x and y axes). */
  tiltX: number[];
  tiltY: number[];
  /** The shadow's computed `translate`, every frame. */
  shadow: string[];
}

/** Every frame for `ms`, each card's face centre against its `<li>`'s, and its shadow's `translate`. */
function sample(page: Page, ids: number[], ms: number): Promise<Record<number, Track>> {
  return page.evaluate(
    ([cardIds, span]) =>
      new Promise<Record<number, Track>>((done) => {
        const out: Record<number, Track> = {};
        for (const id of cardIds) out[id] = { dx: [], dy: [], tiltX: [], tiltY: [], shadow: [] };
        const end = performance.now() + span;
        const frame = (): void => {
          for (const id of cardIds) {
            const li = document.querySelector<HTMLElement>(`[data-board-card="${id}"]`);
            const card = li?.querySelector<HTMLElement>(':scope > .board-card__face > .card');
            const face = li?.querySelector<HTMLElement>(':scope > .board-card__face');
            if (li == null || card == null || face == null) continue;
            const l = li.getBoundingClientRect();
            const c = card.getBoundingClientRect();
            out[id]!.dx.push(c.left + c.width / 2 - (l.left + l.width / 2));
            out[id]!.dy.push(c.top + c.height / 2 - (l.top + l.height / 2));
            // `rotate: x y z <angle>` (or one angle about z, or `none`): the angle shared out along the axis.
            const parts = getComputedStyle(card).rotate.split(' ');
            const angle = parts.length === 4 ? parseFloat(parts[3]!) : 0;
            const [ax, ay, az] = parts.length === 4 ? parts.slice(0, 3).map(Number) : [0, 0, 1];
            const norm = Math.hypot(ax!, ay!, az!) || 1;
            out[id]!.tiltX.push((angle * ax!) / norm);
            out[id]!.tiltY.push((angle * ay!) / norm);
            out[id]!.shadow.push(getComputedStyle(face, '::after').translate);
          }
          if (performance.now() < end) requestAnimationFrame(frame);
          else done(out);
        };
        requestAnimationFrame(frame);
      }),
    [ids, ms] as const,
  );
}

const range = (xs: number[]): number => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));
/** How many times `xs` swings across its own middle, counted with a band of a quarter of its range so a still or noisy trace counts none. */
function swings(xs: number[]): number {
  const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
  const band = range(xs) / 4;
  let side = 0;
  let n = 0;
  for (const x of xs) {
    const now = x > mid + band ? 1 : x < mid - band ? -1 : 0;
    if (now !== 0 && side !== 0 && now !== side) n += 1;
    if (now !== 0) side = now;
  }
  return n;
}
const round = (n: number): number => Math.round(n * 100) / 100;
const summary = (t: Track | undefined) =>
  t === undefined
    ? null
    : {
        frames: t.dx.length,
        xRange: round(range(t.dx)),
        yRange: round(range(t.dy)),
        xSwings: swings(t.dx),
        ySwings: swings(t.dy),
        tiltX: [round(Math.min(...t.tiltX)), round(Math.max(...t.tiltX))],
        tiltY: [round(Math.min(...t.tiltY)), round(Math.max(...t.tiltY))],
        shadows: new Set(t.shadow).size,
        first: t.shadow[0],
      };

test(titled('a flyer loops a sideways 8 and tilts a corner forward as it goes, out of step with the next flyer, its shadow with it; a reduced-motion screen holds it still'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice, bob } = seated;

    for (const [who, page, owner] of [
      ['bob', bob.page, 'you'],
      ['alice', alice.page, 'them'],
    ] as const) {
      const angel = await battlefieldNamed(page, owner, 'Serra Angel');
      const bears = await battlefieldNamed(page, owner, 'Grizzly Bears');
      const giant = await battlefieldNamed(page, owner, 'Hill Giant');
      await expect.poll(() => page.locator(`[data-board-card="${bears}"]`).getAttribute('data-flying'), { message: `${who}: the Bears fly` }).not.toBeNull();

      // One and a half loops (a loop is 5.6 s): a card caught mid-crossing only counts its first swing once it is a quarter of
      // the way out, so a single loop's window can end just before its second crossing.
      const tracks = await sample(page, [angel, bears, giant], 8_500);
      const [a, b, g] = [tracks[angel], tracks[bears], tracks[giant]];
      const apart = a === undefined || b === undefined ? 0 : Math.max(...a.dx.map((x, i) => Math.abs(x - (b.dx[i] ?? x))));
      log(`sampled (${who})`, { angel: summary(a), bears: summary(b), giant: summary(g), flyersApartPx: round(apart) });

      for (const [name, t] of [
        ['Serra Angel', a],
        ['Grizzly Bears', b],
      ] as const) {
        expect(t?.dx.length ?? 0, `${who}: ${name} was sampled`).toBeGreaterThan(30);
        expect.soft(range(t!.dx), `${who}: ${name} sways across by several px`).toBeGreaterThanOrEqual(4);
        expect.soft(range(t!.dx), `${who}: ${name} sways further across than it rises and falls`).toBeGreaterThan(range(t!.dy) * 1.5);
        expect.soft(range(t!.dy), `${who}: ${name}'s sway rises and falls, not a line`).toBeGreaterThan(0.5);
        expect.soft(swings(t!.dx), `${who}: ${name} crosses once each way in a loop`).toBeGreaterThanOrEqual(2);
        expect.soft(swings(t!.dy), `${who}: ${name} rises and falls twice for each crossing — a sideways 8`).toBeGreaterThanOrEqual(swings(t!.dx) * 2 - 1);
        for (const [axis, xs] of [
          ['x', t!.tiltX],
          ['y', t!.tiltY],
        ] as const) {
          expect.soft(Math.max(...xs), `${who}: ${name} tilts one way about ${axis}`).toBeGreaterThan(1);
          expect.soft(Math.min(...xs), `${who}: ${name} tilts the other way about ${axis}`).toBeLessThan(-1);
          expect.soft(Math.max(...xs.map(Math.abs)), `${who}: ${name}'s tilt about ${axis} stays subtle`).toBeLessThan(6);
        }
        expect.soft(new Set(t!.shadow).size, `${who}: ${name}'s shadow moves with it`).toBeGreaterThan(5);
      }
      expect.soft(apart, `${who}: the two flyers are not in step`).toBeGreaterThan(1);
      expect.soft(range(g?.dx ?? []) + range(g?.dy ?? []), `${who}: the Hill Giant, which does not fly, holds still`).toBeLessThan(0.5);
    }

    await bob.page.emulateMedia({ reducedMotion: 'reduce' });
    const angel = await battlefieldNamed(bob.page, 'you', 'Serra Angel');
    const still = (await sample(bob.page, [angel], 1_500))[angel];
    log('reduced motion (bob)', { angel: summary(still) });
    expect.soft(range(still?.dx ?? [1]) + range(still?.dy ?? [1]), 'reduced motion: the flyer holds still').toBeLessThan(0.5);
    expect.soft(Math.max(...(still?.tiltX ?? [1]).map(Math.abs), ...(still?.tiltY ?? [1]).map(Math.abs)), 'reduced motion: the flyer lies flat').toBeLessThan(0.1);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
