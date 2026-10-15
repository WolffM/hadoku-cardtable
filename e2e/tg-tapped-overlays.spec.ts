/**
 * Everything drawn on a card follows it when it turns, and a token wears no mark.
 *
 * The operator, 2026-10-14 (asked twice): *"my request about 'deathtouch not following' a card when
 * it taps i notice is still a problem. that should happen for all counters on a card including
 * indicators like summoning sickness."* And: *"let's just get rid of the token indicator, its noise."*
 *
 * Scenario `tg-tapped-overlays`: alice's Llanowar Elves wearing Basilisk Collar (a pile; granted
 * Deathtouch and Lifelink tags, a +1/+1 counter, P/T), a lone Llanowar Elves with two +1/+1 counters,
 * a summoning-sick Hill Giant that starts tapped with a counter, a Goblin token, Mycosynth Lattice
 * (so the Elves, the Birds and the Forests read a type line they did not print: the type pill), two
 * tapped Forests the spec piles (copies ×2 on a turned card), and three flyers — a tapped, collared
 * Birds of Paradise, an untapped Birds with a counter, and Grizzly Bears given Flying by Arcane Flight.
 *
 * The operator, 2026-10-15, on a tapped Birds of Paradise: *"its ok for the pill to cover the art, but
 * i just want to make sure the pills are actually on the card when they tap"*.
 *
 * Both screens record every animation frame from before alice taps each Elves for mana until after
 * she untaps it again: every overlay on every battlefield card (marks, tags, counters, P/T, copies,
 * type pill, relations, picked) must lie inside the card as it is drawn — the art's own box, turned
 * or not — and every kind the scenario draws must be seen on a turned card. A flyer's art loops on
 * the wing (`card.css`), and everything it wears loops with it: each overlay's offset from the art's
 * drawn box holds within a pixel on every frame while the art itself moves. Then no card on either
 * screen wears a token mark.
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
import { boxOf, onTopPoint, pointerDrag } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[tg-tapped-overlays] ${JSON.stringify({ step, data })}`);

/** Sub-pixel rounding between two boxes laid out from the same card. */
const SLACK = 1;
/** A flyer's whole loop (`card.css`'s `--fly-loop`, 5.6 s) and a little: a recording shorter than this can catch a flyer in a short stretch of its path. */
const LOOP_MS = 6_000;

type Miss = { frame: number; card: string; tapped: boolean; overlay: string; art: number[]; box: number[] };
/** A flyer over the recording: how far its art travelled across and up, and the most any overlay strayed from it. */
type Flyer = { frames: number; artX: number[]; artY: number[]; drift: number; overlays: string[] };
type Rec = {
  frames: number;
  misses: Miss[];
  /** An overlay whose offset from a flyer's art moved by more than the slack: it did not ride with the card. */
  drifts: (Miss & { by: number })[];
  tappedFrames: Record<string, number>;
  overlaysSeen: Record<string, string[]>;
  /** Every overlay kind seen on a turned card, any card. */
  tappedSeen: string[];
  flyers: Record<string, Flyer>;
};

