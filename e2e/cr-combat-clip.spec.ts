/**
 * The operator: *"cards get a bit bigger when they are ready to attack, which is good but it's a
 * little awkward when they get clipped by the field boundaries, or their outline get clipped by
 * the field boundary. let's make sure they can be on top."*
 *
 * A crowded battlefield (`cr-combat-clip.state`: sixteen creatures, five lands) in the live
 * declare-attackers window. The front tier is full of creatures from its first column to its last,
 * and one creature is dragged (a real pointer) into the back tier beside the lands, so a ready
 * creature sits on every edge of the battlefield. Every creature drawn combat-ready must paint its
 * whole grown face, its rings and its shadow inside what its clipping ancestors let through, and
 * nothing on the board may scroll. The resting boxes are printed before the window opens, so two
 * runs can be compared — and no resting box may move when the window opens.
 *
 * Every step prints one `[cr-combat-clip]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test
 * SKIPS and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'cr-combat-clip';
const log = (step: string, data: unknown): void => console.log(`[cr-combat-clip] ${JSON.stringify({ step, data })}`);

interface Painted {
  id: number;
  name: string;
  tier: string;
  /** The resting box of the card's `<li>`, which no emphasis may move. */
  rest: [number, number, number, number];
  /** How far past its visible rect the card's paint reaches, per side, and which ancestor clips it there. */
  clipped: number;
  side: string;
  by: string;
}

interface Board {
  ready: number[];
  cards: Painted[];
  scrolls: string[];
}

/**
 * Every card on the viewer's battlefield: its resting box and how much of its paint — the face
 * as transformed, the face's own shadow and outline, and the art's ring — falls outside the
 * intersection of every ancestor that clips (its padding box, grown by `overflow-clip-margin`
 * where it is `overflow: clip`). Plus every box on the board that has scrollable overflow.
 */
