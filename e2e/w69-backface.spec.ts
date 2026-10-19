/**
 * The operator, 2026-10-11: *"insectile aberation has no art. probably because flip cards aren't in the art
 * pre-load?"* — and the standing rule, *"i really dont want a no-art card to show ever"*.
 *
 * Forge names the face a card is showing. Alice's Delver of Secrets transforms at her upkeep and crosses the
 * wire as Insectile Aberration; bob's Thing in the Ice is already transformed (Awoken Horror). Both screens
 * must draw every back face with that card's back image — on the board and in the inspector — in every
 * frame, and alice's Insectile Aberration must already be warm (asked for before it transforms) so the
 * transform never shows a face without its art.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** A card-sized image, as text (never image bytes). */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#2a4a7a"/></svg>';
const ART_HOSTS = /^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//;
const BACK_FACES = ['Insectile Aberration', 'Awoken Horror'];

type Face = { name: string; where: string; src: string | null; drawn: boolean };
type Frame = { t: number; faces: Face[] };

/** Every frame whose drawing of a back face changed: each tile of one, where it is, its art URL, and whether that art is drawn. */
async function record(page: Page): Promise<void> {
  await page.evaluate((names) => {
    const frames: Frame[] = [];
    (window as unknown as { __faces: () => Frame[] }).__faces = () => frames;
    let last = '';
    const tick = (): void => {
      // Not a tile's hidden other faces (`CardTile.tsx`'s `data-card-faces` layer): never drawn, so never loaded.
      const faces = Array.from(document.querySelectorAll('.card'))
        .filter((card) => card.closest('[data-card-faces]') === null)
        .filter((card) => names.includes(card.querySelector('.card__name')?.textContent?.trim() ?? ''))
        .map((card) => {
          const img = card.querySelector('img.card__art') as HTMLImageElement | null;
          const seat = card.closest('.seat');
          const where = card.closest('[data-inspect]') !== null ? 'inspector' : seat === null ? 'elsewhere' : seat.hasAttribute('data-viewer') ? 'mine' : 'theirs';
          return {
            name: card.querySelector('.card__name')!.textContent!.trim(),
            where,
            src: img?.getAttribute('src') ?? null,
            drawn: img !== null && img.style.display !== 'none' && img.complete && img.naturalWidth > 0,
          };
        });
      const key = JSON.stringify(faces);
      if (key !== last) {
        last = key;
        frames.push({ t: Date.now(), faces });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, BACK_FACES);
}

const framesOf = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __faces: () => Frame[] }).__faces());

/** Answer every art request with the stand-in at once, remembering when each URL was asked for. */
async function serveArt(page: Page, asked: Map<string, number>): Promise<void> {
  await page.route(ART_HOSTS, async (route) => {
    const url = route.request().url();
    if (!asked.has(url)) asked.set(url, Date.now());
    await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
  });
}

/** The art URL of the first tile named `name` on `page`'s board, or null. */
const artOf = (page: Page, name: string): Promise<string | null> =>
  page.evaluate((n) => {
    const card = Array.from(document.querySelectorAll('.seat .card')).find((c) => c.querySelector('.card__name')?.textContent?.trim() === n);
    return card?.querySelector('img.card__art')?.getAttribute('src') ?? null;
  }, name);

const tile = (page: Page, side: 'mine' | 'theirs', name: string) =>
  page.locator(`.seat${side === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] li.board-card`, { has: page.locator('.card__name', { hasText: name }) }).first();

