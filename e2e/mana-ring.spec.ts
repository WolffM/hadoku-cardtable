/**
 * The mana ring, against real Forge (the operator, 2026-11-05: "the generic decision box looks ugly and
 * is too annoying to click because it's far away from where the cursor is from the land. ideally it's a
 * custom visual and it appears directly on the mouse-cursor when they click a land"; take A approved).
 *
 * `mana-ring`, at alice's own priority:
 *   Tundra — two abilities: a ring of W and U on the press; a click on W adds {W}.
 *   City of Brass — Forge's list of five colours: a ring of five; the R key adds {R} and 1 damage.
 *   Adarkar Wastes — {C} | W-or-U: one ring of C, W and U; a click on U answers Forge's ability
 *     question AND its two-button colour question that follows, with no box drawn: {U} and 1 damage.
 * `mana-ring-pay`, inside a payment of Azorius Guildmage's {W/U}{W/U} under full control:
 *   City of Brass — Forge's yes/no of the two colours as a ring; the U key pays one.
 *   Tundra — its two abilities as a ring, both paying the hybrid left; a click on W pays it.
 *   Then Holy Day's {W} from the second Tundra: its U pays nothing owed and is greyed.
 * `mana-ring`, by press, drag and release (the operator, 2026-11-06: "the regular tap should also work"):
 *   Tundra — the press opens its ring before anything is sent; let go on U adds {U}.
 *   City of Brass — let go on R adds {R} and deals its 1: Forge's colour question answered by the drag.
 *   Adarkar Wastes — dragged off every disc and let go on nothing: nothing is sent, nothing tapped;
 *     then a plain click still opens Forge's ring, and W is picked from it.
 * No generic decision box is drawn for any of it.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, isTapped, lifeOf, makeTitled, manaPool as pool, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { centreOf, expectCardViewBesideRing, expectRingOn, lifeNow, pathTo, pressPoint, ring, ringOption, ringOptions } from './mana-ring.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('the mana ring opens on the press at priority: a click, a key, and a two-step source answered by one pick'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const genericBox = page.locator('[data-testid="live-prompt"], [data-testid="live-confirm"]');
    const [tundra] = await ownNamed(page, 'Tundra');
    const [brass] = await ownNamed(page, 'City of Brass');
    const [wastes] = await ownNamed(page, 'Adarkar Wastes');
    if (tundra === undefined || brass === undefined || wastes === undefined) throw new Error('the scenario board is not drawn');
    const life = lifeOf(page, 'me');

    // Tundra: two abilities, a ring of two on the press; a click on W.
    const onTundra = await pressPoint(page, tundra);
    await page.mouse.click(onTundra.x, onTundra.y);
    await expectRingOn(page, onTundra, 'Tundra');
    await expect(ring(page)).toHaveAttribute('data-ring', 'abilities');
    await expectCardViewBesideRing(page, 'Tundra');
    await expect(ringOptions(page)).toHaveCount(2);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);
    await ringOption(page, 'W').click();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).W, { timeout: 10_000, message: 'Tundra added {W}' }).toBe(1);

    // City of Brass: Forge's list of five colours; the R key.
    const onBrass = await pressPoint(page, brass, 0.6, 0.55);
    await page.mouse.click(onBrass.x, onBrass.y);
    await expectRingOn(page, onBrass, 'City of Brass');
    await expect(ring(page)).toHaveAttribute('data-ring', 'colors');
    await expect(ringOptions(page)).toHaveCount(5);
    await expect(ring(page).getByTestId('mana-ring-life'), 'its 1 damage on every colour').toHaveCount(5);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);
    await page.keyboard.press('r');
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).R, { timeout: 10_000, message: 'City of Brass added {R}' }).toBe(1);
    await expect.poll(() => lifeNow(page, life), { timeout: 10_000, message: 'City of Brass dealt 1' }).toBe(19);

    // Adarkar Wastes: one ring of C, W and U; U answers both of Forge's questions.
    const onWastes = await pressPoint(page, wastes);
    await page.mouse.click(onWastes.x, onWastes.y);
    await expectRingOn(page, onWastes, 'Adarkar Wastes');
    await expect(ringOptions(page)).toHaveCount(3);
    await expect(ringOption(page, 'U').getByTestId('mana-ring-life'), 'the pain is on the coloured discs').toHaveText('1');
    await expect(ringOption(page, 'C').getByTestId('mana-ring-life')).toHaveCount(0);
    await ringOption(page, 'U').click();
    await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'Adarkar Wastes added {U}' }).toBe(1);
    await expect.poll(() => lifeNow(page, life), { timeout: 10_000, message: 'Adarkar Wastes dealt 1' }).toBe(18);
    await expect(ring(page), 'the colour question that followed was answered by the same pick').toHaveCount(0);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);
    expect(await isTapped(page, wastes)).toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('inside a payment the mana ring answers Forge’s two-colour yes/no and a dual’s abilities: a key, and a click'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring-pay');
    const page = alice.page;
    const genericBox = page.locator('[data-testid="live-prompt"], [data-testid="live-confirm"]');
    const [brass] = await ownNamed(page, 'City of Brass');
    const [tundra, tundra2] = await ownNamed(page, 'Tundra');
    if (brass === undefined || tundra === undefined || tundra2 === undefined) throw new Error('the scenario board is not drawn');
    // Full control: cardtable's default lets Forge pay a payment it can find by itself.
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control'), 'full control is on').toHaveAttribute('aria-pressed', 'true');
    const guildmage = await handCardNamed(page, 'Azorius Guildmage');
    if (guildmage === undefined) throw new Error('no Azorius Guildmage in hand');
    expect(await clickHandCard(page, guildmage), 'the Guildmage is cast').toBe(true);
    await expect(page.getByTestId('live-payment'), 'the payment opens').toBeVisible({ timeout: 20_000 });

    const onBrass = await pressPoint(page, brass);
    await page.mouse.click(onBrass.x, onBrass.y);
    await expectRingOn(page, onBrass, 'City of Brass, paying');
    await expectCardViewBesideRing(page, 'City of Brass, paying');
    await expect(ring(page)).toHaveAttribute('data-ring', 'prompt');
    await expect(ringOptions(page), 'the two owed colours').toHaveCount(2);
    await expect(ring(page).getByTestId('mana-ring-life'), 'its 1 damage on both').toHaveCount(2);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);
    await page.keyboard.press('u');
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(() => isTapped(page, brass), { timeout: 10_000, message: 'City of Brass paid' }).toBe(true);

    // Tundra: its two abilities; a click on W.
    const onTundra = await pressPoint(page, tundra);
    await page.mouse.click(onTundra.x, onTundra.y);
    await expectRingOn(page, onTundra, 'Tundra, paying');
    await expect(ring(page)).toHaveAttribute('data-ring', 'abilities');
    // The {W/U} left is paid by either colour: nothing is greyed.
    await expect(ring(page).locator('[data-dim]'), 'both colours pay the hybrid left').toHaveCount(0);
    await ringOption(page, 'W').click();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(() => isTapped(page, tundra), { timeout: 10_000, message: 'Tundra paid' }).toBe(true);
    // Paid in full, the Guildmage leaves the hand for the stack (full control holds it there for a pass).
    await expect.poll(async () => (await handCardNamed(page, 'Azorius Guildmage')) === undefined, { timeout: 15_000, message: 'the Guildmage was paid for' }).toBe(true);
    await expect(page.getByTestId('live-payment'), 'no payment is left open').toHaveCount(0);

    // Holy Day, {W}, from the second Tundra: its U pays nothing owed and is greyed; W pays.
    const holyDay = await handCardNamed(page, 'Holy Day');
    if (holyDay === undefined) throw new Error('no Holy Day in hand');
    expect(await clickHandCard(page, holyDay), 'Holy Day is cast').toBe(true);
    await expect(page.getByTestId('live-payment'), "Holy Day's payment opens").toBeVisible({ timeout: 20_000 });
    const onTundra2 = await pressPoint(page, tundra2);
    await page.mouse.click(onTundra2.x, onTundra2.y);
    await expectRingOn(page, onTundra2, 'Tundra, paying {W}');
    await expect(ringOption(page, 'U'), 'U pays nothing of the {W} owed').toHaveAttribute('data-dim');
    await expect(ringOption(page, 'W'), 'W pays it').not.toHaveAttribute('data-dim');
    await page.keyboard.press('u');
    await expect(ringOption(page, 'W'), 'the U key picks nothing greyed: the ring is still open').toBeVisible();
    await ringOption(page, 'W').click();
    await expect.poll(async () => (await handCardNamed(page, 'Holy Day')) === undefined, { timeout: 15_000, message: 'Holy Day was paid for' }).toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('a press on a mana source opens its ring under the press: a drag to a disc and a release picks it, a release on nothing picks nothing, and a click still works'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const genericBox = page.locator('[data-testid="live-prompt"], [data-testid="live-confirm"]');
    const [tundra] = await ownNamed(page, 'Tundra');
    const [brass] = await ownNamed(page, 'City of Brass');
    const [wastes] = await ownNamed(page, 'Adarkar Wastes');
    if (tundra === undefined || brass === undefined || wastes === undefined) throw new Error('the scenario board is not drawn');
    const life = lifeOf(page, 'me');
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
      for (const p of pathTo(from, to)) await page.mouse.move(p.x, p.y);
    };

    // Tundra: the press opens the ring before Forge is asked; let go on U.
    const onTundra = await pressPoint(page, tundra);
    await page.mouse.move(onTundra.x, onTundra.y);
    await page.mouse.down();
    await expectRingOn(page, onTundra, 'Tundra, pressed');
    await expect(ring(page), 'drawn on the press, before Forge asked').toHaveAttribute('data-press');
    await expect(ringOptions(page)).toHaveCount(2);
    const u = await centreOf(ringOption(page, 'U'));
    await drag(onTundra, u);
    await expect(ringOption(page, 'U'), 'the disc under the pointer is lit').toHaveAttribute('data-armed');
    await page.mouse.up();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await expect.poll(async () => (await pool(page)).U, { timeout: 10_000, message: 'Tundra added {U}' }).toBe(1);
    await expect.poll(() => isTapped(page, tundra), { timeout: 10_000 }).toBe(true);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);

    // City of Brass: let go on R answers Forge's colour question too.
    const onBrass = await pressPoint(page, brass, 0.6, 0.55);
    await page.mouse.move(onBrass.x, onBrass.y);
    await page.mouse.down();
    await expect(ring(page)).toHaveAttribute('data-press');
    await expect(ringOptions(page)).toHaveCount(5);
    await expect(ring(page).getByTestId('mana-ring-life'), 'its 1 damage on every colour').toHaveCount(5);
    await drag(onBrass, await centreOf(ringOption(page, 'R')));
    await expect(ringOption(page, 'R'), 'the disc under the pointer is lit').toHaveAttribute('data-armed');
    await page.mouse.up();
    await expect.poll(async () => (await pool(page)).R, { timeout: 10_000, message: 'City of Brass added {R}' }).toBe(1);
    await expect.poll(() => lifeNow(page, life), { timeout: 10_000, message: 'City of Brass dealt 1' }).toBe(19);
    await expect(ring(page), 'no ring left open').toHaveCount(0);
    await expect(genericBox, 'no generic decision box').toHaveCount(0);

    // Adarkar Wastes: over a disc, then off every disc, and let go on nothing.
    const onWastes = await pressPoint(page, wastes);
    await page.mouse.move(onWastes.x, onWastes.y);
    await page.mouse.down();
    await expect(ringOptions(page)).toHaveCount(3);
    const w = await centreOf(ringOption(page, 'W'));
    await drag(onWastes, w);
    await expect(ringOption(page, 'W')).toHaveAttribute('data-armed');
    const away = { x: onWastes.x, y: Math.max(8, onWastes.y - 260) };
    await drag(w, away);
    await expect(ring(page).locator('[data-armed]'), 'off every disc, none is lit').toHaveCount(0);
    await page.mouse.up();
    await expect(ring(page), 'the ring closed').toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(ring(page), 'nothing was sent: Forge asks nothing').toHaveCount(0);
    await expect(genericBox).toHaveCount(0);
    expect(await isTapped(page, wastes), 'nothing tapped').toBe(false);
    expect(await lifeNow(page, life), 'no damage').toBe(19);

    // A plain click still opens Forge's own ring, and a click on W picks from it.
    const again = await pressPoint(page, wastes);
    await page.mouse.click(again.x, again.y);
    await expectRingOn(page, again, 'Adarkar Wastes, clicked');
    await expect(ring(page), "Forge's own question").toHaveAttribute('data-method', 'getAbilityToPlay');
    await ringOption(page, 'W').click();
    await expect.poll(async () => (await pool(page)).W, { timeout: 10_000, message: 'Adarkar Wastes added {W}' }).toBe(1);
    await expect.poll(() => lifeNow(page, life), { timeout: 10_000, message: 'Adarkar Wastes dealt 1' }).toBe(18);
    await expect(ring(page)).toHaveCount(0);
    await expect(genericBox).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