function measure(page: Page): Promise<Board> {
  return page.evaluate(() => {
    const px = (v: string): number => (v.endsWith('px') ? Number.parseFloat(v) : 0);
    /** Per-side reach past the box of every non-inset shadow in a computed `box-shadow`. */
    const shadowReach = (value: string, scale: number): { l: number; r: number; t: number; b: number } => {
      const out = { l: 0, r: 0, t: 0, b: 0 };
      if (value === 'none') return out;
      for (const layer of value.split(/,(?![^(]*\))/)) {
        if (/\binset\b/.test(layer)) continue;
        const lengths = (layer.replace(/\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? []).map(px);
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
        const reach = blur + spread;
        out.l = Math.max(out.l, (reach - x) * scale);
        out.r = Math.max(out.r, (reach + x) * scale);
        out.t = Math.max(out.t, (reach - y) * scale);
        out.b = Math.max(out.b, (reach + y) * scale);
      }
      return out;
    };
    const scaleOf = (el: Element): number => {
      const s = getComputedStyle(el).scale;
      return s === 'none' ? 1 : Number.parseFloat(s);
    };
    /** The painted rect of `el`: its transformed border box, its shadow, its outline. */
    const ink = (el: HTMLElement, scale: number): DOMRect => {
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const sh = shadowReach(cs.boxShadow, scale);
      const ol = cs.outlineStyle === 'none' ? 0 : Math.max(0, (px(cs.outlineWidth) + px(cs.outlineOffset)) * scale);
      const l = Math.max(sh.l, ol);
      const r = Math.max(sh.r, ol);
      const t = Math.max(sh.t, ol);
      const b = Math.max(sh.b, ol);
      return new DOMRect(box.left - l, box.top - t, box.width + l + r, box.height + t + b);
    };
    const zone = document.querySelector<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"]');
    const cards: Painted[] = [];
    for (const li of Array.from(zone?.querySelectorAll<HTMLElement>('[data-board-card]') ?? [])) {
      const face = li.querySelector<HTMLElement>(':scope > .board-card__face');
      const art = face?.querySelector<HTMLElement>(':scope > .card');
      if (face === null || face === undefined || art === null || art === undefined) continue;
      const scale = scaleOf(face);
      const painted = [ink(face, scale), ink(art, scale)];
      const rest = li.getBoundingClientRect();
      let worst = { clipped: 0, side: '', by: '' };
      for (let up = li.parentElement; up !== null && up !== document.documentElement; up = up.parentElement) {
        const cs = getComputedStyle(up);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const box = up.getBoundingClientRect();
        const margin = cs.overflowX === 'clip' || cs.overflowY === 'clip' ? px(cs.overflowClipMargin.split(' ').pop() ?? '0px') : 0;
        const vis = {
          l: box.left + up.clientLeft - margin,
          t: box.top + up.clientTop - margin,
          r: box.left + up.clientLeft + up.clientWidth + margin,
          b: box.top + up.clientTop + up.clientHeight + margin,
        };
        for (const p of painted) {
          for (const [side, over] of [
            ['left', vis.l - p.left],
            ['right', p.right - vis.r],
            ['top', vis.t - p.top],
            ['bottom', p.bottom - vis.b],
          ] as const) {
            if (over > worst.clipped) worst = { clipped: over, side, by: `${up.tagName.toLowerCase()}.${Array.from(up.classList).join('.')}` };
          }
        }
      }
      cards.push({
        id: Number(li.getAttribute('data-board-card')),
        name: li.querySelector('.card__name')?.textContent?.trim() ?? '',
        tier: li.closest('[data-tier]')?.getAttribute('data-tier') ?? '',
        rest: [rest.left, rest.top, rest.width, rest.height].map((n) => Math.round(n * 10) / 10) as [number, number, number, number],
        clipped: Math.round(worst.clipped * 10) / 10,
        side: worst.side,
        by: worst.by,
      });
    }
    const scrolls: string[] = [];
    const doc = document.scrollingElement;
    if (doc !== null && (doc.scrollHeight > doc.clientHeight + 1 || doc.scrollWidth > doc.clientWidth + 1)) scrolls.push(`document ${doc.scrollWidth}x${doc.scrollHeight}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.board *'))) {
      const cs = getComputedStyle(el);
      const scrollable = /auto|scroll/.test(`${cs.overflowX} ${cs.overflowY}`);
      if (scrollable && el.clientHeight > 0 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
        scrolls.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
      }
    }
    return {
      ready: Array.from(zone?.querySelectorAll('[data-combat-ready]') ?? []).map((el) => Number(el.getAttribute('data-board-card'))),
      cards,
      scrolls,
    };
  });
}

test(titled('a creature ready to attack is drawn whole at the edge of the battlefield — face, ring and shadow — and nothing scrolls'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO);
    const { alice } = seated;
    await expect
      .poll(async () => (await measure(alice.page)).cards.length, { timeout: 30_000, message: 'all 21 permanents are on the battlefield' })
      .toBe(21);

    // The front tier's last creature, dragged past the back tier's last land.
    const own = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]');
    const moving = own.locator('[data-tier="front"] li.board-card[data-arrange-card]').last();
    const movingId = Number(await moving.getAttribute('data-board-card'));
    const lastLand = await boxOf(own.locator('[data-tier="back"] li.board-card[data-arrange-card]').last());
    await pointerDrag(alice.page, moving, { x: lastLand.x + lastLand.width * 1.6, y: lastLand.y + lastLand.height / 2 });
    await expect(own.locator(`[data-tier="back"] [data-board-card="${movingId}"]`), 'the creature now sits in the back tier').toHaveCount(1, { timeout: 10_000 });
    await alice.page.waitForTimeout(500);

    const resting = await measure(alice.page);
    log('resting', { scrolls: resting.scrolls, cards: resting.cards.map((c) => [c.name, c.tier, ...c.rest]) });

    await passToDeclareAttackers(alice.page);
    await expect
      .poll(async () => (await measure(alice.page)).ready.length, { timeout: 10_000, message: 'the sixteen creatures are drawn ready to attack' })
      .toBe(16);
    // Let the 160 ms growth settle before reading the painted extent.
    await alice.page.waitForTimeout(500);
    const open = await measure(alice.page);
    const ready = open.cards.filter((c) => open.ready.includes(c.id));
    for (const c of ready) log('ready', c);
    log('declare attackers', { scrolls: open.scrolls, worst: Math.max(...ready.map((c) => c.clipped)) });

    const clipped = ready.filter((c) => c.clipped > 0.5).map((c) => `${c.name} clipped ${c.clipped}px at its ${c.side} by ${c.by}`);
    expect(clipped, 'every creature ready to attack is drawn whole, its ring and shadow included').toEqual([]);
    const front = ready.filter((c) => c.tier === 'front').sort((a, b) => a.rest[0] - b.rest[0]);
    expect(front.length, 'the front tier holds the ready creatures').toBe(15);
    expect(ready.find((c) => c.id === movingId)?.tier, 'and the back tier one more').toBe('back');

    const moved = open.cards.filter((c) => {
      const before = resting.cards.find((r) => r.id === c.id);
      return before === undefined || before.rest.some((v, i) => Math.abs(v - c.rest[i]!) > 0.5);
    });
    expect(moved.map((c) => c.name), 'no resting box moves when the window opens').toEqual([]);
    expect(open.scrolls, 'nothing on the board scrolls').toEqual([]);
    const restingClipped = resting.cards.filter((c) => c.clipped > 0.5).map((c) => `${c.name} clipped ${c.clipped}px at its ${c.side} by ${c.by}`);
    expect(restingClipped, 'and a resting card, its playable ring included, paints inside its lane too').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
