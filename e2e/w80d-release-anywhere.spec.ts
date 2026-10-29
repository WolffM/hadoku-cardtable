/**
 * w80d: a permanent released anywhere is played. The operator, 2026-10-28:
 *
 *   "allow players to release permanent cards anywhere, but if they release it in an invalid location,
 *   just have the card land in the next avaliable board space."
 *
 * Two browsers, a real Forge match (`w80d-release-anywhere.state`). Alice holds Memnite, Ornithopter and
 * an Island, and already has Grizzly Bears, a Forest and a Mountain down. She lets go of Memnite over
 * bob's battlefield, Ornithopter over the stack, and the Island past the board's edge. Each is played:
 * it lands at the next free space of the row its type goes to — the end of that row here, since none
 * has a gap — on both screens, at the same column, and it never floats back to her hand. Before this
 * wave each release floated the card home and sent nothing.
 *
 * Every animation frame from the release on, alice's page records where the card is drawn: in her hand
 * would be the float home, and her stand-in (`data-cast-ghost`) must start where she let go.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[w80d-release] ${JSON.stringify({ step, data })}`);

interface Seen {
  t: number;
  /** The card's own element is in alice's hand and drawn. */
  inHand: boolean;
  /** The centre of her stand-in for it, while there is one. */
  ghost: { x: number; y: number } | null;
}

/** Record every frame of card `id` on alice's page from now on. */
async function record(page: Page, id: number): Promise<void> {
  await page.evaluate((cardId) => {
    const w = window as unknown as { __rel: unknown[]; __relStop: boolean };
    w.__rel = [];
    w.__relStop = false;
    const t0 = performance.now();
    const tick = (): void => {
      if (w.__relStop) return;
      const own = document.querySelector(`[data-zone="hand"][data-owner="you"] [data-board-card="${cardId}"]`);
      const ghost = document.querySelector(`[data-cast-ghost="${cardId}"]`);
      const r = ghost?.getBoundingClientRect();
      w.__rel.push({
        t: Math.round(performance.now() - t0),
        // Lifted, the hand's own element is still in the hand's list but drawn under the pointer: only a card back in its row counts.
        inHand: own !== null && !own.hasAttribute('data-cast-lift') && getComputedStyle(own).visibility !== 'hidden',
        ghost: r === undefined ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

async function frames(page: Page): Promise<Seen[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __rel: Seen[]; __relStop: boolean };
    w.__relStop = true;
    return w.__rel;
  });
}

/** The names of a row's columns on this page, left to right (`''` for a gap). */
async function rowNames(page: Page, owner: 'you' | 'them', tier: 'front' | 'back'): Promise<string[]> {
  return page
    .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-tier="${tier}"] > li`)
    .evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? ''));
}

const handCard = (page: Page, name: string) => page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name });

/** Nothing of the play left on either screen: no stand-in, no landing, no other-screen copy. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.board-entry, [data-cast-landing], [data-cast-ghost], .presence__handoff, .presence__back').count(), { timeout: 20_000, message: 'every stand-in is gone' }).toBe(0);
}

test(titled('a permanent released over the opponent, the stack or past the edge lands at its row’s next space, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // With motion on: the glide from the release point is part of the claim.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w80d-release-anywhere', {
      beforeAlice: (page) => setPlayFastModeDefault(page.context(), false),
      beforeBob: (page) => setPlayFastModeDefault(page.context(), false),
    });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    await expect(handCard(alice.page, 'Memnite')).toHaveCount(1, { timeout: 20_000 });

    const theirField = async () => (await alice.page.locator('[data-zone="battlefield"][data-owner="them"]').boundingBox())!;
    const stackZone = async () => (await alice.page.locator('[data-zone="stack"]').first().boundingBox())!;
    const releases: { name: string; tier: 'front' | 'back'; where: string; to: () => Promise<{ x: number; y: number }> }[] = [
      { name: 'Memnite', tier: 'front', where: "over bob's battlefield", to: async () => { const b = await theirField(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } },
      { name: 'Ornithopter', tier: 'front', where: 'over the stack', to: async () => { const b = await stackZone(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } },
      { name: 'Island', tier: 'back', where: "past the board's edge", to: async () => ({ x: 1600 - 4, y: 4 }) },
    ];

    for (const r of releases) {
      const card = handCard(alice.page, r.name);
      // Offered first: a release before Forge offers the card is the offer moving on, not this rule.
      await expect(card.and(alice.page.locator('[data-selectable]')), `${r.name} is offered`).toHaveCount(1, { timeout: 30_000 });
      const id = Number(await card.getAttribute('data-board-card'));
      const before = { alice: await rowNames(alice.page, 'you', r.tier), bob: await rowNames(bob.page, 'them', r.tier) };
      log(`${r.name} before`, before);
      const to = await r.to();
      await record(alice.page, id);
      expect(await dragHandCard(alice.page, id, to), `${r.name} lifted out of the hand`).toBe(true);

      await expect
        .poll(async () => (await rowNames(alice.page, 'you', r.tier)).includes(r.name), { timeout: 20_000, message: `alice: ${r.name}, released ${r.where}, is on her battlefield` })
        .toBe(true);
      await expect
        .poll(async () => (await rowNames(bob.page, 'them', r.tier)).includes(r.name), { timeout: 20_000, message: `bob: alice's ${r.name} is on her battlefield` })
        .toBe(true);
      await settled(alice.page);
      await settled(bob.page);
      // The stand-in is taken at the release and exists only after it: its first frame is the release's.
      const all = await frames(alice.page);
      const seen = all.slice(Math.max(0, all.findIndex((f) => f.ghost !== null)));

      const after = { alice: await rowNames(alice.page, 'you', r.tier), bob: await rowNames(bob.page, 'them', r.tier) };
      log(`${r.name} after`, { ...after, released: to, firstGhost: seen.find((f) => f.ghost !== null)?.ghost ?? null });
      // The next free space of a row with no gap is its end: the row as it was, then the card.
      expect.soft(after.alice, `alice: ${r.name} took the next space of her ${r.tier} row`).toEqual([...before.alice.filter((n) => n !== ''), r.name]);
      expect.soft(after.bob.indexOf(r.name), `bob: ${r.name} is in the same column as on alice's screen`).toBe(after.alice.indexOf(r.name));
      expect.soft(seen.filter((f) => f.inHand).map((f) => f.t), `alice: ${r.name} never floated back to the hand`).toEqual([]);
      const first = seen.find((f) => f.ghost !== null)?.ghost ?? null;
      expect.soft(first, `alice: ${r.name}'s stand-in is drawn after the release`).not.toBeNull();
      // Past the edge, the card is held inside the window: its stand-in starts as near the point as it can be drawn.
      if (first !== null && r.where !== "past the board's edge") expect.soft(Math.hypot(first.x - to.x, first.y - to.y), `alice: ${r.name}'s glide starts where she let go`).toBeLessThanOrEqual(24);
    }
    await expect(alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]')).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});
