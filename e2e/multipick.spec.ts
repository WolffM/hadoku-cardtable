/**
 * A constrained search is ONE picker. The operator, 2026-10-26, on Gifts Ungiven's four "(1 / 4)" windows:
 * *"this is obviously a situation where a multi selector should be used, not separate questions"*.
 *
 * `tr-gifts.state`: alice casts Gifts Ungiven over a library with two Counterspells, two Brainstorms and two
 * Islands. ONE prompt shows the whole library counted against four. Ticking a Counterspell greys the other
 * one (it cannot be ticked); unticking frees it. She picks four different names and presses OK; bob picks two
 * of them for the graveyard; alice is asked nothing more, and two of the four are in her graveyard, two in her
 * hand.
 *
 * `set-shard.state`: alice casts Shard Convergence ("a Plains, an Island, a Swamp and a Mountain card"), which
 * Forge asked as one window per type. ONE prompt shows the five cards that fit a type, counted against four.
 * Ticking a Plains greys the other (one Plains slot); Volcanic Island (an Island and a Mountain) stays free beside
 * the Island and fills the Mountain. The four go to her hand.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, livePrompt, makeTitled, offeredNamed, pressPaymentAuto, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[mp] ${JSON.stringify({ step, data })}`);

const openMethod = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('[data-testid="live-prompt"]')?.getAttribute('data-method') ?? null);

/** The search's rows: card id, name, whether it is greyed, whether it is ticked. */
const rows = (page: Page) =>
  livePrompt(page)
    .locator('[data-testid="prompt-cards"] > li')
    .evaluateAll((els) =>
      els.map((li) => ({
        id: Number(li.getAttribute('data-card-id')),
        name: li.querySelector('.card__name')?.textContent?.trim() ?? '',
        blocked: li.getAttribute('data-blocked') === 'true',
        ticked: li.querySelector<HTMLInputElement>('input[data-testid="prompt-choice"]')?.checked === true,
      })),
    );

test(titled('Gifts Ungiven searches with one picker: a name already ticked greys its twin, four different names found'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'tr-gifts');
    const page = alice.page;

    await expect.poll(() => offeredNamed(page, 'Gifts Ungiven'), { timeout: 45_000, message: 'alice is offered Gifts Ungiven' }).not.toBeUndefined();
    await clickHandCard(page, (await offeredNamed(page, 'Gifts Ungiven'))!);
    const asked = async (): Promise<boolean> => ['chooseSingleEntityForEffect', 'chooseEntitiesForEffect'].includes((await openMethod(page)) ?? '');
    const deadline = Date.now() + 90_000;
    while (!(await asked()) && Date.now() < deadline) {
      await pressPaymentAuto(page);
      if (await asked()) break;
      for (const p of [page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && !(await asked())) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(100);
    }
    log('asked', { method: await openMethod(page), says: await says(page) });
    expect(await openMethod(page), 'the search is one multi-pick').toBe('chooseEntitiesForEffect');

    const prompt = livePrompt(page);
    const searchCall = await prompt.getAttribute('data-call-id');
    const before = await rows(page);
    expect(before, 'the whole library to choose from').toHaveLength(24);
    expect(before.filter((r) => r.blocked), 'nothing greyed before a pick').toEqual([]);
    await expect(prompt.getByTestId('prompt-bounds')).toHaveText('0 / 4');

    const box = (id: number) => prompt.locator(`li[data-card-id="${id}"] input[data-testid="prompt-choice"]`);
    const [counterspell, twin] = before.filter((r) => r.name === 'Counterspell');
    await box(counterspell!.id).click({ force: true });
    await expect(prompt.locator(`li[data-card-id="${twin!.id}"]`), 'the other Counterspell is greyed').toHaveAttribute('data-blocked', 'true');
    await expect(box(twin!.id), 'and cannot be ticked').toBeDisabled();
    await box(counterspell!.id).click({ force: true });
    await expect(prompt.locator(`li[data-card-id="${twin!.id}"]`), 'unticking frees it').not.toHaveAttribute('data-blocked', 'true');
    await box(counterspell!.id).click({ force: true });

    for (let picked = 1; picked < 4; picked++) {
      const next = (await rows(page)).find((r) => !r.blocked && !r.ticked && r.name !== 'Counterspell' && r.name !== 'Island');
      await box(next!.id).click({ force: true });
    }
    const chosen = (await rows(page)).filter((r) => r.ticked);
    log('chosen', chosen);
    expect(new Set(chosen.map((r) => r.name)).size, 'four different names').toBe(4);
    await expect(prompt.getByTestId('prompt-bounds')).toHaveText('4 / 4');
    await prompt.getByTestId('prompt-submit').click();

    // Bob picks two of the four; alice is asked nothing more about the search.
    const later: string[] = [];
    const drainEnd = Date.now() + 60_000;
    while (Date.now() < drainEnd) {
      const graveyard = Number(await page.locator('[data-zone="graveyard"][data-owner="you"]').getAttribute('data-count'));
      if ((await stackCount(page)) === 0 && graveyard === 3 && (await openMethod(page)) === null) break;
      const theirs = await answerPrompt(bob.page);
      if (theirs !== null) log('bob answered', theirs);
      const open = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="live-prompt"]');
        return p === null ? null : `${p.getAttribute('data-method')}:${p.getAttribute('data-call-id')}`;
      });
      if (open !== null && !open.endsWith(`:${searchCall}`) && !later.includes(open)) {
        later.push(open);
        await answerPrompt(page);
      }
      for (const p of [page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && (await openMethod(p)) === null) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(150);
    }
    log('later', later);
    expect(later.filter((o) => /^choose/.test(o)), 'no second search window for alice').toEqual([]);

    const hand = (await page.locator('[data-zone="hand"][data-owner="you"] [data-board-card] .card__name').allTextContents()).map((n) => n.trim());
    const found = chosen.map((r) => r.name);
    log('result', { hand, found });
    await expect(page.locator('[data-zone="graveyard"][data-owner="you"]'), 'two of the four beside Gifts in the graveyard').toHaveAttribute('data-count', '3');
    expect(found.filter((name) => hand.includes(name)), 'the other two in the hand').toHaveLength(2);
  } finally {
    await stack.stop();
  }
});

