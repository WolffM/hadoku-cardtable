/**
 * A face-down spell on the stack is a card back on the screen that may not see it.
 *
 * w69-hidden made a card this seat's wire names nothing for a card back named "Hidden card" wherever a
 * board card is drawn. The stack layer (`apps/ui/src/play/live/placed.ts`) builds its own card from the
 * stack item's source card, so a face-down spell there was still a face — a text tile reading "Hidden
 * card", no art.
 *
 * Scenario `w69-facedown`: alice drags Exalted Angel onto her battlefield; three Plains pay only for
 * its morph, so Forge casts it face down. Bob (Full Control) holds priority, so it stays on the stack.
 * Alice's screen is sent her own card (Forge lets the controller look), so her stack card is the
 * Angel; bob's is never sent its name, so his stack card is the same back as any hidden card — the
 * card's own size, named "Hidden card" — and hovering it enlarges that back, never a face.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, makeTitled, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const NAME = 'Exalted Angel';
const HIDDEN = 'Hidden card';

interface Drawn {
  back: boolean;
  backIsCard: boolean;
  backLabel: string | null;
  name: string | null;
  text: string | null;
  art: boolean;
  label: string | null;
  pending: boolean;
  size: string;
  card: string;
}

/** What the stack layer draws for card `id` on `page`. */
const drawnOnStack = (page: Page, id: number): Promise<Drawn | null> =>
  page.evaluate((cardId) => {
    const el = document.querySelector(`[data-placed-card="${cardId}"]`);
    if (el === null) return null;
    const back = el.querySelector('[data-card-back]');
    const box = el.getBoundingClientRect();
    const card = document.querySelector('[data-zone="battlefield"] li.board-card')?.getBoundingClientRect();
    return {
      back: back !== null,
      backIsCard: back?.classList.contains('card') ?? false,
      backLabel: back?.getAttribute('aria-label') ?? null,
      name: el.querySelector('.card__name')?.textContent?.trim() ?? null,
      text: el.querySelector('.placed__text')?.textContent?.trim() ?? null,
      art: el.querySelector('img.card__art') !== null,
      label: el.getAttribute('aria-label'),
      pending: el.hasAttribute('data-placed-pending'),
      size: `${Math.round(box.width)}×${Math.round(box.height)}`,
      card: card === undefined ? 'none' : `${Math.round(card.width)}×${Math.round(card.height)}`,
    };
  }, id);

/** What the open inspector shows: a back and its name, or a face's name. */
const inspected = (page: Page): Promise<{ back: boolean; label: string | null; name: string | null } | null> =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-inspect]');
    if (panel === null) return null;
    const back = panel.querySelector('[data-card-back]');
    return { back: back !== null, label: back?.getAttribute('aria-label') ?? null, name: panel.querySelector('.card__name')?.textContent?.trim() ?? null };
  });

/** Every visible text or accessible name on the page that names the card. */
const naming = (page: Page, name: string): Promise<string[]> =>
  page.evaluate((n) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
      if (el.getAttribute('aria-label')?.includes(n)) out.push(`${el.tagName.toLowerCase()} aria-label="${el.getAttribute('aria-label')}"`);
    }
    for (const el of Array.from(document.querySelectorAll('.card__name, .placed__text, .placed__chip-text'))) {
      if (el.textContent?.includes(n)) out.push(`${el.className} "${el.textContent.trim()}"`);
    }
    return out;
  }, name);

test(titled('a face-down spell on the stack is the caster’s own card on her screen and a card back on the other'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-facedown');
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    let id: number | undefined;
    await expect.poll(async () => (id = await offeredNamed(alice.page, NAME)), { timeout: 60_000, message: `alice is offered ${NAME}` }).not.toBeUndefined();
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await castByDrag(alice.page, stack, id!, { x: Math.round(field.x + field.width * 0.4), y: Math.round(field.y + field.height * 0.5) });

    // Both screens draw it on the stack, shown (not still waiting for its point).
    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      await expect
        .poll(async () => (await drawnOnStack(page, id!))?.pending === false, { timeout: 15_000, message: `${who}: the face-down spell is drawn on the stack` })
        .toBe(true);
    }
    // Past presence's hand-over and any turn-over, so what is drawn is what stays.
    await bob.page.waitForTimeout(800);

    const mine = (await drawnOnStack(alice.page, id!))!;
    const theirs = (await drawnOnStack(bob.page, id!))!;
    console.log(`[w69-facedown] alice stack: ${JSON.stringify(mine)}`);
    console.log(`[w69-facedown] bob stack: ${JSON.stringify(theirs)}`);

    // Alice: Forge lets her see her own face-down card — the Angel, with its art.
    expect(mine.name, 'alice: her face-down spell is drawn as her own card').toBe(NAME);
    expect(mine.art, 'alice: with its art').toBe(true);

    // Bob: the same back a hidden card is everywhere else, at the card's own size, never a face.
    expect(theirs.name, `bob: no face on the stack (drawn "${theirs.name ?? theirs.text ?? ''}")`).toBeNull();
    expect(theirs.text, 'bob: no text tile on the stack').toBeNull();
    expect(theirs.back, 'bob: the face-down spell is a card back').toBe(true);
    expect(theirs.backIsCard, 'bob: the hidden card’s own back (a card), not a placeholder').toBe(true);
    expect(theirs.backLabel, 'bob: named Hidden card').toBe(HIDDEN);
    const width = (s: string) => Number(s.split('×')[0]);
    expect(Math.abs(width(theirs.size) - width(theirs.card)), `bob: at a battlefield card’s width (${theirs.size} vs ${theirs.card})`).toBeLessThanOrEqual(2);

    // Hovering it opens the one inspector on that back.
    const box = (await bob.page.locator(`[data-placed-card="${id!}"]`).boundingBox())!;
    await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect.poll(() => inspected(bob.page), { timeout: 5_000, message: 'bob: hovering the face-down spell opens the inspector' }).not.toBeNull();
    const shown = (await inspected(bob.page))!;
    console.log(`[w69-facedown] bob inspector: ${JSON.stringify(shown)}`);
    expect(shown.back, 'bob: the inspector enlarges the back').toBe(true);
    expect(shown.label, 'bob: named Hidden card').toBe(HIDDEN);
    expect(shown.name, 'bob: never a face in the inspector').toBeNull();
    await bob.page.mouse.move(2, 2);

    const leaks = await naming(bob.page, NAME);
    console.log(`[w69-facedown] bob: ${leaks.length} element(s) name ${NAME}${leaks.length === 0 ? '' : `: ${leaks.join(' | ')}`}`);
    expect(leaks, `bob: nothing on his screen names ${NAME}`).toEqual([]);
  } finally {
    await stack.stop();
  }
});
