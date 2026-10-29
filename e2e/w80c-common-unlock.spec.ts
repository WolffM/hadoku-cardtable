/**
 * The operator, 2026-10-29, of w80c's films: *"my 90% rule was more about the more common animations like cards
 * on the stack getting countered or resolving single effects like doomblade. from what i can see it's 0% now
 * not 90%?"*
 *
 * `w80c-common.state`, Fast Mode off: a counter and a single-target removal resolve, each once as alice's own
 * act and once as bob's, and alice is the one asked next every time. Her screen is recorded from its own clock:
 * every animation, when the stack shrank, and when her next decision opened (an enabled OK, or a hand card she
 * can cast). That moment is a share of the resolution's effect, the animations the frame that shrank the stack
 * set off (the slice; the counter's blink and its target's crack and fade), not the spell then fading off the
 * stack. After bob's act it opens on the effect's last tenth; after her own it opens at once, as Forge asks
 * (AF216). `[w80c-common]` lines are the evidence.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { BUTTON_ONE, castUntilOnStack, handCardNamed, makeTitled, passOverStack, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Anim {
  name: string;
  start: number;
  end: number;
}

interface Recorded {
  anims: Anim[];
  /** Each change of the stack's count. */
  stack: { at: number; count: number }[];
  /** Each change of whether a decision is open, and what was castable. */
  open: { at: number; open: boolean; ok: boolean; castable: string[] }[];
}

async function record(page: Page): Promise<void> {
  await page.evaluate((buttonOne) => {
    const rec: Recorded = { anims: [], stack: [], open: [] };
    (window as unknown as { __common: Recorded }).__common = rec;
    const origin = performance.timeOrigin;
    const now = (): number => origin + performance.now();
    const seen = new Map<Animation, Anim>();
    const tick = (): void => {
      const t = now();
      for (const a of document.getAnimations()) {
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end !== 'number' || !Number.isFinite(end) || end < 150 || a.startTime === null) continue;
        const n = a as Animation & { animationName?: string };
        const target = (a.effect as KeyframeEffect | null)?.target;
        const what = target instanceof Element ? `${target.tagName.toLowerCase()}.${[...target.classList].slice(0, 2).join('.')}` : '?';
        const name = typeof n.animationName === 'string' && n.animationName !== '' ? n.animationName : `${a.id || 'anim'}@${what}`;
        const rate = Math.abs(a.playbackRate) || 1;
        const start = origin + Number(a.startTime);
        const timed = { name, start, end: start + end / rate };
        const had = seen.get(a);
        if (had === undefined) {
          seen.set(a, timed);
          rec.anims.push(timed);
        } else Object.assign(had, timed);
      }
      for (const [a, anim] of seen) {
        if (document.getAnimations().includes(a)) continue;
        anim.end = Math.min(anim.end, t);
        seen.delete(a);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let lastStack = -1;
    let lastKey = '';
    const look = (): void => {
      const t = now();
      const count = Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0');
      if (count !== lastStack) rec.stack.push({ at: t, count: (lastStack = count) });
      const ok = document.querySelector(buttonOne) !== null;
      const castable = [...document.querySelectorAll('[data-zone="hand"][data-owner="you"] [data-board-card][data-can-act]')].map(
        (e) => e.querySelector('.card__name')?.textContent?.trim() ?? e.getAttribute('data-board-card') ?? '',
      );
      const open = ok || castable.length > 0;
      const key = `${open}|${ok}|${castable.join(',')}`;
      if (key !== lastKey) rec.open.push({ at: t, open, ok, castable });
      lastKey = key;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    look();
  }, BUTTON_ONE);
}

const recorded = (page: Page): Promise<Recorded> => page.evaluate(() => (window as unknown as { __common: Recorded }).__common);
const clock = (page: Page): Promise<number> => page.evaluate(() => performance.timeOrigin + performance.now());

/** Pass over the stack on `page` until its count drops below `from`. */
async function passUntilBelow(page: Page, watch: Page, from: number, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await stackCount(watch)) < from) return true;
        await passOverStack(page);
        return (await stackCount(watch)) < from;
      },
      { timeout: 20_000, intervals: [100], message: what },
    )
    .toBe(true);
}

async function cast(page: Page, stack: { serverLogFile: string }, name: string, targets: Locator[]): Promise<void> {
  const id = await handCardNamed(page, name);
  expect(id, `${name} is in hand`).toBeDefined();
  await castUntilOnStack(page, stack, id!, targets);
}

