/**
 * A played card waits over the board for as long as Forge's question about it is open, and the
 * question shows the card it comes from. The operator, 2026-10-15, on Cavern of Souls: *"i notice
 * Cavern of Souls return to my hand while it's waiting on a 'choose 1' effect … cards should never
 * time out and return to hand while decisions like this are on the screen"*, and *"why does it just
 * say 'Choose 1' it should show the effect text of cavern of souls"*.
 *
 * `cv-cavern.state`: alice holds only Cavern of Souls. She plays it, and Forge asks its
 * "As Cavern of Souls enters, choose a creature type" (an ETB replacement, run while the land is
 * still in her hand). She takes longer than the park clock (`PARK_UNANSWERED_MS`, 4 s) to answer:
 * every frame while the question is up, the land is still over the board — never floating back,
 * never drawn in the hand again — and the question draws Cavern's face and Forge's own text for
 * the effect. Answered, Cavern is on her battlefield with the type she named.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Longer than the park clock (`PARK_UNANSWERED_MS`, 4 s) with room for a tick of it. */
const THINKING_MS = 6_000;

interface Frame {
  t: number;
  prompt: string | null;
  /** The card's own element in alice's hand is drawn there, with no lift: it is back in the hand. */
  inHand: boolean;
  /** `data-cast-lift` on the card's own element or on its stand-in. */
  lift: string | null;
}

async function record(page: Page, id: number): Promise<void> {
  await page.evaluate((card) => {
    const state = { frames: [] as unknown[], run: true };
    (window as unknown as { __cvPark: typeof state }).__cvPark = state;
    const tick = (): void => {
      if (!state.run) return;
      const el = document.querySelector<HTMLElement>(`.seat[data-viewer] [data-zone="hand"] [data-board-card="${card}"]`);
      const ghost = document.querySelector(`[data-cast-ghost="${card}"]`);
      const lift = el?.getAttribute('data-cast-lift') ?? ghost?.getAttribute('data-cast-lift') ?? null;
      state.frames.push({
        t: Math.round(performance.now()),
        prompt: document.querySelector('[data-testid="live-prompt"]')?.getAttribute('data-method') ?? null,
        inHand: el !== null && !el.hasAttribute('data-cast-lift') && getComputedStyle(el).visibility !== 'hidden',
        lift,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

async function recording(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const state = (window as unknown as { __cvPark: { frames: Frame[]; run: boolean } }).__cvPark;
    state.run = false;
    return state.frames;
  });
}

test(titled('a played Cavern of Souls waits over the board while its creature-type question is open, and the question shows Cavern'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'cv-cavern');
    const page = seated.alice.page;
    await expect.poll(() => handCardNamed(page, 'Cavern of Souls'), { timeout: 30_000, message: 'alice holds Cavern of Souls' }).not.toBeUndefined();
    const cavern = (await handCardNamed(page, 'Cavern of Souls'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Cavern of Souls is offered to play' }).toContain(cavern);

    await record(page, cavern);
    expect(await clickHandCard(page, cavern), 'Cavern of Souls lifted out of alice’s hand').toBe(true);
    const sheet = page.locator('[data-testid="live-prompt"][data-method="getChoices"]');
    await expect(sheet, `Cavern asks for a creature type — says: "${await says(page)}"`).toBeVisible({ timeout: 15_000 });

    // The operator taking their time over it.
    await page.waitForTimeout(THINKING_MS);
    await expect(sheet, 'the question is still open').toBeVisible();

    const face = sheet.locator(`[data-thumb="card"][data-card-id="${cavern}"]`);
    const text = (await sheet.textContent()) ?? '';
    console.log(`[cv] prompt text: ${JSON.stringify(text.slice(0, 200))} face=${await face.count()}`);
    await expect.soft(face, 'the question draws the card it comes from').toHaveCount(1);
    expect.soft(text, 'and Forge’s own text for the effect').toContain('As Cavern of Souls enters, choose a creature type.');

    await sheet.getByRole('checkbox', { name: 'Goblin', exact: true }).dispatchEvent('click');
    await sheet.getByTestId('prompt-submit').click();
    await expect(sheet, 'the question closed once answered').toHaveCount(0, { timeout: 15_000 });

    const frames = await recording(page);
    const asked = frames.filter((f) => f.prompt === 'getChoices');
    const home = asked.filter((f) => f.inHand || f.lift === 'returning');
    console.log(`[cv] frames=${frames.length} asked=${asked.length} home=${home.length} first-home=${JSON.stringify(home[0] ?? null)}`);
    expect(asked.length, 'the question was up for many frames').toBeGreaterThan(30);
    expect(home.length, `while the question is up, Cavern never goes back to the hand — first: ${JSON.stringify(home[0] ?? null)}`).toBe(0);

    const onBoard = page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-board-card="${cavern}"]`);
    await expect(onBoard, 'Cavern of Souls entered alice’s battlefield').toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.seat[data-viewer] [data-zone="battlefield"] .board-card__tags > [data-choice="type"]'), 'with the type she named').toHaveText('Goblin');
    await expect(page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'nothing is left over the board').toHaveCount(0, { timeout: 5_000 });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
