/**
 * A dead control bar (prod match m-3bc0ad1f5ac1, 2026-10-11):
 *
 *   "after suspending Ancestral Vision there was no way to press next phase/End Turn;
 *   tapping then untapping Ghost Quarter un-softlocked it … how can we prevent this from
 *   happening once and for all? i'm tired of this kind of bug"
 *
 * The server held a live, enabled priority window for that seat the whole time — byte-identical
 * to the one before the suspend — and no press ever reached it. Two browsers, a real Forge match
 * (`scenarios/dead-bar.state`): alice suspends Ancestral Vision by dragging it out of her hand
 * (it goes to exile, never the stack or the battlefield), and, in the second test, plays Ghost
 * Quarter. After each act her Next Phase and End Turn must be pressable within a bound, and a
 * real mouse press on Next Phase must reach the server.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that says why, when
 * Forge is absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { BUTTON_ONE, castByDrag, dragHandCard, makeTitled, offeredNamed, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** How long a live window may take to become pressable after the act that produced it. */
const PRESSABLE_WITHIN_MS = 3_000;

/** Everything about alice's bar a reader of a red run needs, in one line. */
async function barState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const at = (id: string) => {
      const el = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      if (el === null) return `${id}=none`;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const top = hit === null ? 'nothing' : hit === el || el.contains(hit) ? 'self' : `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}`;
      return `${id}=${el.disabled ? 'disabled' : 'enabled'}(hit:${top})`;
    };
    const prompts = Array.from(document.querySelectorAll('[data-testid="live-prompt"]')).map((e) => e.getAttribute('data-method'));
    const lifted = Array.from(document.querySelectorAll('[data-cast-lift]')).map((e) => `${e.getAttribute('data-board-card') ?? e.getAttribute('data-cast-ghost') ?? '?'}=${e.getAttribute('data-cast-lift')}`);
    return [at('live-button-next-phase'), at('live-button-end-turn'), at('live-decision-ok'), `prompts=[${prompts.join(',')}]`, `lifted=[${lifted.join(',')}]`].join(' ');
  });
}

const NEXT_PHASE = '[data-testid="live-button-next-phase"]';

/** The first enabled button `selector` names is what a press at its centre lands on. */
async function pressable(page: Page, selector = NEXT_PHASE): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = Array.from(document.querySelectorAll<HTMLButtonElement>(sel)).find((b) => !b.disabled);
    if (el === undefined) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  }, selector);
}

/** The server's last few decisions for seat 0, for a red run's message. */
function serverTail(stack: PlayStack, seat = 0): string {
  return serverLog(stack)
    .filter((r) => r.seat === seat && ['prompt-forwarded', 'prompt-withheld', 'ask-answered', 'ask-auto-answered', 'auto-paid', 'placement'].includes(String(r.evt)))
    .slice(-8)
    .map((r) => `${String(r.evt)}:${String(r.kind ?? r.method ?? r.card ?? '')}:${String(r.why ?? '')}`)
    .join(' | ');
}

/** After an act: `selector` (Next Phase by default) pressable within the bound, then a real press at its centre reaches the server. */
async function mustPressNextPhase(page: Page, stack: PlayStack, label: string, seat = 0, selector = NEXT_PHASE): Promise<void> {
  const from = Date.now();
  const live = await expect
    .poll(() => pressable(page, selector), { timeout: PRESSABLE_WITHIN_MS, intervals: [50] })
    .toBe(true)
    .then(
      () => true,
      () => false,
    );
  const waited = Date.now() - from;
  console.log(`[dead-bar] ${label}: pressable=${live} after ${waited} ms; ${await barState(page)}; says="${(await says(page)).replace(/\n/g, ' / ')}"; server: ${serverTail(stack, seat)}`);
  expect(live, `${label}: the bar is pressable within ${PRESSABLE_WITHIN_MS} ms of the act — ${await barState(page)}; server: ${serverTail(stack, seat)}`).toBe(true);

  const presses = () => serverLog(stack).filter((r) => r.evt === 'client' && r.seat === seat && r.kind === 'sound' && r.why === 'press').length;
  const pressesBefore = presses();
  const box = (await page.locator(selector).and(page.locator(':enabled')).first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(presses, {
      timeout: 5_000,
      message: `${label}: the press reached the server`,
    })
    .toBeGreaterThan(pressesBefore);
  console.log(`[dead-bar] ${label}: the press reached the server`);
}

/** Drag `name` from alice's hand over her battlefield, answering whatever Forge asks, until it leaves her hand. */
async function playFromHand(page: Page, name: string): Promise<void> {
  await expect.poll(() => offeredNamed(page, name), { timeout: 30_000, message: `alice is offered ${name}` }).not.toBeUndefined();
  const id = (await offeredNamed(page, name))!;
  const field = (await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
  expect(await dragHandCard(page, id, { x: field.x + field.width * 0.5, y: field.y + field.height * 0.5 }), `the press lifted ${name}`).toBe(true);
  const inHand = page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${id}"]`);
  await expect
    .poll(
      async () => {
        await answerPrompt(page);
        return inHand.count();
      },
      { timeout: 15_000, message: `${name} left alice's hand` },
    )
    .toBe(0);
}

test(titled('after suspending Ancestral Vision, Next Phase is pressable and a press reaches the server'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'dead-bar');
    await expect.poll(() => pressable(alice.page), { timeout: 30_000, message: 'alice holds a live bar in her main phase' }).toBe(true);
    console.log(`[dead-bar] before: ${await barState(alice.page)}`);

    await playFromHand(alice.page, 'Ancestral Vision');
    await expect(alice.page.locator('.seat[data-viewer] [data-zone="exile"] li.board-card'), 'Ancestral Vision is in her exile').toHaveCount(1, { timeout: 10_000 });
    await mustPressNextPhase(alice.page, stack, 'suspend');
  } finally {
    await stack.stop();
  }
});

