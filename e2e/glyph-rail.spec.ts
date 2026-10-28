/**
 * The P/T badge always reads, however many keywords a creature gains, upright or turned.
 *
 * The operator, 2026-10-28: *"when a creature is turned sideways and has multiple keywords (First
 * strike + lifelink + trample) eventually the power/toughness is not visible anymore. that's a big
 * problem, we gotta make sure that always shows."* The approved design: every keyword a glyph chip,
 * in one row directly above the P/T badge, ending in "+N" when the card is too narrow.
 *
 * Scenario `glyph-rail`: alice's Grizzly Bears under Archetype of Courage, two wearing Loxodon
 * Warhammer (3 keywords) and two wearing it with Basilisk Collar and Arcane Flight (5), one of each
 * tapped with a +1/+1 counter. At 1280×720 and 1920×1080, on both screens: no tag's box meets the P/T
 * badge, the badge and every chip lie inside the card, no chip meets a mark or a counter, and the
 * chips and the "+N" chip's tip between them name every keyword the card gained.
 *
 * Every step prints one `[glyph-rail]` line, green or red; each card is also photographed (the
 * paths are in the `shot` lines).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[glyph-rail] ${JSON.stringify({ step, data })}`);

const THREE = ['first strike', 'lifelink', 'trample'];
const FIVE = ['flying', 'first strike', 'deathtouch', 'lifelink', 'trample'];
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];

type Rect = [number, number, number, number];
interface Drawn {
  id: number;
  tapped: boolean;
  /** What the rail's list says: every tag, drawn or not. */
  said: string;
  card: Rect;
  pts: Rect[];
  tags: { what: string; tip: string; box: Rect }[];
  others: { what: string; box: Rect }[];
}

/** Every Grizzly Bears on `owner`'s battlefield as `page` draws it: the face, its P/T badges, its tags, its marks and counters. */
function bears(page: Page, owner: 'you' | 'them'): Promise<Drawn[]> {
  return page.locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`).evaluateAll((els) => {
    const box = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom];
    };
    return els
      .filter((e) => e.querySelector(':scope > .board-card__face .card__name')?.textContent?.trim() === 'Grizzly Bears')
      .map((e) => ({
        id: Number(e.getAttribute('data-board-card')),
        tapped: e.hasAttribute('data-tapped'),
        said: e.querySelector(':scope > .board-card__tags')?.getAttribute('aria-label')?.toLowerCase() ?? '',
        // The art as drawn: a flyer's sway moves it and everything it wears together (`card.css`).
        card: box(e.querySelector(':scope > .board-card__face > .card')!),
        pts: [...e.querySelectorAll(':scope > .board-card__pt')].map(box),
        tags: [...e.querySelectorAll<HTMLElement>(':scope > .board-card__tags > li')].map((t) => ({
          what: t.dataset.keyword ?? (t.dataset.more === undefined ? 'other' : `+${t.dataset.more}`),
          tip: t.dataset.tip ?? '',
          box: box(t),
        })),
        others: [...e.querySelectorAll<HTMLElement>(':scope > .board-card__marks > li, :scope > .board-card__counters > li')].map((o) => ({
          what: o.dataset.mark ?? `counter ${o.dataset.counter ?? ''}`,
          box: box(o),
        })),
      }));
  });
}

/** Sub-pixel rounding, and a flyer's overlays riding its sway within a pixel of its art (`tg-tapped-overlays`). */
const SLACK = 1;
const meets = (a: Rect, b: Rect): boolean => a[2] > b[0] + SLACK && a[0] < b[2] - SLACK && a[3] > b[1] + SLACK && a[1] < b[3] - SLACK;
const inside = (a: Rect, card: Rect): boolean => a[0] >= card[0] - SLACK && a[1] >= card[1] - SLACK && a[2] <= card[2] + SLACK && a[3] <= card[3] + SLACK;

/** The keywords a card's rail names: each chip's, and the ones the "+N" chip's tip lists. */
function named(card: Drawn): string[] {
  return card.tags
    .flatMap((t) => (t.what.startsWith('+') ? t.tip.split(', ').map((w) => w.toLowerCase()) : t.what === 'other' ? [] : [t.what]))
    .sort();
}

/** The keywords the rail's list says, of the ones the scenario grants. */
const said = (card: Drawn): string[] => FIVE.filter((k) => card.said.includes(k)).sort();

/** What is wrong with how this card is drawn; empty when nothing is. */
function faults(card: Drawn): string[] {
  const out: string[] = [];
  if (card.pts.length === 0) out.push('no P/T badge');
  for (const pt of card.pts) if (!inside(pt, card.card)) out.push(`P/T ${pt.map(Math.round)} outside the card ${card.card.map(Math.round)}`);
  for (const tag of card.tags) {
    if (!inside(tag.box, card.card)) out.push(`${tag.what} outside the card`);
    for (const pt of card.pts) if (meets(tag.box, pt)) out.push(`${tag.what} ${tag.box.map(Math.round)} meets the P/T ${pt.map(Math.round)}`);
    for (const other of card.others) if (meets(tag.box, other.box)) out.push(`${tag.what} meets ${other.what}`);
  }
  return out;
}

test(titled('the P/T badge reads on a creature with 3 and 5 granted keywords, upright and turned, at 1280×720 and 1920×1080'), async ({ browser }, testInfo) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'glyph-rail');
    const screens = [
      ['alice', seated.alice.page, 'you'],
      ['bob', seated.bob.page, 'them'],
    ] as const;
    for (const viewport of VIEWPORTS) {
      for (const [who, page, owner] of screens) {
        await resizeWindow(page, viewport);
        const at = `${who} ${viewport.width}x${viewport.height}`;
        // Every Bears drawn with all it gained: two of each count, one of each turned.
        await expect
          .poll(
            async () =>
              (await bears(page, owner))
                .map((c) => `${said(c).length}${c.tapped ? 't' : 'u'}`)
                .sort()
                .join(','),
            { timeout: 60_000, message: `${at}: four Bears, 3 and 5 keywords, upright and turned` },
          )
          .toBe('3t,3u,5t,5u');
        const drawn = await bears(page, owner);
        for (const card of drawn) {
          const want = [...(said(card).length === 5 ? FIVE : THREE)].sort();
          const kind = `${want.length}-${card.tapped ? 'turned' : 'upright'}`;
          const bad = faults(card);
          log(bad.length === 0 ? 'clear' : 'RED', { at, kind, card: card.card.map(Math.round), tags: card.tags.map((t) => t.what), bad });
          // A card too small for even the "+N" chip draws no tag; its list still says each.
          if (card.tags.length > 0) expect(named(card), `${at} ${kind}: the chips and the +N tip name every keyword`).toEqual(want);
          expect(bad, `${at} ${kind}`).toEqual([]);
          const [l, t, r, b] = card.card;
          const path = testInfo.outputPath(`${who}-${viewport.width}x${viewport.height}-${kind}.png`);
          await page.screenshot({ path, clip: { x: l - 6, y: t - 6, width: r - l + 12, height: b - t + 12 } });
          log('shot', { at, kind, path });
        }
      }
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
