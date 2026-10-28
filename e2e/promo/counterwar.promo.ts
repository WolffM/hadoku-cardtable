/**
 * Clip: a Legacy counter war, filmed from the UB seat. Oko → Counterspell → Swan Song → Force of Will
 * (pitching Brainstorm) → Spell Pierce → Daze: six spells on the stack, then it all unwinds and Oko is
 * countered. `promo-counterwar.state` has the board.
 */
import { test, type Page } from '@playwright/test';

import { offeredNamed, pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { answerPrompt } from '../play/prompts.ts';
import { cast, deliberateClick, okEnabled, pickTiles, selectionTiles, restCursor, pressIfThere, shootScenario, until, wrap, type Shoot } from './drive.ts';

/**
 * Pick `name` as the target of a stack-target ask by clicking its stack item — the board's own gesture.
 * The choice list answers it when Forge draws one (several legal targets).
 */
async function aimAtStack(page: Page, name: string): Promise<boolean> {
  const item = page.locator(`[data-stack-id][aria-label*="${name}"]`).first();
  if ((await item.count()) > 0 && /target/i.test(await says(page)) && (await page.locator('section[data-prompt="getChoices"]').count()) === 0) {
    await item.click().catch(() => undefined);
    return true;
  }
  const list = page.locator('section[data-prompt="getChoices"] li', { hasText: name }).first();
  if ((await list.count()) > 0) {
    await list.locator('label').click().catch(() => undefined);
    await pressIfThere(page.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]:enabled'));
    return true;
  }
  return false;
}

/**
 * An alternative cost's own question — Force of Will's "Exile 1 card(s) from your hand", Daze's "return an
 * Island" — answered with the sheet's tile that starts with `card`, or that card on the board if no sheet.
 */
async function payAlternative(page: Page, card: string): Promise<void> {
  const tile = (await selectionTiles(page)).find((t) => t.text.startsWith(card));
  if (tile !== undefined) return pickTiles(page, [tile.id], 300);
  const onBoard = page.locator('.seat[data-viewer] [data-board-card][data-selectable]', { hasText: card }).first();
  if ((await onBoard.count()) > 0) await deliberateClick(page, onBoard, { hover: 400 });
}

/** `seat` casts `name` at `target` once Forge offers it, and pays, until the stack holds `depth` spells. */
async function respond(seat: Page, other: Page, name: string, target: string | null, depth: number, opts: { alt?: { asks: RegExp; card: string }; orDone?: () => Promise<boolean> } = {}): Promise<void> {
  // The other seat passes: with a free Daze in hand Forge never auto-passes it.
  await until(`${name} is offered`, async () => {
    if ((await offeredNamed(seat, name)) !== undefined) return true;
    await pressIfThere(okEnabled(other));
    return false;
  }, 60_000, 300);
  await cast(seat, name, { hover: 1_000 });
  let heard = '';
  await until(`${name} is on the stack`, async () => {
    const prompt = seat.locator('[data-testid="live-prompt"]');
    const now = `${await says(seat)} | ${(await prompt.count()) > 0 ? await prompt.first().getAttribute('data-method') : '-'}`;
    if (now !== heard) console.log(`[promo:counterwar] ${name}: ${(heard = now).replace(/\s+/g, ' ').slice(0, 140)}`);
    const placed = (await seat.locator(`[data-stack-id][aria-label*="${name.split(',')[0]}"]`).count()) > 0;
    const asking = (await seat.locator('[data-testid="live-prompt"]').count()) > 0 || /pay|choose|select|target|exile|return/i.test(await says(seat));
    if ((await stackCount(seat)) >= depth && placed && !asking) return true;
    // The last word: with the other seat tapped out, Forge passes for it and the stack can unwind at once.
    if (opts.orDone !== undefined && (await opts.orDone())) return true;
    if (opts.alt !== undefined && opts.alt.asks.test(await says(seat))) {
      await payAlternative(seat, opts.alt.card);
      return false;
    }
    if (target !== null && (await aimAtStack(seat, target))) return false;
    await pressPaymentAuto(seat);
    return false;
  }, 30_000, 250, seat);
  await restCursor(seat);
  console.log(`[promo:counterwar] ${name} on the stack (${depth}); says "${(await says(seat)).slice(0, 80)}"`);
}

test('counterwar: five counters over one Oko', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'counterwar', 'promo-counterwar');
    const { film, hero, rival } = shoot;
    film.mark('board');
    await film.beat(1_500);

    film.mark('oko');
    await respond(rival.page, hero.page, 'Oko, Thief of Crowns', null, 1);
    await film.beat(700);
    film.mark('counterspell');
    await respond(hero.page, rival.page, 'Counterspell', 'Oko', 2);
    await film.beat(900);
    film.mark('swan-song');
    await respond(rival.page, hero.page, 'Swan Song', 'Counterspell', 3);
    await film.beat(900);
    film.mark('force');
    await respond(hero.page, rival.page, 'Force of Will', 'Swan Song', 4, { alt: { asks: /Exile \d+ card/i, card: 'Brainstorm' } });
    await film.beat(900);
    film.mark('pierce');
    await respond(rival.page, hero.page, 'Spell Pierce', 'Force of Will', 5);
    await film.beat(900);
    film.mark('daze');
    const okoCountered = async (): Promise<boolean> =>
      (await hero.page.locator('.seat:not([data-viewer]) [data-zone="graveyard"] [data-board-card]', { hasText: 'Oko' }).count()) > 0;
    await respond(hero.page, rival.page, 'Daze', 'Spell Pierce', 6, { alt: { asks: /return/i, card: 'Island' }, orDone: okoCountered });
    film.mark('six-deep');

    // Unwind: both seats pass; the tapped-out rival declines every "pay?". Done once Oko is in a graveyard.
    await until('Oko is countered', async () => {
      if (await okoCountered()) return true;
      await pressIfThere(rival.page.locator('[data-testid="prompt-confirm-no"]:enabled'));
      await answerPrompt(rival.page).catch(() => null);
      for (const page of [hero.page, rival.page]) if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
      return false;
    }, 90_000, 400, hero.page);
    film.mark('oko-countered');
    await film.beat(4_000);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});
