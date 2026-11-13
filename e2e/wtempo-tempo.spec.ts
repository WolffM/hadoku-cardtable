/**
 * The operator, 2026-11-02: *"the more time an animation plays in a single turn, i think the faster it should
 * happen (up to a speed cap). spells like blasphemous act should count as a single instance of an animation even
 * if it plays multiple fireballs. each time thopter foundry animation plays, i would want the sword of the meek
 * reanimate thing to happen faster and faster."*
 *
 * Tempo (`games/magic/ui/src/play/live/tempo.ts`): the `n`th instance of one thing in a turn plays at
 * `min(TEMPO_CAP, 1 + TEMPO_STEP × (n − 1))`.
 *
 *   1. Scenario `tf-thopter-sword` against the Forge AI, paced (Fast Mode off, where the Sword rises; Fast Mode
 *      draws its landing alone): alice loops Thopter Foundry and Sword of the Meek eight times in one turn. The
 *      page records each of the Sword's rises out of the graveyard (`entries.ts`'s `rise` stand-in) from the
 *      frame it is drawn to the frame it is gone, the lengths its animations were given, and the frames it was
 *      drawn with none of them running. Each rise's animations are no longer than the one before, the eighth's
 *      are given exactly `TEMPO_CAP` times less than the first's, and every rise is drawn for its animations and
 *      nothing else: never cut short, and never held more than a frame or two with nothing playing.
 *   2. Scenario `w80c-blasphemous`: alice's Blasphemous Act draws a fireball at each of the eleven creatures, every
 *      one at 1× — one instance, however many fireballs — on both screens, and the match log has no faster view of it.
 *
 * `[tempo]` lines are the evidence, with the match log's `beats` (each view's `tempo`). Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one
 * this SKIPS and the title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, castUntilOnStack, handCardNamed, makeTitled, ownNamed, passOverStack, pressOffered, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';
import { startScenarioMatch, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** `tempo.ts`'s own: the e2e states them rather than importing the UI. */
const TEMPO_CAP = 2.5;
/** The scenario's eight Islands: a loop each. */
const LOOPS = 8;
/**
 * The frames a rise may be drawn with none of its animations running: the hand-over from one to the next, and its
 * removal. Counted in frames, not milliseconds: a busy runner draws a frame late, and a wall-clock length compared
 * with the rise before reads that as the product (rises 6 and 7 at 2.25× and 2.5× drawn 639 and 742 ms, their
 * animations 564 and 508 ms).
 */
const IDLE_FRAMES = 2;

const life = (page: Page) => page.locator('.seat[data-viewer] [data-testid="life"]');

interface Rise {
  /** From the frame the stand-in was drawn to the frame it was gone. */
  shownMs: number;
  /** What its animations were given on the wall: each one's length over its playback rate, summed. */
  plannedMs: number;
  /** Frames it was drawn with none of its own animations running. */
  idleFrames: number;
  tempo: string;
}
interface Ball {
  tempo: string;
  look: string;
}
interface Recorded {
  rises: Rise[];
  balls: Ball[];
}

