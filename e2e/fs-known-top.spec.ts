/**
 * The operator, 2026-10-19:
 *
 *   *"when 'fate seal' happens and the card stays on top, it should stay revealed for the player who has
 *   that knowledge. the special zone we created for that should be used for this. I notice it was there
 *   for a moment but then disappeared. aside from opponent seeing it, we should also utilize this zone for
 *   when you have cards that let you look at the top of your library"*
 *
 * A library's top cards a seat looked at stay drawn in that library's top-card zone (under its owner's
 * avatar) on that seat's screen, top first, for as long as they stay on top in that order — and on no
 * other screen. Two real-Forge cases, two screens each, each screen sampled every 25 ms from the look on:
 *
 *   1. `fs-fate-seal`: alice's Jace, the Mind Sculptor +2 looks at bob's top card, Lightning Bolt, and she
 *      keeps it there. Alice's screen draws it under bob's avatar from her answer until bob draws it on his
 *      turn; bob's screen draws nothing on his library; Shock, under it, never reaches alice.
 *   2. `fs-scry-keep`: alice's Serum Visions draws, then scries 2 and keeps both, Lightning Bolt over
 *      Shock. Her screen draws both on her library, top first, through the rest of her turn; bob's draws
 *      nothing on hers and is never sent either name.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { castCard, clickHandCard, clickPermanent, enabledOk, grindPriority, handCardNamed, livePrompt, makeTitled, offered, offeredNamed, promptMethod, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Sample {
  t: number;
  /** The names this screen draws in each seat's library top zone, top first. */
  you: string[];
  them: string[];
  /** How many cards each seat's hand holds, as this screen counts them. */
  youHand: number;
  themHand: number;
}