/** Pass `page`'s own priority over its cast, and wait until the other page is asked. */
async function passTo(page: Page, other: Page, depth: number): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await other.locator(`body:has([data-zone="stack"][data-count="${depth}"]) :is(${BUTTON_ONE})`).count()) > 0) return true;
        await passOverStack(page);
        return false;
      },
      { timeout: 20_000, intervals: [100], message: `the other seat holds priority over ${depth} items` },
    )
    .toBe(true);
}

interface Measured {
  act: string;
  /** The decision opened this far into the resolution's effect, 0 at its start and 1 at its last animation's end. */
  share: number;
}

/** Alice's next decision after the stack shrank from `from` (at or after `since`), against what that resolution drew. */
async function measure(page: Page, act: string, since: number, from: number): Promise<Measured> {
  await expect
    .poll(async () => {
      const rec = await recorded(page);
      const shrank = rec.stack.find((s) => s.at >= since && s.count < from);
      return shrank !== undefined && rec.open.some((o) => o.at >= shrank.at && o.open);
    }, { timeout: 20_000, intervals: [100], message: `${act}: alice is asked after the resolution` })
    .toBe(true);
  // Let what the resolution drew play out before it is read.
  await page.waitForTimeout(2_500);
  const rec = await recorded(page);
  const shrank = rec.stack.find((s) => s.at >= since && s.count < from)!;
  const opened = rec.open.find((o) => o.at >= shrank.at && o.open)!;
  // What the resolution drew, not the decision's own panel coming in.
  const drawn = rec.anims.filter((a) => a.start >= shrank.at - 50 && a.start <= shrank.at + 1_500 && !a.name.includes('@section.confirm'));
  // Its effect: the slice, the counter's blink and its target's crack and fade — not the spell then fading off the stack (`placed.ts`'s leave).
  const effect = drawn.filter((a) => !a.name.includes('@div.placed'));
  const start = Math.min(...effect.map((a) => a.start));
  const end = Math.max(...effect.map((a) => a.end));
  const whole = Math.max(...drawn.map((a) => a.end));
  const share = effect.length === 0 ? NaN : (opened.at - start) / (end - start);
  const rel = (t: number): number => Math.round(t - shrank.at);
  console.log(
    `[w80c-common] ${act}: stack ${from}→${shrank.count} drawn at 0; alice's decision opened at ${rel(opened.at)} ms` +
      ` (ok ${opened.ok}, castable [${opened.castable.join(', ')}]); the effect's animations ${rel(start)}..${rel(end)} ms, the spell off the stack by ${rel(whole)};` +
      ` opened at ${Math.round(share * 100)}% of the effect, ${Math.round(((opened.at - start) / (whole - start)) * 100)}% of all of it`,
  );
  console.log(`[w80c-common] ${act}: open ${rec.open.filter((o) => o.at >= shrank.at - 2_000 && o.at <= shrank.at + 3_000).map((o) => `${rel(o.at)} ${o.open ? (o.ok ? 'OK' : 'cast') : 'shut'}`).join(' | ')}; stack ${rec.stack.filter((x) => x.at >= shrank.at - 2_000).map((x) => `${rel(x.at)}:${x.count}`).join(' ')}`);
  console.log(`[w80c-common] ${act}: animations ${drawn.map((a) => `${a.name} ${rel(a.start)}..${rel(a.end)}`).join(' | ')}`);
  return { act, share };
}