/** Records every rise stand-in and every flying hit drawn on `page` from now on. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rec = { rises: [] as Rise[], balls: [] as Ball[] };
    (window as unknown as { __tempo: Recorded }).__tempo = rec;
    const open = new Map<Element, { at: number; planned: Map<Animation, number>; idle: number }>();
    const look = (): void => {
      for (const [el, r] of open) {
        const anims = el.getAnimations();
        for (const a of anims) {
          const d = Number(a.effect?.getComputedTiming().duration ?? 0);
          if (Number.isFinite(d)) r.planned.set(a, d / (a.playbackRate || 1));
        }
        if (el.isConnected && !anims.some((a) => a.playState === 'running')) r.idle += 1;
        if (!el.isConnected) {
          rec.rises.push({
            shownMs: Math.round(performance.now() - r.at),
            plannedMs: Math.round([...r.planned.values()].reduce((s, x) => s + x, 0)),
            idleFrames: r.idle,
            tempo: (el as HTMLElement).style.getPropertyValue('--tempo'),
          });
          open.delete(el);
        }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.matches('.board-entry[data-entry="rise"]')) open.set(n, { at: performance.now(), planned: new Map(), idle: 0 });
          if (n.matches('.effect-hit')) rec.balls.push({ tempo: n.style.getPropertyValue('--tempo'), look: n.dataset.projectile ?? '' });
        }
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const recorded = (page: Page): Promise<Recorded> => page.evaluate(() => (window as unknown as { __tempo: Recorded }).__tempo);

const whenOffered = (page: Page, id: number, timeout: number) =>
  page.waitForFunction((card) => document.querySelector(`[data-board-card="${card}"][data-selectable]`) !== null, id, { polling: 'raf', timeout });

/**
 * Loop `loop` is over: its Thopter made (the scenario's 11 permanents, a Thopter a loop), the Sword back, and — while an
 * Island is left to pay for the next — the Foundry offered again.
 */
const whenLooped = (page: Page, foundry: number, loop: number, timeout: number) =>
  page.waitForFunction(
    ({ card, permanents, last }) => {
      const own = [...(document.querySelector('.seat[data-viewer]')?.querySelectorAll('[data-zone="battlefield"] [data-board-card]') ?? [])];
      const sword = own.some((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Sword of the Meek');
      return sword && own.length === permanents && (last || document.querySelector(`[data-board-card="${card}"][data-selectable]`) !== null);
    },
    { card: foundry, permanents: 11 + loop + 1, last: loop === LOOPS - 1 },
    { polling: 'raf', timeout },
  );

test(titled('Thopter Foundry + Sword of the Meek, eight loops in one turn: each return of the Sword plays faster, to the cap'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'tf-thopter-sword', { fastMode: false });
    const page = alice.page;
    await expect.poll(() => ownNamed(page, 'Thopter Foundry'), { timeout: 60_000, message: 'alice has her Thopter Foundry' }).toHaveLength(1);
    const [foundry] = await ownNamed(page, 'Thopter Foundry');
    await expect(life(page)).toHaveText('20', { timeout: 30_000 });
    await whenOffered(page, foundry!, 60_000);
    await record(page);

    for (let loop = 0; loop < LOOPS; loop++) {
      const [sword] = await ownNamed(page, 'Sword of the Meek');
      expect(sword, `loop ${loop + 1}: the Sword is on the battlefield`).not.toBeUndefined();
      expect(await pressOffered(boardCard(page, foundry!)), `loop ${loop + 1}: the Foundry is pressed`).toBe(true);
      const pick = page.locator(`[data-testid="live-selection-host"] li[data-card-id="${sword}"] label`);
      await pick.waitFor({ timeout: 20_000 });
      await pick.click();
      if (loop === 0) {
        // The Sword's "may", once: Always + Yes.
        await expect(page.getByTestId('live-confirm'), 'the Sword asks its "may"').toHaveCount(1, { timeout: 20_000 });
        await page.getByTestId('live-confirm-always').check();
        await page.getByTestId('prompt-confirm-yes').click();
      }
      await whenLooped(page, foundry!, loop, 20_000);
    }
    await expect(life(page), 'every loop’s life is drawn once the beats are over').toHaveText(String(20 + LOOPS), { timeout: 10_000 });
    await expect.poll(async () => (await recorded(page)).rises.length, { timeout: 10_000, message: 'every rise has played out' }).toBe(LOOPS);

    const { rises, balls } = await recorded(page);
    for (const [i, r] of rises.entries()) console.log(`[tempo] rise ${i + 1}: tempo ${r.tempo || '1'}, shown ${r.shownMs} ms, its animations ${r.plannedMs} ms, ${r.idleFrames} frame(s) with none running`);
    console.log(`[tempo] heal motes: ${balls.filter((b) => b.look === 'heal').map((b) => b.tempo || '1').join(' ')}`);
    // The match log's word on each view's beats, the Sword's returns among them (`numbers.ts`'s `beats`, its `tempo`); a
    // busy second's events beyond the server's cap are dropped, so the log is evidence, not the measure.
    const beats = serverLog(stack).filter((r) => r.evt === 'client' && r.seat === 0 && r.what === 'beats' && Number(r.arrivals) > 0);
    console.log(`[tempo] log: arrivals' beats ${beats.map((r) => `${String(r.tempo)}×/${String(r.totalMs)}ms`).join(' ')}`);

    expect(rises.map((r) => Number(r.tempo || '1')), 'the nth return plays at the nth tempo').toEqual([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.5]);
    for (let i = 1; i < rises.length; i++) {
      expect(rises[i]!.plannedMs, `rise ${i + 1}'s animations are no longer than rise ${i}'s`).toBeLessThanOrEqual(rises[i - 1]!.plannedMs);
    }
    expect(rises[0]!.plannedMs / rises[7]!.plannedMs, 'its animations are given exactly the cap').toBeCloseTo(TEMPO_CAP, 1);
    // What is drawn is those animations: each rise plays them out, and nothing holds it on the table besides.
    for (const [i, r] of rises.entries()) {
      expect(r.shownMs, `rise ${i + 1} is drawn for all of its animations`).toBeGreaterThanOrEqual(r.plannedMs);
      expect(r.idleFrames, `rise ${i + 1} is held no more than ${IDLE_FRAMES} frame(s) with nothing playing`).toBeLessThanOrEqual(IDLE_FRAMES);
    }
  } finally {
    await stack.stop();
  }
});

