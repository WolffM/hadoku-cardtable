/**
 * An ability chip reads the ability's own text, not Forge's stack-instance notes.
 *
 * Forge's stack description for a trigger appends what its debug view tracks: "(Targeting: [[Lightning
 * Bolt (12)]])" for its targets, "[Zone Changer: Eternal Witness (40)]" for the card that triggered it,
 * "[Phase: Bella]" for a phase trigger (the operator's Delver screenshot). On a chip that made it
 * longer than the card's own text and showed internal ids. The chip reads the ability's own words
 * instead; its targets stay on the arrow and in its accessible name.
 *
 * Two triggers, both screens: Eternal Witness's (targets a card, a zone-change trigger) and Goblin
 * Rabblemaster's (a phase trigger). Each chip — and the inspector's enlarged copy — reads the ability's
 * text and none of Forge's notes.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, stackCount } from './play/board.ts';
import { chipOf, triggerOnStack } from './play/chip.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Forge's stack-instance notes: a targets list, a bracketed tracked object, a card's internal id. */
const NOTES = /Targeting:|Zone Changer|Phase:|\[|\]|\(\d+\)/;

/** Bob takes Full Control; both seats pass on an empty stack until Rabblemaster's combat trigger is a chip on both screens. */
async function phaseTriggerOnStack(alice: Page, bob: Page): Promise<void> {
  await bob.getByTestId('live-full-control').click();
  await expect(bob.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && ((await chipOf(alice).count()) === 0 || (await chipOf(bob).count()) === 0)) {
    for (const page of [alice, bob]) {
      if ((await stackCount(page)) === 0 && (await enabledOk(page).count()) > 0) await enabledOk(page).first().click().catch(() => undefined);
    }
    await alice.waitForTimeout(150);
  }
  await expect(chipOf(alice), 'alice sees the chip').toHaveCount(1, { timeout: 10_000 });
  await expect(chipOf(bob), 'bob sees the chip').toHaveCount(1, { timeout: 10_000 });
}

const CASES = [
  {
    name: 'witness',
    scenario: 'w67-trigger',
    reads: 'return target card from your graveyard to your hand',
    target: 'Lightning Bolt',
    onStack: (alice: Page, bob: Page) => triggerOnStack(alice, bob, 'Eternal Witness'),
  },
  {
    name: 'rabblemaster',
    scenario: 'w69-rabblemaster',
    reads: 'create a 1/1 red Goblin creature token with haste',
    target: null,
    onStack: phaseTriggerOnStack,
  },
] as const;

for (const c of CASES) {
  test(titled(`${c.name}: the ability chip reads the ability’s own text, without Forge’s stack notes, on both screens`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, c.scenario);
      await c.onStack(alice.page, bob.page);

      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const chip = chipOf(page);
        const text = ((await chip.locator('.placed__chip-text').textContent()) ?? '').trim();
        const name = ((await chip.locator('.placed__chip-name').textContent()) ?? '').trim();
        const label = (await chip.getAttribute('aria-label')) ?? '';
        console.log(`[w69-chip-text] ${c.name} ${who} band="${name}" text="${text}" label="${label}"`);
        expect(text, `${who}: the chip reads the ability’s own text`).toContain(c.reads);
        expect(text, `${who}: and none of Forge’s stack notes`).not.toMatch(NOTES);
        if (c.target !== null) expect(label, `${who}: the target is still named, on the chip’s accessible name`).toContain(`→ ${c.target}`);

        await chip.locator('.placed__chip-text').hover();
        const panel = page.locator('[data-inspect] [data-ability-chip] .placed__chip-text');
        await expect(panel, `${who}: hovering the chip opens the expanded view`).toHaveCount(1);
        const enlarged = ((await panel.textContent()) ?? '').trim();
        console.log(`[w69-chip-text] ${c.name} ${who} inspector text="${enlarged}"`);
        expect(enlarged, `${who}: the expanded view reads the same`).toBe(text);
        await page.mouse.move(2, 2);
      }
    } finally {
      await stack.stop();
    }
  });
}
