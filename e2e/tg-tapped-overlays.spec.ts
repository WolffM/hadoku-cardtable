/**
 * Everything drawn on a card follows it when it turns, and a token wears no mark.
 *
 * The operator, 2026-10-14 (asked twice): *"my request about 'deathtouch not following' a card when
 * it taps i notice is still a problem. that should happen for all counters on a card including
 * indicators like summoning sickness."* And: *"let's just get rid of the token indicator, its noise."*
 *
 * Scenario `tg-tapped-overlays`: alice's Llanowar Elves wearing Basilisk Collar (a pile; granted
 * Deathtouch and Lifelink tags, a +1/+1 counter, P/T), a lone Llanowar Elves with two +1/+1 counters,
 * a summoning-sick Hill Giant that starts tapped with a counter, and a Goblin token.
 *
 * Both screens record every animation frame from before alice taps each Elves for mana until after
 * she untaps it again: every overlay on every battlefield card (marks, tags, counters, P/T, copies,
 * type pill, relations, picked) must lie inside the card as it is drawn — the art's own box, turned
 * or not. Then no card on either screen wears a token mark.
 *
 * Every step prints one `[tg-tapped-overlays]` line, green or red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, clickRecords, isTapped, makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[tg-tapped-overlays] ${JSON.stringify({ step, data })}`);

/** Sub-pixel rounding between two boxes laid out from the same card. */
const SLACK = 1;

type Miss = { frame: number; card: string; tapped: boolean; overlay: string; art: number[]; box: number[] };
type Rec = { frames: number; misses: Miss[]; tappedFrames: Record<string, number>; overlaysSeen: Record<string, string[]> };

