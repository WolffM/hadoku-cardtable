/**
 * The operator, 2026-10-15: *"much like how we created a pill for cost reduction in hand, let's also
 * create an 'eye' pill for cards that have been revealed to your opponent"*.
 *
 * Real Forge, scenario `ey-seen`: alice's Thoughtseize shows her bob's hand and takes his Lightning
 * Bolt. Bob's own screen then wears the eye on exactly the two cards she saw (Timetwister, Mountain),
 * and not on the Shock he draws next turn. Bob casts Timetwister: his hand is shuffled into his
 * library, alice knows none of it, and no card of bob's wears the eye. Alice's screen draws no eye
 * at all, and no frame she receives names anyone but her in a card's `PlayerMayLook` — the fact goes
 * to the card's holder only — nor the Shock she was never shown.
 *
 * `[ey-shot before|after] <base64 jpeg>` lines carry bob's hand before and after Thoughtseize.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { castCard, clickHandCard, clickOnce, enabledOk, grindPriority, livePrompt, makeTitled, offeredNamed, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[ey-seen] ${JSON.stringify({ step, data })}`);

/** Each card in `page`'s own hand, by name, and whether it wears the eye. */
const ownHand = (page: Page): Promise<{ name: string; seen: boolean }[]> =>
  page
    .locator('.seat[data-viewer] [data-zone="hand"] li.board-card')
    .evaluateAll((els) =>
      els.map((e) => ({ name: e.querySelector('.card__name')?.textContent?.trim() ?? '', seen: e.querySelector(':scope > .board-card__tags > [data-seen]') !== null })),
    );

const seenNames = async (page: Page): Promise<string[]> => (await ownHand(page)).filter((c) => c.seen).map((c) => c.name).sort();

/** The game-state frames this browser received, as JSON. */
const stateFrames = (f: Friend): string[] =>
  messages(f)
    .filter((m) => m.dir === 'in')
    .flatMap((m) => {
      const msg = m.msg as { frame?: { method?: string }; frames?: { method?: string }[] } | null;
      return [...(msg?.frames ?? []), ...(msg?.frame === undefined ? [] : [msg.frame])];
    })
    .filter((frame) => ['setGameView', 'applyDelta', 'openView'].includes(frame.method ?? ''))
    .map((frame) => JSON.stringify(frame));

/** Every player id any `PlayerMayLook` in these frames names. */
function lookIds(frames: readonly string[]): number[] {
  const ids = new Set<number>();
  for (const frame of frames) {
    for (const [, list] of frame.matchAll(/"PlayerMayLook":\{"t":"(?:list|set)","v":\[([^\]]*)\]/g)) {
      for (const [, id] of list!.matchAll(/"v":(\d+)/g)) ids.add(Number(id));
    }
  }
  return [...ids].sort();
}

async function shot(page: Page, label: string): Promise<void> {
  const jpeg = await page.locator('.seat[data-viewer] [data-zone="hand"]').screenshot({ type: 'jpeg', quality: 80 });
  console.log(`[ey-shot ${label}] ${jpeg.toString('base64')}`);
}

