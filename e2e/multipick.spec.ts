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
 * Ticking the other Plains unticks the first (one Plains slot); Volcanic Island (an Island and a Mountain) stays free beside
 * the Island and fills the Mountain. The four go to her hand.
 *
 * `set-titan-picker.state`: alice casts Sundering Titan beside bob's Tundra (a Plains and an Island) and Volcanic
 * Island. The picker shows the five basic types and works out which ticked land answers which: the Tundra alone
 * lights Plains and Island; an Island takes Island and leaves the Tundra the Plains; unticking the Island gives the
 * Tundra both again; an Island and a Plains then untick the Tundra itself, the kinds still lit. With the Island, the
 * Plains and a Mountain ticked, Volcanic Island stays tickable and unticks only the Island, the oldest pick it
 * leaves with no kind. With the Plains, the Mountain, Volcanic Island, a Swamp and a Forest ticked, the Tundra
 * unticks the Plains (the oldest pick whose removal lets the rest each hold a kind), and an Island then the
 * Mountain. The five chosen lands are destroyed; the Plains and the Mountain stay.
 */
import { expect, test, type Page } from '@playwright/test';

import { castAndPassUntil, enabledOk, livePrompt, makeTitled, offeredCard, says, stackCount } from './play/board.ts';
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

    const asked = async (): Promise<boolean> => ['chooseSingleEntityForEffect', 'chooseEntitiesForEffect'].includes((await openMethod(page)) ?? '');
    const card = await offeredCard(page, 'Gifts Ungiven', { zone: 'hand', message: 'alice is offered Gifts Ungiven' });
    await castAndPassUntil([page, bob.page], stack, card, [page.locator('[data-player-face]:not([data-viewer])')], asked);
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

