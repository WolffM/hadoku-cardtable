/**
 * A modal spell on the stack draws its arrows on both screens (the operator, 2026-10-11, with a
 * screenshot: "izzet charm should have produced an arrow here targeting muddle the mixture, but it
 * didn't. why was the arrow not drawn?").
 *
 * A charm or a Command keeps each chosen mode's targets one `SubInstance` down from the stack item
 * Forge publishes (`CharmEffect.chainAbilities`); the item itself targets nothing. Both tests read
 * the arrows `live/placed.ts` draws (`[data-testid="placed-arrow"]`, keyed `from:kind:to`).
 *
 * 1. `modal-charm`: alice casts Ponder, bob answers with Izzet Charm's counter mode — the charm's
 *    arrow to Ponder, on alice's screen and on bob's.
 * 2. `modal-command`: alice casts Kolaghan's Command, its two legal modes 2 damage at bob's Grizzly
 *    Bears and bob discards — one arrow to the Bears and one to bob, on both screens.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickOnce, handCardNamed, makeTitled, offered, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The opponent's battlefield card named `name`, on `page`. */
async function theirBattlefieldCard(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** Every arrow key `page` draws, for the evidence line. */
const arrowKeys = (page: Page): Promise<string[]> =>
  page.locator('[data-testid="placed-arrow"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key') ?? ''));

/** Lift a targeted hand card and release it over the battlefield by raw mouse events (`w49-counterspell.spec.ts`'s own gesture). */
async function liftAndRelease(page: Page, cardId: number): Promise<void> {
  const castLift = (): Promise<string | null> => page.locator(`[data-board-card="${cardId}"]`).getAttribute('data-cast-lift').catch(() => null);
  for (let i = 0; i < 8 && (await castLift()) !== 'parked'; i++) {
    if (i > 0) await page.waitForTimeout(250);
    const btnBox = await page.locator(`[data-board-card="${cardId}"] button`).first().boundingBox();
    if (btnBox === null) continue;
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    if ((await castLift()) !== 'lifted') continue;
    const bf = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
    if (bf !== null) await page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
  }
  expect(await castLift(), `card ${cardId} is parked — the cast actually went out`).toBe('parked');
}

/** Tick the `getChoices` row whose text matches `label` and submit it; `false` when no such row is showing. */
async function chooseRow(page: Page, label: RegExp): Promise<boolean> {
  const prompt = page.locator('section[data-prompt="getChoices"]');
  const item = prompt.locator('li', { hasText: label }).first();
  if ((await item.count()) === 0) return false;
  const checkbox = item.locator('input[type="checkbox"]');
  if ((await checkbox.count()) > 0 && !(await checkbox.isChecked().catch(() => true))) await item.locator('label').click().catch(() => undefined);
  const submit = prompt.locator('[data-testid="prompt-submit"]');
  if ((await submit.count()) > 0 && (await submit.isEnabled().catch(() => false))) await submit.click().catch(() => undefined);
  return true;
}

