/**
 * What every promo clip does between "the board is up" and "the moment": a filmed two-seat scenario
 * match, and the paced, human-looking presses a viewer can follow. The e2e helpers press as fast as the
 * DOM allows; a trailer needs a beat before each press and the cursor's own hover first.
 */
import type { Browser, Locator, Page } from '@playwright/test';

import { resolve } from 'node:path';

import { dragHandCard, says } from '../play/board.ts';
import type { Friend } from '../play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { startScenarioMatch } from '../play/scenario.ts';
import { HERO, openPromoFriend, PROMO_DIR, RIVAL, startFilm, TAGS, type Film } from './rig.ts';

export interface Shoot {
  film: Film;
  stack: PlayStack;
  hero: Friend;
  rival: Friend;
}

/** Boot Forge, seat the filmed hero and a headless rival on `scenario`, and start rolling once both keep. */
export async function shootScenario(browser: Browser, clip: string, scenario: string): Promise<Shoot> {
  const forge = forgeAvailability();
  if (!forge.ok) throw new Error(`promo: ${forge.reason}`);
  const film = await startFilm(clip);
  let stack: PlayStack | undefined;
  try {
    stack = await startPlayStack(forge);
    const { alice, bob } = await startScenarioMatch(browser, stack, scenario, {
      seats: {
        open: [() => openPromoFriend(film.hero, HERO, { filmed: true }), () => openPromoFriend(browser, RIVAL)],
        names: [TAGS[HERO]!, TAGS[RIVAL]!],
      },
    });
    // Art decodes before the first frame is filmed.
    await alice.page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(2_000);
    await film.roll();
    return { film, stack, hero: alice, rival: bob };
  } catch (err) {
    await wrap({ film, stack });
    throw err;
  }
}

export async function wrap(shoot: Partial<Shoot> & { film?: Film }): Promise<void> {
  await shoot.film?.stop();
  await shoot.stack?.stop();
}

/** Glide to `target` and rest on it (the hover inspector opens), then click. */
export async function deliberateClick(page: Page, target: Locator, opts: { hover?: number } = {}): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('promo: nothing to click');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await page.waitForTimeout(opts.hover ?? 450);
  // The locator's own click: a bare mouse.click on a player's face never reached the board's pick handler.
  await target.click();
}

export const handCard = (page: Page, name: string): Locator =>
  page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name }).first();

/** Hover the hand card (its inspector opens), then drag it up onto the battlefield and let go: a cast. */
export async function cast(page: Page, name: string, opts: { hover?: number } = {}): Promise<void> {
  const card = handCard(page, name);
  const id = Number(await card.getAttribute('data-board-card'));
  const box = await card.boundingBox();
  const field = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox();
  if (box === null || field === null) throw new Error(`promo: cannot cast ${name}: no box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await page.waitForTimeout(opts.hover ?? 900);
  const to = { x: field.x + field.width / 2, y: field.y + field.height * 0.35 };
  const mid = { x: (box.x + box.width / 2 + to.x) / 2, y: (box.y + to.y) / 2 };
  if (!(await dragHandCard(page, id, to, [mid]))) throw new Error(`promo: ${name} (${id}) did not lift`);
}

/** Park the cursor over empty table, so no hover inspector covers the moment. */
export async function restCursor(page: Page): Promise<void> {
  const field = await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').first().boundingBox();
  if (field !== null) await page.mouse.move(field.x + field.width * 0.92, field.y + field.height * 0.25, { steps: 14 });
}

export const okEnabled = (page: Page): Locator => page.locator('[data-testid="live-decision-ok"]:enabled');

export async function pressIfThere(target: Locator): Promise<boolean> {
  if ((await target.count()) === 0) return false;
  await target.first().click({ timeout: 1_000 }).catch(() => undefined);
  return true;
}

/** The open prompt sheet (a selection or a multi-pick choice): its card tiles, and the text each shows. */
const openSheet = (page: Page): Locator => page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();

export async function selectionTiles(page: Page): Promise<{ id: number; text: string }[]> {
  return openSheet(page)
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

/**
 * Tick each tile in `ids` at a readable pace, then press the sheet's OK. Forge closes a selection itself
 * once its maximum is picked (the sheet counts down "up to 6…", "up to 2…"), so OK may be gone by then.
 */
export async function pickTiles(page: Page, ids: readonly number[], gapMs = 140): Promise<void> {
  for (const id of ids) {
    const tile = openSheet(page).locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`);
    if ((await tile.count()) === 0) continue;
    await tile.scrollIntoViewIfNeeded();
    const box = await tile.boundingBox();
    if (box === null) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24), { steps: 6 });
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24));
    await page.waitForTimeout(gapMs);
  }
  await page.waitForTimeout(400);
  // Only OK the sheet these tiles were on: once Forge closed it, the open sheet is the NEXT question.
  const still = new Set((await selectionTiles(page)).map((t) => t.id));
  if (!ids.some((id) => still.has(id))) return;
  const ok = openSheet(page).locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled');
  if ((await ok.count()) > 0) await deliberateClick(page, ok.first(), { hover: 250 });
}

export const lifeOf = (page: Page, whose: 'mine' | 'theirs'): Locator =>
  page.locator(`.seat${whose === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-testid="life"]`).first();

export const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])').first();

/** Poll `step` every `ms` until it answers true, or throw naming `what`. */
export async function until(what: string, step: () => Promise<boolean>, timeoutMs = 90_000, ms = 200, witness?: Page): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await step())) {
    if (Date.now() > deadline) {
      if (witness !== undefined) {
        const shot = resolve(PROMO_DIR, `stuck-${what.replace(/[^a-z0-9]+/gi, '-')}.png`);
        await witness.screenshot({ path: shot });
        console.log(`[promo] stuck on "${what}": says "${await says(witness)}"; screenshot ${shot}`);
      }
      throw new Error(`promo: ${what} never happened`);
    }
    await new Promise((r) => setTimeout(r, ms));
  }
}
