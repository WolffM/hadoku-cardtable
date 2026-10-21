/**
 * The operator, 2026-10-20 (match m-b752a3424b43): *"why is my tinker not resolving?"* — *"that
 * question never popped up on my screen"*, and after a refresh it did.
 *
 * Tinker: "As an additional cost to cast this spell, sacrifice an artifact. Search your library for an
 * artifact card, put that card onto the battlefield, then shuffle." Forge asks which artifact to
 * sacrifice first (a cost's sacrifice is chosen before the targets and the mana), then takes the {2}{U} —
 * the server presses Auto for it. In the live game, when the mana still came first, the server sent that
 * question (the run dir's stream has it: `setSelectables`
 * [Mishra's Bauble], `tempShowZones`, "Select artifact to sacrifice (1 left)", OK off) and the board drew
 * nothing until a reload.
 *
 * And on the same question: *"it's a bad question because there is only one target"* — the ruling: *"yes,
 * auto-pick the only legal sacrifice, bone shards too."*
 *
 * Scenario `tk-tinker-two`: alice holds Tinker and has three Islands, Mishra's Bauble and Ornithopter out;
 * Blightsteel Colossus is on top of her library. Her screen shows the sacrifice the moment Forge asks it,
 * both artifacts are offered, and once she picks the Bauble Tinker resolves and the Colossus enters.
 *
 * Scenario `tk-tinker`: the Bauble is her only artifact. `tk-tinker-bauble`: the Bauble is in her hand
 * instead, and she casts it and then Tinker the moment it lands — the live game's order (0.6 s apart).
 * Either way the server takes the Bauble as the sacrifice (`auto-picked`, "the only legal sacrifice"), it
 * is never offered and nothing pops up, and Tinker resolves.
 *
 * `[tk]` lines are the evidence: what her screen says and offers while Forge waits on the sacrifice.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { answerPrompt } from './play/prompts.ts';
import { boardCard, clickHandCard, drawnText, handCardNamed, isOffered, makeTitled, offered, ownNamed, pressOffered, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The pop-up a decision draws (the selection sheet, or the decision area's own), or null when none is. */
async function popup(page: Page): Promise<string | null> {
  for (const id of ['live-selection-host', 'live-decision-host']) {
    const text = await drawnText(page, id);
    if (text !== null) return `${id}: ${text}`;
  }
  return null;
}

/** What the board draws of the open decision: the line, the pop-up, the offered cards, any prompt sheet. */
async function drawn(page: Page): Promise<string> {
  const sheets = await page.getByTestId('live-prompt').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-method') ?? ''}#${e.getAttribute('data-call-id') ?? ''}`));
  return `says="${(await says(page)).replace(/\s+/g, ' ')}" popup=${JSON.stringify(await popup(page))} offered=${JSON.stringify(await offered(page))} sheets=${JSON.stringify(sheets)}`;
}

/**
 * Alice's Tinker, cast from her hand once any Bauble in her hand has been cast and landed: her Bauble's
 * id, and how long the server's log was just before the Tinker click.
 */
async function castTinker(page: Page, stack: { serverLogFile: string }): Promise<{ bauble: number; from: number }> {
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
  const from = serverLog(stack).length;
  expect(await clickHandCard(page, tinker), 'Tinker lifted and cast').toBe(true);
  return { bauble: bauble!, from };
}

/** The selections put on alice's wire from log row `from` on (the probe trace's `wire-frame` rows), up to row `to`. */
const selectionsSent = (stack: { serverLogFile: string }, from: number, to?: number): number =>
  serverLog(stack)
    .slice(from, to)
    .filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'setSelectables').length;

/** The search: one artifact in the library, picked by the prompt's own default; then Tinker is done. */
async function resolves(page: Page): Promise<void> {
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
}