test.describe(titled('a modal spell draws its arrows'), () => {
  test('Izzet Charm countering a spell draws its arrow to that spell on both screens', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'modal-charm');
      const { alice, bob } = seated;
      for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });

      // Full control for alice: she holds priority with both spells on the stack, so neither resolves before the read.
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      let ponder: number | undefined;
      await expect.poll(async () => (ponder = await handCardNamed(alice.page, 'Ponder')), { timeout: 30_000, message: 'Ponder is in alice’s hand' }).not.toBeUndefined();
      await liftAndRelease(alice.page, ponder!);
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (await answerLoneAbility(alice.page)) return stackCount(alice.page);
            if (!(await pressPaymentAuto(alice.page)) && /Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
            return stackCount(alice.page);
          },
          { timeout: 20_000, message: 'Ponder reached the stack' },
        )
        .toBe(1);
      await expect
        .poll(async () => (/^Priority:/.test(await says(alice.page)) ? await clickOnce(alice.page, await says(alice.page), 'ok') : false), {
          timeout: 10_000,
          message: 'alice passes priority on her own Ponder',
        })
        .toBe(true);

      const charm = await handCardNamed(bob.page, 'Izzet Charm');
      expect(charm, 'Izzet Charm is in bob’s hand').not.toBeUndefined();
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered Izzet Charm' }).toContain(charm);
      await liftAndRelease(bob.page, charm!);
      // The mode is bob's one question; Ponder is the counter's only legal target, so that ask answers itself.
      await expect
        .poll(
          async () => {
            const text = await says(bob.page);
            if (await chooseRow(bob.page, /Counter target noncreature spell/i)) return stackCount(bob.page);
            if (await answerLoneAbility(bob.page)) return stackCount(bob.page);
            if (!(await pressPaymentAuto(bob.page)) && /Pay Mana Cost/i.test(text)) await clickOnce(bob.page, text, 'ok');
            return stackCount(bob.page);
          },
          { timeout: 30_000, message: 'Izzet Charm reached the stack' },
        )
        .toBe(2);

      for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const charmItem = page.locator('[data-stack-id][aria-label*="Izzet Charm"]');
        const ponderItem = page.locator('[data-stack-id][aria-label*="Ponder"]');
        await expect(charmItem, `${name}: Izzet Charm is on the stack`).toHaveCount(1, { timeout: 10_000 });
        await expect(ponderItem, `${name}: Ponder is still on the stack`).toHaveCount(1);
        const key = `${await charmItem.getAttribute('data-stack-id')}:stack:${await ponderItem.getAttribute('data-stack-id')}`;
        const drawn = await page
          .locator(`[data-testid="placed-arrow"][data-key="${key}"]`)
          .waitFor({ timeout: 10_000 })
          .then(() => true, () => false);
        console.log(`[modal-arrows] charm ${name}: want ${key} drawn=${drawn} arrows=[${(await arrowKeys(page)).join(' ')}]`);
        expect(drawn, `${name}: Izzet Charm draws its arrow to Ponder, the spell it counters`).toBe(true);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });

  test('Kolaghan’s Command draws one arrow per chosen mode’s target — the creature and the player — on both screens', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'modal-command');
      const { alice, bob } = seated;
      for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });

      // Full control for bob: he holds priority over alice's Command, so it does not resolve before the read.
      await bob.page.getByTestId('live-full-control').click();
      await expect(bob.page.getByTestId('live-full-control'), 'full control is on for bob').toHaveAttribute('aria-pressed', 'true');

      const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
      const bobId = await bobFace.getAttribute('data-player-id');
      let bears: number | undefined;
      await expect.poll(async () => (bears = await theirBattlefieldCard(alice.page, 'Grizzly Bears')), { timeout: 30_000, message: 'bob’s Grizzly Bears are on the battlefield' }).not.toBeUndefined();
      let command: number | undefined;
      await expect.poll(async () => (command = await handCardNamed(alice.page, "Kolaghan's Command")), { timeout: 30_000, message: 'the Command is in alice’s hand' }).not.toBeUndefined();
      await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'alice is offered the Command' }).toContain(command);

      await liftAndRelease(alice.page, command!);
      // Its two legal modes are both taken; each asks for its own target: the Bears when they are offered, else bob.
      const answered: string[] = [];
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if ((await offered(alice.page)).includes(bears!)) {
              await alice.page.locator(`[data-board-card="${bears}"]`).click().catch(() => undefined);
              answered.push('bears');
            } else if (/target/i.test(text) && !/Pay Mana Cost/i.test(text)) {
              await bobFace.click().catch(() => undefined);
              answered.push('bob');
            } else if (!(await pressPaymentAuto(alice.page)) && /Pay Mana Cost/i.test(text)) {
              await clickOnce(alice.page, text, 'ok');
            }
            return stackCount(alice.page);
          },
          { timeout: 30_000, message: 'the Command reached the stack' },
        )
        .toBe(1);
      console.log(`[modal-arrows] command answers: ${answered.join(' ')}`);

      for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const item = page.locator('[data-stack-id][aria-label*="Kolaghan"]');
        await expect(item, `${name}: the Command is on the stack`).toHaveCount(1, { timeout: 10_000 });
        const id = await item.getAttribute('data-stack-id');
        const want = [`${id}:card:${bears}`, `${id}:player:${bobId}`];
        const drawn = await expect
          .poll(async () => {
            const keys = await arrowKeys(page);
            return want.every((k) => keys.includes(k));
          }, { timeout: 10_000 })
          .toBe(true)
          .then(() => true, () => false);
        console.log(`[modal-arrows] command ${name}: want [${want.join(' ')}] drawn=${drawn} arrows=[${(await arrowKeys(page)).join(' ')}]`);
        expect(drawn, `${name}: the Command draws an arrow to the Bears and one to bob`).toBe(true);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });
});
