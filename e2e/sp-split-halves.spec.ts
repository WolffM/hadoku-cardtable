/**
 * The operator, 2026-10-19: "'Choose a face' doesn't work well when picking between split cards. i see
 * the entire split card in both choices so i can't really tell which one is wish. Is there a way we can
 * just show the 'half' of each card on both sides?"
 *
 * Scenario `split-halves`: alice holds Fire // Ice, Wear // Tear (fuse), Bonecrusher Giant (an
 * adventure), Unholy Annex // Ritual Chamber (a room) and Cut // Ribbons (aftermath). Selecting each of
 * the first four offers its faces side by side; every face printed on the card's one image shows only
 * its own part of it (`data-face-crop`), turned upright, and fuse's "both halves" is the whole card.
 * Hovering Cut // Ribbons and turning the wheel shows each aftermath half the same way.
 *
 * Every step prints one `[sp]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[sp] ${JSON.stringify({ step, data })}`);

interface DrawnFace {
  face: string | null;
  crop: string | null;
  turn: string | null;
}

/** Select `name` in alice's hand, read the faces it offers, and answer None. */
async function facesOf(page: Page, name: string): Promise<DrawnFace[]> {
  const id = await handCardNamed(page, name);
  expect(id, `${name} is in alice’s hand`).not.toBeUndefined();
  await clickHandCard(page, id!);
  const faces = page.getByTestId('prompt-face');
  await expect(faces.first(), `${name}: its faces are offered`).toBeVisible({ timeout: 20_000 });
  const drawn = await faces.evaluateAll((els) =>
    els.map((e) => ({
      face: e.getAttribute('data-face'),
      crop: e.querySelector('.card')?.getAttribute('data-face-crop') ?? null,
      turn: e.querySelector<HTMLImageElement>('img.card__art')?.style.transform || null,
    })),
  );
  log(name, drawn);
  await page.getByTestId('prompt-cancel').click();
  await expect(faces, `${name}: None closes the offer`).toHaveCount(0, { timeout: 20_000 });
  return drawn;
}

test(titled('a split card’s faces are offered as its own halves, upright; an adventure as its own inset'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'split-halves');
    const page = alice.page;

    expect(await facesOf(page, 'Fire // Ice')).toEqual([
      { face: 'Fire', crop: 'split-left', turn: 'rotate(90deg)' },
      { face: 'Ice', crop: 'split-right', turn: 'rotate(90deg)' },
    ]);

    const fuse = await facesOf(page, 'Wear // Tear');
    expect(new Map(fuse.map((f) => [f.face, f.crop])), 'each half its own; both halves the whole card').toEqual(
      new Map([
        ['Wear', 'split-left'],
        ['Tear', 'split-right'],
        ['Wear // Tear', null],
      ]),
    );

    expect(await facesOf(page, 'Bonecrusher Giant')).toEqual([
      { face: 'Bonecrusher Giant', crop: null, turn: null },
      { face: 'Stomp', crop: 'adventure', turn: 'rotate(0deg)' },
    ]);

    expect((await facesOf(page, 'Unholy Annex // Ritual Chamber')).map((f) => [f.face, f.crop])).toEqual([
      ['Unholy Annex', 'split-left'],
      ['Ritual Chamber', 'split-right'],
    ]);

    // Aftermath, on the inspector's wheel: the same crop the picker draws.
    const cut = await handCardNamed(page, 'Cut // Ribbons');
    expect(cut, 'Cut // Ribbons is in alice’s hand').not.toBeUndefined();
    await page.locator(`[data-board-card="${cut}"]`).hover();
    await expect(page.locator('[data-inspect]')).toBeVisible();
    const shown = () =>
      page.locator('[data-inspect] .card').evaluate((e) => ({
        face: e.querySelector('.card__name')?.textContent ?? null,
        crop: e.getAttribute('data-face-crop'),
        turn: e.querySelector<HTMLImageElement>('img.card__art')?.style.transform || null,
      }));
    const seen = [await shown()];
    for (let i = 0; i < 2; i += 1) {
      await page.mouse.wheel(0, 120);
      seen.push(await shown());
    }
    log('wheel', seen);
    expect(seen).toEqual([
      { face: 'Cut // Ribbons', crop: null, turn: null },
      { face: 'Cut', crop: 'aftermath-top', turn: 'rotate(0deg)' },
      { face: 'Ribbons', crop: 'aftermath-bottom', turn: 'rotate(-90deg)' },
    ]);
  } finally {
    await stack.stop();
  }
});