test(titled('Tinker with two artifacts: the sacrifice is on screen the moment Forge asks it, and picking the Bauble resolves Tinker'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'tk-tinker-two');
    const page = alice.page;
    const [thopter] = await ownNamed(page, 'Ornithopter');
    expect(thopter, 'alice has her Ornithopter').not.toBeUndefined();
    const { bauble, from } = await castTinker(page, stack);

    // Forge asks the sacrifice first, before it takes the mana.
    await expect
      .poll(() => isOffered(page, bauble), { timeout: 20_000, message: `the sacrifice is on screen — ${await drawn(page)}` })
      .toBe(true);
    const paidForHer = () => serverLog(stack).some((r) => r.evt === 'auto-paid' && r.seat === 0 && r.cost === '{2}{U}');
    expect(paidForHer(), 'the sacrifice is asked before the mana is taken').toBe(false);
    expect(await isOffered(page, thopter!), 'the Ornithopter is offered too').toBe(true);
    // Forge sends the question's words after the offer (`setSelectables`, then `tempShowZones` answered by
    // this screen, then the prompt): wait for the words, not one read taken between the two.
    await expect.poll(() => says(page), { timeout: 5_000, message: `the board words the sacrifice — ${await drawn(page)}` }).toMatch(/sacrifice/i);
    console.log(`[tk] sacrifice asked: ${await drawn(page)}`);
    // The question pops up as every decision does — the operator: "that question never popped up on my screen".
    await expect.poll(() => popup(page), { timeout: 5_000, message: `the sacrifice pops up — ${await drawn(page)}` }).toMatch(/sacrifice/i);
    // What the board drew reaches the match's log, so a live game's missing pop-up is read from it.
    await expect
      .poll(() => serverLog(stack).find((r) => r.evt === 'client' && r.seat === 0 && r.what === 'pick-drawn' && r.at === '3s'), { timeout: 10_000, message: 'the pick is recorded' })
      .toMatchObject({ selection: 'on-board', popup: true, host: expect.stringMatching(/^selection@/) });

    expect(await pressOffered(boardCard(page, bauble)), 'alice picks the Bauble').toBe(true);
    await expect.poll(paidForHer, { timeout: 20_000, message: 'the {2}{U} paid for her' }).toBe(true);
    await resolves(page);
    expect(await ownNamed(page, 'Ornithopter'), 'the Ornithopter stayed').toHaveLength(1);
    expect(selectionsSent(stack, from), 'the sacrifice reached her wire as a selection').toBeGreaterThan(0);
    expect(serverLog(stack).filter((r) => r.evt === 'auto-picked' && r.seat === 0), 'no pick was made for her').toEqual([]);
  } finally {
    await stack.stop();
  }
});

for (const { scenario, board, ai } of [
  { scenario: 'tk-tinker', board: 'the Bauble already out', ai: false },
  { scenario: 'tk-tinker-bauble', board: 'the Bauble cast just before', ai: false },
  // The live game was against the Forge AI.
  { scenario: 'tk-tinker-bauble', board: 'the Bauble cast just before, against the Forge AI', ai: true },
]) test(titled(`Tinker with only the Bauble: the only legal sacrifice is taken for her, never asked, and Tinker resolves (${board})`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = ai ? await startScenarioVsAi(browser, stack, scenario) : await startScenarioMatch(browser, stack, scenario);
    const page = alice.page;
    const { bauble, from } = await castTinker(page, stack);

    // From the cast until the Bauble is gone, nothing pops up to ask the sacrifice.
    const seen: string[] = [];
    await expect
      .poll(
        async () => {
          const up = await popup(page);
          if (up !== null && /sacrifice/i.test(up)) seen.push(`popup: ${up}`);
          return (await ownNamed(page, "Mishra's Bauble")).length;
        },
        { timeout: 20_000, intervals: [50], message: `the Bauble was sacrificed — ${await drawn(page)}` },
      )
      .toBe(0);
    console.log(`[tk] sacrificed for her: ${await drawn(page)}`);
    expect(seen, 'no sacrifice popped up').toEqual([]);
    const rows = serverLog(stack);
    const picked = rows.filter((r) => r.evt === 'auto-picked' && r.seat === 0);
    expect(picked, 'the server took the Bauble, and said why').toEqual([expect.objectContaining({ why: 'the only legal sacrifice', cards: [{ id: bauble, name: "Mishra's Bauble" }] })]);
    const at = rows.findIndex((r) => r.evt === 'auto-picked' && r.seat === 0);
    expect(selectionsSent(stack, from, at), 'the sacrifice never reached her wire before it was taken').toBe(0);
    await resolves(page);
  } finally {
    await stack.stop();
  }
});
