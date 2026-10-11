/**
 * The operator, 2026-10-11, Cabal Therapy: *"after the spell resolved i am softlocked, it should have
 * shown me something to let me name a card"* … *"oh i see it now, but it took FOREVER to show the
 * picker."* Forge's name-a-card ask offered 33,659 names in one 1.8 MB frame; the browser drew every
 * one, and the tab froze until socket.io's ping timed out.
 *
 * Alice casts Cabal Therapy at bob in a Legacy 2005 table. The picker must be on her screen within
 * 500 ms of the ask's frame arriving; it is a search, offering only names legal in the format; she
 * types part of a name and presses Enter, and bob's Grizzly Bears goes to his graveyard on both
 * screens with nobody disconnected.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, livePrompt, makeTitled, offeredNamed, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { playMessagesIn } from './play/frames.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const nameAsk = (page: Page) => page.locator('[data-testid="live-prompt"][data-method="getChoices"]').filter({ hasText: /card name/i });
const zoneNames = (page: Page, zone: 'hand' | 'graveyard', owner: 'you' | 'them') =>
  page.locator(`[data-zone="${zone}"][data-owner="${owner}"] [data-board-card] .card__name`).allTextContents();

/** When the name ask's prompt reached the DOM, and when the frame after it was painted (wall clock, ms). */
async function watchForPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ggPicker?: { dom?: number; painted?: number } };
    w.__ggPicker = {};
    const seen = () => {
      const el = document.querySelector('[data-testid="live-prompt"][data-method="getChoices"]');
      if (el === null || !/card name/i.test(el.textContent ?? '') || w.__ggPicker!.dom !== undefined) return;
      w.__ggPicker!.dom = Date.now();
      requestAnimationFrame(() => setTimeout(() => (w.__ggPicker!.painted = Date.now()), 0));
    };
    new MutationObserver(seen).observe(document.body, { subtree: true, childList: true });
  });
}

const pickerAt = (page: Page) => page.evaluate(() => (window as unknown as { __ggPicker?: { dom?: number; painted?: number } }).__ggPicker ?? {});

test(titled('Cabal Therapy: the name picker is up at once, offers the format’s names, and the named card is discarded on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob, matchId } = await startScenarioMatch(browser, stack, 'w69-name-card');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    await watchForPicker(alice.page);
    const castAt = Date.now();

    await expect.poll(() => offeredNamed(alice.page, 'Cabal Therapy'), { timeout: 45_000, message: 'alice is offered Cabal Therapy' }).not.toBeUndefined();
    await clickHandCard(alice.page, (await offeredNamed(alice.page, 'Cabal Therapy'))!);

    // Bob is the target; the Swamp pays; both pass until it resolves and Forge asks alice for a name.
    const bobTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
    const deadline = Date.now() + 90_000;
    while ((await nameAsk(alice.page).count()) === 0 && Date.now() < deadline) {
      if ((await bobTarget.count()) > 0) {
        await bobTarget.first().locator('button').first().click({ timeout: 1_000 }).catch(() => undefined);
        continue;
      }
      await pressPaymentAuto(alice.page);
      if ((await nameAsk(alice.page).count()) > 0) break;
      for (const p of [alice.page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && (await nameAsk(alice.page).count()) === 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(100);
    }
    await expect(nameAsk(alice.page), 'Forge asks alice to name a card').toHaveCount(1, { timeout: 120_000 });
    await expect.poll(async () => (await pickerAt(alice.page)).painted, { timeout: 120_000, message: 'the picker is painted' }).not.toBeUndefined();

    // The ask's own frame, as alice's browser received it.
    const frame = alice.captures.find((c) => c.dir === 'in' && c.t >= castAt && c.text.includes('"getChoices"') && /card name/i.test(c.text));
    expect(frame, 'the name ask reached alice’s browser').toBeDefined();
    const ask = (playMessagesIn(frame!)[0]?.msg as { frame?: { names?: string[]; choices: unknown[] } } | undefined)?.frame;
    const parsed = ask?.names !== undefined ? 'names' : 'choices';
    const count = ask?.names?.length ?? ask?.choices.length ?? 0;
    const at = await pickerAt(alice.page);
    const toDom = at.dom! - frame!.t;
    const toPaint = at.painted! - frame!.t;
    const asked = serverLog(stack).find((r) => r.evt === 'name-ask' && r.matchId === matchId);
    console.log(
      `[gg-name] format=${String(asked?.format ?? 'none')} offered=${String(asked?.offered ?? '?')} shown=${String(asked?.shown ?? count)} wire=${parsed} count=${count} frameBytes=${frame!.text.length} toPickerDom=${toDom}ms toPickerPainted=${toPaint}ms`,
    );
    expect(toPaint, 'the picker took FOREVER to show').toBeLessThan(500);

    // A search: a name outside Legacy 2005 is not offered; part of a name in it finds it.
    const search = alice.page.getByTestId('prompt-name-search');
    await expect(search, 'the picker is a search').toBeVisible();
    const options = alice.page.getByTestId('prompt-name-option');
    await search.pressSequentially('goblin gui');
    await alice.page.waitForTimeout(300);
    const goblins = await options.allTextContents();
    console.log(`[gg-name] "goblin gui" offers: ${JSON.stringify(goblins)}`);
    expect(goblins, 'Goblin Guide (2010) is not offered in Legacy 2005').not.toContain('Goblin Guide');
    await search.fill('');
    await search.pressSequentially('grizz');
    await expect(options.first(), 'typing part of the name finds it').toHaveText('Grizzly Bears');
    await search.press('Enter');
    await expect(nameAsk(alice.page), 'Enter names it').toHaveCount(0, { timeout: 10_000 });

    // Bob discards it: gone from his hand, in his graveyard, on both screens.
    await expect.poll(() => zoneNames(bob.page, 'graveyard', 'you'), { timeout: 30_000, message: 'bob’s Grizzly Bears is in his graveyard' }).toContain('Grizzly Bears');
    await expect.poll(() => zoneNames(alice.page, 'graveyard', 'them'), { timeout: 15_000, message: 'alice sees it in bob’s graveyard' }).toContain('Grizzly Bears');
    const bobHand = await zoneNames(bob.page, 'hand', 'you');
    console.log(`[gg-name] after: bob's hand ${JSON.stringify(bobHand)}; alice says "${await says(alice.page)}"`);
    expect(bobHand, 'only the named card left his hand').toEqual(expect.arrayContaining(['Llanowar Elves', 'Mountain']));
    expect(bobHand).not.toContain('Grizzly Bears');

    const dropped = serverLog(stack).filter((r) => r.matchId === matchId && (r.evt === 'seat-departing' || (r.evt === 'ask-aborted' && r.reason === 'disconnected')));
    console.log(`[gg-name] disconnects: ${dropped.length}`);
    expect(dropped, 'nobody disconnected').toEqual([]);
    await expect(livePrompt(alice.page), 'nothing is left open for alice').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
