/**
 * Knowledge is sticky. The operator, 2026-10-13:
 *
 *   *"revealed hand information should always be revealed. should also include when top of deck is
 *   revealed. if goblin guide reveals top of deck. And then that card is drawn, it should be revealed in
 *   the hand. make sense?"* and *"when top of deck is revealed put it below the avatar"*
 *
 * A card a seat was shown while it sat in a hidden zone stays shown to that seat while it stays there —
 * and a revealed top card that is drawn stays shown in the hand it went to. Two real-Forge cases, two
 * screens each:
 *
 *   1. `af29-goblin-guide`: alice's Goblin Guide attacks; bob reveals Lightning Bolt off his library. It
 *      is drawn under bob's avatar on both screens while it stays on top, and once bob draws it on his
 *      turn alice's screen draws it face up in his hand. Shock, under it, never reaches alice.
 *   2. `thoughtseize`: alice takes a card; bob's other two stay face up in his hand on her screen after
 *      the choice has closed.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { clickCombat, clickHandCard, enabledOk, grindPriority, livePrompt, makeTitled, offeredNamed, resizeWindow, says } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Owner = 'you' | 'them';

/** The names `page` draws face up in `owner`'s hand. */
const handNames = (page: Page, owner: Owner): Promise<string[]> =>
  page
    .locator(`.seat [data-zone="hand"][data-owner="${owner}"] .card__name`)
    .allTextContents()
    .then((t) => t.map((s) => s.trim()).sort());

/** How many cards `page` says `owner`'s hand holds. */
const handCount = (page: Page, owner: Owner): Promise<number> =>
  page
    .locator(`.seat${owner === 'you' ? '[data-viewer]' : ':not([data-viewer])'} [data-zone="hand"]`)
    .getAttribute('data-count')
    .then((n) => Number(n ?? -1));

/** The revealed top of `owner`'s library as `page` draws it: its name, and where it sits against that seat's avatar. */
async function libraryTop(page: Page, owner: Owner): Promise<{ name: string | null; underAvatar: boolean | null }> {
  return page.evaluate((owner) => {
    const seat = document.querySelector(`.seat${owner === 'you' ? '[data-viewer]' : ':not([data-viewer])'}`);
    const top = seat?.querySelector('[data-library-top]') ?? null;
    const face = seat?.querySelector('[data-player-face]') ?? null;
    if (top === null) return { name: null, underAvatar: null };
    const name = top.querySelector('.card__name')?.textContent?.trim() ?? null;
    if (face === null) return { name, underAvatar: false };
    const t = top.getBoundingClientRect();
    const f = face.getBoundingClientRect();
    // In the avatar's own column, on the side of it away from the centre line: below it on the viewer's
    // seat, and — the opponent's seat being the board's vertical mirror — above it on theirs.
    const column = t.left < f.right && t.right > f.left;
    const side = owner === 'you' ? t.top >= f.bottom - 2 : t.bottom <= f.top + 2;
    return { name, underAvatar: column && side };
  }, owner);
}