test(titled('Shard Convergence picks a card of each type in one picker: a second Plains greyed, Volcanic Island the Mountain'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'set-shard');
    const page = alice.page;

    await expect.poll(() => offeredNamed(page, 'Shard Convergence'), { timeout: 45_000, message: 'alice is offered Shard Convergence' }).not.toBeUndefined();
    await clickHandCard(page, (await offeredNamed(page, 'Shard Convergence'))!);
    const asked = async (): Promise<boolean> => ['chooseSingleEntityForEffect', 'chooseEntitiesForEffect'].includes((await openMethod(page)) ?? '');
    const deadline = Date.now() + 90_000;
    while (!(await asked()) && Date.now() < deadline) {
      await pressPaymentAuto(page);
      if (await asked()) break;
      for (const p of [page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && !(await asked())) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(100);
    }
    log('asked', { method: await openMethod(page), says: await says(page) });
    expect(await openMethod(page), 'the search is one multi-pick').toBe('chooseEntitiesForEffect');

    const prompt = livePrompt(page);
    const searchCall = await prompt.getAttribute('data-call-id');
    const before = await rows(page);
    log('rows', before);
    expect(before.map((r) => r.name).sort(), 'every card that fits a type, and no Forest').toEqual(['Island', 'Plains', 'Plains', 'Swamp', 'Volcanic Island']);
    await expect(prompt.getByTestId('prompt-bounds')).toHaveText('0 / 4');

    const box = (id: number) => prompt.locator(`li[data-card-id="${id}"] input[data-testid="prompt-choice"]`);
    const named = (name: string) => before.filter((r) => r.name === name);
    const [plains, twin] = named('Plains');
    await box(plains!.id).click({ force: true });
    await expect(prompt.locator(`li[data-card-id="${twin!.id}"]`), 'the other Plains is greyed').toHaveAttribute('data-blocked', 'true');
    await expect(box(twin!.id), 'and cannot be ticked').toBeDisabled();
    await box(named('Island')[0]!.id).click({ force: true });
    await expect(prompt.locator(`li[data-card-id="${named('Volcanic Island')[0]!.id}"]`), 'Volcanic Island can still be the Mountain').not.toHaveAttribute('data-blocked', 'true');
    await box(named('Volcanic Island')[0]!.id).click({ force: true });
    await box(named('Swamp')[0]!.id).click({ force: true });
    await expect(prompt.getByTestId('prompt-bounds')).toHaveText('4 / 4');
    await prompt.getByTestId('prompt-submit').click();

    const later: string[] = [];
    const drainEnd = Date.now() + 60_000;
    const handNames = async () => (await page.locator('[data-zone="hand"][data-owner="you"] [data-board-card] .card__name').allTextContents()).map((n) => n.trim()).sort();
    while (Date.now() < drainEnd) {
      if ((await stackCount(page)) === 0 && (await handNames()).length === 4 && (await openMethod(page)) === null) break;
      const open = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="live-prompt"]');
        return p === null ? null : `${p.getAttribute('data-method')}:${p.getAttribute('data-call-id')}`;
      });
      if (open !== null && !open.endsWith(`:${searchCall}`) && !later.includes(open)) {
        later.push(open);
        await answerPrompt(page);
      }
      for (const p of [page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && (await openMethod(p)) === null) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(150);
    }
    log('later', later);
    expect(later.filter((o) => /^choose/.test(o)), 'no second search window').toEqual([]);
    expect(await handNames(), 'one of each type in hand').toEqual(['Island', 'Plains', 'Swamp', 'Volcanic Island']);
  } finally {
    await stack.stop();
  }
});
