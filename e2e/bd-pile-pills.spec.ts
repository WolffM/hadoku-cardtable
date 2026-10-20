/**
 * The operator, 2026-10-20 (match m-e6863c7810f1):
 *
 *  - "notice the extra 1/1 below the stacks of tokens causing a new row? this is happening because the
 *    stacks of tokens have become very small and cannot fit both the 2x and the 1/1 on the same stack.
 *    help me fix the way the pills so they stack correctly."
 *  - "notice the many white hourglass effects of kappa cannoneer? once the white hourglass happens more
 *    than once, let's just display it once and show a number next to it that we increment rather than
 *    continuing to stack the icon lower."
 *
 * Scenario `bd-pile-pills`: Alice's front row is Kappa Cannoneer and 24 Servo tokens at 1280×800, so
 * every column is squeezed well under the row's card width. She piles Servos, and on both screens every
 * pile's ×N and P/T sit inside the top card's face without covering each other, and no pile stands
 * taller than its face and its fan. Then Sram's Expertise makes three Servos at once: Kappa triggers
 * three times and wears ONE effect mark with a 3 beside it, on both screens, its tip saying what.
 *
 * Every step prints one `[bd]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, grindPriority, handCardNamed, makeTitled, resizeWindow, stackCount } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, onTopPoint, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[bd] ${JSON.stringify({ step, data })}`);

type Side = 'you' | 'them';
/** Alice's battlefield: her own screen's (`you`) or bob's (`them`). */
const field = (page: Page, side: Side) => page.locator(`.seat${side === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"]`);

interface PileFit {
  id: string;
  size: string;
  faceW: number;
  /** How far each pill reaches outside the top card's face, px (0 or less is inside). */
  outside: Record<string, number>;
  /** Width × height the ×N and the P/T cover each other by, px. */
  overlap: [number, number];
  /** How much taller the pile's own box is than its face and its fan, px (layout, whole px). */
  taller: number;
  /** What the box was measured from, for a red: the width written vs drawn, and what moves the face. */
  diag: Record<string, unknown>;
}

