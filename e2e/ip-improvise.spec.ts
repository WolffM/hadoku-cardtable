/**
 * The operator, 2026-10-20 (match m-e6863c7810f1): *"i just tried to play an improvise creature and it
 * showed 'select artifacts to reduce cost' and none of my artifacts were selectable. … i had a ton of
 * artifacts in play."*
 *
 * Forge asks which artifacts to tap for improvise (and which creatures for convoke) through
 * `InputSelectCardsForConvokeOrImprovise`, which never names its cards to the GUI; the bridge now
 * publishes them (`PlayBridge.java`'s `syncConvokeSelectables`). Scenario `ip-improvise`: alice holds
 * Kappa Cannoneer ({5}{U}, improvise) with six Islands and four Mishra's Baubles; `ip-convoke`: Siege
 * Wurm ({5}{G}{G}, convoke) with seven Forests and three Grizzly Bears. She casts it, the pick pops up
 * offering every one of them, she taps them all, presses Done, and the spell resolves with only the
 * rest paid from her lands.
 *
 * `[ip]` lines are the evidence: what her screen says and offers while Forge waits on the pick.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { answerPrompt } from './play/prompts.ts';
import { boardCard, clickHandCard, drawnText, handCardNamed, isOffered, isTapped, makeTitled, offered, ownNamed, pressOffered, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The selection pop-up's text, or null when it is not drawn. */
const selectionPopup = (page: Page): Promise<string | null> => drawnText(page, 'live-selection-host');

const drawn = async (page: Page): Promise<string> =>
  `says="${(await says(page)).replace(/\s+/g, ' ')}" popup=${JSON.stringify(await selectionPopup(page))} offered=${JSON.stringify(await offered(page))}`;

for (const { scenario, spell, tapper, land, keyword, cmc } of [
  { scenario: 'ip-improvise', spell: 'Kappa Cannoneer', tapper: "Mishra's Bauble", land: 'Island', keyword: 'Improvise', cmc: 6 },
  { scenario: 'ip-convoke', spell: 'Siege Wurm', tapper: 'Grizzly Bears', land: 'Forest', keyword: 'Convoke', cmc: 7 },
]) test(titled(`${keyword}: casting ${spell} offers every untapped ${tapper}, and tapping them pays for it`), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, scenario);
    const page = alice.page;
    await expect.poll(() => handCardNamed(page, spell), { timeout: 30_000, message: `alice holds ${spell}` }).not.toBeUndefined();
    const card = (await handCardNamed(page, spell))!;
    const tappers = await ownNamed(page, tapper);
    const lands = await ownNamed(page, land);
    expect(tappers.length, `alice has her ${tapper}s`).toBeGreaterThan(0);
    await expect.poll(() => offered(page), { timeout: 45_000, message: `${spell} is offered` }).toContain(card);

    expect(await clickHandCard(page, card), `${spell} lifted and cast`).toBe(true);

    for (const id of tappers) {
      await expect.poll(() => isOffered(page, id), { timeout: 15_000, message: `${tapper} ${id} is offered for ${keyword} — ${await drawn(page)}` }).toBe(true);
    }
    console.log(`[ip] ${keyword} asked: ${await drawn(page)}`);
    await expect.poll(() => selectionPopup(page), { timeout: 5_000, message: `the pick pops up — ${await drawn(page)}` }).toMatch(new RegExp(`for ${keyword}`, 'i'));
    await expect
      .poll(() => serverLog(stack).find((r) => r.evt === 'client' && r.seat === 0 && r.what === 'pick-drawn' && r.at === '3s'), { timeout: 10_000, message: 'the pick is recorded' })
      .toMatchObject({ selection: 'on-board', popup: true });

    for (const id of tappers) {
      const before = await says(page);
      expect(await pressOffered(boardCard(page, id)), `alice taps ${tapper} ${id}`).toBe(true);
      // Forge re-words the pick with what is left to pay after each one.
      await expect.poll(() => says(page), { timeout: 10_000, message: `the remaining cost shrinks after ${id} — ${await drawn(page)}` }).not.toBe(before);
    }
    console.log(`[ip] all picked: ${await drawn(page)}`);
    await page.getByTestId('selection-done').click();

    await expect
      .poll(
        async () => {
          await answerPrompt(page);
          return (await ownNamed(page, spell)).length;
        },
        { timeout: 30_000, message: `${spell} resolved — ${await drawn(page)}` },
      )
      .toBe(1);
    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'the stack is empty' }).toBe(0);
    for (const id of tappers) expect(await isTapped(page, id), `${tapper} ${id} tapped for ${keyword}`).toBe(true);
    const tappedLands = (await Promise.all(lands.map((id) => isTapped(page, id)))).filter(Boolean).length;
    expect(tappedLands, `${land}s paid only the ${cmc - tappers.length} ${keyword} left`).toBe(cmc - tappers.length);
    expect(serverLog(stack).some((r) => r.evt === 'auto-paid' && r.seat === 0), 'the rest was paid for her').toBe(true);
  } finally {
    await stack.stop();
  }
});
