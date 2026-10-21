/**
 * The operator, 2026-10-19, building a deck after a draft: "i remember having asked for 'scroll to see
 * transformed card' as a feature when hovering. Did that not land? I'm hovering Etali right now and i
 * can see it has a transform, why can i not scroll to see it?"
 *
 * The wheel turned an enlarged card to its other faces on the board only (Fable of the
 * Mirror-Breaker, `faces.spec.ts`); a drafted pool carried no faces at all and no other surface drew
 * them. What this pins, with Etali, Primal Conqueror:
 *
 *  - the deck builder, the operator's own surface: the pool's Etali, enlarged, turns to Etali, Primal
 *    Sickness and back. The builder's pool is the pod's `GET …/mine` answer, served here from this
 *    checkout's own `pool.json` entries (Etali among them) — a real draft cannot be steered to deal
 *    Etali;
 *  - a real Forge game (scenario `etali-faces`): Etali in alice's hand, on the stack while bob holds
 *    priority over it, and on her battlefield once it resolves.
 *
 * Every step prints one `[etali-faces]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { castByDrag, enabledOk, handCardNamed, makeTitled, offered, stackCount } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[etali-faces] ${JSON.stringify({ step, data })}`);

const FRONT = 'Etali, Primal Conqueror';
const BACK = 'Etali, Primal Sickness';

const shown = (page: Page): Promise<string | null> => page.locator('[data-inspect] .card__name').textContent({ timeout: 5_000 }).catch(() => null);

/** Hover `target`, then turn the wheel down and back up: the names the enlarged card shows at each step. */
async function wheelOver(page: Page, target: Locator, where: string): Promise<(string | null)[]> {
  // Into view and the pointer to the card's centre, by hand: a spell on the stack breathes while it
  // waits, so it is never "stable" to Playwright's own hover or scroll.
  await target.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${where}: the card is not on the screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('[data-inspect]'), `${where}: the card enlarges`).toBeVisible();
  const seen = [await shown(page)];
  await page.mouse.wheel(0, 120);
  seen.push(await shown(page));
  await page.mouse.wheel(0, -120);
  seen.push(await shown(page));
  log(where, seen);
  await page.mouse.move(5, 5);
  return seen;
}

test(titled('the wheel turns an enlarged Etali to Etali, Primal Sickness — in the deck builder, the hand, the stack and the battlefield'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    /* ── the deck builder ─────────────────────────────────────────────── */
    const pool = (JSON.parse(readFileSync(fileURLToPath(new URL('../apps/ui/src/draft/pool.json', import.meta.url)), 'utf8')) as { cards: { name: string }[] }).cards;
    const etali = pool.find((c) => c.name.startsWith(`${FRONT} //`));
    expect(etali, 'the cube pool holds Etali').not.toBeUndefined();
    const builder = await openFriend(browser, 'carol');
    await builder.page.route('**/api/drafts/*/mine', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pool: [...pool.slice(0, 20), etali], deck: null }) }),
    );
    await builder.page.goto(`${stack.origin}${PREFIX}/#/deck/r-e7a11e7a11e7`);
    // The builder opens with every pick in the main deck (the operator, 2026-10-21, Arena-style); Etali is put back in the pool, whole.
    const inDeck = builder.page.locator('[data-testid="main-grid"] [data-testid="card"]', { has: builder.page.locator('.card__name', { hasText: FRONT }) });
    await expect(inDeck, 'Etali is in the builder’s deck').toHaveCount(1, { timeout: 30_000 });
    // By its name strip: in a pile, the card's top is what shows.
    await inDeck.dragTo(builder.page.getByTestId('pool-area'), { sourcePosition: { x: 12, y: 6 } });
    const tile = builder.page.locator('[data-testid="side-grid"] [data-testid="card"]', { has: builder.page.locator('.card__name', { hasText: FRONT }) });
    await expect(tile, 'Etali is in the builder’s pool').toHaveCount(1, { timeout: 30_000 });
    expect(await wheelOver(builder.page, tile, 'deck builder')).toEqual([etali!.name, BACK, etali!.name]);

    /* ── a real game: the hand, the stack, the battlefield ───────────── */
    const { alice, bob } = await startScenarioMatch(browser, stack, 'etali-faces');
    const page = alice.page;
    const id = await handCardNamed(page, FRONT);
    expect(id, 'Etali is in alice’s hand').not.toBeUndefined();
    expect(await wheelOver(page, page.locator(`[data-board-card="${id}"]`), 'hand')).toEqual([FRONT, BACK, FRONT]);

    const field = (await page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
    await castByDrag(page, stack, id!, { x: Math.round(field.x + field.width * 0.6), y: Math.round(field.y + field.height * 0.5) });
    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'Etali is on the stack' }).toBe(1);
    await expect.poll(async () => (await offered(bob.page)).length > 0 && (await enabledOk(bob.page).count()) > 0, { timeout: 20_000, message: 'bob holds priority over Etali' }).toBe(true);
    const onStack = page.locator('[data-placed-spell]:not([data-placed-leaving]) .placed__tile .card');
    await expect(onStack, 'Etali is drawn on the stack').toHaveCount(1);
    expect(await wheelOver(page, onStack, 'stack')).toEqual([FRONT, BACK, FRONT]);

    await enabledOk(bob.page).first().click();
    const onField = page.locator('[data-zone="battlefield"][data-owner="you"] li.board-card', { has: page.locator('.card__name', { hasText: FRONT }) });
    await expect(onField, 'Etali resolves onto alice’s battlefield').toHaveCount(1, { timeout: 30_000 });
    expect(await wheelOver(page, onField, 'battlefield')).toEqual([FRONT, BACK, FRONT]);
  } finally {
    await stack.stop();
  }
});
