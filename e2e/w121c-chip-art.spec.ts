/**
 * AF632 — the operator, 2026-11-16: "dragonologist ability chip was rendered without art. happened
 * again for betor, kin to all." Neither card is in any cube, so the committed, cube-and-library-pool
 * artist table (`games/magic/ui/src/draft/art-artists.json`, built by `scripts/art/build-art-artists.ts`)
 * never heard of either id — even though `play/art-ids.ts` resolves both ids fine and `/api/art/<id>`
 * would serve either's image with no 404 and no mirror row needed (`play/art-ids.test.ts`,
 * `http/card-art.test.ts`). The class: any card not in the bundled cube or the committed table —
 * every constructed-deck card a cube never bundled. `AbilityChip.tsx`'s fix falls back to the
 * server's own live lookup, `GET /api/art/<id>/artist`, which reads the Scryfall corpus directly
 * (`http/card-art.ts`) once the committed table has answered "no" for an id.
 *
 * Scenario `w121c-chip-art`: alice casts Dragonologist (its own ETB trigger goes on the stack) while
 * bob (Full Control) holds priority, same mechanism as `w67-trigger.state`/`e2e/play/chip.ts`'s
 * `triggerOnStack`. Betor, Kin to All sits on alice's battlefield already with Wall of Omens beside
 * it (total toughness 11, past Betor's own "10 or greater" check), so once Dragonologist's trigger
 * is answered and the turn is walked to alice's end step, Betor's own trigger is the chip too.
 *
 * The plain image route is stood in for (a card-sized SVG, never real image bytes — the same
 * convention `w69-backface.spec.ts`/`front-gallery-preload.spec.ts` use): this spec is about whether
 * the chip ASKS for and DRAWS an id's art, not about Scryfall's own bytes. The new `/artist` route is
 * left to the real server, reading the real `CARDTABLE_SCRYFALL_DIR` corpus the wave's env points at
 * — the one thing this spec measures live.
 *
 * The e2e stack's own server catalog (`e2e/fixtures/sets-catalog.json`, ISD/ALA/ARB — never the
 * host's) has no printing of either card, by design (`play/harness.ts`'s `PLAY_CATALOG`): no e2e
 * spec's match should depend on the host's 35k-card corpus. So this match's own stack is started with
 * its OWN small catalog, `e2e/fixtures/w121c-catalog.json` — Dragonologist and Betor, Kin to All ONLY,
 * their real TDM printings, standing in for "a card a constructed deck named that the live catalog
 * resolves" (`CARDTABLE_CATALOG` overrides `startPlayStack`'s own default). Without it `art.card()`
 * finds neither card at all (`play/art-ids.ts`'s catalog fallback has nothing to fall back to), no
 * id ever reaches the wire, and the chip draws no art for a reason this fix does not touch — the
 * measured RED this spec is actually about is an id that DOES resolve, credited or not.
 */
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { chipOf, triggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { grindPriority, makeTitled, resizeWindow } from './play/board.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { ART_ROUTE } from './art.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** A card-sized image, as text (never image bytes). Only the plain `/api/art/<id>` route: `/artist` passes through to the real server. */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';
async function serveArt(page: Page): Promise<void> {
  await page.route(ART_ROUTE, async (route) => {
    if (route.request().url().endsWith('/artist')) {
      await route.continue();
      return;
    }
    await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
  });
}

/** The one ability chip on screen naming `source`, if any. */
const chipNamed = (page: Page, source: string) => chipOf(page).filter({ has: page.locator('.placed__chip-name', { hasText: source }) });

/** Every `/api/art/` request this page makes from here on, by path (never host — the art host differs per environment). */
function trackArtRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (ART_ROUTE.test(url.pathname)) seen.push(url.pathname);
  });
  return seen;
}

/** Whether `chip`'s art band has a decoded image — the repo's own art-ready contract (`draft/cardImage.ts`'s `artReady`). */
const chipArtDecoded = (chip: ReturnType<typeof chipOf>) =>
  chip.evaluate((el) => {
    const img = el.querySelector<HTMLImageElement>('img.placed__chip-art');
    return img !== null && img.complete && img.naturalWidth > 0;
  });

test(titled('AF632 — Dragonologist and Betor, Kin to All: neither card is in any cube, both chips draw decoded art'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge, { env: { CARDTABLE_CATALOG: resolve(import.meta.dirname, 'fixtures', 'w121c-catalog.json') } });
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w121c-chip-art', { beforeAlice: serveArt, beforeBob: serveArt });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const aliceArt = trackArtRequests(alice.page);

    // Dragonologist: cast from hand, its trigger sits on the stack as the chip (bob holds priority).
    await triggerOnStack(alice.page, bob.page, 'Dragonologist');
    const dragonologist = chipNamed(alice.page, 'Dragonologist');
    await expect(dragonologist, 'Dragonologist’s chip is on screen, on both sides').toHaveCount(1);
    await expect(chipNamed(bob.page, 'Dragonologist')).toHaveCount(1);
    await expect.poll(() => chipArtDecoded(dragonologist), { timeout: 10_000, message: `art requests so far: ${aliceArt.join(', ')}` }).toBe(true);
    expect(aliceArt.some((p) => p.endsWith('/artist')), `alice's page asked the live artist route at least once: ${aliceArt.join(', ')}`).toBe(true);

    // Let Dragonologist's own trigger resolve (decline the optional reveal), then walk the turn
    // forward — combat, nobody attacks, into alice's end step — where Betor's trigger is the chip.
    await answerPrompt(alice.page).catch(() => undefined);
    await grindPriority([alice.page, bob.page], async () => (await chipNamed(alice.page, 'Betor, Kin to All').count()) > 0, { timeoutMs: 60_000 });
    const betor = chipNamed(alice.page, 'Betor, Kin to All');
    await expect(betor, 'Betor, Kin to All’s chip is on screen, on both sides').toHaveCount(1);
    await expect(chipNamed(bob.page, 'Betor, Kin to All')).toHaveCount(1);
    await expect.poll(() => chipArtDecoded(betor), { timeout: 10_000, message: `art requests so far: ${aliceArt.join(', ')}` }).toBe(true);
    expect(aliceArt.filter((p) => p.endsWith('/artist')).length, `alice's page asked the live artist route for both cards: ${aliceArt.join(', ')}`).toBeGreaterThanOrEqual(2);
  } finally {
    await stack.stop();
  }
});
