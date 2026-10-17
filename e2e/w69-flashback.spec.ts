/**
 * The operator, 2026-10-11, on Cabal Therapy: *"it was awkward to play from the graveyard. i was like
 * dragging an arrow from the graveyard, but it should be possible to pick up cards from the graveyard if
 * they have flashback. so i should be able to drag them and play them like a spell, not have a target
 * arrow drawn. the target arrow should come after the spell is played."*
 *
 * Alice's graveyard holds Firebolt and Think Twice, both offered for their flashback. With real mouse
 * gestures on two screens:
 *
 *   1. a press on Firebolt in the pile picks it up like a hand card — it follows the pointer, and no arrow
 *      is drawn — and bob sees a held card at her pointer; let go back over the graveyard, nothing is sent
 *      and it goes home;
 *   2. picked up again and let go over the table, it is cast: only now does Forge ask for its target, and
 *      only now is the arrow drawn; she points it at bob, pays, and both screens show Firebolt on the stack;
 *   3. from the expanded pile view, Think Twice is picked up the same way (the view gives way to the card in
 *      hand), let go over the table, paid for, and on the stack on both screens.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { clickOnce, enabledOk, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const YARD = '.seat [data-zone="graveyard"][data-owner="you"]';
const inYard = (page: Page, id: number) => page.locator(`${YARD} [data-board-card="${id}"]`);
const targeter = (page: Page) => page.locator('[data-board-overlay] [data-testid="targeter"]');
const back = (page: Page) => page.locator('[data-board-overlay] .presence__back');
const view = (page: Page) => page.getByTestId('pile-view');
const lift = (page: Page, id: number) => inYard(page, id).getAttribute('data-cast-lift').catch(() => null);
const acts = (f: Friend): number => messages(f).filter((m) => m.dir === 'out' && m.kind === 'c2s').length;

/** The middle of what a graveyard card shows of itself in the pile (a buried card is a strip). */
const strip = (page: Page, id: number) =>
  page.evaluate(
    ([sel, cardId]) => {
      const li = document.querySelector<HTMLElement>(`${sel} li[data-card-id="${cardId}"]`)!;
      const next = li.nextElementSibling as HTMLElement | null;
      const box = li.getBoundingClientRect();
      const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
      return { x: box.left + box.width / 2, y: box.top + Math.min(px, box.height) / 2, px };
    },
    [YARD, id] as const,
  );

const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * Every card name a page draws on the stack, from now on. Auto-pass can resolve a spell a few hundred
 * ms after it lands, between two polls, so the stack is watched rather than sampled.
 */
const watchStack = (page: Page) =>
  page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __stackSeen: () => string[] }).__stackSeen = () => [...seen];
    const look = (): void => {
      document.querySelectorAll('[data-placed-spell] .card__name').forEach((el) => seen.add(el.textContent?.trim() ?? ''));
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    look();
  });
const stackSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __stackSeen: () => string[] }).__stackSeen());
const exiled = (page: Page) => page.locator('.seat[data-viewer] [data-zone="exile"] .card__name').allTextContents();

/**
 * Answer whatever the cast still asks (the lone-ability sheet, the mana), and pass priority while the
 * spell waits on the stack, until it has resolved into her exile — never pressing OK on an empty stack,
 * which would end her main phase.
 */
async function resolveIntoExile(alice: Page, bob: Page, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await answerLoneAbility(alice);
        await pressPaymentAuto(alice);
        if ((await stackCount(alice)) > 0) {
          for (const p of [alice, bob]) if ((await enabledOk(p).count()) > 0) await clickOnce(p, await says(p), 'ok');
        }
        return (await exiled(alice)).includes(name);
      },
      { timeout: 30_000, message: `${name} resolves into her exile — says "${await says(alice)}"` },
    )
    .toBe(true);
}

