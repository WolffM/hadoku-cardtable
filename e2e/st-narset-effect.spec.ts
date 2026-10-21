/**
 * The operator, 2026-10-13: *"indicator for active affect of narset -2 effect. not sure the best way
 * to do it, but maybe on a black chip on the planes walker? either that or we can leave the ability
 * chip on the board until it gets consumed."*
 *
 * Narset Transcendent's -2 is a Forge `DelayedTrigger` hosted by Narset: *"When you cast your next
 * instant or sorcery spell from your hand this turn, it gains rebound."* Once the ability resolves it
 * is on no stack and on no card — it waits inside Forge's trigger handler until Opt is cast.
 *
 * Alice activates the -2. Narset then wears an effect tag in her tag column, on both screens, whose
 * tip says what is waiting; casting Opt uses it up and the tag goes.
 *
 * Scenario: `st-narset-effect`. Every step prints one `[st]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, clickPermanent, handCardNamed, makeTitled, passOverStack, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[st] ${JSON.stringify({ step, data })}`);

const WAITING = /When you cast your next instant or sorcery spell from your hand this turn, it gains rebound/;

/** The permanent named `name` on `owner`'s battlefield, by id. */
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

/** Each effect tag a card wears: its tip and its background. */
function effectTags(page: Page, id: number): Promise<{ tip: string; background: string }[]> {
  return page.evaluate(
    (cardId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-board-card="${cardId}"] > .board-card__tags > [data-effect]`)).map((t) => ({
        tip: t.dataset.tip ?? '',
        background: getComputedStyle(t).backgroundColor,
      })),
    id,
  );
}

test(titled('a delayed effect waits on its source as a tag: Narset’s -2 on Narset until the next instant uses it, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'st-narset-effect');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const screens = [
      ['alice', alice.page, 'you'],
      ['bob', bob.page, 'them'],
    ] as const;

    const narset = await battlefieldNamed(alice.page, 'you', 'Narset Transcendent');
    for (const [who, page, owner] of screens) {
      const id = await battlefieldNamed(page, owner, 'Narset Transcendent');
      expect(await effectTags(page, id), `${who}: nothing waits on Narset yet`).toEqual([]);
    }

    // The -2, picked from Narset's three loyalty abilities.
    expect(await clickPermanent(alice.page, narset), 'Narset is offered').toBe(true);
    const minusTwo = alice.page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: 'next instant or sorcery' });
    await expect(minusTwo, 'the -2 is among her abilities').toHaveCount(1, { timeout: 15_000 });
    await minusTwo.click();
    // Paid and resolved: nobody holds priority over a loyalty ability here, so it can be on and off
    // the stack between two polls — Narset's loyalty, 6 less 2, is the durable sign. Both pass if asked.
    const loyalty = alice.page.locator(`[data-board-card="${narset}"] > .board-card__face .card__stat`);
    await expect
      .poll(
        async () => {
          for (const p of [alice.page, bob.page]) await passOverStack(p);
          return `${(await loyalty.textContent())?.trim()} | stack ${await stackCount(alice.page)}`;
        },
        { timeout: 30_000, message: 'the -2 resolved' },
      )
      .toBe('4 | stack 0');

    for (const [who, page, owner] of screens) {
      const id = await battlefieldNamed(page, owner, 'Narset Transcendent');
      let seen: Awaited<ReturnType<typeof effectTags>> = [];
      try {
        await expect.poll(async () => (seen = await effectTags(page, id)).length, { timeout: 15_000, message: `${who}: Narset wears what her -2 left waiting` }).toBe(1);
      } finally {
        log(`after the -2 (${who})`, { id, seen });
      }
      expect(seen[0]!.tip, `${who}: the tip says what is waiting`).toMatch(WAITING);
    }

    // Opt, cast from her hand: the effect is used up.
    const opt = await handCardNamed(alice.page, 'Opt');
    expect(opt, 'Opt is in alice’s hand').not.toBeUndefined();
    const field = (await alice.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
    await castByDrag(alice.page, stack, opt!, { x: Math.round(field.x + field.width * 0.6), y: Math.round(field.y + field.height * 0.5) });
    for (const [who, page, owner] of screens) {
      const id = await battlefieldNamed(page, owner, 'Narset Transcendent');
      let seen: Awaited<ReturnType<typeof effectTags>> = [];
      try {
        await expect.poll(async () => (seen = await effectTags(page, id)).length, { timeout: 15_000, message: `${who}: the effect is used up once Opt is cast` }).toBe(0);
      } finally {
        log(`after Opt (${who})`, { id, seen });
      }
    }
  } finally {
    await stack.stop();
  }
});