/** Where the library top and the avatar of `owner`'s seat are on `page`, for the log. */
const geometry = (page: Page, owner: Owner): Promise<string> =>
  page.evaluate((owner) => {
    const seat = document.querySelector(`.seat${owner === 'you' ? '[data-viewer]' : ':not([data-viewer])'}`);
    const box = (el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      return r === undefined ? 'none' : `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    return `top@${box(seat?.querySelector('[data-library-top]'))} avatar@${box(seat?.querySelector('[data-player-face]'))}`;
  }, owner);

/** Whether `name` ever reached this browser in a game-state frame. */
const received = (f: Friend, name: string): boolean =>
  messages(f)
    .filter((m) => m.dir === 'in')
    .flatMap((m) => {
      const msg = m.msg as { frame?: { method?: string }; frames?: { method?: string }[] } | null;
      return [...(msg?.frames ?? []), ...(msg?.frame === undefined ? [] : [msg.frame])];
    })
    .filter((frame) => frame.method === 'setGameView' || frame.method === 'applyDelta')
    .some((frame) => JSON.stringify(frame).includes(JSON.stringify(name)));

test(titled("Goblin Guide's revealed top card sits under bob's avatar on both screens, and once drawn stays face up in his hand on alice's"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af29-goblin-guide');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    const guide = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').filter({ hasText: 'Goblin Guide' });
    await expect(guide, 'Goblin Guide is on her battlefield').toHaveCount(1, { timeout: 60_000 });
    await passToDeclareAttackers(alice.page);
    await expect(guide, 'Goblin Guide is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    expect(await clickCombat(guide), 'Goblin Guide pressed').toBe(true);
    await expect(guide, 'Forge declared it attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });

    // The trigger resolves: bob reveals Lightning Bolt, and it stays on top of his library.
    await grindPriority([alice.page, bob.page], async () => (await alice.page.getByTestId('live-reveal').count()) > 0, { timeoutMs: 45_000 });
    for (const p of [alice.page, bob.page]) {
      const ok = p.getByTestId('live-reveal-ok');
      if ((await ok.count()) > 0) await ok.click();
    }
    // Polled: the board may still be settling the frame the reveal arrived with.
    await expect.soft.poll(() => libraryTop(alice.page, 'them'), { timeout: 10_000, message: "alice's screen draws Lightning Bolt under bob's avatar" }).toEqual({ name: 'Lightning Bolt', underAvatar: true });
    await expect.soft.poll(() => libraryTop(bob.page, 'you'), { timeout: 10_000, message: "bob's screen draws it under his own avatar" }).toEqual({ name: 'Lightning Bolt', underAvatar: true });
    console.log(`[af29] after the reveal: alice's screen draws bob's top ${JSON.stringify(await libraryTop(alice.page, 'them'))} ${await geometry(alice.page, 'them')}, bob's ${JSON.stringify(await libraryTop(bob.page, 'you'))} ${await geometry(bob.page, 'you')}`);

    // Bob's turn: he draws it.
    await grindPriority([alice.page, bob.page], async () => (await handCount(alice.page, 'them')) === 1, { timeoutMs: 90_000 });
    await expect.poll(() => handNames(bob.page, 'you'), { timeout: 10_000, message: 'bob drew Lightning Bolt' }).toEqual(['Lightning Bolt']);
    const drawn = await handNames(alice.page, 'them');
    const leaks = { shockToAlice: received(alice, 'Shock'), aliceTopOnBob: (await libraryTop(bob.page, 'them')).name, bobTopNow: (await libraryTop(alice.page, 'them')).name };
    console.log(`[af29] after bob's draw: alice's screen draws his hand ${JSON.stringify(drawn)} (says "${(await says(alice.page)).trim()}"); hidden ${JSON.stringify(leaks)}`);
    expect.soft(drawn, "alice's screen draws the drawn Lightning Bolt face up in bob's hand").toEqual(['Lightning Bolt']);
    expect(leaks, 'what was never revealed is never sent, and nothing unrevealed is drawn on a library').toEqual({ shockToAlice: false, aliceTopOnBob: null, bobTopNow: null });
  } finally {
    await stack.stop();
  }
});

test(titled("Thoughtseize: bob's hand stays face up on alice's screen after her choice has closed"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'thoughtseize');
    await expect.poll(() => offeredNamed(alice.page, 'Thoughtseize'), { timeout: 45_000, message: 'alice is offered Thoughtseize' }).not.toBeUndefined();
    expect(await handNames(alice.page, 'them'), "before Thoughtseize alice's screen shows none of bob's hand").toEqual([]);

    await clickHandCard(alice.page, (await offeredNamed(alice.page, 'Thoughtseize'))!);
    const sheet = livePrompt(alice.page).first();
    const choosable = sheet.locator('[data-testid="prompt-choice"]');
    const opponentTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
    // Every other question is answered; the discard choice (Forge's reveal folded into it) is left for below.
    for (let i = 0; i < 200; i++) {
      if ((await choosable.count()) > 0) break;
      if ((await opponentTarget.count()) > 0) {
        await opponentTarget.first().locator('button').first().click({ timeout: 2_000 }).catch(() => undefined);
        continue;
      }
      if (/Pay Mana Cost/i.test(await says(alice.page)) && (await enabledOk(alice.page).count()) > 0) {
        await enabledOk(alice.page).click();
        continue;
      }
      await answerPrompt(alice.page, { leave: ['getChoices', 'chooseSingleEntityForEffect'] });
      await alice.page.waitForTimeout(50);
    }
    await expect.poll(() => choosable.count(), { timeout: 10_000, message: 'the discard choice is open' }).toBeGreaterThan(0);
    await choosable.first().click({ force: true });
    await livePrompt(alice.page).getByTestId('prompt-submit').click();
    await expect(livePrompt(alice.page), 'the choice closed').toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="graveyard"][data-owner="you"]'), 'the chosen card was discarded').toHaveAttribute('data-count', '1', { timeout: 10_000 });
    const left = await handNames(bob.page, 'you');
    expect(left, 'bob keeps two cards, the Mountain one of them').toHaveLength(2);
    expect(left).toContain('Mountain');

    const shown = await handNames(alice.page, 'them');
    console.log(`[af29] after Thoughtseize: alice's screen draws bob's hand ${JSON.stringify(shown)}; bob's own ${JSON.stringify(left)}`);
    expect(shown, "bob's two remaining cards stay face up in his hand on alice's screen").toEqual(left);
  } finally {
    await stack.stop();
  }
});