test(titled('Blasphemous Act is one instance: every one of its fireballs flies at 1×, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const slow = (page: Page): Promise<void> => setPlayFastModeDefault(page.context(), false);
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w80c-blasphemous', { beforeAlice: slow, beforeBob: slow });
    const a = alice.page;
    const b = bob.page;
    await expect.poll(() => handCardNamed(a, 'Blasphemous Act'), { timeout: 45_000, message: 'alice holds Blasphemous Act' }).toBeDefined();
    await record(a);
    await record(b);
    const act = await handCardNamed(a, 'Blasphemous Act');
    await castUntilOnStack(a, stack, act!, []);
    await expect
      .poll(
        async () => {
          if ((await stackCount(a)) === 0) return true;
          await passOverStack(b);
          return (await stackCount(a)) === 0;
        },
        { timeout: 20_000, intervals: [100], message: 'Blasphemous Act resolves' },
      )
      .toBe(true);
    await a.waitForTimeout(3_000);
    for (const [who, page] of [
      ['alice', a],
      ['bob', b],
    ] as const) {
      const bolts = (await recorded(page)).balls.filter((x) => x.look === 'bolt');
      console.log(`[tempo] ${who}: ${bolts.length} fireballs, tempos ${bolts.map((x) => x.tempo || '1').join(' ')}`);
      expect(bolts.length, `${who}: a fireball for each creature it hit`).toBeGreaterThanOrEqual(8);
      expect(new Set(bolts.map((x) => x.tempo || '1')), `${who}: every one at 1×`).toEqual(new Set(['1']));
    }
    const wipe = serverLog(stack).filter((r) => r.evt === 'client' && r.what === 'beats' && Number(r.hits) >= 8);
    console.log(`[tempo] log: the wipe's beats ${wipe.map((r) => `seat ${String(r.seat)} ${String(r.hits)} hits at ${String(r.tempo)}×`).join(', ')}`);
    expect(wipe.filter((r) => r.tempo !== 1), 'the log: the wipe drawn at 1× wherever its beats were told').toEqual([]);
  } finally {
    await stack.stop();
  }
});