/** Every frame: each battlefield card's overlays against its drawn art. Read back with {@link stopRecording}. */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate((slack) => {
    const w = window as unknown as { __tg: Rec & { stop: boolean; start: number; base: Record<string, number[]> } };
    type Miss = { frame: number; card: string; tapped: boolean; overlay: string; art: number[]; box: number[] };
    type Flyer = { frames: number; artX: number[]; artY: number[]; drift: number; overlays: string[] };
    type Rec = {
      frames: number;
      misses: Miss[];
      drifts: (Miss & { by: number })[];
      tappedFrames: Record<string, number>;
      overlaysSeen: Record<string, string[]>;
      tappedSeen: string[];
      flyers: Record<string, Flyer>;
    };
    w.__tg = { frames: 0, misses: [], drifts: [], tappedFrames: {}, overlaysSeen: {}, tappedSeen: [], flyers: {}, stop: false, start: performance.now(), base: {} };
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
        const flyer = li.hasAttribute('data-flying') ? (rec.flyers[id] ??= { frames: 0, artX: [a.left, a.left], artY: [a.top, a.top], drift: 0, overlays: [] }) : undefined;
        if (flyer !== undefined) {
          flyer.frames += 1;
          flyer.artX = [Math.min(flyer.artX[0]!, a.left), Math.max(flyer.artX[1]!, a.left)];
          flyer.artY = [Math.min(flyer.artY[0]!, a.top), Math.max(flyer.artY[1]!, a.top)];
        }
        for (const name of OVERLAYS) {
          Array.from(li.querySelectorAll(`:scope > .board-card__${name}`)).forEach((el, n) => {
            const o = el.getBoundingClientRect();
            if (o.width === 0 && o.height === 0) return;
            const seen = (rec.overlaysSeen[id] ??= []);
            if (!seen.includes(name)) seen.push(name);
            if (tapped && !rec.tappedSeen.includes(name)) rec.tappedSeen.push(name);
            const inside = o.left >= a.left - slack && o.top >= a.top - slack && o.right <= a.right + slack && o.bottom <= a.bottom + slack;
            if (!inside && rec.misses.length < 40) rec.misses.push({ frame: rec.frames, card: id, tapped, overlay: name, art: box(a), box: box(o) });
            if (flyer === undefined) return;
            if (!flyer.overlays.includes(name)) flyer.overlays.push(name);
            // Its offset from each edge of the art, against the first frame of this card in this state. An overlay pinned to
            // one edge keeps that edge's offset even when its own width changes, so the nearer of the two edges is the one held.
            const off = [o.left - a.left, o.right - a.right, o.top - a.top, o.bottom - a.bottom];
            const was = (w.__tg.base[`${id}:${tapped}:${name}:${n}`] ??= off);
            const by = Math.max(Math.min(Math.abs(off[0]! - was[0]!), Math.abs(off[1]! - was[1]!)), Math.min(Math.abs(off[2]! - was[2]!), Math.abs(off[3]! - was[3]!)));
            flyer.drift = Math.max(flyer.drift, by);
            if (by > slack && rec.drifts.length < 40) rec.drifts.push({ frame: rec.frames, card: id, tapped, overlay: name, art: box(a), box: box(o), by: Math.round(by * 100) / 100 });
          });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SLACK);
}

async function stopRecording(page: Page): Promise<Rec> {
  await page.waitForFunction((loop) => performance.now() - (window as unknown as { __tg: { start: number } }).__tg.start >= loop, LOOP_MS);
  return page.evaluate(() => {
    const w = window as unknown as { __tg: Rec & { stop: boolean } };
    w.__tg.stop = true;
    const { frames, misses, drifts, tappedFrames, overlaysSeen, tappedSeen, flyers } = w.__tg;
    return { frames, misses, drifts, tappedFrames, overlaysSeen, tappedSeen, flyers };
  });
}

/** Lets a few frames paint, so a state is sampled at rest as well as on the frame it changed. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => { let n = 0; const f = () => (++n >= 12 ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }));

test(titled('every overlay stays on a card as it taps and untaps and rides a flyer as it loops, on both screens, and a token wears no mark'), async ({ browser }) => {
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

    // The two tapped Forests piled: copies on a turned card.
    const forests = await ownNamed(a, 'Forest');
    const tappedForests: number[] = [];
    for (const id of forests) if (await isTapped(a, id)) tappedForests.push(id);
    expect(tappedForests.length, 'two Forests start tapped').toBe(2);
    const [forestBase, forestTop] = tappedForests as [number, number];
    await pointerDrag(a, a.locator(`[data-board-card="${forestTop}"]`), onTopPoint(await boxOf(a.locator(`[data-board-card="${forestBase}"]`))));
    await expect(a.locator(`[data-board-card="${forestBase}"]`), 'the tapped Forests are one pile').toHaveAttribute('data-pile-size', '2');
    await expect.poll(() => b.locator(`[data-board-card="${forestBase}"] > .board-card__copies`).textContent(), { timeout: 10_000, message: 'bob sees ×2 on the tapped pile' }).toBe('×2');
    await expect(a.locator(`[data-board-card="${forestBase}"] > .board-card__copies`), 'alice sees ×2 on the tapped pile').toHaveText('×2');

    const birds = await ownNamed(a, 'Birds of Paradise');
    expect(birds.length, 'both Birds are drawn').toBe(2);
    const birdsTapped = await Promise.all(birds.map((id) => isTapped(a, id)));
    const flyers = {
      tappedBirds: birds[birdsTapped.indexOf(true)]!,
      birds: birds[birdsTapped.indexOf(false)]!,
      bears: (await ownNamed(a, 'Grizzly Bears'))[0]!,
    } as const;
    const typeLines = await a.locator(`[data-board-card="${flyers.tappedBirds}"] > .board-card__face .card__type`).allTextContents();
    log('flyers', { ...flyers, typeLines });
    for (const [what, id] of Object.entries(flyers)) {
      await expect(a.locator(`[data-board-card="${id}"]`), `${what} flies`).toHaveAttribute('data-flying', /.*/);
      await expect(b.locator(`[data-board-card="${id}"]`), `bob sees ${what} fly`).toHaveAttribute('data-flying', /.*/);
    }
    expect(birdsTapped.toSorted(), 'one Birds starts tapped, the other not').toEqual([false, true]);
    await expect(a.locator(`[data-board-card="${flyers.tappedBirds}"]`), 'the tapped Birds wears the collar').toHaveAttribute('data-pile-size', '2');
    await expect(a.locator(`[data-board-card="${flyers.tappedBirds}"] > .board-card__type-pill`), 'Mycosynth Lattice puts the type pill on the tapped Birds').toHaveCount(1);
    await expect(a.locator(`[data-board-card="${flyers.bears}"] > .board-card__tags > [data-keyword="flying"]`), 'Arcane Flight tags the Bears Flying').toHaveCount(1);

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
      log(`${who} frames`, { frames: rec.frames, tappedFrames: rec.tappedFrames, overlaysSeen: rec.overlaysSeen, tappedSeen: rec.tappedSeen, misses: rec.misses.slice(0, 12) });
      log(`${who} flyers`, { flyers: rec.flyers, drifts: rec.drifts.slice(0, 12) });
    }
    for (const [who, rec] of Object.entries(recs)) {
      for (const id of [piled, lone, giant]) {
        expect(rec.tappedFrames[String(id)] ?? 0, `${who}: card ${id} was sampled tapped`).toBeGreaterThan(0);
      }
      expect(rec.overlaysSeen[String(piled)] ?? [], `${who}: the collared Elves' overlays were sampled`).toEqual(expect.arrayContaining(['tags', 'counters', 'pt', 'type-pill']));
      expect(rec.tappedSeen, `${who}: every overlay kind the scenario draws was sampled on a turned card`).toEqual(
        expect.arrayContaining(['marks', 'tags', 'counters', 'pt', 'copies', 'type-pill']),
      );
      for (const [what, id] of Object.entries(flyers)) {
        const f = rec.flyers[String(id)];
        expect(f?.frames ?? 0, `${who}: ${what} was sampled`).toBeGreaterThan(30);
        expect((f?.artX[1] ?? 0) - (f?.artX[0] ?? 0), `${who}: ${what}'s art sways across`).toBeGreaterThan(3);
      }
      expect(rec.flyers[String(flyers.tappedBirds)]?.overlays ?? [], `${who}: the tapped Birds' overlays were sampled`).toEqual(expect.arrayContaining(['tags', 'counters', 'pt', 'type-pill']));
      expect(rec.flyers[String(flyers.birds)]?.overlays ?? [], `${who}: the untapped Birds' overlays were sampled`).toEqual(expect.arrayContaining(['counters', 'pt', 'type-pill']));
      expect(rec.flyers[String(flyers.bears)]?.overlays ?? [], `${who}: the Bears' overlays were sampled`).toEqual(expect.arrayContaining(['tags', 'counters', 'pt']));
      expect(rec.misses, `${who}: every overlay lies on its card, turned or not, on every frame`).toEqual([]);
      expect(rec.drifts, `${who}: every overlay on a flyer moves with its art, on every frame`).toEqual([]);
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
