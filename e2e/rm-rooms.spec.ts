/**
 * The operator, 2026-10-19: "cards like 'Walk-In Closet' it's hard to tell whats actually going on.
 * which room was played, which room is active? has the door been unlocked?"
 *
 * Scenario `rooms`: alice has a Room on the battlefield that was never cast, the same Room in hand,
 * and eleven Forests. A Room on the battlefield is drawn as its two doors, each marked locked or
 * unlocked, the same on both screens:
 *
 *   1. the never-cast Room: both doors locked; a press on it offers its two unlocks as its two doors,
 *      and the one picked unlocks with a beat;
 *   2. cast Walk-In Closet from hand: its left door unlocked, the right locked;
 *   3. a press on the locked door unlocks Forgotten Cellar: both unlocked, and the beat is seen;
 *   4. the inspector shows the door under the pointer with its lock state, and the wheel the other.
 *
 * Every step prints one `[rm]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, makeTitled, pressPaymentAuto, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[rm] ${JSON.stringify({ step, data })}`);

const ROOM = 'Walk-In Closet // Forgotten Cellar';

/** Each door of the Room `id` as `page` draws it, left then right: its name and state. */
function doorsOn(page: Page, id: number): Promise<string[]> {
  return page
    .locator(`[data-zone="battlefield"] [data-board-card="${id}"] .board-card__door`)
    .evaluateAll((els) => els.map((e) => `${e.querySelector('.card__name')?.textContent ?? '?'}:${e.querySelector<HTMLElement>('.card')?.dataset.door ?? '?'}`));
}

/** Record every door that plays its unlock beat on `page`, from now on, in `window.__rmBeats`. */
async function watchBeats(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rmBeats?: string[] };
    w.__rmBeats = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (el.hasAttribute('data-unlocking')) w.__rmBeats!.push(`${el.closest('[data-board-card]')?.getAttribute('data-board-card')}:${el.dataset.doorSide}`);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-unlocking'] });
  });
}

const beats = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __rmBeats?: string[] }).__rmBeats ?? []);