test(titled('a flashback card is picked up from the graveyard like a hand card, and its target arrow comes only after it is cast'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-flashback');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    let firebolt: number | undefined;
    await expect
      .poll(async () => (firebolt = await offeredNamed(alice.page, 'Firebolt')), { timeout: 60_000, message: "alice is offered Firebolt's flashback from her graveyard" })
      .not.toBeUndefined();
    const bolt = firebolt!;
    const twice = (await offeredNamed(alice.page, 'Think Twice'))!;
    expect(twice, "Think Twice's flashback is offered too").not.toBeUndefined();
    const field = centre((await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!);

    // ── 1. Picked up, carried over the table, and let go back over the graveyard: nothing is sent.
    const at = await strip(alice.page, bolt);
    const sentBefore = acts(alice);
    await alice.page.mouse.move(at.x, at.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(field.x, field.y, { steps: 10 });
    const held = { lift: await lift(alice.page, bolt), arrow: await targeter(alice.page).count() };
    const box = await inYard(alice.page, bolt).boundingBox();
    await expect(back(bob.page), "bob sees alice's held card at her pointer").toHaveCount(1, { timeout: 3_000 }).catch(() => undefined);
    const bobBack = await back(bob.page).count();
    console.log(
      `[hh-flash] press on Firebolt #${bolt} in the graveyard (strip ${Math.round(at.px)}px at ${Math.round(at.x)},${Math.round(at.y)}), carried to the table at ${Math.round(field.x)},${Math.round(field.y)}: data-cast-lift=${held.lift}, arrows drawn=${held.arrow}, card centre ${box === null ? 'none' : `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`}, bob's held backs=${bobBack}`,
    );
    expect(held, 'the press picks Firebolt up like a hand card (data-cast-lift=lifted), with no arrow drawn while it is carried').toEqual({ lift: 'lifted', arrow: 0 });
    expect(box, 'the lifted card follows the pointer').not.toBeNull();
    expect(Math.hypot(box!.x + box!.width / 2 - field.x, box!.y + box!.height / 2 - field.y), 'the lifted card is under the pointer').toBeLessThan(4);
    expect(bobBack, "bob's screen shows a held card at her pointer, as for a hand card").toBe(1);

    await alice.page.mouse.move(at.x, at.y, { steps: 10 });
    await alice.page.mouse.up();
    await expect.poll(() => lift(alice.page, bolt), { timeout: 3_000, message: 'let go over its own graveyard, Firebolt goes home' }).toBeNull();
    await expect(back(bob.page), "bob's held card goes with the cancel").toHaveCount(0, { timeout: 5_000 });
    expect(acts(alice) - sentBefore, 'a release over its own graveyard sends nothing').toBe(0);
    expect(await stackCount(alice.page), 'nothing was cast').toBe(0);
    console.log(`[hh-flash] cancel over the graveyard: acts sent ${acts(alice) - sentBefore}, Firebolt still in the pile ${await inYard(alice.page, bolt).count()}, bob's backs ${await back(bob.page).count()}`);

    // ── 2. Picked up and let go over the table: cast. The target arrow comes only now.
    const again = await strip(alice.page, bolt);
    await alice.page.mouse.move(again.x, again.y);
    await alice.page.mouse.down();
    await alice.page.mouse.move(field.x, field.y, { steps: 10 });
    expect(await targeter(alice.page).count(), 'no arrow while it is carried').toBe(0);
    await alice.page.mouse.up();
    await expect.poll(() => says(alice.page), { timeout: 15_000, message: 'cast at the release, Firebolt asks for its target' }).toMatch(/target/i);
    const face = centre((await alice.page.locator('[data-player-face]:not([data-viewer])').boundingBox())!);
    await alice.page.mouse.move(face.x, face.y, { steps: 8 });
    await expect(targeter(alice.page), 'the target arrow comes once Forge asks for the target').toHaveCount(1, { timeout: 3_000 });
    const arrow = { mode: await targeter(alice.page).getAttribute('data-mode'), source: await targeter(alice.page).getAttribute('data-source') };
    console.log(`[hh-flash] released over the table: says "${(await says(alice.page)).replace(/\s+/g, ' ').trim()}", arrow after the cast mode=${arrow.mode} source=${arrow.source}`);
    expect(arrow.source, 'the arrow leaves from Firebolt').toBe(String(bolt));
    for (const p of [alice.page, bob.page]) await watchStack(p);
    await alice.page.mouse.click(face.x, face.y);
    await resolveIntoExile(alice.page, bob.page, 'Firebolt');
    const bobLife = bob.page.locator('[data-player-face][data-viewer] [data-testid="life"]');
    await expect(bobLife, 'Firebolt hit bob').toHaveText('18', { timeout: 10_000 });
    const boltSeen = { alice: await stackSeen(alice.page), bob: await stackSeen(bob.page) };
    console.log(`[hh-flash] Firebolt cast, targeted at bob and resolved: drawn on the stack on alice's screen [${boltSeen.alice.join(', ')}], on bob's [${boltSeen.bob.join(', ')}]; bob at ${(await bobLife.textContent())?.trim()} life`);
    expect(boltSeen.alice, 'Firebolt was on the stack on her screen').toContain('Firebolt');
    expect(boltSeen.bob, "and on bob's").toContain('Firebolt');

    // ── 3. From the expanded pile view: Think Twice is picked up the same way.
    await expect.poll(() => offeredNamed(alice.page, 'Think Twice'), { timeout: 30_000, message: "Think Twice's flashback is offered again" }).toBe(twice);
    const island = await alice.page.locator(`${YARD} li[data-card-id]`).first().boundingBox();
    await alice.page.mouse.click(island!.x + island!.width / 2, island!.y + 3);
    await expect(view(alice.page), 'clicking her graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
    const inView = centre((await view(alice.page).locator(`li[data-card-id="${twice}"]`).boundingBox())!);
    await alice.page.mouse.move(inView.x, inView.y, { steps: 4 });
    await alice.page.mouse.down();
    await alice.page.mouse.move(field.x, field.y, { steps: 10 });
    const fromView = { lift: await lift(alice.page, twice), arrow: await targeter(alice.page).count(), view: await view(alice.page).count() };
    console.log(`[hh-flash] press on Think Twice #${twice} in the pile view, carried to the table: data-cast-lift=${fromView.lift}, arrows drawn=${fromView.arrow}, pile views open=${fromView.view}`);
    expect(fromView, 'the pile view gives Think Twice up to the pointer like a hand card, no arrow').toEqual({ lift: 'lifted', arrow: 0, view: 0 });
    await alice.page.mouse.up();
    await resolveIntoExile(alice.page, bob.page, 'Think Twice');
    const twiceSeen = { alice: await stackSeen(alice.page), bob: await stackSeen(bob.page) };
    const exile = await exiled(alice.page);
    console.log(`[hh-flash] Think Twice cast from the pile view and resolved: drawn on the stack on alice's screen [${twiceSeen.alice.join(', ')}], on bob's [${twiceSeen.bob.join(', ')}]; alice's exile [${exile.join(', ')}], graveyard ${await alice.page.locator(YARD).getAttribute('data-count')}`);
    expect(twiceSeen.alice, 'Think Twice was on the stack on her screen').toContain('Think Twice');
    expect(twiceSeen.bob, "and on bob's").toContain('Think Twice');
    expect(exile.sort(), 'both flashback spells resolved into exile').toEqual(['Firebolt', 'Think Twice']);
  } finally {
    await stack.stop();
  }
});
