/**
 * What every promo clip does between "the board is up" and "the moment": a filmed two-seat scenario
 * match, and the paced, human-looking presses a viewer can follow. The e2e helpers press as fast as the
 * DOM allows; a trailer needs a beat before each press and the cursor's own hover first.
 */
import type { Browser, Locator, Page } from '@playwright/test';

import { resolve } from 'node:path';

import { pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { passToDeclareAttackers } from '../play/combat.ts';
import { answerPrompt } from '../play/prompts.ts';
import type { Friend } from '../play/browser.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { expectPoolOn, poolSlider } from '../play/pool.ts';
import { startScenarioMatch } from '../play/scenario.ts';
import { humanMove, humanRest } from './mouse.ts';
import { AVATARS, HERO, openPromoFriend, PROMO_DIR, RIVAL, startFilm, TAGS, type Film } from './rig.ts';

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
        open: [() => openPromoFriend(film.hero, HERO), () => openPromoFriend(browser, RIVAL)],
        names: [TAGS[HERO]!, TAGS[RIVAL]!],
        // A roomless match has no room to read a face from: the probe-only `avatars` field carries them.
        avatars: [AVATARS[HERO]!, AVATARS[RIVAL]!],
      },
    });
    // Art decodes before the first frame is filmed.
    await alice.page.waitForLoadState('networkidle').catch(() => undefined);
    await film.beat(2_000);
    await film.roll();
    watchEvents(film, alice.page);
    return { film, stack, hero: alice, rival: bob };
  } catch (err) {
    await wrap({ film, stack });
    throw err;
  }
}

/**
 * Mark the game's own events while a clip rolls: every change in the stack's size (`stack:N`) and in either
 * life total (`life:theirs:N`, `life:mine:N`), polled every 100 ms. Landings, resolutions and hits are then
 * in the marks, so the edit cuts on what the board did rather than on when the driver pressed.
 */
function watchEvents(film: Film, page: Page): void {
  const last = new Map<string, string>();
  const timer = setInterval(() => {
    void (async () => {
      const now = await page
        .evaluate(() => ({
          stack: document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0',
          'life:mine': document.querySelector('.seat[data-viewer] [data-testid="life"]')?.textContent?.trim() ?? '',
          'life:theirs': document.querySelector('.seat:not([data-viewer]) [data-testid="life"]')?.textContent?.trim() ?? '',
        }))
        .catch(() => null);
      if (now === null) return;
      for (const [key, value] of Object.entries(now)) {
        if (last.has(key) && last.get(key) !== value) film.mark(`${key}:${value}`);
        last.set(key, value);
      }
    })();
  }, 100);
  watching.set(film, timer);
}

const watching = new WeakMap<Film, ReturnType<typeof setInterval>>();

export async function wrap(shoot: Partial<Shoot> & { film?: Film }): Promise<void> {
  if (shoot.film !== undefined) clearInterval(watching.get(shoot.film));
  await shoot.film?.stop();
  await shoot.stack?.stop();
}

export { humanMove, humanRest };

const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Glide to `target` and rest on it (the hover inspector opens), then click. */
export async function deliberateClick(page: Page, target: Locator, opts: { hover?: number; pace?: number } = {}): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('promo: nothing to click');
  await humanMove(page, centre(box), opts.pace);
  await humanRest(page, opts.hover ?? 450);
  // The locator's own click: a bare mouse.click on a player's face never reached the board's pick handler.
  await target.click();
}

/**
 * The leader drags the Classic year slider's pill to `eraId`'s tick (`play/pool.ts`), as a person would:
 * onto the pill, press, carry it along the ruler, let go. Resolves once the room has answered.
 */
export async function dragYear(page: Page, eraId: string): Promise<void> {
  const slider = poolSlider(page);
  const thumb = (await slider.locator('.year-slider__thumb').boundingBox())!;
  const rail = (await slider.getByRole('slider').boundingBox())!;
  const tick = (await slider.locator(`[data-era="${eraId}"]`).boundingBox())!;
  const y = rail.y + rail.height / 2;
  await humanMove(page, { x: thumb.x + thumb.width / 2, y });
  await humanRest(page, 260);
  await page.mouse.down();
  await humanMove(page, { x: tick.x + tick.width / 2, y }, 1.6);
  await humanRest(page, 180);
  await page.mouse.up();
  await expectPoolOn(page, eraId);
}

export const handCard = (page: Page, name: string): Locator =>
  page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name }).first();

/** Hover the hand card (its inspector opens), then drag it up onto the battlefield and let go: a cast. */
export async function cast(page: Page, name: string, opts: { hover?: number; offCamera?: boolean } = {}): Promise<void> {
  const card = handCard(page, name);
  const box = await card.boundingBox();
  const field = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox();
  if (box === null || field === null) throw new Error(`promo: cannot cast ${name}: no box`);
  if (opts.offCamera === true) {
    // The unfilmed seat: no hand to imitate and no viewer to read a hover, so it casts at once. The filmed
    // seat sees the card leave the other hand and fly in, which is all the clip needs of it.
    const c = centre(box);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    if ((await card.getAttribute('data-cast-lift').catch(() => null)) !== 'lifted') {
      await page.mouse.up();
      throw new Error(`promo: ${name} did not lift`);
    }
    await page.mouse.move(field.x + field.width / 2, field.y + field.height * 0.35, { steps: 4 });
    await page.mouse.up();
    return;
  }
  await humanMove(page, centre(box));
  await humanRest(page, opts.hover ?? 900);
  await page.mouse.down();
  if ((await card.getAttribute('data-cast-lift').catch(() => null)) !== 'lifted') {
    await page.mouse.up();
    throw new Error(`promo: ${name} did not lift`);
  }
  await humanMove(page, { x: field.x + field.width / 2, y: field.y + field.height * 0.35 });
  await page.mouse.up();
  // Off the card at once: the cursor resting where it let go opens the inspector over the spell's flight.
  await restCursor(page);
}

