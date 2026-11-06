/**
 * Driving `wlife-chunks` (`e2e/wlife-life-chunks.spec.ts`): alice's bolt, drain and three-creature attack
 * at bob, and every value each life counter shows on the way.
 */
import { expect, type Page } from '@playwright/test';

import { boardCard, castAndPassUntil, clickOnce, grindPriority, offeredCard, ownNamed, says } from './board.ts';
import { clickCombat, passToDeclareAttackers } from './combat.ts';
import type { PlayStack } from './harness.ts';
import type { ScenarioMatch } from './scenario.ts';

declare global {
  interface Window {
    __lifeSeen?: Record<string, string[]>;
  }
}

/** Start recording every value each seat's life counter shows on `page`, keyed by its face's player id. */
export async function watchLife(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: Record<string, string[]> = {};
    window.__lifeSeen = seen;
    const read = (): void => {
      for (const span of document.querySelectorAll('[data-player-face] [data-testid="life"]')) {
        const id = span.closest('[data-player-face]')?.getAttribute('data-player-id') ?? '?';
        const list = (seen[id] ??= []);
        const text = span.textContent ?? '';
        if (list[list.length - 1] !== text) list.push(text);
      }
    };
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

export const lifeSeen = (page: Page): Promise<Record<string, string[]>> => page.evaluate(() => window.__lifeSeen ?? {});

/** The life a seat's counter reads on `page`: `you` for the page's own seat, `them` for the other. */
const lifeOf = async (page: Page, whose: 'you' | 'them'): Promise<number> =>
  Number(await page.locator(`.seat${whose === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-testid="life"]`).textContent());

/**
 * Drive `wlife-chunks` from alice's seat: the bolt, the drain, then the three-creature attack, each
 * resolved before the next. `afterStep` runs once each one's life has landed on both screens.
 */
export async function playLifeChunks(seated: ScenarioMatch, stack: PlayStack, afterStep: (step: string) => Promise<void> = async () => undefined): Promise<void> {
  const { alice, bob } = seated;
  const pages = [alice.page, bob.page];
  const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
  const settled = async (aliceLife: number, bobLife: number): Promise<boolean> =>
    (await lifeOf(alice.page, 'you')) === aliceLife &&
    (await lifeOf(alice.page, 'them')) === bobLife &&
    (await lifeOf(bob.page, 'you')) === bobLife &&
    (await lifeOf(bob.page, 'them')) === aliceLife;

  const bolt = await offeredCard(alice.page, 'Lightning Bolt', { zone: 'hand' });
  await castAndPassUntil(pages, stack, bolt, [bobFace], () => settled(20, 17));
  await afterStep('bolt');

  const bite = await offeredCard(alice.page, 'Sovereign’s Bite', { zone: 'hand' }).catch(() => offeredCard(alice.page, "Sovereign's Bite", { zone: 'hand' }));
  await castAndPassUntil(pages, stack, bite, [bobFace], () => settled(23, 14));
  await afterStep('drain');

  await passToDeclareAttackers(alice.page);
  for (const name of ['Vampire Nighthawk', 'Grizzly Bears', 'Hill Giant']) {
    const id = (await ownNamed(alice.page, name))[0];
    expect(id, `alice controls ${name}`).toBeDefined();
    await clickCombat(boardCard(alice.page, id!));
    await expect(boardCard(alice.page, id!), `${name} is declared`).toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
  }
  await expect
    .poll(
      async () => {
        const text = await says(alice.page);
        if (/^Select creatures to attack/i.test(text)) await clickOnce(alice.page, text, 'ok');
        return /^Select creatures to attack/i.test(await says(alice.page));
      },
      { timeout: 15_000, message: 'the attack window closes on its own OK' },
    )
    .toBe(false);
  await grindPriority(pages, () => settled(25, 7), { timeoutMs: 60_000, intervalMs: 60 });
  await afterStep('combat');
}
