/**
 * Full control asks only real questions. The operator, 2026-10-19:
 *
 *   "when tapping black lotus why does it ask me if i want to sacrifice? of course i do, i tapped
 *   it. for cards like timewarp, why is it asking me to 'select' an ability? there is only one
 *   valid choice here. … even in full control mode it's pointless to have selection boxes with
 *   single options like that."
 *
 * Two browsers, a real Forge match (`scenarios/fc-lotus-walk.state`), alice in full control: she
 * casts Time Walk (one ability) and taps Black Lotus (one ability, a sacrifice cost). Neither may
 * draw the ability picker, and the Lotus's "Sacrifice?" confirm is never drawn; the Lotus's colour
 * is a real choice and is still asked. Every prompt alice's page draws is recorded from the DOM, so
 * a red run names what was asked.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that says why, when Forge is
 * absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { castByDrag, enabledOk, handCardNamed, makeTitled, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Record every prompt and decision pop-up the page draws, from now on: `method` or `decision:<text>`. */
async function recordPrompts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __fcSeen: string[] }).__fcSeen = seen;
    const note = (entry: string) => {
      if (seen.at(-1) !== entry) seen.push(entry);
    };
    const look = () => {
      for (const el of document.querySelectorAll('[data-testid="live-prompt"]')) note(el.getAttribute('data-method') ?? '?');
      for (const el of document.querySelectorAll('[data-testid="live-decision-host"]')) note(`decision:${(el.textContent ?? '').trim().slice(0, 80)}`);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    look();
  });
}

const seenOn = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __fcSeen: string[] }).__fcSeen);

const battlefieldCard = (page: Page, name: string) =>
  page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]', { has: page.locator('.card__name', { hasText: name }) });

test(titled('full control: casting Time Walk and tapping Black Lotus draw no ability picker and no sacrifice confirm'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'fc-lotus-walk');
    const page = alice.page;
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await recordPrompts(page);

    /* ── Time Walk: one ability, so the cast asks nothing before its payment ── */
    const walk = await handCardNamed(page, 'Time Walk');
    expect(walk, 'Time Walk is in alice’s hand').not.toBeUndefined();
    const field = (await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await castByDrag(page, stack, walk!, { x: field.x + field.width * 0.5, y: field.y + field.height * 0.5 });
    console.log(`[fc] after Time Walk: seen=${JSON.stringify(await seenOn(page))}`);

    /* ── Black Lotus: tap it; the colour is the only question ── */
    const lotus = battlefieldCard(page, 'Black Lotus');
    await expect(lotus).toHaveCount(1);
    await expect
      .poll(
        async () => {
          if ((await lotus.count()) === 0) return true;
          const asked = await answerPrompt(page);
          if (asked === null) {
            // Anything Forge put to her that is not an ask (a confirm's Yes) is answered too, so a red
            // run reaches the assertions below and names what was asked.
            const decision = page.getByTestId('live-decision-host');
            if ((await decision.count()) > 0 && /Sacrifice/i.test((await decision.textContent()) ?? '')) {
              await enabledOk(page).first().click({ timeout: 1_500 }).catch(() => undefined);
            } else {
              const box = await lotus.first().boundingBox();
              if (box !== null && (await page.locator('[data-testid="live-prompt"]').count()) === 0) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            }
          }
          return false;
        },
        { timeout: 30_000, intervals: [400], message: 'Black Lotus left alice’s battlefield' },
      )
      .toBe(true);

    const seen = await seenOn(page);
    const confirmed = serverLog(stack).filter((r) => r.evt === 'auto-confirmed' && r.seat === 0);
    console.log(`[fc] seen=${JSON.stringify(seen)} autoConfirmed=${JSON.stringify(confirmed.map((r) => r.why))}`);
    expect(seen.filter((s) => s === 'getAbilityToPlay'), 'no ability picker was drawn').toEqual([]);
    expect(seen.filter((s) => /Sacrifice/i.test(s)), 'no sacrifice confirm was drawn').toEqual([]);
    expect(seen, 'the colour is still hers to choose').toContain('getChoices');
    expect(confirmed.map((r) => r.why), 'the server answered the sacrifice for her').toContain('the seat chose this ability just before');
  } finally {
    await stack.stop();
  }
});