/** Start sampling `page`'s library top zones every 25 ms, keeping each change. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fsTops: unknown[] };
    w.__fsTops = [];
    let last = '';
    const seat = (viewer: boolean) => document.querySelector(`.seat${viewer ? '[data-viewer]' : ':not([data-viewer])'}`);
    const tops = (viewer: boolean) => [...(seat(viewer)?.querySelectorAll('[data-library-top]') ?? [])].map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? '?');
    const hand = (viewer: boolean) => Number(seat(viewer)?.querySelector('[data-zone="hand"]')?.getAttribute('data-count') ?? -1);
    setInterval(() => {
      const now = { you: tops(true), them: tops(false), youHand: hand(true), themHand: hand(false) };
      const key = JSON.stringify(now);
      if (key === last) return;
      last = key;
      w.__fsTops.push({ t: Math.round(performance.now()), ...now });
    }, 25);
  });
}

const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as unknown as { __fsTops: Sample[] }).__fsTops);
const clock = (page: Page): Promise<number> => page.evaluate(() => Math.round(performance.now()));

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

async function ownPermanent(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]')
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 45_000, message: `${name} is on alice's battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

test(titled("Fate Seal: Jace's +2 keeps bob's Lightning Bolt on top — alice's screen draws it under bob's avatar until he draws it, bob's draws nothing"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'fs-fate-seal');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const jace = await ownPermanent(alice.page, 'Jace, the Mind Sculptor');
    for (const p of [alice.page, bob.page]) await record(p);

    expect(await clickPermanent(alice.page, jace), 'Jace is offered').toBe(true);
    const plusTwo = alice.page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: 'Look at the top card' });
    const opponentTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
    // Everything up to the look: the ability, its target, priority on its way off the stack.
    await expect
      .poll(
        async () => {
          const method = await promptMethod(alice.page);
          if (method === 'chooseEntitiesForEffect') return method;
          if ((await plusTwo.count()) > 0) await plusTwo.first().click({ timeout: 1_000 }).catch(() => undefined);
          else if ((await opponentTarget.count()) > 0) await opponentTarget.first().locator('button').first().click({ timeout: 1_000 }).catch(() => undefined);
          else if (method !== null) await answerPrompt(alice.page).catch(() => undefined);
          for (const p of [alice.page, bob.page]) if ((await stackCount(p)) > 0 && (await enabledOk(p).count()) > 0) await enabledOk(p).first().click({ timeout: 1_000 }).catch(() => undefined);
          return method ?? 'none';
        },
        { timeout: 45_000, intervals: [100], message: "the +2's look opens on alice's screen" },
      )
      .toBe('chooseEntitiesForEffect');
    // Nothing to the bottom: the Bolt stays on top.
    await livePrompt(alice.page).getByTestId('prompt-submit').click();
    await expect(livePrompt(alice.page), 'the look closed').toHaveCount(0, { timeout: 10_000 });
    const answered = await clock(alice.page);
    console.log(`[fs-known-top] fate seal answered at ${answered}; alice says "${(await says(alice.page)).trim()}"`);

    // More of alice's turn: she plays her Island — frames that move other cards, none of bob's library.
    const island = (await handCardNamed(alice.page, 'Island'))!;
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered her Island' }).toContain(island);
    expect(await clickHandCard(alice.page, island, { row: 'back' }), 'the Island is played').toBe(true);
    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 15_000, message: `the Island left her hand — says: "${await says(alice.page)}"` }).toBeUndefined();
    await alice.page.waitForTimeout(1_000);
    const beforeReload = await samples(alice.page);
    const reloadedAt = await clock(alice.page);
    // And she comes back to the table: what she knows is still hers.
    await alice.page.reload();
    await expect(alice.page.locator('.seat:not([data-viewer]) [data-player-face]'), 'alice is back at the table').toHaveCount(1, { timeout: 30_000 });
    await record(alice.page);

    // On through the rest of alice's turn until bob draws the Bolt on his.
    await grindPriority([alice.page, bob.page], async () => (await bob.page.locator('[data-zone="hand"][data-owner="you"] .card__name').allTextContents()).some((n) => n.trim() === 'Lightning Bolt'), { timeoutMs: 90_000 });
    await alice.page.waitForTimeout(500);

    const afterReload = await samples(alice.page);
    const seenByBob = await samples(bob.page);
    console.log(`[fs-known-top] alice's screen before her reload at ${reloadedAt}: ${JSON.stringify(beforeReload.map((s) => [s.t, s.them, s.youHand, s.themHand]))}`);
    console.log(`[fs-known-top] alice's screen after it: ${JSON.stringify(afterReload.map((s) => [s.t, s.them, s.themHand]))}`);
    console.log(`[fs-known-top] bob's screen: ${JSON.stringify(seenByBob.map((s) => [s.t, s.you, s.youHand]))}`);
    // The state at the answer, then every change until the reload.
    const atAnswer = beforeReload.filter((s) => s.t <= answered).at(-1);
    const between = [...(atAnswer === undefined ? [] : [{ ...atAnswer, t: answered }]), ...beforeReload.filter((s) => s.t > answered)];
    // A frame or two after the answer may still be settling: from the first sample that draws it on.
    const shownFrom = between.findIndex((s) => s.them.length > 0);
    expect(shownFrom, "alice's screen draws bob's kept top card after her answer").toBeGreaterThanOrEqual(0);
    expect(between[shownFrom]!.t - answered, 'within 3 s of the answer').toBeLessThan(3_000);
    const gone = between.slice(shownFrom).filter((s) => JSON.stringify(s.them) !== JSON.stringify(['Lightning Bolt']));
    expect(gone, "alice's screen draws Lightning Bolt on bob's library from then on, through her Island").toEqual([]);
    expect(between.at(-1)!.youHand, 'her Island was played meanwhile: Opt is all she holds').toBe(1);
    // After the reload: from its first drawing of the Bolt until bob draws it.
    const drawnAt = afterReload.find((s) => s.themHand > 0)?.t ?? Infinity;
    const back = afterReload.filter((s) => s.t < drawnAt);
    const backFrom = back.findIndex((s) => s.them.length > 0);
    expect(backFrom, "after the reload alice's screen draws bob's top card again").toBeGreaterThanOrEqual(0);
    const goneAfter = back.slice(Math.max(0, backFrom)).filter((s) => JSON.stringify(s.them) !== JSON.stringify(['Lightning Bolt']));
    expect(goneAfter, 'and after the reload, until bob draws it').toEqual([]);
    expect(seenByBob.filter((s) => s.you.length > 0), "bob's screen never draws a card on his own library").toEqual([]);
    expect(received(alice, 'Shock'), 'Shock, under it, never reaches alice').toBe(false);
  } finally {
    await stack.stop();
  }
});

test(titled('Scry keep: Serum Visions keeps Lightning Bolt over Shock — alice’s screen draws both on her library, top first; bob’s draws nothing and is never sent either'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'fs-scry-keep');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => offeredNamed(alice.page, 'Serum Visions'), { timeout: 45_000, message: 'alice is offered Serum Visions' }).not.toBeUndefined();
    for (const p of [alice.page, bob.page]) await record(p);
    await castCard(alice.page, (await offeredNamed(alice.page, 'Serum Visions'))!);
    await expect
      .poll(
        async () => {
          const method = await promptMethod(alice.page);
          if (method === 'order') return method;
          for (const p of [alice.page, bob.page]) if ((await stackCount(p)) > 0 && (await enabledOk(p).count()) > 0) await enabledOk(p).first().click({ timeout: 1_000 }).catch(() => undefined);
          return method ?? 'none';
        },
        { timeout: 45_000, intervals: [100], message: "the scry opens on alice's screen" },
      )
      .toBe('order');
    const top = await livePrompt(alice.page).getByTestId('order-source').locator(':scope > li .card__name').allTextContents();
    console.log(`[fs-known-top] the scry's top group: ${JSON.stringify(top.map((n) => n.trim()))}`);
    // Both start on top: keep them there.
    await livePrompt(alice.page).getByTestId('prompt-submit').click();
    await expect(livePrompt(alice.page), 'the scry closed').toHaveCount(0, { timeout: 10_000 });
    const answered = await clock(alice.page);

    // On to bob's turn: alice's own library is not drawn from on his.
    await grindPriority([alice.page, bob.page], async () => /Turn: 2/.test(await says(bob.page)), { timeoutMs: 90_000 });
    await alice.page.waitForTimeout(1_000);
    const seenByAlice = await samples(alice.page);
    const seenByBob = await samples(bob.page);
    console.log(`[fs-known-top] alice's screen: ${JSON.stringify(seenByAlice.map((s) => [s.t, s.you]))}`);
    console.log(`[fs-known-top] bob's screen: ${JSON.stringify(seenByBob.map((s) => [s.t, s.them]))}`);
    const atAnswer = seenByAlice.filter((s) => s.t <= answered).at(-1);
    const after = [...(atAnswer === undefined ? [] : [{ ...atAnswer, t: answered }]), ...seenByAlice.filter((s) => s.t > answered)];
    const shownFrom = after.findIndex((s) => s.you.length > 0);
    expect(shownFrom, "alice's screen draws her kept cards after the scry").toBeGreaterThanOrEqual(0);
    expect(after[shownFrom]!.t - answered, 'within 3 s of the answer').toBeLessThan(3_000);
    const wrong = after.slice(shownFrom).filter((s) => JSON.stringify(s.you) !== JSON.stringify(['Lightning Bolt', 'Shock']));
    expect(wrong, "alice's screen draws Lightning Bolt then Shock on her library from then on").toEqual([]);
    expect(seenByBob.filter((s) => s.them.length > 0), "bob's screen never draws a card on alice's library").toEqual([]);
    expect({ bolt: received(bob, 'Lightning Bolt'), shock: received(bob, 'Shock') }, 'bob is sent neither name').toEqual({ bolt: false, shock: false });
  } finally {
    await stack.stop();
  }
});
