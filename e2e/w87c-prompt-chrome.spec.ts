/**
 * Trailer cut 2, at the operator's own size (1920×1080):
 *
 *   §C "when selecting a target for valakut, i would expect to see a checkbox that allows picking 'select
 *      same target for all?' this checkbox should appear when the game detects multiple triggers of the
 *      same thing on the stack." — it existed (`live-same-target`), drawn under the target popup's tiles.
 *   Finding 6: "Waiting for Nightjar to choose cards for Force of Will…" while Nightjar picked Spell
 *      Pierce's target, and the bar drawn over the Oko stack card (counterwar.mkv ~30 s).
 *
 * `promo-valakut.state`: alice Bolts first (one target question, no box), then Scapeshifts for ten
 * Valakut triggers, ticks the box with a real pointer and points at bob once. `promo-counterwar.state`:
 * bob's Oko, alice's Counterspell, bob's Swan Song, alice's Force of Will; then bob casts Spell Pierce,
 * and while he picks its target alice's screen says he is choosing a target — not for Force of Will, and
 * not naming Spell Pierce, which her board does not show until the cast is done — over no stack card.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { dragHandCard, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SIZE = { width: 1920, height: 1080 };

const okEnabled = (page: Page): Locator => page.locator('[data-testid="live-decision-ok"]:enabled');

async function pressIfThere(target: Locator): Promise<void> {
  if ((await target.count()) > 0) await target.first().click({ timeout: 1_000 }).catch(() => undefined);
}

/** Poll `step` until it answers true, or fail naming `what`. */
async function until(what: string, step: () => Promise<boolean>, timeout = 90_000): Promise<void> {
  await expect.poll(step, { timeout, intervals: [250], message: what }).toBe(true);
}

/** Drag `name` from the hand onto the battlefield: a cast. */
async function cast(page: Page, name: string): Promise<void> {
  let id: number | undefined;
  await until(`${name} is offered`, async () => (id = await offeredNamed(page, name)) !== undefined, 60_000);
  const field = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox();
  if (field === null) throw new Error('no battlefield');
  expect(await dragHandCard(page, id!, { x: field.x + field.width / 2, y: field.y + field.height * 0.35 }), `${name} lifted`).toBe(true);
}

const sheet = (page: Page): Locator => page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();

async function tiles(page: Page): Promise<{ id: number; text: string }[]> {
  return sheet(page)
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

/** Tick each tile in `ids`, then press the sheet's own Done while it is still this sheet. */
async function pick(page: Page, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const tile = sheet(page).locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"] label`);
    if ((await tile.count()) > 0) await tile.click({ timeout: 2_000 }).catch(() => undefined);
  }
  const still = new Set((await tiles(page)).map((t) => t.id));
  if (!ids.some((id) => still.has(id))) return;
  await pressIfThere(sheet(page).locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled'));
}

/** What is drawn at an element's centre: itself (or inside it), or the element that covers it. */
async function hitAtCentre(target: Locator): Promise<{ own: boolean; covering: string }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const own = hit !== null && (hit === el || el.contains(hit));
    const covering = hit === null ? 'nothing' : `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ').join('.')}${hit.closest('[data-testid]') === null ? '' : ` in ${hit.closest('[data-testid]')!.getAttribute('data-testid')}`}`;
    return { own, covering };
  });
}

const VALAKUT = /Valakut, the Molten Pinnacle/;
const asksValakutTarget = (text: string): boolean => VALAKUT.test(text) && !/^Do you want to deal/.test(text) && !/^Priority/.test(text);

