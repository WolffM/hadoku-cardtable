/**
 * The operator, 2026-10-20 (match m-b752a3424b43): *"why is my tinker not resolving?"* — *"that
 * question never popped up on my screen"*, and after a refresh it did.
 *
 * Tinker: "As an additional cost to cast this spell, sacrifice an artifact. Search your library for an
 * artifact card, put that card onto the battlefield, then shuffle." Forge takes the {2}{U} first — the
 * server presses Auto for it — and then asks which artifact to sacrifice, before the spell is on the
 * stack. In the live game the server sent that question (the run dir's stream has it: `setSelectables`
 * [Mishra's Bauble], `tempShowZones`, "Select artifact to sacrifice (1 left)", OK off) and the board drew
 * nothing until a reload.
 *
 * Scenario `tk-tinker`: alice holds Tinker, three Islands and Mishra's Bauble; Blightsteel Colossus is on
 * top of her library. `tk-tinker-bauble`: the Bauble is in her hand instead, and she casts it and then
 * Tinker the moment it lands — the live game's order (0.6 s apart). Either way her screen shows the
 * sacrifice the moment Forge asks it, the Bauble is offered, and once she picks it Tinker resolves and the
 * Colossus enters.
 *
 * `[tk]` lines are the evidence: what her screen says and offers while Forge waits on the sacrifice.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { answerPrompt } from './play/prompts.ts';
import { boardCard, clickHandCard, handCardNamed, isOffered, makeTitled, offered, ownNamed, pressOffered, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The pop-up a decision draws (the selection sheet, or the decision area's own), or null when none is. */
async function popup(page: Page): Promise<string | null> {
  for (const id of ['live-selection-host', 'live-decision-host']) {
    const host = page.getByTestId(id);
    if ((await host.count()) > 0 && (await host.first().isVisible())) return `${id}: ${((await host.first().textContent()) ?? '').replace(/\s+/g, ' ').trim()}`;
  }
  return null;
}

/** What the board draws of the open decision: the line, the pop-up, the offered cards, any prompt sheet. */
async function drawn(page: Page): Promise<string> {
  const sheets = await page.getByTestId('live-prompt').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-method') ?? ''}#${e.getAttribute('data-call-id') ?? ''}`));
  return `says="${(await says(page)).replace(/\s+/g, ' ')}" popup=${JSON.stringify(await popup(page))} offered=${JSON.stringify(await offered(page))} sheets=${JSON.stringify(sheets)}`;
}

for (const { scenario, board } of [
  { scenario: 'tk-tinker', board: 'the Bauble already out' },
  { scenario: 'tk-tinker-bauble', board: 'the Bauble cast just before' },
]) test(titled(`Tinker: the sacrifice is on screen the moment Forge asks it, and picking the Bauble resolves Tinker (${board})`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, scenario);
    const page = alice.page;
    await expect.poll(() => handCardNamed(page, 'Tinker'), { timeout: 30_000, message: 'alice holds Tinker' }).not.toBeUndefined();
    const tinker = (await handCardNamed(page, 'Tinker'))!;
    const inHand = await handCardNamed(page, "Mishra's Bauble");
    if (inHand !== undefined) {
      await expect.poll(() => offered(page), { timeout: 45_000, message: 'the Bauble is offered' }).toContain(inHand);
      expect(await clickHandCard(page, inHand), 'the Bauble lifted and cast').toBe(true);
      await expect.poll(() => ownNamed(page, "Mishra's Bauble"), { timeout: 20_000, message: 'the Bauble landed' }).toHaveLength(1);
    }
    const [bauble] = await ownNamed(page, "Mishra's Bauble");
    expect(bauble, "alice has her Mishra's Bauble").not.toBeUndefined();
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Tinker is offered' }).toContain(tinker);

    expect(await clickHandCard(page, tinker), 'Tinker lifted and cast').toBe(true);

    // Forge asks the sacrifice once the mana is paid; the server's own log says when.
    await expect
      .poll(() => serverLog(stack).some((r) => r.evt === 'auto-paid' && r.seat === 0 && r.cost === '{2}{U}'), { timeout: 20_000, message: 'the {2}{U} paid for her' })
      .toBe(true);
    await expect
      .poll(() => isOffered(page, bauble!), { timeout: 10_000, message: `the sacrifice is on screen — ${await drawn(page)}` })
      .toBe(true);
    console.log(`[tk] sacrifice asked: ${await drawn(page)}`);
    expect(await says(page), 'the board words the sacrifice').toMatch(/sacrifice/i);
    // The question pops up as every decision does — the operator: "that question never popped up on my screen".
    await expect.poll(() => popup(page), { timeout: 5_000, message: `the sacrifice pops up — ${await drawn(page)}` }).toMatch(/sacrifice/i);

    expect(await pressOffered(boardCard(page, bauble!)), 'alice picks the Bauble').toBe(true);
    // The search: one artifact in the library, picked by the prompt's own default.
    await expect
      .poll(
        async () => {
          await answerPrompt(page);
          return (await ownNamed(page, 'Blightsteel Colossus')).length;
        },
        { timeout: 30_000, message: `Tinker resolved — ${await drawn(page)}` },
      )
      .toBe(1);
    expect(await stackCount(page), 'the stack is empty').toBe(0);
    expect(await ownNamed(page, "Mishra's Bauble"), 'the Bauble was sacrificed').toHaveLength(0);
  } finally {
    await stack.stop();
  }
});
