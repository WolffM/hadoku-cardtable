/**
 * A pick that must take exactly N cards says N, never "up to N", against real Forge.
 *
 * The operator, 2026-10-14: *"brainstorm says 'up to 2 cards' but it's just 2 cards."* Brainstorm's
 * put-back is `ChangeZone | ChangeNum$ 2 | Mandatory$ True`; `ChangeZoneEffect` words every multi-card
 * pick with more cards than it takes as `lblSelectUpToNumCardFromPlayerZone` ("Select up to 2 cards
 * from your hand") whatever its minimum, while the selection it opens (`setSelectables`) carries
 * min 2, max 2 — Forge's OK stays off until both are picked.
 *
 * `prompts-brainstorm.state`: alice casts Brainstorm off her Island and both pass; the put-back pick
 * opens on her hand. Every place her screen words the pick (the prompt line, the decision pop-up, a
 * selection window) must say 2 cards, and none "up to".
 *
 * `[af57]` lines are the evidence: each place's text and the selection's min and max.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, drawnText, grindPriority, handCardNamed, makeTitled, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every place this page words the open decision, by test id: the text each shows, `null` when not drawn. */
async function wordings(page: Page): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of ['live-says', 'live-decision-host', 'live-selection-host', 'live-target-host']) {
    out[id] = await drawnText(page, id);
  }
  return out;
}

test(titled("Brainstorm's put-back says 2 cards, not up to 2: an exact pick is worded from Forge's own min and max"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'prompts-brainstorm');
    const { alice, bob } = seated;
    let brainstorm: number | undefined;
    await expect.poll(async () => (brainstorm = await handCardNamed(alice.page, 'Brainstorm')), { timeout: 30_000, message: 'Brainstorm is in hand' }).not.toBeUndefined();
    await clickHandCard(alice.page, brainstorm!);

    const picking = async (): Promise<boolean> => /from your hand/i.test(await says(alice.page));
    await grindPriority([alice.page, bob.page], picking, { timeoutMs: 60_000 });

    const selection = serverLog(stack).filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'setSelectables').at(-1);
    const words = await wordings(alice.page);
    console.log(`[af57] selection ${JSON.stringify(selection)} wordings ${JSON.stringify(words)}`);

    const drawn = Object.entries(words).filter((e): e is [string, string] => e[1] !== null);
    expect(drawn.length, 'the pick is worded somewhere').toBeGreaterThan(0);
    for (const [id, text] of drawn) expect(text, `${id} never says "up to" for an exact pick`).not.toMatch(/up to/i);
    expect(drawn.some(([, text]) => /select 2 cards\b/i.test(text)), 'the pick says its exact count').toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