/** Park the cursor over empty table, so no hover inspector covers the moment. */
export async function restCursor(page: Page): Promise<void> {
  const field = await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').first().boundingBox();
  if (field !== null) await humanMove(page, { x: field.x + field.width * 0.92, y: field.y + field.height * 0.25 });
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
 * `settleMs` is the look at the full sheet before its OK; a combo's repeated pick wants it short.
 */
export async function pickTiles(page: Page, ids: readonly number[], gapMs = 140, settleMs = 400): Promise<void> {
  for (const id of ids) {
    const tile = openSheet(page).locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`);
    if ((await tile.count()) === 0) continue;
    await tile.scrollIntoViewIfNeeded();
    const box = await tile.boundingBox();
    if (box === null) continue;
    const at = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 24) };
    await humanMove(page, at, 0.45);
    await page.mouse.click(at.x, at.y);
    await humanRest(page, gapMs);
  }
  await page.waitForTimeout(settleMs);
  // Only OK the sheet these tiles were on: once Forge closed it, the open sheet is the NEXT question.
  const still = new Set((await selectionTiles(page)).map((t) => t.id));
  if (!ids.some((id) => still.has(id))) return;
  const ok = openSheet(page).locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled');
  if ((await ok.count()) > 0) await deliberateClick(page, ok.first(), { hover: Math.min(250, settleMs) });
}

export const lifeOf = (page: Page, whose: 'mine' | 'theirs'): Locator =>
  page.locator(`.seat${whose === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-testid="life"]`).first();

export const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])').first();

/** The rival's face is offered as a target (a target prompt's words sit in its popup, not the status line). */
export const faceTargetable = async (page: Page): Promise<boolean> => (await page.locator('[data-player-face][data-selectable]:not([data-viewer])').count()) > 0;

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

/** Put `page`'s seat on Auto Yield for the turn it is watching, so none of its priority windows interrupt the hero's. */
export async function autoYield(page: Page): Promise<void> {
  const slot = page.getByTestId('live-button-end-turn');
  await until('the rival can Auto Yield', async () => (await slot.textContent())?.trim() === 'Auto Yield' && (await slot.isEnabled()), 30_000, 150, page);
  await slot.click();
  await until('the rival yields', async () => (await slot.getAttribute('data-yield')) === 'on', 10_000, 100, page);
}

/** Pass the hero's priority until the stack is empty (the rival on Auto Yield), paying and saying yes as asked. */
export async function resolveStack(page: Page, what: string): Promise<void> {
  await until(what, async () => {
    if ((await stackCount(page)) === 0 && (await page.getByTestId('live-prompt').count()) === 0) return true;
    await pressPaymentAuto(page);
    await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
    if ((await stackCount(page)) > 0) await pressIfThere(okEnabled(page));
    return false;
  }, 60_000, 300, page);
}

/** Into combat and swing: `all` presses the board's own All, a list clicks each attacker; then Done. */
export async function swing(page: Page, attackers: 'all' | number[]): Promise<void> {
  await passToDeclareAttackers(page);
  await humanRest(page, 500);
  let ids = attackers === 'all' ? [] : attackers;
  if (attackers === 'all') {
    const all = page.locator('[data-testid="live-attack-all"]:visible');
    const deadline = Date.now() + 4_000;
    while ((await all.count()) === 0 && Date.now() < deadline) await page.waitForTimeout(150);
    if ((await all.count()) > 0) await deliberateClick(page, all.first(), { hover: 500 });
    // No All on the bar (Forge's own second button holds that slot): every creature that can attack, by hand.
    else ids = await page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card][data-selectable]:has(.board-card__pt)').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
  }
  for (const id of ids) await deliberateClick(page, page.locator(`[data-board-card="${id}"] button`).first(), { hover: 250 });
  await humanRest(page, 500);
  // Done, once it is offered; a declaration Forge has already taken leaves nothing to press.
  const done = okEnabled(page).first();
  const deadline = Date.now() + 5_000;
  while ((await done.count()) === 0 && Date.now() < deadline) await page.waitForTimeout(150);
  if ((await done.count()) > 0) await deliberateClick(page, done, { hover: 350 });
  await restCursor(page);
}

/** Until the hero has won, passing as asked; marks `hit` the moment the rival's life first drops. */
export async function untilWon(film: Film, page: Page): Promise<void> {
  const start = Number((await lifeOf(page, 'theirs').textContent()) ?? '20');
  let hit = false;
  await until('the game is won', async () => {
    const life = Number((await lifeOf(page, 'theirs').textContent()) ?? '20');
    if (!hit && life < start) {
      hit = true;
      film.mark('hit');
    }
    if ((await page.getByTestId('game-result').count()) > 0) return true;
    // A storm copy asks for its own target: the rival's face again.
    if (await faceTargetable(page)) await opponentFace(page).locator('button').first().click({ timeout: 1_000 }).catch(() => undefined);
    // Any other ask on the way (an attack trigger's "use it?") takes its default.
    await answerPrompt(page).catch(() => null);
    await pressIfThere(okEnabled(page));
    return false;
  }, 90_000, 200, page);
  film.mark('win');
}

/** The first card on the rival's battlefield named `name`. */
export const theirCard = (page: Page, name: string): Locator =>
  page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]', { has: page.locator('.card__name', { hasText: name }) }).first();