test(titled('Shard Convergence picks a card of each type in one picker: a second Plains takes the first one’s place, Volcanic Island the Mountain'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'set-shard');
    const page = alice.page;

    const asked = async (): Promise<boolean> => ['chooseSingleEntityForEffect', 'chooseEntitiesForEffect'].includes((await openMethod(page)) ?? '');
    const card = await offeredCard(page, 'Shard Convergence', { zone: 'hand', message: 'alice is offered Shard Convergence' });
    await castAndPassUntil([page, bob.page], stack, card, [], asked);
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
    await expect(prompt.locator(`li[data-card-id="${twin!.id}"]`), 'the other Plains stays tickable').not.toHaveAttribute('data-blocked', 'true');
    await box(twin!.id).click({ force: true });
    await expect(box(plains!.id), 'and takes the first one’s place: one Plains slot').not.toBeChecked();
    await expect(box(twin!.id)).toBeChecked();
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

test(titled('Sundering Titan’s picker works out which land answers which basic type, and a new pick unticks the oldest one it can'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'set-titan-picker');
    const page = alice.page;

    const asked = async (): Promise<boolean> => (await openMethod(page)) === 'chooseEntitiesForEffect';
    const card = await offeredCard(page, 'Sundering Titan', { zone: 'hand', message: 'alice is offered Sundering Titan' });
    await castAndPassUntil([page, bob.page], stack, card, [], asked);
    log('asked', { method: await openMethod(page), says: await says(page) });
    expect(await openMethod(page), 'the choice is one multi-pick').toBe('chooseEntitiesForEffect');

    const prompt = livePrompt(page);
    const searchCall = await prompt.getAttribute('data-call-id');
    const before = await rows(page);
    log('rows', before);
    const one = (name: string) => before.find((r) => r.name === name)!;
    const box = (id: number) => prompt.locator(`li[data-card-id="${id}"] input[data-testid="prompt-choice"]`);
    const kind = (name: string) => prompt.locator(`[data-testid="slot-kind"][data-kind="${name}"]`);
    const covers = async (name: string, state: string, by?: number) => {
      await expect(kind(name), `${name} ${state}${by === undefined ? '' : ` by ${by}`}`).toHaveAttribute('data-state', state);
      if (by !== undefined) await expect(kind(name)).toHaveAttribute('data-by', String(by));
    };
    const tundra = one('Tundra').id;
    const volcanic = one('Volcanic Island').id;
    const island = one('Island').id;
    const plains = one('Plains').id;
    await expect(prompt.getByTestId('slot-kind')).toHaveCount(5);
    for (const name of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) await covers(name, 'open');

    await box(tundra).click({ force: true });
    await covers('Plains', 'held', tundra);
    await covers('Island', 'held', tundra);
    await expect(prompt.locator(`li[data-card-id="${island}"]`), 'an Island stays tickable beside the Tundra').not.toHaveAttribute('data-blocked', 'true');

    await box(island).click({ force: true });
    await covers('Island', 'held', island);
    await covers('Plains', 'held', tundra);
    await expect(box(tundra)).toBeChecked();

    await box(island).click({ force: true });
    await expect(box(island), 'unticked by hand').not.toBeChecked();
    await covers('Island', 'held', tundra);
    await covers('Plains', 'held', tundra);

    await box(island).click({ force: true });
    await box(plains).click({ force: true });
    await expect(box(tundra), 'the Plains unticks the Tundra, which answers nothing the others do not').not.toBeChecked();
    await covers('Plains', 'held', plains);
    await covers('Island', 'held', island);
    await expect(prompt.getByTestId('prompt-submit'), 'Swamp, Mountain and Forest still open').toBeDisabled();

    const mountain = one('Mountain').id;
    await box(mountain).click({ force: true });
    await expect(prompt.locator(`li[data-card-id="${volcanic}"]`), 'a land of answered kinds stays tickable').not.toHaveAttribute('data-blocked', 'true');
    await box(volcanic).click({ force: true });
    await expect(box(island), 'Volcanic Island unticks the Island, the oldest pick it leaves with no kind').not.toBeChecked();
    await expect(box(mountain), 'the Mountain keeps Mountain').toBeChecked();
    await expect(box(plains)).toBeChecked();
    await covers('Island', 'held', volcanic);
    await covers('Mountain', 'held', mountain);

    for (const name of ['Swamp', 'Forest']) await box(one(name).id).click({ force: true });
    for (const name of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) await covers(name, 'held');

    // Plains, Mountain, Volcanic Island, Swamp, Forest ticked: the Tundra drops the Plains, the oldest pick whose
    // removal lets the rest each hold a kind; then the Island drops the Mountain, Volcanic Island now the Mountain.
    await box(tundra).click({ force: true });
    await expect(box(plains), 'the Tundra takes the old Plains’ place').not.toBeChecked();
    await expect(box(volcanic), 'Volcanic Island stays').toBeChecked();
    await covers('Plains', 'held', tundra);
    await covers('Island', 'held', volcanic);
    await box(island).click({ force: true });
    await expect(box(mountain), 'the Island takes the old Mountain’s place').not.toBeChecked();
    await expect(box(tundra)).toBeChecked();
    await covers('Mountain', 'held', volcanic);
    await covers('Island', 'held', island);
    for (const name of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) await covers(name, 'held');
    const chosen = (await rows(page)).filter((r) => r.ticked);
    log('chosen', chosen);
    await prompt.getByTestId('prompt-submit').click();

    const destroyed = chosen.map((r) => r.id);
    const onField = async () =>
      page.locator('[data-zone="battlefield"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
    const drainEnd = Date.now() + 60_000;
    while (Date.now() < drainEnd) {
      const field = await onField();
      if ((await stackCount(page)) === 0 && destroyed.every((id) => !field.includes(id)) && (await openMethod(page)) === null) break;
      const open = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="live-prompt"]');
        return p === null ? null : `${p.getAttribute('data-method')}:${p.getAttribute('data-call-id')}`;
      });
      if (open !== null && !open.endsWith(`:${searchCall}`)) await answerPrompt(page);
      for (const p of [page, bob.page]) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0 && (await openMethod(p)) === null) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await page.waitForTimeout(150);
    }
    const field = await onField();
    log('field', field);
    expect(destroyed.filter((id) => field.includes(id)), 'the five chosen lands destroyed').toEqual([]);
    expect(field, 'the Plains stays').toContain(plains);
    expect(field, 'the Mountain stays').toContain(mountain);
  } finally {
    await stack.stop();
  }
});
