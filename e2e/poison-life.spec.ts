/**
 * The operator, 2026-10-15: *"can we show poison counters next to the life total when they happen?
 * have the life total and poison counters center justifined within two split columns in the side
 * bar. Also instead of P can we show a skull and bones icon?"*
 *
 * `poison.state` puts three poison counters (and energy and experience) on alice's seat. On both
 * screens — hers, where it is the viewer's seat, and bob's, where it is the opponent's — her life
 * total and her poison sit side by side on one line in the seat's bar: two equal columns, each
 * centred in its own, the poison drawn as a skull-and-crossbones mark and the count, never a
 * letter, with the full words in its tip. Bob has no poison, so his life is drawn alone, centred
 * under his avatar. Poison is drawn in that one place: the counts line keeps energy and experience
 * and has no poison mark of its own. Measured in both board layouts and at both of the operator's
 * window sizes.
 *
 * Scenario: `poison`. Every measurement prints one `[poison]` line (claws keep artifacts only on red).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { chooseLanes } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[poison] ${JSON.stringify({ step, data })}`);

type Owner = 'you' | 'them';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One seat's life and poison, as one screen draws them. */
interface Vitals {
  life: { text: string; box: Box } | null;
  poison: { text: string; tip: string | null; label: string | null; icon: boolean; inFace: boolean; box: Box } | null;
  /** The nearest box holding both life and poison — the row the two columns split — else the life's own parent. */
  row: Box | null;
  art: Box | null;
  bar: Box | null;
  /** Poison drawn anywhere else in the seat: a `.seat__counter` for it, or a second `poison` mark. */
  elsewhere: number;
  counters: string[];
}

function vitalsOf(page: Page, owner: Owner): Promise<Vitals> {
  return page.evaluate((owner) => {
    const box = (el: Element | null): Box | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    };
    const seat = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="player"]')).find((s) => s.hasAttribute('data-viewer') === (owner === 'you'));
    if (seat === undefined) return { life: null, poison: null, row: null, art: null, bar: null, elsewhere: 0, counters: [] };
    const face = seat.querySelector<HTMLElement>('[data-player-face]');
    const life = seat.querySelector<HTMLElement>('[data-testid="life"]');
    const marks = Array.from(seat.querySelectorAll<HTMLElement>('[data-testid="poison"]'));
    const poison = marks[0] ?? null;
    let row: Element | null = life?.parentElement ?? null;
    if (life !== null && poison !== null) {
      row = life.parentElement;
      while (row !== null && !row.contains(poison)) row = row.parentElement;
    }
    const counters = Array.from(seat.querySelectorAll<HTMLElement>('.seat__counter')).map((c) => c.getAttribute('data-counter') ?? '');
    return {
      life: life === null ? null : { text: life.textContent ?? '', box: box(life)! },
      poison:
        poison === null
          ? null
          : {
              text: (poison.textContent ?? '').trim(),
              tip: poison.getAttribute('data-tip'),
              label: poison.getAttribute('aria-label'),
              icon: poison.querySelector('svg') !== null,
              inFace: face !== null && face.contains(poison),
              box: box(poison)!,
            },
      row: box(row),
      art: box(face?.querySelector('.face__art') ?? null),
      bar: box(seat.querySelector('.seat__who')),
      elsewhere: Math.max(0, marks.length - 1) + counters.filter((c) => c === 'poison').length,
      counters,
    };
  }, owner);
}

const mid = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (a: Box, b: Box): boolean => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
] as const;

test(titled('poison sits beside the life total in two centred columns, as a skull-and-crossbones and its count, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'poison');
    // Alice's seat carries the poison: the viewer's seat on her screen, the opponent's on bob's.
    const screens = [
      ['alice', alice, 'you', 'them'],
      ['bob', bob, 'them', 'you'],
    ] as const;

    for (const layout of ['single', 'lanes'] as const) {
      if (layout === 'lanes') for (const [, f] of screens) await chooseLanes(f);
      for (const size of SIZES) {
        for (const [, f] of screens) await f.page.setViewportSize(size);
        for (const [who, f, poisoned, clean] of screens) {
          const where = `${who} ${layout} ${size.width}×${size.height}`;
          await expect
            .poll(async () => (await vitalsOf(f.page, poisoned)).poison?.text ?? null, { timeout: 60_000, message: `${where}: alice's poison is drawn` })
            .toBe('3');
          const v = await vitalsOf(f.page, poisoned);
          log(`${where} poisoned seat`, v);
          const { life, poison, row, art, bar } = v;
          expect(life?.text, `${where}: the life badge is the number and nothing else`).toBe('20');
          expect(poison!.icon, `${where}: poison is a drawn mark`).toBe(true);
          expect(poison!.text, `${where}: the mark and the count — no letter`).toBe('3');
          expect(poison!.tip, `${where}: the tip says it in words`).toBe('3 poison');
          expect(poison!.label, `${where}: so does the accessible name`).toBe('3 poison');
          expect(poison!.inFace, `${where}: poison is drawn on the face, with the life total`).toBe(true);
          expect(v.elsewhere, `${where}: poison is drawn in one place only`).toBe(0);
          expect(v.counters.sort(), `${where}: the counts line keeps energy and experience`).toEqual(['energy', 'experience']);

          const l = mid(life!.box);
          const p = mid(poison!.box);
          expect(Math.abs(l.y - p.y), `${where}: life and poison share one line`).toBeLessThanOrEqual(1.5);
          expect(life!.box.x + life!.box.w, `${where}: life is the left column, poison the right`).toBeLessThanOrEqual(poison!.box.x + 0.5);
          expect(Math.abs(l.x - (row!.x + row!.w / 4)), `${where}: life is centred in the left half of its row`).toBeLessThanOrEqual(1.5);
          expect(Math.abs(p.x - (row!.x + (3 * row!.w) / 4)), `${where}: poison is centred in the right half of its row`).toBeLessThanOrEqual(1.5);
          expect(Math.abs(mid(row!).x - mid(art!).x), `${where}: the row is centred under the avatar`).toBeLessThanOrEqual(1.5);
          expect(inside(life!.box, bar!), `${where}: life inside the seat's bar`).toBe(true);
          expect(inside(poison!.box, bar!), `${where}: poison inside the seat's bar`).toBe(true);
          expect(life!.box.y, `${where}: the line is under the avatar`).toBeGreaterThanOrEqual(art!.y + art!.h);

          const c = await vitalsOf(f.page, clean);
          log(`${where} clean seat`, c);
          expect(c.poison, `${where}: bob has no poison and none is drawn`).toBeNull();
          expect(Math.abs(mid(c.life!.box).x - mid(c.art!).x), `${where}: a life alone stays centred under its avatar`).toBeLessThanOrEqual(1.5);
        }
      }
    }

    // The tip: resting the pointer on the mark says it in words.
    const mark = (await vitalsOf(bob.page, 'them')).poison!;
    await bob.page.mouse.move(mark.box.x + mark.box.w / 2, mark.box.y + mark.box.h / 2);
    await expect(bob.page.getByTestId('board-tip'), 'hovering the poison mark tips it in words').toHaveText(/3 poison/, { timeout: 5_000 });
  } finally {
    await stack.stop();
  }
});
