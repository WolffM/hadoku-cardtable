/**
 * The turn counter on the phase rail (`live-turn-n`), wave 32 Q1: until turn 1 it
 * reads `Start`, not `0`, and the name that used to sit under it is gone (the
 * `data-whose` attribute on the rail stays). A spec that waited for `^\d+$` would
 * wait out its timeout at the coin toss, so every spec reads it through here.
 */
import { expect, type Page } from '@playwright/test';

import { answerConfirm, confirmOpen } from './confirm.ts';

/** What `live-turn-n` shows once the board has a view: a turn number, or Start. */
export const TURN_TEXT = /^(Start|\d+)$/;

/** `Start` is turn 0; anything else is the number. */
export function turnNumber(text: string | null): number {
  const t = (text ?? '').trim();
  return t === 'Start' || t === '' ? 0 : Number(t);
}

/** Play, keep: whatever one seat's opening asks, until its turn counter reads a real turn. */
export async function pressIntoTurnOne(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const playOrDraw = page.getByTestId('live-play-or-draw-play');
        if ((await playOrDraw.count()) > 0) await playOrDraw.click({ timeout: 2_000 }).catch(() => undefined);
        else if (await confirmOpen(page)) await answerConfirm(page, 'yes');
        return turnNumber(await page.getByTestId('live-turn-n').textContent());
      },
      { message: 'the match reaches turn 1', timeout: 90_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(1);
}
