/**
 * Two of the operator's reports, in the window the second one came from — declaring blockers:
 *
 *  1. *"i dont like the written 'vigilance' on the card when it has it as part of its base effects.
 *     those types of written tabs should only go there if they received the effect from something
 *     else."* Serra Angel (printed "Flying, vigilance", also wearing Arcane Flight) wears no tag and
 *     still floats; Grizzly Bears wearing Arcane Flight wears a Flying tag. Both screens.
 *  2. *"let's drop the dashed summoning sickness on the art, not needed"* (2026-10-15). The blocker's
 *     own sick Hill Giant wears its corner mark and nothing laid over its art, at rest and under the
 *     pointer: its face draws no `::before` layer.
 *
 * Card art is answered locally with a solid picture so that it is always decoded.
 *
 * Scenario: `kw-granted-tags`. Every step prints one `[kw-granted-tags]` line, green or red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, says } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const SCENARIO = 'kw-granted-tags';
const log = (step: string, data: unknown): void => console.log(`[kw-granted-tags] ${JSON.stringify({ step, data })}`);

const SOLID_ART = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#3a7bd5"/></svg>';

/** Every image this page asks for is answered with one solid picture, so card art is always decoded. */
async function solidArt(page: Page): Promise<void> {
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'image' ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SOLID_ART }) : route.fallback(),
  );
}

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

/** A card's keyword tags and whether it floats. */
function tagsOf(page: Page, id: number): Promise<{ tags: string[]; flying: boolean } | null> {
  return page.evaluate((cardId) => {
    const li = document.querySelector<HTMLElement>(`[data-board-card="${cardId}"]`);
    if (li === null) return null;
    return {
      tags: Array.from(li.querySelectorAll(':scope > .board-card__tags > [data-keyword]')).map((t) => (t as HTMLElement).dataset.keyword ?? ''),
      flying: li.hasAttribute('data-flying'),
    };
  }, id);
}

interface Overlay {
  /** It wears the summoning-sick corner mark. */
  sick: boolean;
  artDecoded: boolean;
  /** The face's `::before` layer, its `content` and `background-image`: both `none` when nothing is laid over the art. */
  layer: string;
}

/** What is laid over this card's art right now. */
function overlay(page: Page, id: number): Promise<Overlay> {
  return page.evaluate((cardId) => {
    const li = document.querySelector<HTMLElement>(`[data-board-card="${cardId}"]`);
    const face = li?.querySelector<HTMLElement>(':scope > .board-card__face') ?? null;
    const img = face?.querySelector<HTMLImageElement>('.card img.card__art') ?? null;
    const before = face === null ? null : getComputedStyle(face, '::before');
    return {
      sick: (li?.querySelector('.board-card__mark[data-mark="sick"]') ?? null) !== null,
      artDecoded: img !== null && img.complete && img.naturalWidth > 0,
      layer: before === null ? 'no face' : `content:${before.content} background:${before.backgroundImage}`,
    };
  }, id);
}

const NOTHING_OVER_ART = 'content:none background:none';

test(titled('declaring blockers: a printed keyword wears no tag, a granted one does, and a sick creature wears its mark with nothing over its art'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, SCENARIO, { beforeBob: solidArt });
    const { alice, bob } = seated;
    const angel = await battlefieldNamed(bob.page, 'you', 'Serra Angel');
    const bears = await battlefieldNamed(bob.page, 'you', 'Grizzly Bears');
    const giant = await battlefieldNamed(bob.page, 'you', 'Hill Giant');

    await passDeclareAttackers(alice.page);
    await expect.poll(() => says(bob.page), { timeout: 90_000, message: 'the block window is open for bob' }).toMatch(/select creatures to block/i);

    for (const [who, page, owner] of [
      ['bob', bob.page, 'you'],
      ['alice', alice.page, 'them'],
    ] as const) {
      await battlefieldNamed(page, owner, 'Serra Angel');
      let bearsSeen: Awaited<ReturnType<typeof tagsOf>> = null;
      try {
        await expect
          .poll(async () => (bearsSeen = await tagsOf(page, bears))?.tags, { timeout: 15_000, message: `${who}: the Bears wear the Flying Arcane Flight grants` })
          .toEqual(['flying']);
      } finally {
        log(`bears (${who})`, { bears, seen: bearsSeen });
      }
      const angelSeen = await tagsOf(page, angel);
      log(`serra angel (${who})`, { angel, ...angelSeen });
      expect.soft(angelSeen?.tags, `${who}: Serra Angel's printed flying and vigilance wear no tag`).toEqual([]);
      expect.soft(angelSeen?.flying, `${who}: and Serra Angel still floats`).toBe(true);
    }

    const atRest = await overlay(bob.page, giant);
    log('hill giant at rest (bob)', { giant, ...atRest });
    expect(atRest.sick, 'the Hill Giant wears the summoning-sick mark').toBe(true);
    expect(atRest.artDecoded, 'its art is decoded').toBe(true);
    expect.soft(atRest.layer, 'nothing is laid over its art at rest').toBe(NOTHING_OVER_ART);

    const box = await bob.page.locator(`[data-board-card="${giant}"] > .board-card__face`).boundingBox();
    expect(box, 'the Hill Giant has a face').not.toBeNull();
    await bob.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await bob.page.waitForTimeout(400);
    const hovered = await overlay(bob.page, giant);
    log('hill giant under the pointer (bob)', { giant, ...hovered });
    expect.soft(hovered.layer, 'and nothing under the pointer').toBe(NOTHING_OVER_ART);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