test(titled('after a land drop whose window repeats the last one, Next Phase is pressable and a press reaches the server'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'dead-bar');
    await expect.poll(() => pressable(alice.page), { timeout: 30_000, message: 'alice holds a live bar in her main phase' }).toBe(true);

    await playFromHand(alice.page, 'Ancestral Vision');
    await playFromHand(alice.page, 'Ghost Quarter');
    await expect(
      alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Ghost Quarter' }),
      'Ghost Quarter is on her battlefield',
    ).toHaveCount(1, { timeout: 10_000 });
    await mustPressNextPhase(alice.page, stack, 'suspend-then-land');
  } finally {
    await stack.stop();
  }
});

/** Click `name` on the viewer's battlefield, wait for Forge's "which ability?" picker, and answer None. */
async function pickNone(page: Page, name: string): Promise<void> {
  const card = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]', { has: page.locator('.card__name', { hasText: name }) }).first();
  const picker = page.locator('section[data-prompt="getAbilityToPlay"]');
  await expect
    .poll(
      async () => {
        if ((await picker.count()) > 0) return true;
        const box = await card.boundingBox();
        if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return picker
          .waitFor({ timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
      },
      { timeout: 20_000, message: `a click on ${name} opens the ability picker` },
    )
    .toBe(true);
  console.log(`[dead-bar] picker for ${name}: ${(await picker.getByTestId('prompt-choice').allTextContents()).join(' | ')}`);
  await picker.getByTestId('prompt-cancel').click();
  await expect(picker, 'the picker closed').toHaveCount(0, { timeout: 5_000 });
}

test(titled('after the ability picker is answered None in her own main phase, Next Phase is pressable and a press reaches the server'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'dead-bar-picker');
    await expect.poll(() => pressable(alice.page), { timeout: 30_000, message: 'alice holds a live bar in her main phase' }).toBe(true);
    await pickNone(alice.page, 'Ghost Quarter');
    await mustPressNextPhase(alice.page, stack, 'picker-none-main');
  } finally {
    await stack.stop();
  }
});

test(titled('holding priority over a spell, a seat keeps a live bar while it thinks, and after the ability picker is answered None can still let the spell resolve'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'dead-bar-picker');
    // Full control: no stop policy passes bob's priority over her spell for him.
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => offeredNamed(alice.page, 'Storm Crow'), { timeout: 30_000, message: 'alice is offered Storm Crow' }).not.toBeUndefined();
    const crow = (await offeredNamed(alice.page, 'Storm Crow'))!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await castByDrag(alice.page, stack, crow, { x: field.x + field.width * 0.5, y: field.y + field.height * 0.5 });
    await expect.poll(() => pressable(bob.page, BUTTON_ONE), { timeout: 15_000, message: 'bob holds priority over Storm Crow' }).toBe(true);
    console.log(`[dead-bar] bob over the crow: ${await barState(bob.page)}`);

    // "these decisions should never timeout": a seat that only thinks keeps its window.
    const THINK_MS = 65_000;
    await bob.page.waitForTimeout(THINK_MS);
    const stillLive = await pressable(bob.page, BUTTON_ONE);
    console.log(`[dead-bar] bob after ${THINK_MS} ms of thinking: pressable=${stillLive}; ${await barState(bob.page)}`);
    expect(stillLive, `bob's window over the crow is still pressable after ${THINK_MS} ms with no input — ${await barState(bob.page)}`).toBe(true);

    await pickNone(bob.page, 'Ghost Quarter');
    await mustPressNextPhase(bob.page, stack, 'picker-none-over-spell', 1, BUTTON_ONE);
    await expect(
      bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name', { hasText: 'Storm Crow' }),
      'Storm Crow resolved onto alice’s battlefield',
    ).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});
