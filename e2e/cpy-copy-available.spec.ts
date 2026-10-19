/**
 * The operator, 2026-10-19: *"for instant cards that copy spells like lutri and others of that
 * nature can we default to having the player hold priority after casting any spell that is a valid
 * target for those? (assuming the copy spell is playable)"*
 *
 * A seat's own spell is passed on (`own-spell`, Q17) unless Forge offers the seat a card that
 * copies spells and the spell is a target for it — then the window is kept (`copy-available`).
 *
 * Two real browsers. `cpy-twincast`: alice's own Main 1, Lightning Bolt and Twincast in hand,
 * a Mountain and two Islands. She bolts bob and is held over her own Bolt with Twincast offered.
 * `cpy-no-copier`: Brainstorm where Twincast was — her Bolt is passed on and resolves.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');
const opponentLife = (page: Page): Locator => page.locator('.seat:not([data-viewer]) [data-testid="life"]');
const decisionOk = (page: Page): Locator => page.locator('[data-testid="live-decision-ok"]:enabled');

/** Alice's priority judgements from `from` on, as `evt rule plays`. */
const aliceStops = (stack: PlayStack, from: number): string[] =>
  serverLog(stack)
    .slice(from)
    .filter((r) => r.seat === 0 && ((r.evt === 'prompt-forwarded' && r.kind === 'priority') || r.evt === 'auto-passed'))
    .map((r) => [r.evt, r.rule, r.plays === undefined ? undefined : JSON.stringify(r.plays)].filter((x) => x !== undefined).join(' '));

/** Alice bolts bob: the offered Bolt, then his face, until it is cast. Returns where the log stood before. */
async function aliceBolts(alice: Page, stack: PlayStack): Promise<number> {
  let bolt: number | undefined;
  await expect.poll(async () => (bolt = await offeredNamed(alice, 'Lightning Bolt')), { timeout: 45_000, message: 'alice is offered Lightning Bolt' }).not.toBeUndefined();
  const from = serverLog(stack).length;
  await castUntilOnStack(alice, stack, bolt!, [opponentFace(alice)]);
  return from;
}

/** The first judgement of alice's priority over her own Bolt: kept for a copier, or passed. */
async function firstJudgement(stack: PlayStack, from: number): Promise<string> {
  let first = '';
  await expect
    .poll(() => (first = aliceStops(stack, from).find((r) => /copy-available|own-spell/.test(r)) ?? ''), { timeout: 30_000, message: 'alice’s window over her own Bolt was judged' })
    .not.toBe('');
  return first;
}

test(titled('a seat holding a playable Twincast keeps priority over its own Lightning Bolt'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'cpy-twincast');
    const from = await aliceBolts(alice.page, stack);
    const first = await firstJudgement(stack, from);
    console.log(`[cpy] twincast: ${first}; rows [${aliceStops(stack, from).join(' | ')}]`);
    expect(first, 'the window was kept for the copier, and the log names it').toMatch(/^prompt-forwarded copy-available .*"name":"Twincast"/);
    await expect
      .poll(async () => (await stackCount(alice.page)) === 1 && (await decisionOk(alice.page).count()) === 1, { timeout: 15_000, message: 'alice holds priority over her own Bolt' })
      .toBe(true);
    expect(await offeredNamed(alice.page, 'Twincast'), 'with Twincast offered').not.toBeUndefined();
    await expect(opponentLife(alice.page), 'the Bolt has not resolved').toHaveText('20');
  } finally {
    await stack.stop();
  }
});

test(titled('with no copier in hand, the seat’s own Lightning Bolt is passed on and resolves'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'cpy-no-copier');
    const from = await aliceBolts(alice.page, stack);
    const first = await firstJudgement(stack, from);
    console.log(`[cpy] no copier: ${first}; rows [${aliceStops(stack, from).join(' | ')}]`);
    expect(first, 'the window was passed as her own spell').toBe('auto-passed own-spell');
    await expect(opponentLife(alice.page), 'the Bolt resolved with no press from alice').toHaveText('17', { timeout: 20_000 });
  } finally {
    await stack.stop();
  }
});
