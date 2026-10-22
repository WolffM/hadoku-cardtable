/**
 * Dividing an attacker's combat damage, against real Forge: the window reads as cards and meters.
 *
 * The operator, 2026-10-14, over a Hangarback Walker blocked by a Zombie token and Kalitas: *"assigning
 * combat damage is a bit ugly, can we improve the visuals of this?"* The window said "Skipping is not
 * supported yet.", drew one row inline and the next wrapped onto two lines, had a number spinner AND
 * −/+ on every row, and named each blocker as words with a tiny "lethal N" after it.
 *
 * `af50-combat-damage.state`: bob attacks alice with Craw Wurm (6) and Kodama of the North Tree (6,
 * Trample). Alice blocks the Wurm with Hill Giant and Gray Ogre, the Kodama with Grizzly Bears, Runeclaw
 * Bear and Savannah Lions, so Forge asks bob twice: two recipients, then four (three blockers and alice).
 * Each window, at 1280×800:
 * - the attacker is drawn as a card in the window's head, beside the damage left to assign;
 * - every recipient is one row of one height: its card (a player's own mark for alice), its name, a
 *   meter of the damage assigned against what is lethal, and ONE stepper — −, the value, + — with no
 *   native spinner, the steppers in one column across the rows;
 * - no sentence of ours explains anything;
 * - the window fits the screen without scrolling its rows;
 * - while it is open, bob's board shows each blocker the damage it is about to take.
 * The Wurm's window is answered by the steppers (the keyboard for one step), the Kodama's by Auto; the
 * creatures die and one point tramples over to alice, which is Forge accepting both answers.
 *
 * `[af50]` lines are the evidence: each window's rows as measured.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, ownNamed, resizeWindow, says } from './play/board.ts';
import { assignBlock, attackingCards, passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const damageWindow = (page: Page): Locator => page.locator('section[data-prompt="assignCombatDamage"]');

/** The attacking creature named `name`, as `page` draws it. */
async function attackerNamed(page: Page, name: string): Promise<number> {
  const ids = await attackingCards(page).evaluateAll(
    (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
    name,
  );
  if (ids[0] === undefined) throw new Error(`no attacking ${name}`);
  return ids[0];
}

async function ownOne(page: Page, name: string): Promise<number> {
  const [id] = await ownNamed(page, name);
  if (id === undefined) throw new Error(`no ${name} on alice's battlefield`);
  return id;
}

interface Row {
  name: string;
  card: string | null;
  art: boolean;
  mark: boolean;
  steppers: number;
  buttons: number;
  spinbuttons: number;
  numberInputs: number;
  meter: boolean;
  lethal: string | null;
  reached: boolean;
  top: number;
  height: number;
  stepperLeft: number;
  stepperRight: number;
  stepperTop: number;
  stepperBottom: number;
}

interface Measured {
  title: string;
  text: string;
  attacker: string | null;
  attackerArt: boolean;
  left: string | null;
  rows: Row[];
  box: { top: number; bottom: number; left: number; right: number };
  bodyScrolls: boolean;
  viewport: { w: number; h: number };
  submitEnabled: boolean;
}

/** The open window, measured in one pass. */
function measure(): Measured {
  const sheet = document.querySelector<HTMLElement>('section[data-prompt="assignCombatDamage"]')!;
  const r = sheet.getBoundingClientRect();
  const body = sheet.querySelector<HTMLElement>('.prompt__body')!;
  const rows = Array.from(sheet.querySelectorAll<HTMLElement>('[data-testid="prompt-slot"], [data-testid="prompt-defender"]')).map((row) => {
    const box = row.getBoundingClientRect();
    const steppers = row.querySelectorAll('.prompt__stepper');
    const s = (steppers[0] ?? row).getBoundingClientRect();
    const meter = row.querySelector<HTMLElement>('[data-testid="damage-meter"]');
    const thumb = row.querySelector<HTMLElement>('[data-thumb]');
    return {
      name: row.querySelector('.prompt__amount-name')?.textContent?.trim() ?? '',
      card: thumb?.getAttribute('data-card-id') ?? null,
      art: thumb?.querySelector('img.card__art') !== null && thumb !== null,
      mark: thumb?.querySelector('.player-mark') !== null && thumb !== null,
      steppers: steppers.length,
      buttons: row.querySelectorAll('.prompt__stepper button').length,
      spinbuttons: row.querySelectorAll('[role="spinbutton"]').length,
      numberInputs: row.querySelectorAll('input[type="number"]').length,
      meter: meter !== null,
      lethal: meter?.getAttribute('data-lethal') ?? null,
      reached: meter?.hasAttribute('data-reached') ?? false,
      top: Math.round(box.top),
      height: Math.round(box.height),
      stepperLeft: Math.round(s.left),
      stepperRight: Math.round(s.right),
      stepperTop: Math.round(s.top - box.top),
      stepperBottom: Math.round(box.bottom - s.bottom),
    };
  });
  const head = sheet.querySelector<HTMLElement>('[data-testid="damage-attacker"]');
  return {
    title: sheet.querySelector('.prompt__title')?.textContent ?? '',
    text: sheet.textContent ?? '',
    attacker: head?.getAttribute('data-card-id') ?? null,
    attackerArt: head?.querySelector('img.card__art') != null,
    left: sheet.querySelector('[data-testid="damage-left"]')?.textContent?.trim() ?? null,
    rows,
    box: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
    bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    submitEnabled: !(sheet.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled ?? true),
  };
}

/** Every structural claim, for one open window with `count` recipients. */
async function expectWellDrawn(page: Page, attacker: number, damage: number, count: number): Promise<Measured> {
  const m = await page.evaluate(measure);
  console.log(`[af50] window ${JSON.stringify(m)}`);
  expect(m.text, 'no sentence of ours: the skip note is gone').not.toMatch(/not supported/i);
  await expect(page.getByTestId('prompt-mayskip'), 'no skip note').toHaveCount(0);
  expect(m.attacker, 'the head draws the attacker as a card').toBe(String(attacker));
  expect(m.attackerArt, "the attacker's card resolves its art through the lookup").toBe(true);
  expect(m.left, 'the head says the damage left to assign').toBe(String(damage));
  expect(m.rows, 'one row per recipient').toHaveLength(count);
  for (const row of m.rows) {
    expect(row.steppers, `${row.name}: one stepper`).toBe(1);
    expect(row.buttons, `${row.name}: − and + only`).toBe(2);
    expect(row.spinbuttons, `${row.name}: one value`).toBe(1);
    expect(row.numberInputs, `${row.name}: no native number spinner beside the stepper`).toBe(0);
    expect(row.meter, `${row.name}: a damage meter`).toBe(true);
    expect(row.card !== null || row.mark, `${row.name}: a card or a player's mark`).toBe(true);
    if (row.card !== null) {
      expect(row.art, `${row.name}: its card resolves its art through the lookup`).toBe(true);
      expect(row.lethal, `${row.name}: the meter knows what is lethal`).toMatch(/^\d+$/);
    }
    // One line: the stepper sits inside the row's own band, never wrapped under the name.
    expect(row.stepperTop, `${row.name}: the stepper is on the row's one line`).toBeGreaterThanOrEqual(0);
    expect(row.stepperBottom, `${row.name}: the stepper is on the row's one line`).toBeGreaterThanOrEqual(0);
  }
  const heights = new Set(m.rows.map((r) => r.height));
  expect(Math.max(...heights) - Math.min(...heights), 'every row is one height').toBeLessThanOrEqual(1);
  const lefts = m.rows.map((r) => r.stepperLeft);
  const rights = m.rows.map((r) => r.stepperRight);
  expect(Math.max(...lefts) - Math.min(...lefts), 'the steppers are one column').toBeLessThanOrEqual(1);
  expect(Math.max(...rights) - Math.min(...rights), 'the steppers are one column').toBeLessThanOrEqual(1);
  expect(m.box.top, 'the window is inside the screen').toBeGreaterThanOrEqual(0);
  expect(m.box.bottom, 'the window is inside the screen').toBeLessThanOrEqual(m.viewport.h);
  expect(m.box.right, 'the window is inside the screen').toBeLessThanOrEqual(m.viewport.w);
  expect(m.bodyScrolls, 'every recipient fits without scrolling').toBe(false);
  return m;
}

/** The damage bob's board shows a blocker taking while the window is open. */
const boardPreview = (page: Page, id: number): Promise<string | null> =>
  page.locator(`[data-board-card="${id}"] [data-damage-preview]`).first().getAttribute('data-damage-preview', { timeout: 1_000 }).catch(() => null);

test(titled('dividing combat damage: the attacker and every recipient are cards, one meter and one stepper per row in one column, no note of ours, fits 1280×800, echoed on the board — and Forge takes both answers'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'af50-combat-damage');
    const { alice, bob } = seated;
    await resizeWindow(bob.page, { width: 1280, height: 800 });

    const wurm = await attackerNamed(alice.page, 'Craw Wurm');
    const kodama = await attackerNamed(alice.page, 'Kodama of the North Tree');
    const giant = await ownOne(alice.page, 'Hill Giant');
    const ogre = await ownOne(alice.page, 'Gray Ogre');
    const bears = await ownOne(alice.page, 'Grizzly Bears');
    const runeclaw = await ownOne(alice.page, 'Runeclaw Bear');
    const lions = await ownOne(alice.page, 'Savannah Lions');

    await passDeclareAttackers(bob.page);
    await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'the block window is open for alice' }).toMatch(/select creatures to block/i);
    for (const [blocker, attacker] of [
      [giant, wurm],
      [ogre, wurm],
      [bears, kodama],
      [runeclaw, kodama],
      [lions, kodama],
    ] as const) {
      await assignBlock(alice.page, blocker, attacker);
      await expect(alice.page.locator(`[data-board-card="${blocker}"]`), `${blocker} blocks`).toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
    }
    await enabledOk(alice.page).click(); // Done blocking.

    // Each seat passes whatever priority it is held at until bob's first window opens.
    const win = damageWindow(bob.page);
    for (let i = 0; i < 200 && !(await win.isVisible()); i++) {
      for (const page of [alice.page, bob.page]) {
        const text = await says(page);
        if (/^Priority/i.test(text)) await clickOnce(page, text, 'ok');
      }
      await win.waitFor({ state: 'visible', timeout: 250 }).catch(() => undefined);
    }
    await expect(win, "bob is asked to divide the first attacker's damage").toBeVisible({ timeout: 30_000 });

    const answered = new Set<number>();
    for (let round = 0; round < 2; round++) {
      await expect(win).toBeVisible({ timeout: 30_000 });
      const title = (await win.locator('.prompt__title').textContent()) ?? '';
      const isWurm = title.includes('Craw Wurm');
      const attacker = isWurm ? wurm : kodama;
      expect(answered.has(attacker), `each attacker is asked once (${title})`).toBe(false);
      answered.add(attacker);
      const m = await expectWellDrawn(bob.page, attacker, 6, isWurm ? 2 : 4);
      const blockers = isWurm ? [giant, ogre] : [bears, runeclaw, lions];
      expect(m.rows.slice(0, blockers.length).map((r) => Number(r.card)), 'the blockers, in damage order').toEqual(expect.arrayContaining(blockers));

      if (isWurm) {
        // By the steppers: + to lethal on the first, the rest on the second, one step by keyboard.
        const rows = win.locator('[data-testid="prompt-slot"]');
        const first = rows.nth(0);
        const second = rows.nth(1);
        const firstLethal = Number(await first.locator('[data-testid="damage-meter"]').getAttribute('data-lethal'));
        for (let i = 0; i < firstLethal; i++) await first.getByRole('button', { name: /^more to / }).click();
        await expect(first.locator('[data-testid="damage-meter"]'), 'lethal reached is its own state').toHaveAttribute('data-reached', '');
        await expect(win.getByTestId('damage-left')).toHaveText(String(6 - firstLethal));
        const id = Number(await first.locator('[data-thumb]').getAttribute('data-card-id'));
        await expect.poll(() => boardPreview(bob.page, id), { timeout: 5_000, message: "bob's board echoes the damage on the blocker" }).toBe(String(firstLethal));
        await second.getByRole('spinbutton').focus();
        await bob.page.keyboard.press('ArrowUp');
        for (let i = 1; i < 6 - firstLethal; i++) await second.getByRole('button', { name: /^more to / }).click();
        await expect(win.getByTestId('damage-left')).toHaveText('0');
      } else {
        await win.getByTestId('prompt-auto').click();
        for (const meter of await win.locator('[data-testid="prompt-slot"] [data-testid="damage-meter"]').all()) {
          await expect(meter, 'Auto gives every blocker lethal').toHaveAttribute('data-reached', '');
        }
        await expect(win.getByTestId('damage-left')).toHaveText('0');
      }
      console.log(`[af50] answering ${title} ${JSON.stringify(await bob.page.evaluate(measure))}`);
      await expect(win.getByTestId('prompt-submit')).toBeEnabled();
      await win.getByTestId('prompt-submit').click();
      await expect
        .poll(async () => ((await win.count()) === 0 ? '' : ((await win.locator('.prompt__title').textContent()) ?? '')), { timeout: 10_000, message: 'the answered window closes' })
        .not.toBe(title);
    }

    await expect(bob.page.locator('[data-damage-preview]'), 'the echo goes with the window').toHaveCount(0, { timeout: 5_000 });

    // Forge took both answers: every blocker died, and one point trampled over.
    for (const id of [giant, ogre, bears, runeclaw, lions]) {
      await expect(alice.page.locator(`[data-zone="battlefield"] [data-board-card="${id}"]`), `blocker ${id} died`).toHaveCount(0, { timeout: 20_000 });
    }
    await expect(alice.page.locator('.seat[data-viewer] [data-testid="life"]'), 'one point trampled over to alice').toHaveText('19', { timeout: 10_000 });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
