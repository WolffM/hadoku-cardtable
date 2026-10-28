/**
 * The operator, 2026-10-20, on Atraxa, Grand Unifier: *"would be much better if we just showed all 7
 * cards and let me pick all of them at once rather than one at a time"* and *"weird bug that it seems
 * to show a pill of the chosen card on top of atraxa after she resolves."*
 *
 * Atraxa's trigger is Forge's `RepeatEach` over the revealed cards' types, one `ChooseCard` per type
 * (`atraxa_grand_unifier.txt`). `ax-atraxa`: alice casts Atraxa and her top ten hold seven card types.
 * - The trigger is ONE sheet: all ten revealed cards, Hand and Bottom, the types as the hand's limits.
 *   Alice puts seven cards in hand, Ornithopter (an artifact creature) for its creature type beside
 *   Sol Ring for artifact; Llanowar Elves after them is refused (no type left for it). One answer, and
 *   no other question before the stack is empty; the seven are in her hand.
 * - Once Atraxa has resolved she wears no chosen-card tag, on both screens: the card her last
 *   `ChooseCard` set is that resolution's bookkeeping, nothing her abilities read.
 *
 * `[ax]` lines are the evidence. Needs a Forge build; without one this SKIPS and the title says why.
 * Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castAndPassUntil, enabledOk, livePrompt, makeTitled, offeredCard, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[ax] ${JSON.stringify({ step, data })}`);

const PICKS = ['Ornithopter', 'Sol Ring', 'Lightning Bolt', 'Divination', 'Pacifism', 'Forest', 'Jace Beleren'];
const ATRAXA = 'Atraxa, Grand Unifier';

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

/** Every tag and relation pill a board card wears, as `kind:text`. */
function pills(page: Page, id: number): Promise<string[]> {
  return page.evaluate(
    (cardId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-board-card="${cardId}"] [data-choice], [data-board-card="${cardId}"] [data-relation]`)).map(
        (t) => `${t.dataset.choice ?? t.dataset.relation}:${(t.textContent ?? '').trim()}`,
      ),
    id,
  );
}

/** The zones sheet's cards, zone by zone, by name. */
function sheetZones(page: Page): Promise<{ zones: Record<string, string[]>; types: { type: string; filled: boolean }[] }> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="live-prompt"]');
    const zones: Record<string, string[]> = {};
    for (const list of host?.querySelectorAll<HTMLElement>('[data-testid^="zone-"][data-zone]') ?? []) {
      if (list.dataset.testid === 'zone-library') continue;
      zones[list.dataset.zone ?? '?'] = Array.from(list.querySelectorAll<HTMLElement>(':scope > li')).map((li) => li.getAttribute('aria-label') ?? '');
    }
    const types = Array.from(host?.querySelectorAll<HTMLElement>('[data-testid="zone-type"]') ?? []).map((t) => ({ type: t.dataset.type ?? '', filled: t.hasAttribute('data-filled') }));
    return { zones, types };
  });
}

/** The method of the prompt open on `page` now, if any. */
const openMethod = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('[data-testid="live-prompt"]')?.getAttribute('data-method') ?? null);

test(titled("Atraxa's trigger is one sheet of the ten revealed cards, one per type, and she wears no chosen-card tag after it"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ax-atraxa');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    // Cast Atraxa and pass both seats' priority until her trigger asks alice.
    const asked = async (): Promise<boolean> => ['order', 'getChoices', 'chooseSingleEntityForEffect', 'chooseEntitiesForEffect'].includes((await openMethod(alice.page)) ?? '');
    const card = await offeredCard(alice.page, ATRAXA, { zone: 'hand', message: 'alice is offered Atraxa' });
    await castAndPassUntil([alice.page, bob.page], stack, card, [], asked);
    const first = await openMethod(alice.page);
    log('asked', { method: first, says: await says(alice.page) });
    expect(await asked(), "Atraxa's trigger asks alice").toBe(true);

    let questions = 1;
    if (first === 'order') {
      const sheet = livePrompt(alice.page);
      const before = await sheetZones(alice.page);
      log('sheet', before);
      expect(Object.values(before.zones).flat().sort(), 'the sheet shows every revealed card').toEqual(
        [...PICKS, 'Llanowar Elves', 'Island', 'Shock'].sort(),
      );
      expect(before.types.map((t) => t.type).sort(), 'the types are the hand’s limits').toEqual(
        ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery'],
      );
      const card = (name: string) => sheet.locator(`[data-testid="zone-source"] > li[aria-label="${name}"]`);
      for (const name of PICKS) {
        await card(name).click();
        await expect(sheet.locator(`[data-testid="zone-dest"] > li[aria-label="${name}"]`), `${name} moves to Hand`).toHaveCount(1);
      }
      await card('Llanowar Elves').click();
      const after = await sheetZones(alice.page);
      log('picked', after);
      expect(after.zones.hand?.sort(), 'Llanowar Elves is refused: no type is left for it').toEqual([...PICKS].sort());
      expect(after.types.every((t) => t.filled), 'every type is filled').toBe(true);
      await sheet.getByTestId('prompt-submit').click();
    } else {
      expect.soft(first, 'the trigger is one sheet, not a question per type').toBe('order');
    }

    // Drain: any further question is one more than the one sheet.
    const drainEnd = Date.now() + 60_000;
    while (Date.now() < drainEnd) {
      if ((await stackCount(alice.page)) === 0 && (await openMethod(alice.page)) === null) break;
      const answered = await answerPrompt(alice.page);
      if (answered !== null) {
        questions += 1;
        log('another question', answered);
      }
      for (const p of [alice.page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && (await openMethod(p)) === null) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(150);
    }
    log('questions', { questions });
    expect.soft(questions, 'the trigger asked alice once').toBe(1);

    if (first === 'order') {
      const hand = await alice.page
        .locator('[data-zone="hand"][data-owner="you"] [data-board-card] .card__name')
        .allTextContents();
      log('hand', hand);
      expect(hand.map((n) => n.trim()).sort(), 'the seven picked cards are in alice’s hand').toEqual([...PICKS].sort());
    }

    for (const [who, page, owner] of [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const) {
      const atraxa = await battlefieldNamed(page, owner, ATRAXA);
      let seen: string[] = [];
      try {
        await page.waitForTimeout(500);
        seen = await pills(page, atraxa);
      } finally {
        log(`atraxa pills (${who})`, { atraxa, seen });
      }
      expect(seen, `${who}: Atraxa wears no leftover pill once she has resolved`).toEqual([]);
    }
  } finally {
    await stack.stop();
  }
});