test(titled("an eye on exactly bob's cards alice saw, on bob's screen only, gone once they are shuffled away"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ey-seen');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => offeredNamed(alice.page, 'Thoughtseize'), { timeout: 45_000, message: 'alice is offered Thoughtseize' }).not.toBeUndefined();
    await expect.poll(async () => (await ownHand(bob.page)).length, { timeout: 10_000, message: "bob's hand is drawn" }).toBe(3);
    expect(await seenNames(bob.page), 'before Thoughtseize nothing of bob has been seen').toEqual([]);
    await shot(bob.page, 'before');

    await clickHandCard(alice.page, (await offeredNamed(alice.page, 'Thoughtseize'))!);
    const choosable = livePrompt(alice.page).first().locator('[data-testid="prompt-choice"]');
    const opponentTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
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
    // The choice is an input inside the label that draws the card: Lightning Bolt by its label.
    await livePrompt(alice.page).first().locator('label').filter({ hasText: 'Lightning Bolt' }).locator('[data-testid="prompt-choice"]').first().click({ force: true });
    await livePrompt(alice.page).getByTestId('prompt-submit').click();
    await expect(livePrompt(alice.page), 'the choice closed').toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="graveyard"][data-owner="you"]'), 'Lightning Bolt was discarded').toHaveAttribute('data-count', '1', { timeout: 10_000 });

    await expect
      .poll(() => seenNames(bob.page), { timeout: 10_000, message: "bob's screen wears the eye on the two cards alice saw" })
      .toEqual(['Mountain', 'Timetwister']);
    await shot(bob.page, 'after');
    log('after Thoughtseize', { bob: await ownHand(bob.page), alice: await ownHand(alice.page) });

    // Bob's turn: he draws a Shock alice never saw, then casts Timetwister.
    // Never pass bob's own precombat main: that is where he casts it.
    const bobsMain = (text: string): boolean => /Turn: \d+ \(Bob\)[\s\S]*Main phase, precombat/.test(text);
    await grindPriority([alice.page, bob.page], async () => (await offeredNamed(bob.page, 'Timetwister')) !== undefined, {
      timeoutMs: 90_000,
      press: async (page) => {
        const text = await says(page);
        if (page === bob.page && bobsMain(text)) return;
        if ((await enabledOk(page).count()) > 0) await clickOnce(page, text, 'ok');
      },
    });
    const drawn = await ownHand(bob.page);
    log("bob's turn", { bob: drawn });
    expect(drawn.find((c) => c.name === 'Shock'), 'bob drew a Shock').toBeDefined();
    expect(await seenNames(bob.page), 'the drawn Shock wears no eye; the seen two still do').toEqual(['Mountain', 'Timetwister']);

    // The first act after the turn passes can be dropped (`castCard`'s own note): cast again while it is still offered.
    const twisted = async (): Promise<boolean> =>
      (await bob.page.locator('.seat[data-viewer] [data-zone="graveyard"] .card__name').allTextContents()).some((n) => n.trim() === 'Timetwister');
    await expect
      .poll(
        async () => {
          if ((await stackCount(bob.page)) > 0 || (await twisted())) return true;
          const id = await offeredNamed(bob.page, 'Timetwister');
          if (id !== undefined) await castCard(bob.page, id).catch(() => undefined);
          return (await stackCount(bob.page)) > 0 || twisted();
        },
        { timeout: 30_000, message: 'Timetwister reached the stack' },
      )
      .toBe(true);
    await grindPriority([alice.page, bob.page], async () => (await twisted()) && (await ownHand(bob.page)).length === 7, { timeoutMs: 60_000 });
    const after = await ownHand(bob.page);
    const aliceSees = await alice.page.locator('.seat:not([data-viewer]) [data-zone="hand"] .card__name').allTextContents();
    log('after Timetwister', { bob: after, aliceSeesOfBobsHand: aliceSees });
    expect(after.filter((c) => c.seen), 'shuffled away, nothing of bob is known to alice').toEqual([]);
    expect(aliceSees, "and alice's screen draws none of bob's new hand face up").toEqual([]);

    const aliceFrames = stateFrames(alice);
    const aliceId = Number(/"myPlayers":\[(\d+)/.exec(aliceFrames.find((f) => f.includes('"openView"')) ?? '')?.[1] ?? NaN);
    const leaks = { aliceEyes: await alice.page.locator('[data-seen]').count(), looksAliceGot: lookIds(aliceFrames), aliceId, shock: aliceFrames.some((f) => f.includes('"Shock"')) };
    log('alice', leaks);
    expect(Number.isInteger(aliceId), "alice's player id").toBe(true);
    expect(leaks, 'alice wears no eye, is named alone in any look she receives, and never receives the Shock').toEqual({
      aliceEyes: 0,
      looksAliceGot: [aliceId],
      aliceId,
      shock: false,
    });
  } finally {
    await stack.stop();
  }
});
