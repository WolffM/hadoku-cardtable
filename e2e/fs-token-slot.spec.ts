/**
 * The operator, 2026-10-17: *"theres a shitty behavior with how cards get selected to be placed on the
 * board when they are created by something. ideally it's the first avaliable slot from top left onward.
 * it the logic appears to want to always place it towards the right and beyond the furthest thing i've
 * placed, it's not very consistent either"*.
 *
 * Alice's front row is three creatures; she stacks the first onto the second, which leaves column 0
 * open (a gap left of the cards she placed). Raise the Alarm makes two Soldier tokens nobody placed: the
 * first takes the gap at column 0, the second — with no gap left — joins the row's end. Bob's screen
 * draws alice's row the same.
 */
import { expect, test, type Page } from '@playwright/test';

import { grindPriority, makeTitled, offeredNamed, resizeWindow, castCard } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { boxOf, onTopPoint, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Alice's front row, column by column (null for a gap), on her screen (`you`) or on bob's (`them`). */
const frontColumns = (page: Page, side: 'you' | 'them'): Promise<(string | null)[]> =>
  page
    .locator(`.seat${side === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="battlefield"] [data-tier="front"] > li`)
    .evaluateAll((els) => els.map((e) => (e.classList.contains('zone__gap') ? null : e.getAttribute('data-card-id'))));
const show = (columns: readonly (string | null)[]): string => columns.map((c) => c ?? '_').join(' ');

test(titled('a token nobody placed takes the first free column of its row from the left, else the row’s end — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'fs-token-slot');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const a = alice.page;
    const card = (id: string) => a.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${id}"]`);

    await expect.poll(async () => (await frontColumns(a, 'you')).length, { timeout: 45_000, message: 'alice’s three creatures in the front row' }).toBe(3);
    const [c0, c1, c2] = (await frontColumns(a, 'you')) as [string, string, string];

    // A gap at column 0, left of the cards she placed: the first creature onto the second.
    await pointerDrag(a, card(c0), onTopPoint(await boxOf(card(c1))));
    await expect(card(c1), 'two creatures in one pile').toHaveAttribute('data-pile-size', '2');
    await expect.poll(() => frontColumns(a, 'you'), { message: 'alice: column 0 is open' }).toEqual([null, c1, c2]);
    await expect.poll(() => frontColumns(bob.page, 'them'), { timeout: 10_000, message: 'bob: the same gap' }).toEqual([null, c1, c2]);
    console.log(`[fs] before the tokens: ${show(await frontColumns(a, 'you'))}`);

    const before = new Set(await a.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-board-card')!)));
    await expect.poll(() => offeredNamed(a, 'Raise the Alarm'), { timeout: 45_000, message: 'alice is offered Raise the Alarm' }).not.toBeUndefined();
    await castCard(a, (await offeredNamed(a, 'Raise the Alarm'))!);
    const tokens = async (): Promise<string[]> =>
      (await a.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-board-card')!))).filter(
        (id) => !before.has(id),
      );
    await grindPriority([a, bob.page], async () => (await tokens()).length >= 2, { timeoutMs: 60_000 });
    const made = await tokens();
    expect(made, 'Raise the Alarm made two tokens').toHaveLength(2);

    await expect
      .poll(async () => (await frontColumns(a, 'you')).filter((c) => c !== null && made.includes(c)).length, {
        timeout: 10_000,
        message: 'alice: both tokens drawn in her front row',
      })
      .toBe(2);
    const mine = await frontColumns(a, 'you');
    console.log(`[fs] alice after the tokens ${made.join(',')}: ${show(mine)}`);
    expect(mine.slice(1, 3), 'the cards she placed keep their columns').toEqual([c1, c2]);
    expect([mine[0], mine[3]].sort(), 'one token in the gap at column 0, the other at the row’s end').toEqual([...made].sort());
    expect(mine, 'no gap is left and nothing sits past the end').toHaveLength(4);
    await expect.poll(() => frontColumns(bob.page, 'them'), { timeout: 10_000, message: 'bob draws alice’s row the same' }).toEqual(mine);
    console.log(`[fs] bob sees alice's row: ${show(await frontColumns(bob.page, 'them'))}`);
  } finally {
    await stack.stop();
  }
});