test(titled('a counter and a removal resolving: when alice’s next decision opens, against what the resolution draws'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Fast Mode off, as a person plays: Fast Mode holds nothing for the board.
    const slow = (page: Page): Promise<void> => setPlayFastModeDefault(page.context(), false);
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w80c-common', { beforeAlice: slow, beforeBob: slow });
    const a = alice.page;
    const b = bob.page;
    for (const page of [a, b]) {
      await page.getByTestId('live-full-control').click();
      await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    }
    await expect.poll(() => handCardNamed(a, 'Doom Blade'), { timeout: 45_000, message: 'alice holds Doom Blade' }).toBeDefined();
    await record(a);
    const theirCreature = (page: Page): Locator => page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card][data-selectable]');
    const theirFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');
    const results: Measured[] = [];

    // Alice's own removal: her Doom Blade at bob's Bears.
    await cast(a, stack, 'Doom Blade', [theirCreature(a)]);
    await passTo(a, b, 1);
    let since = await clock(a);
    await passUntilBelow(b, a, 1, 'Doom Blade resolves');
    results.push(await measure(a, 'own Doom Blade', since, 1));

    // Bob's counter: her Bolt, his Counterspell.
    await cast(a, stack, 'Lightning Bolt', [theirFace(a)]);
    await passTo(a, b, 1);
    await cast(b, stack, 'Counterspell', []);
    await passTo(b, a, 2);
    since = await clock(a);
    await passUntilBelow(a, a, 2, 'Counterspell resolves');
    results.push(await measure(a, 'bob’s Counterspell', since, 2));

    // Bob's removal: her Shock, his Doom Blade at her Bears.
    await cast(a, stack, 'Shock', [theirFace(a)]);
    await passTo(a, b, 1);
    await cast(b, stack, 'Doom Blade', [theirCreature(b)]);
    await passTo(b, a, 2);
    since = await clock(a);
    await passUntilBelow(a, a, 2, 'his Doom Blade resolves');
    results.push(await measure(a, 'bob’s Doom Blade', since, 2));
    await passTo(a, b, 1);
    await passUntilBelow(b, a, 1, 'her Shock resolves');

    // Alice's own counter: her Shock, his Bolt, her Counterspell at his Bolt.
    await cast(a, stack, 'Shock', [theirFace(a)]);
    await passTo(a, b, 1);
    await cast(b, stack, 'Lightning Bolt', [theirFace(b)]);
    await passTo(b, a, 2);
    await cast(a, stack, 'Counterspell', [a.locator('[data-placed-spell][data-selectable]:not([data-mine])')]);
    await passTo(a, b, 3);
    since = await clock(a);
    await passUntilBelow(b, a, 3, 'her Counterspell resolves');
    results.push(await measure(a, 'alice’s Counterspell at bob’s Bolt', since, 3));

    for (const r of serverLog(stack).filter((x) => x.evt === 'client' && x.seat === 0 && x.what === 'input-held')) {
      console.log(`[w80c-common] input-held ${String(r.method)} ${String(r.ms)}ms board ${String(r.boardMs)} gaps ${String(r.gapMs)} ahead ${String(r.classes)}`);
    }
    console.log(`[w80c-common] summary ${results.map((r) => `${r.act} ${Math.round(r.share * 100)}%`).join('; ')}`);
    // Alice's own Doom Blade is her own act, drawn as Forge sends it (AF216): printed, not judged. Every other one
    // takes bob's spell off the stack, and her decision after it opens on the effect's last tenth — a frame of a
    // loaded runner either side.
    for (const r of results.filter((x) => x.act !== 'own Doom Blade')) {
      expect(r.share, `${r.act}: alice's next decision opens on the effect's last tenth, not as it starts`).toBeGreaterThanOrEqual(0.8);
      expect(r.share, `${r.act}: and not after it is over`).toBeLessThanOrEqual(1.1);
    }
  } finally {
    await stack.stop();
  }
});

/*
 * The operator, of the after-film: "i can see fireblast light up immediately as soon as the blasphemous animation
 * starts". The film is the caster's screen, and the caster's own act is drawn as Forge sends it (AF216, the
 * operator, 2026-10-20: "let my click jump animations"): this measures when Fireblast lights there, and what bob's
 * screen draws meanwhile — he is asked nothing until alice passes.
 */
test(titled('a board wipe: when the caster’s Fireblast lights, against the wipe’s deaths, on both screens'), async ({ browser }) => {
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
    await cast(a, stack, 'Blasphemous Act', []);
    const since = await clock(a);
    await passUntilBelow(b, a, 1, 'Blasphemous Act resolves');
    const { share } = await measure(a, 'own Blasphemous Act', since, 1);
    const recA = await recorded(a);
    const shrankA = recA.stack.find((s) => s.at >= since && s.count < 1)!;
    const fireblast = recA.open.find((o) => o.at >= shrankA.at && o.castable.includes('Fireblast'));
    console.log(`[w80c-common] alice: Fireblast lit ${fireblast === undefined ? 'never' : `${Math.round(fireblast.at - shrankA.at)} ms`} after the wipe was drawn (${Math.round(share * 100)}% of its effect)`);
    const recB = await recorded(b);
    const shrankB = recB.stack.find((s) => s.count === 0 && s.at >= recB.stack[0]!.at && recB.stack.some((x) => x.count > 0 && x.at < s.at));
    if (shrankB !== undefined) {
      const wipe = recB.anims.filter((x) => x.start >= shrankB.at - 50 && x.start <= shrankB.at + 1_500 && !x.name.includes('@section.confirm') && !x.name.includes('@div.placed'));
      const openB = recB.open.find((o) => o.at >= shrankB.at && o.open);
      console.log(
        `[w80c-common] bob: the wipe drawn, its effect ${Math.round(Math.min(...wipe.map((x) => x.start)) - shrankB.at)}..${Math.round(Math.max(...wipe.map((x) => x.end)) - shrankB.at)} ms;` +
          ` bob's next decision ${openB === undefined ? 'none while recorded (alice holds priority)' : `opened at ${Math.round(openB.at - shrankB.at)} ms`}`,
      );
    }
  } finally {
    await stack.stop();
  }
});
