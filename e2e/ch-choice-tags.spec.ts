/**
 * The operator, 2026-10-12: *"selected a color on prism ring. the selected color should be visible
 * on the card as a tag. … any card that selects a color or makes a decision that becomes a permanent
 * thing about it on the battlefield should recieve a visual indicator."*
 *
 * Alice casts Prism Ring and picks blue, then Pithing Needle and names Llanowar Elves. Each permanent
 * wears what was chosen, on both screens, in the card's top-right tag column: the colour as its mana
 * symbol, the name as words, and the hover tip says what was chosen. Two different choice kinds
 * (Forge's `ChosenColors` and `NamedCard`) through the one tag renderer.
 *
 * Scenario: `ch-choice-tags`. Every step prints one `[ch]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, livePrompt, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const FORMAT = 'legacy-2005-08-20';
const log = (step: string, data: unknown): void => console.log(`[ch] ${JSON.stringify({ step, data })}`);

/** The battlefield permanent named `name` on `owner`'s side, by id. */
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

/** Each choice tag a card wears: its kind, visible text, mana glyph classes and tip. */
function choiceTags(page: Page, id: number): Promise<{ kind: string; text: string; glyph: string; tip: string }[]> {
  return page.evaluate(
    (cardId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-board-card="${cardId}"] > .board-card__tags > [data-choice]`)).map((t) => ({
        kind: t.dataset.choice ?? '',
        text: (t.textContent ?? '').trim(),
        glyph: Array.from(t.querySelectorAll('.ms')).map((g) => g.className).join(' '),
        tip: t.dataset.tip ?? '',
      })),
    id,
  );
}

/** Cast `name` from alice's hand and pass both seats' priority until `asked` shows on her screen. */
async function castUntilAsked(alice: Page, bob: Page, name: string, asked: () => Promise<boolean>): Promise<void> {
  await expect.poll(() => offeredNamed(alice, name), { timeout: 45_000, message: `alice is offered ${name}` }).not.toBeUndefined();
  await clickHandCard(alice, (await offeredNamed(alice, name))!);
  const deadline = Date.now() + 90_000;
  while (!(await asked()) && Date.now() < deadline) {
    await pressPaymentAuto(alice);
    if (await asked()) break;
    for (const p of [alice, bob]) {
      const ok = enabledOk(p).first();
      if ((await ok.count()) > 0 && !(await asked())) await ok.click({ timeout: 1_000 }).catch(() => undefined);
    }
    await alice.waitForTimeout(100);
  }
  log(`${name} asked`, { asked: await asked(), method: await livePrompt(alice).first().getAttribute('data-method').catch(() => null), says: await says(alice) });
  expect(await asked(), `${name}: Forge asks alice its choice`).toBe(true);
}

test(titled('a permanent wears what was chosen for it: Prism Ring its colour, Pithing Needle its name, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ch-choice-tags', { format: FORMAT });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    // Prism Ring: the colour ask, answered blue.
    const blue = livePrompt(alice.page).getByRole('checkbox', { name: /^blue$/i });
    await castUntilAsked(alice.page, bob.page, 'Prism Ring', async () => (await blue.count()) > 0);
    await blue.first().dispatchEvent('click');
    await livePrompt(alice.page).getByTestId('prompt-submit').click();
    await expect(livePrompt(alice.page), 'the colour ask closed once answered').toHaveCount(0, { timeout: 15_000 });

    for (const [who, page, owner] of [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const) {
      const ring = await battlefieldNamed(page, owner, 'Prism Ring');
      let seen: Awaited<ReturnType<typeof choiceTags>> = [];
      try {
        await expect
          .poll(async () => (seen = await choiceTags(page, ring)).map((t) => t.kind), { timeout: 15_000, message: `${who}: Prism Ring wears its chosen colour` })
          .toEqual(['color']);
      } finally {
        log(`prism ring (${who})`, { ring, seen });
      }
      expect(seen[0]!.glyph, `${who}: the colour is drawn as its mana symbol`).toMatch(/\bms-u\b/);
      expect(seen[0]!.tip, `${who}: the tip says what was chosen`).toBe('Chosen colour: Blue');
    }

    // Pithing Needle: the name ask, answered Llanowar Elves.
    const search = alice.page.getByTestId('prompt-name-search');
    await castUntilAsked(alice.page, bob.page, 'Pithing Needle', async () => (await search.count()) > 0);
    await search.pressSequentially('llanowar elves');
    const options = alice.page.getByTestId('prompt-name-option');
    await expect(options.first(), 'the picker finds it').toHaveText('Llanowar Elves').catch(async (e: unknown) => {
      log('name options', await options.allTextContents());
      throw e;
    });
    await search.press('Enter');
    await expect(livePrompt(alice.page), 'the name ask closed once answered').toHaveCount(0, { timeout: 15_000 });

    for (const [who, page, owner] of [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const) {
      const needle = await battlefieldNamed(page, owner, 'Pithing Needle');
      let seen: Awaited<ReturnType<typeof choiceTags>> = [];
      try {
        await expect
          .poll(async () => (seen = await choiceTags(page, needle)), { timeout: 15_000, message: `${who}: Pithing Needle wears the name chosen` })
          .toEqual([{ kind: 'card', text: 'Llanowar Elves', glyph: '', tip: 'Named card: Llanowar Elves' }]);
      } finally {
        log(`pithing needle (${who})`, { needle, seen });
      }
    }
  } finally {
    await stack.stop();
  }
});