test(titled('a Room is drawn as its two doors, locked or unlocked, on both screens, and a door unlocks with a beat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice: a, bob: b } = await startScenarioMatch(browser, stack, 'rooms');
    const alice = a.page;
    const bob = b.page;
    const both = async (id: number) => ({ alice: await doorsOn(alice, id), bob: await doorsOn(bob, id) });
    const pumpUntil = async (done: () => Promise<boolean>, label: string, face?: string) => {
      await expect
        .poll(
          async () => {
            if (await done()) return true;
            if (face !== undefined) await alice.locator(`[data-testid="prompt-face"][data-face="${face}"]`).click({ timeout: 500 }).catch(() => undefined);
            await pressPaymentAuto(alice);
            if ((await stackCount(alice)) > 0) {
              for (const page of [alice, bob]) await enabledOk(page).click({ timeout: 500 }).catch(() => undefined);
            }
            return done();
          },
          { timeout: 40_000, intervals: [250], message: label },
        )
        .toBe(true);
    };

    // 1. The Room that was never cast.
    const own = alice.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    const uncast = await own.evaluateAll((els) =>
      els.filter((e) => !/^Forest$/.test(e.querySelector('.card__name')?.textContent ?? '')).map((e) => Number(e.getAttribute('data-board-card'))),
    );
    log('uncast', uncast);
    expect(uncast, 'one Room on alice’s battlefield').toHaveLength(1);
    const locked = uncast[0]!;
    await expect.poll(() => both(locked), { message: 'both doors locked, on both screens' }).toEqual({
      alice: ['Walk-In Closet:locked', 'Forgotten Cellar:locked'],
      bob: ['Walk-In Closet:locked', 'Forgotten Cellar:locked'],
    });
    log('never cast', await both(locked));

    await watchBeats(alice);
    await watchBeats(bob);
    await alice.locator(`[data-board-card="${locked}"] .board-card__door[data-door-side="left"]`).click();
    const faces = alice.getByTestId('prompt-face');
    await expect(faces, 'its two unlocks, offered as its two doors').toHaveCount(2, { timeout: 20_000 });
    const offered = await faces.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-face')}:${e.querySelector<HTMLElement>('.card')?.dataset.door}`));
    log('unlock offer', offered);
    expect(offered).toEqual(['Walk-In Closet:locked', 'Forgotten Cellar:locked']);
    await pumpUntil(async () => (await doorsOn(alice, locked))[0] === 'Walk-In Closet:unlocked', 'the uncast Room’s Walk-In Closet unlocks', 'Walk-In Closet');
    await expect.poll(() => doorsOn(bob, locked), { message: 'bob sees it unlock' }).toEqual(['Walk-In Closet:unlocked', 'Forgotten Cellar:locked']);
    await expect.poll(() => beats(alice), { message: 'alice sees the beat' }).toContain(`${locked}:left`);
    await expect.poll(() => beats(bob), { message: 'bob sees the beat' }).toContain(`${locked}:left`);
    log('first unlock', { doors: await both(locked), beats: { alice: await beats(alice), bob: await beats(bob) } });

    // 2. Cast Walk-In Closet from her hand.
    const inHand = await alice
      .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
      .filter({ has: alice.locator('.card__name', { hasText: ROOM }) })
      .first()
      .getAttribute('data-board-card');
    const cast = Number(inHand);
    expect(await clickHandCard(alice, cast), 'the Room lifted out of her hand').toBe(true);
    await pumpUntil(async () => (await doorsOn(alice, cast)).length === 2 && (await stackCount(alice)) === 0, 'Walk-In Closet resolves', 'Walk-In Closet');
    await expect.poll(() => both(cast), { message: 'the cast door unlocked, the other locked, on both screens' }).toEqual({
      alice: ['Walk-In Closet:unlocked', 'Forgotten Cellar:locked'],
      bob: ['Walk-In Closet:unlocked', 'Forgotten Cellar:locked'],
    });
    log('cast', { doors: await both(cast), beats: await beats(alice) });
    expect(await beats(alice), 'a door open as the Room arrives plays no beat').not.toContain(`${cast}:left`);

    // 3. A press on the locked door unlocks it.
    await alice.locator(`[data-board-card="${cast}"] .board-card__door[data-door-side="right"]`).click();
    await pumpUntil(async () => (await doorsOn(alice, cast))[1] === 'Forgotten Cellar:unlocked', 'Forgotten Cellar unlocks', 'Forgotten Cellar');
    await expect.poll(() => both(cast), { message: 'both doors unlocked, on both screens' }).toEqual({
      alice: ['Walk-In Closet:unlocked', 'Forgotten Cellar:unlocked'],
      bob: ['Walk-In Closet:unlocked', 'Forgotten Cellar:unlocked'],
    });
    await expect.poll(() => beats(alice), { message: 'alice sees Forgotten Cellar’s beat' }).toContain(`${cast}:right`);
    await expect.poll(() => beats(bob), { message: 'bob sees Forgotten Cellar’s beat' }).toContain(`${cast}:right`);
    log('second unlock', { doors: await both(cast), beats: { alice: await beats(alice), bob: await beats(bob) } });

    // 4. The inspector: the door under the pointer with its state, and the wheel turns to the other.
    const shown = () =>
      alice.locator('[data-inspect] .card').evaluate((e) => `${e.querySelector('.card__name')?.textContent}:${(e as HTMLElement).dataset.door}`);
    await bob.mouse.move(5, 5);
    await alice.locator(`[data-board-card="${locked}"] .board-card__door[data-door-side="right"] .card`).hover();
    await expect(alice.locator('[data-inspect]')).toBeVisible();
    const seen = [await shown()];
    await alice.mouse.wheel(0, 120);
    seen.push(await shown());
    log('inspector', seen);
    expect(seen).toEqual(['Forgotten Cellar:locked', 'Walk-In Closet:unlocked']);
  } finally {
    await stack.stop();
  }
});