test(titled('1920×1080, ten Valakut triggers: the same-target box is on top and takes a real click; a lone Bolt shows none'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-valakut');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, SIZE);
    const page = alice.page;
    const same = page.getByTestId('live-same-target');
    const bobLife = page.locator('.seat:not([data-viewer]) [data-testid="life"]').first();

    // One target question with nothing behind it: no box. Bolt bob, and let it resolve.
    await cast(page, 'Lightning Bolt');
    let boltAsked = false;
    await until('the Bolt resolves at bob', async () => {
      await pressPaymentAuto(page);
      if (/target/i.test(await says(page)) && /Lightning Bolt/.test(await says(page))) {
        boltAsked = true;
        expect.soft(await same.count(), 'a single target question offers no "same target for all"').toBe(0);
        await page.locator('[data-player-face]:not([data-viewer])').first().click({ timeout: 1_000 }).catch(() => undefined);
      }
      await pressIfThere(okEnabled(bob.page));
      return (await bobLife.textContent()) === '17';
    });
    console.log(`[w87c] Bolt target question drawn: ${boltAsked}`);

    // Scapeshift: sacrifice all eleven lands, fetch Valakut and ten Mountains.
    await cast(page, 'Scapeshift');
    await until('the sacrifice sheet', async () => {
      if ((await tiles(page)).length >= 11) return true;
      await pressPaymentAuto(page);
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await pressIfThere(okEnabled(bob.page));
      return false;
    });
    await pick(page, (await tiles(page)).map((t) => t.id));
    await until('the search sheet', async () => {
      if ((await tiles(page)).some((t) => /Valakut/.test(t.text))) return true;
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      await pressIfThere(okEnabled(bob.page));
      return false;
    });
    const library = await tiles(page);
    await pick(page, [...library.filter((t) => /Valakut/.test(t.text)), ...library.filter((t) => t.text.startsWith('Mountain'))].map((t) => t.id));

    await until('the first Valakut target question', async () => {
      if (asksValakutTarget(await says(page)) && (await same.count()) > 0) return true;
      await answerPrompt(page).catch(() => null);
      await pressIfThere(okEnabled(bob.page));
      return false;
    });
    await page.waitForTimeout(500);

    // The box: drawn, not covered, and a real pointer ticks it.
    await expect(same).toBeVisible();
    const hit = await hitAtCentre(same);
    console.log(`[w87c] at the box's centre: ${hit.own ? 'the box' : hit.covering}`);
    expect(hit.own, `the same-target box is on top at its centre (drawn there: ${hit.covering})`).toBe(true);
    await same.click({ timeout: 5_000 });
    await expect(same).toBeChecked();

    // One pick sends every trigger at bob.
    let picks = 0;
    await until('every Valakut trigger hit bob', async () => {
      const text = await says(page);
      if (asksValakutTarget(text) && picks === 0) {
        picks += 1;
        await page.locator('[data-player-face]:not([data-viewer])').first().click({ timeout: 1_000 }).catch(() => undefined);
      }
      await pressIfThere(page.locator('[data-testid="prompt-confirm-yes"]:enabled'));
      for (const p of [page, bob.page]) await pressIfThere(okEnabled(p));
      const life = Number((await bobLife.textContent()) ?? '20');
      return life <= 0 || (await page.getByText(/victory/i).count()) > 0;
    }, 150_000);
    expect.soft(picks, 'one pick covered every trigger').toBe(1);
  } finally {
    await stack.stop();
  }
});

/** Pass `other`'s windows until `seat` is offered `name`, cast it, aim it at `target` on the stack, and pay. */
async function respond(seat: Page, other: Page, name: string, target: string | null, depth: number, alt?: { asks: RegExp; card: string }): Promise<void> {
  await until(`${name} is offered`, async () => {
    if ((await offeredNamed(seat, name)) !== undefined) return true;
    await pressIfThere(okEnabled(other));
    return false;
  }, 60_000);
  await cast(seat, name);
  await until(`${name} is on the stack`, async () => {
    const placed = (await seat.locator(`[data-stack-id][aria-label*="${name.split(',')[0]}"]`).count()) > 0;
    const asking = (await seat.getByTestId('live-prompt').count()) > 0 || /pay|choose|select|target|exile|return/i.test(await says(seat));
    if ((await stackCount(seat)) >= depth && placed && !asking) return true;
    if (alt !== undefined && alt.asks.test(await says(seat))) {
      const tile = (await tiles(seat)).find((t) => t.text.startsWith(alt.card));
      if (tile !== undefined) await pick(seat, [tile.id]);
      return false;
    }
    if (target !== null && (await aimAt(seat, target))) return false;
    await pressPaymentAuto(seat);
    return false;
  }, 45_000);
}