/** Every frame: each battlefield card's overlays against its drawn art. Read back with {@link stopRecording}. */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate((slack) => {
    const w = window as unknown as { __tg: Rec & { stop: boolean } };
    type Miss = { frame: number; card: string; tapped: boolean; overlay: string; art: number[]; box: number[] };
    type Rec = { frames: number; misses: Miss[]; tappedFrames: Record<string, number>; overlaysSeen: Record<string, string[]> };
    w.__tg = { frames: 0, misses: [], tappedFrames: {}, overlaysSeen: {}, stop: false } as Rec & { stop: boolean };
    const OVERLAYS = ['marks', 'tags', 'counters', 'pt', 'copies', 'type-pill', 'relations', 'picked'];
    const box = (r: DOMRect) => [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n * 10) / 10);
    const tick = () => {
      const rec = w.__tg;
      if (rec.stop) return;
      rec.frames += 1;
      for (const li of Array.from(document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]'))) {
        const id = li.getAttribute('data-board-card') ?? '?';
        const art = li.querySelector(':scope > .board-card__face > .card');
        if (art === null) continue;
        const a = art.getBoundingClientRect();
        const tapped = li.hasAttribute('data-tapped');
        if (tapped) rec.tappedFrames[id] = (rec.tappedFrames[id] ?? 0) + 1;
        for (const name of OVERLAYS) {
          for (const el of Array.from(li.querySelectorAll(`:scope > .board-card__${name}`))) {
            const seen = (rec.overlaysSeen[id] ??= []);
            if (!seen.includes(name)) seen.push(name);
            const o = el.getBoundingClientRect();
            if (o.width === 0 && o.height === 0) continue;
            const inside = o.left >= a.left - slack && o.top >= a.top - slack && o.right <= a.right + slack && o.bottom <= a.bottom + slack;
            if (!inside && rec.misses.length < 40) rec.misses.push({ frame: rec.frames, card: id, tapped, overlay: name, art: box(a), box: box(o) });
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SLACK);
}

async function stopRecording(page: Page): Promise<Rec> {
  return page.evaluate(() => {
    const w = window as unknown as { __tg: Rec & { stop: boolean } };
    w.__tg.stop = true;
    const { frames, misses, tappedFrames, overlaysSeen } = w.__tg;
    return { frames, misses, tappedFrames, overlaysSeen };
  });
}

/** Lets a few frames paint, so a state is sampled at rest as well as on the frame it changed. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => { let n = 0; const f = () => (++n >= 12 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }));

test(titled('every overlay stays on a card as it taps and untaps, on both screens, and a token wears no mark'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tg-tapped-overlays');
    const a = seated.alice.page;
    const b = seated.bob.page;

    let elves: number[] = [];
    await expect.poll(async () => (elves = await ownNamed(a, 'Llanowar Elves')).length, { timeout: 45_000, message: 'both Elves are drawn' }).toBe(2);
    const giant = (await ownNamed(a, 'Hill Giant'))[0]!;
    const collared = await a.locator(`[data-board-card="${elves[0]}"]`).evaluate((e) => e.hasAttribute('data-pile-size'));
    const [piled, lone] = collared ? [elves[0]!, elves[1]!] : [elves[1]!, elves[0]!];
    const tags = await a.locator(`[data-board-card="${piled}"] > .board-card__tags > [data-keyword]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-keyword')));
    log('board', { piled, lone, giant, tags });
    expect(tags, 'the collared Elves wear its granted keywords').toEqual(expect.arrayContaining(['deathtouch', 'lifelink']));
    await expect(a.locator(`[data-board-card="${giant}"] > .board-card__marks > [data-mark="sick"]`), 'the Giant wears the sick mark').toHaveCount(1);
    expect(await isTapped(a, giant), 'the Giant starts tapped').toBe(true);

    await startRecording(a);
    await startRecording(b);
    for (const [what, id] of [
      ['collared Elves', piled],
      ['lone Elves', lone],
    ] as const) {
      expect(await clickPermanent(a, id), `${what} is offered`).toBe(true);
      await expect.poll(() => isTapped(a, id), { timeout: 15_000, message: `${what} taps — ${clickRecords(stack, id)}` }).toBe(true);
      await expect.poll(() => isTapped(b, id), { timeout: 10_000, message: `bob sees ${what} tapped` }).toBe(true);
      await settle(a);
      await settle(b);
      expect(await clickPermanent(a, id, 10_000), `${what} is offered again to untap`).toBe(true);
      await expect.poll(() => isTapped(a, id), { timeout: 10_000, message: `${what} untaps — ${clickRecords(stack, id)}` }).toBe(false);
      await expect.poll(() => isTapped(b, id), { timeout: 10_000, message: `bob sees ${what} untapped` }).toBe(false);
      await settle(a);
      await settle(b);
    }
    const recs = { alice: await stopRecording(a), bob: await stopRecording(b) };
    for (const [who, rec] of Object.entries(recs)) {
      log(`${who} frames`, { frames: rec.frames, tappedFrames: rec.tappedFrames, overlaysSeen: rec.overlaysSeen, misses: rec.misses.slice(0, 12) });
    }
    for (const [who, rec] of Object.entries(recs)) {
      for (const id of [piled, lone, giant]) {
        expect(rec.tappedFrames[String(id)] ?? 0, `${who}: card ${id} was sampled tapped`).toBeGreaterThan(0);
      }
      expect(rec.overlaysSeen[String(piled)] ?? [], `${who}: the collared Elves' overlays were sampled`).toEqual(expect.arrayContaining(['tags', 'counters', 'pt']));
      expect(rec.misses, `${who}: every overlay lies on its card, turned or not, on every frame`).toEqual([]);
    }

    for (const [who, page] of [
      ['alice', a],
      ['bob', b],
    ] as const) {
      const goblin = await page.locator('[data-zone="battlefield"] [data-board-card]').evaluateAll((els) =>
        els.filter((e) => (e.querySelector('.card__name')?.textContent ?? '').includes('Goblin')).map((e) => ({
          id: e.getAttribute('data-board-card'),
          marks: Array.from(e.querySelectorAll(':scope > .board-card__marks > [data-mark]')).map((m) => m.getAttribute('data-mark')),
        })),
      );
      log(`${who} token`, { goblin, tokenMarks: await page.locator('[data-mark="token"]').count() });
      expect(goblin.length, `${who}: the Goblin token is drawn`).toBe(1);
      expect(goblin[0]!.marks, `${who}: the token wears no mark`).toEqual([]);
      await expect(page.locator('[data-mark="token"]'), `${who}: no token mark anywhere`).toHaveCount(0);
    }
    log('green', {});
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