test(titled("a transformed card's back face is drawn with its own art on both screens, in every frame, and in the inspector"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-backface');
    const seats = [['alice', alice.page], ['bob', bob.page]] as const;
    const asked = new Map<Page, Map<string, number>>();
    for (const [, page] of seats) {
      await resizeWindow(page, { width: 1280, height: 800 });
      asked.set(page, new Map());
      await serveArt(page, asked.get(page)!);
      // Cold, with the art served: the match's preload runs again on this join.
      await page.reload();
    }
    for (const [name, page] of seats) {
      await expect(tile(page, name === 'alice' ? 'mine' : 'theirs', 'Delver of Secrets'), `${name} sees alice's Delver of Secrets`).toHaveCount(1, { timeout: 30_000 });
      await expect(tile(page, name === 'alice' ? 'theirs' : 'mine', 'Awoken Horror'), `${name} sees bob's transformed Thing in the Ice`).toHaveCount(1, { timeout: 30_000 });
    }
    await alice.page.waitForTimeout(1500);
    await Promise.all(seats.map(([, page]) => record(page)));

    const delverFront = await artOf(alice.page, 'Delver of Secrets');
    console.log(`[w69-backface] alice's Delver of Secrets draws ${delverFront}`);
    expect(delverFront, "alice's Delver of Secrets has art").toMatch(/\/front\//);
    const delverBack = delverFront!.replace('/front/', '/back/');

    const endTurn = bob.page.locator('[data-testid="live-button-end-turn"]:enabled');
    await expect(endTurn, 'bob holds his own main phase').toHaveCount(1, { timeout: 60_000 });
    const endedAt = Date.now();
    await endTurn.click();
    console.log('[w69-backface] bob pressed End Turn');

    // Alice's upkeep: Delver looks at her top card (Lava Spike) and asks whether to reveal it.
    let transformedAt = 0;
    await expect
      .poll(
        async () => {
          if ((await confirmYes(alice.page).count()) > 0) {
            console.log(`[w69-backface] alice answers ${await confirmYes(alice.page).textContent()} to Delver's reveal`);
            await confirmYes(alice.page).click({ timeout: 2_000 });
          }
          const done = (await tile(alice.page, 'mine', 'Insectile Aberration').count()) > 0 && (await tile(bob.page, 'theirs', 'Insectile Aberration').count()) > 0;
          if (done && transformedAt === 0) transformedAt = Date.now();
          return done;
        },
        { timeout: 60_000, intervals: [250], message: "alice's Delver of Secrets transforms on both screens" },
      )
      .toBe(true);

    // The inspector, on each screen, over alice's Insectile Aberration: the recorder sees what it draws.
    for (const [name, page] of seats) {
      const box = (await tile(page, name === 'alice' ? 'mine' : 'theirs', 'Insectile Aberration').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await expect(page.locator('[data-inspect] .card__name'), `${name}'s inspector reads Insectile Aberration`).toHaveText('Insectile Aberration', { timeout: 5_000 });
      await page.waitForTimeout(300);
      await page.mouse.move(5, 5);
    }

    for (const [name, page] of seats) {
      const frames = await framesOf(page);
      const line = (f: Frame): string =>
        `${f.t - endedAt}ms ${f.faces.map((x) => `${x.where}:${x.name}${x.drawn ? '' : ' NO-ART'} ${x.src ?? 'no-img'}`).join(' + ')}`;
      for (const f of frames) console.log(`[w69-backface] ${name} ${line(f)}`);
      const noArt = frames.filter((f) => f.faces.some((x) => !x.drawn));
      console.log(`[w69-backface] ${name}: ${frames.length} frame(s), ${noArt.length} with a back face missing its art`);
      expect(noArt.map(line), `${name} sees a back face without its art`).toEqual([]);
      const insectile = frames.flatMap((f) => f.faces).filter((x) => x.name === 'Insectile Aberration');
      expect([...new Set(insectile.map((x) => x.where))].sort(), `${name} drew Insectile Aberration on the board and in the inspector`).toEqual(['inspector', name === 'alice' ? 'mine' : 'theirs'].sort());
      expect([...new Set(insectile.map((x) => x.src))], `${name} draws Insectile Aberration as Delver's back image`).toEqual([delverBack]);

      const warmed = asked.get(page)!.get(delverBack);
      console.log(`[w69-backface] ${name} asked for Insectile Aberration's art ${warmed === undefined ? 'never' : `${warmed - transformedAt}ms from the transform`}`);
      expect(warmed !== undefined && warmed < endedAt, `${name}'s page warmed Insectile Aberration's art before the turn that transforms it`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