/** Answer a stack-target question with `name`: its stack item, or the choice list's row when Forge draws one. */
async function aimAt(page: Page, name: string): Promise<boolean> {
  const list = page.locator('section[data-prompt="getChoices"] li', { hasText: name }).first();
  if ((await list.count()) > 0) {
    await list.locator('label').click().catch(() => undefined);
    await pressIfThere(page.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]:enabled'));
    return true;
  }
  const item = page.locator(`[data-stack-id][aria-label*="${name}"]`).first();
  if ((await item.count()) > 0 && /target/i.test(await says(page))) {
    await item.click().catch(() => undefined);
    return true;
  }
  return false;
}

test(titled('1920×1080, a counter war: while bob aims Spell Pierce, alice reads that he is choosing a target, over no stack card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'promo-counterwar');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, SIZE);
    await respond(bob.page, alice.page, 'Oko, Thief of Crowns', null, 1);
    await respond(alice.page, bob.page, 'Counterspell', 'Oko', 2);
    await respond(bob.page, alice.page, 'Swan Song', 'Counterspell', 3);
    await respond(alice.page, bob.page, 'Force of Will', 'Swan Song', 4, { asks: /Exile \d+ card/i, card: 'Brainstorm' });

    // Bob casts Spell Pierce and does NOT answer its target yet.
    await until('Spell Pierce is offered', async () => {
      if ((await offeredNamed(bob.page, 'Spell Pierce')) !== undefined) return true;
      await pressIfThere(okEnabled(alice.page));
      return false;
    }, 60_000);
    await cast(bob.page, 'Spell Pierce');
    await until("bob is asked for Spell Pierce's target", async () => (await bob.page.locator('section[data-prompt="getChoices"]').count()) > 0, 30_000);

    const pop = alice.page.getByTestId('live-waiting-pop');
    await expect(pop, "alice's screen says what bob is doing").toBeVisible({ timeout: 15_000 });
    await alice.page.waitForTimeout(400);
    const sentence = ((await pop.textContent()) ?? '').trim();
    console.log(`[w87c] alice reads "${sentence}" while bob says "${(await says(bob.page)).trim().slice(0, 120)}"`);
    // Forge shows alice the spell only once its cast is done (bob can still back out of it), so the pop names
    // no spell rather than the stack's top, which is someone else's.
    expect(await alice.page.locator('[data-stack-id][aria-label*="Spell Pierce"]').count(), 'Spell Pierce is not on alice’s stack yet').toBe(0);
    expect(sentence, 'the pop says what bob is doing, and names no spell he is not casting').toBe('Waiting for Bob to choose a target…');

    // Nothing on the stack is under it.
    const popBox = await pop.boundingBox();
    const items = await alice.page.locator('[data-stack-id]').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label') ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
    );
    expect(popBox).not.toBeNull();
    const under = items.filter((i) => i.left < popBox!.x + popBox!.width && i.right > popBox!.x && i.top < popBox!.y + popBox!.height && i.bottom > popBox!.y);
    console.log(`[w87c] pop at ${Math.round(popBox!.x)},${Math.round(popBox!.y)} ${Math.round(popBox!.width)}x${Math.round(popBox!.height)}; stack items ${items.length}; under it: ${under.map((i) => i.name.slice(0, 40)).join(' | ')}`);
    expect(under.map((i) => i.name), 'the waiting pop covers no stack card').toEqual([]);
  } finally {
    await stack.stop();
  }
});