/** Every pile on `side`'s battlefield, measured against the top card's own face. */
function pileFits(page: Page, side: Side): Promise<PileFit[]> {
  return field(page, side)
    .locator('li.board-card[data-pile-size]')
    .evaluateAll((lis) =>
      lis.map((li) => {
        const face = li.querySelector(':scope > .board-card__face')!.getBoundingClientRect();
        const pills = [...li.querySelectorAll<HTMLElement>(':scope > :is(.board-card__pt, .board-card__copies)')];
        const outside: Record<string, number> = {};
        for (const p of pills) {
          const r = p.getBoundingClientRect();
          outside[p.className] = +Math.max(face.left - r.left, r.right - face.right, face.top - r.top, r.bottom - face.bottom).toFixed(1);
        }
        const [a, b] = pills.map((p) => p.getBoundingClientRect());
        const overlap: [number, number] =
          a === undefined || b === undefined
            ? [0, 0]
            : [+(Math.min(a.right, b.right) - Math.max(a.left, b.left)).toFixed(1), +(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)).toFixed(1)];
        const fan = parseFloat(li.style.getPropertyValue('--pile-fan')) || 0;
        return {
          id: li.dataset.cardId!,
          size: li.dataset.pileSize!,
          faceW: +face.width.toFixed(1),
          outside,
          overlap,
          // Layout boxes, not drawn ones: a lifted face is drawn bigger than the box it lays out in.
          taller: (li as HTMLElement).offsetHeight - (li.querySelector<HTMLElement>(':scope > .board-card__face')!).offsetHeight - Math.round(fan),
          diag: (() => {
            const f = li.querySelector<HTMLElement>(':scope > .board-card__face')!;
            const fs = getComputedStyle(f);
            const ls = getComputedStyle(li);
            const lr = li.getBoundingClientRect();
            const pt = li.querySelector<HTMLElement>(':scope > .board-card__pt');
            const r = pt?.getBoundingClientRect();
            return {
              drawnW: (li as HTMLElement).style.getPropertyValue('--card-drawn-w'),
              liW: +lr.width.toFixed(1),
              liOffsetW: (li as HTMLElement).offsetWidth,
              faceOffsetW: f.offsetWidth,
              face: [+face.left.toFixed(1), +face.top.toFixed(1), +face.right.toFixed(1), +face.bottom.toFixed(1)],
              li: [+lr.left.toFixed(1), +lr.top.toFixed(1), +lr.right.toFixed(1), +lr.bottom.toFixed(1)],
              pt: r === undefined ? null : [+r.left.toFixed(1), +r.top.toFixed(1), +r.right.toFixed(1), +r.bottom.toFixed(1)],
              faceTransform: [fs.transform, fs.scale, fs.translate, fs.rotate].join('|'),
              liTransform: [ls.transform, ls.scale, ls.translate].join('|'),
              anims: [...li.getAnimations({ subtree: true })].map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.constructor.name}@${String(a.currentTime)}`),
              attrs: [...li.attributes].map((x) => x.name).filter((n) => n.startsWith('data-')).join(','),
            };
          })(),
        };
      }),
    );
}

/** Kappa's effect marks on `side`: count, tip, and what the chip shows beside its glyph. */
function kappaMarks(page: Page, side: Side): Promise<{ count: string | null; shown: string; tip: string }[]> {
  return field(page, side)
    .locator('li.board-card', { has: page.locator(':scope > .board-card__face .card__name', { hasText: 'Kappa Cannoneer' }) })
    .first()
    .evaluate((li) =>
      [...li.querySelectorAll<HTMLElement>(':scope > .board-card__tags > [data-effect]')].map((t) => ({
        count: t.dataset.count ?? null,
        shown: t.textContent ?? '',
        tip: t.dataset.tip ?? '',
      })),
    );
}

/** Soft, so one run reports both of the operator's cases. */
/**
 * The piles once the board has settled: nothing animating on them and the same measure twice running.
 * An arrival moves every column of the row (its glide transforms the cards), and a box read mid-move is
 * the move's, not the layout's.
 */
async function settledFits(page: Page, side: Side): Promise<PileFit[]> {
  let last = '';
  let fits: PileFit[] = [];
  await expect
    .poll(
      async () => {
        fits = await pileFits(page, side);
        const now = JSON.stringify(fits);
        const same = now === last && fits.every((f) => (f.diag.anims as unknown[]).length === 0);
        last = now;
        return same;
      },
      { timeout: 10_000, intervals: [100], message: 'the piles stop moving' },
    )
    .toBe(true);
  return fits;
}

function expectPilesFit(fits: PileFit[], who: string): void {
  expect(fits.length, `${who}: alice's piles are drawn`).toBeGreaterThan(0);
  for (const f of fits) {
    for (const [pill, out] of Object.entries(f.outside)) expect.soft(out, `${who}: pile ${f.id} (${f.faceW}px face): ${pill} is inside the face`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.min(...f.overlap), `${who}: pile ${f.id}: the ×N and the P/T do not cover each other`).toBeLessThanOrEqual(0.5);
    expect.soft(f.taller, `${who}: pile ${f.id}: no taller than its face and its fan`).toBeLessThanOrEqual(1);
  }
}

test(titled('a crowded pile of tokens keeps its ×N and P/T on the card, and the same effect thrice is one mark with a 3 — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bd-pile-pills');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const a = alice.page;
    const screens = [
      ['alice', a, 'you'],
      ['bob', bob.page, 'them'],
    ] as const;

    const servos = field(a, 'you').locator('li.board-card', { has: a.locator(':scope > .board-card__face .card__name', { hasText: 'Servo' }) });
    await expect(servos, 'alice’s 24 Servos, each its own column').toHaveCount(24, { timeout: 45_000 });
    const ids = await servos.evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')!));
    const card = (id: string) => field(a, 'you').locator(`li.board-card[data-card-id="${id}"]`);
    // Two piles of two, by real pointer drags.
    for (const [base, top] of [
      [ids[0]!, ids[1]!],
      [ids[2]!, ids[3]!],
    ] as const) {
      await pointerDrag(a, card(top), onTopPoint(await boxOf(card(base))));
      await expect(card(base), `Servo ${top} piled on ${base}`).toHaveAttribute('data-pile-size', '2');
    }
    for (const [who, page, side] of screens) {
      await expect(field(page, side).locator('li.board-card[data-pile-size]'), `${who}: two piles`).toHaveCount(2, { timeout: 10_000 });
      const fits = await settledFits(page, side);
      log(`piles (${who})`, fits);
      expectPilesFit(fits, who);
    }

    // Sram's Expertise: three Servos at once, three Kappa triggers.
    const sram = await handCardNamed(a, "Sram's Expertise");
    expect(sram, 'Sram’s Expertise is in alice’s hand').not.toBeUndefined();
    const box = (await field(a, 'you').boundingBox())!;
    await castByDrag(a, stack, sram!, { x: Math.round(box.x + box.width * 0.6), y: Math.round(box.y + box.height * 0.5) });
    await grindPriority([a, bob.page], async () => (await servos.count()) === 27 && (await stackCount(a)) === 0, { timeoutMs: 60_000 });
    log('after Sram’s Expertise', { servos: await servos.count(), stack: await stackCount(a) });

    for (const [who, page, side] of screens) {
      let marks: Awaited<ReturnType<typeof kappaMarks>> = [];
      try {
        await expect
          .poll(async () => (marks = await kappaMarks(page, side)).map((m) => m.count).join(','), { timeout: 15_000, message: `${who}: Kappa wears one effect mark counting 3` })
          .toBe('3');
      } finally {
        log(`kappa (${who})`, marks);
      }
      expect(marks[0]!.shown, `${who}: the 3 is drawn beside the mark`).toBe('3');
      expect(marks[0]!.tip, `${who}: the tip says what the three are`).toMatch(/blocked[^\n]*\(×3\)/i);
      const fits = await settledFits(page, side);
      log(`piles after (${who})`, fits);
      expectPilesFit(fits, who);
    }

    // Into combat: every creature alice can attack with rises off the table (`data-combat-ready`), and
    // what it wears rises with it — the P/T stayed on the table 3px under the raised face (run 39378672508).
    const ready = field(a, 'you').locator('li.board-card[data-pile-size][data-combat-ready]');
    await passToDeclareAttackers(a);
    await expect(ready, 'both of alice’s piles are drawn ready to attack').toHaveCount(2, { timeout: 10_000 });
    const lifted = await settledFits(a, 'you');
    log('piles declaring attackers (alice)', lifted);
    expectPilesFit(lifted, 'alice, declaring attackers');
  } finally {
    await stack.stop();
  }
});
