/**
 * The offered outline does not blink off between two steps of one decision. The operator,
 * 2026-10-16: *"activating an ability from one creature to another causes an extra flash of the
 * blue outline … 1. i activate Nomads en-Kor (all cards turn black, then things turn green again
 * as they are selectable) 2. i select a card, everything turns black then things turn green again
 * … can we remove the intermittent flashing to black?"*
 *
 * `nf-nomads.state`: alice holds priority in her Main 1 with Nomads en-Kor, Grizzly Bears and two
 * Plains; bob has nothing he could play. Alice activates Nomads, chooses the Bears as its target,
 * and the ability resolves back to her own priority — twice, as a player repeats it. Every step's
 * next decision is alice's, so in no frame from the first click to the second return of priority
 * may her board show nothing on offer. Alice plays with Fast Mode off, as the operator did.
 *
 * `nf-nomads-held.state` is the bound the other way: bob holds an Opt and an Island, so with the
 * ability on the stack the decision is his, and alice's board must show nothing on offer while he
 * holds it.
 *
 * A sampler in alice's page records, on every animation frame, the cards drawn offered
 * (`data-selectable`), how many glow as actionable (`data-can-act`), whether a button of hers is
 * live, and the stack's size; the page's own socket stamps every `forge:s2c` frame with the
 * animation frame it arrived in. Each change is printed as an `[nf]` line beside the server's own
 * decisions for the same moments.
 */
import { expect, test, type Page } from '@playwright/test';

import { frameIntervals, installFrameClock, wireStamps } from './frame-clock.ts';
import { BUTTON_ONE, BUTTON_TWO, clickPermanent, enabledOk, holdsLiveWindow, isOffered, makeTitled, offered, ownNamed, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Alice plays as the operator did (`m-ecaebecacf06`'s `client` info: `fastMode:false`): Forge's frames paced. */
async function asTheOperatorPlays(page: Page): Promise<void> {
  await setPlayFastModeDefault(page.context(), false);
  await installFrameClock(page);
}

interface Sample {
  at: number;
  frame: number;
  /** The offered card ids, ascending, joined. */
  offered: string;
  canAct: number;
  live: boolean;
  stack: number;
}

/** Records every frame's offer until `window.__nfStop`; a frame is kept only when something changed. */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate((buttons) => {
    const w = window as unknown as { __nf: Sample[]; __nfStop: boolean; __frameNo: number };
    w.__nf = [];
    w.__nfStop = false;
    let last = '';
    const tick = (): void => {
      if (w.__nfStop) return;
      const ids = Array.from(document.querySelectorAll('[data-board-card][data-selectable]'))
        .map((e) => Number(e.getAttribute('data-board-card')))
        .sort((a, b) => a - b);
      const sample: Sample = {
        at: performance.timeOrigin + performance.now(),
        frame: w.__frameNo,
        offered: ids.join(','),
        canAct: document.querySelectorAll('[data-board-card][data-can-act]').length,
        live: document.querySelector(buttons) !== null,
        stack: Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0'),
      };
      const key = `${sample.offered}|${sample.canAct}|${sample.live}|${sample.stack}`;
      if (key !== last) w.__nf.push(sample);
      last = key;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, `${BUTTON_ONE}, ${BUTTON_TWO}`);
}

async function stopSampler(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __nf: Sample[]; __nfStop: boolean };
    w.__nfStop = true;
    return w.__nf;
  });
}

/** One `forge:s2c` frame as a short line: its method, and the cards an input frame names. */
function gist(text: string): string | null {
  const m = /^42(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/.exec(text);
  if (m === null) return null;
  const [event, body] = JSON.parse(m[1]!) as [string, { frame?: Record<string, unknown> }];
  if (event !== 'forge:s2c') return null;
  const frame = body.frame ?? {};
  const method = String(frame.method ?? '?');
  if (method === 'applyDelta') return 'applyDelta';
  const ids = (list: unknown): string => (Array.isArray(list) ? list.map((c) => String((c as { id?: unknown }).id)).join(',') : '');
  if (method === 'setSelectables' || method === 'setWeaklySelectable') return `${method}[${ids(frame.cards)}]`;
  if (method === 'showPromptMessage') return `${method} "${String(frame.message ?? '').slice(0, 40)}"`;
  if (method === 'updateButtons') return `${method} ${String(frame.label1)}:${String(frame.enable1)} ${String(frame.label2)}:${String(frame.enable2)}`;
  return `${String(frame.kind)}:${method}`;
}

/** Every `[nf]` line for the window from `t0`: the server's decisions, alice's wire, alice's frames. */
async function evidence(page: Page, stack: { serverLogFile: string }, samples: Sample[], t0: number): Promise<void> {
  const say = (line: string): void => console.log(`[nf] ${line}`);
  for (const r of serverLog(stack)) {
    const at = Date.parse(String(r.t));
    if (Number.isNaN(at) || at < t0 - 200 || r.evt === 'client') continue;
    const { t: _t, svc: _svc, matchId: _m, evt, ...rest } = r;
    say(`server ${Math.round(at - t0)}ms ${String(evt)} ${JSON.stringify(rest).slice(0, 160)}`);
  }
  for (const w of await wireStamps(page)) {
    if (w.at < t0 - 200) continue;
    const what = gist(w.text);
    if (what !== null) say(`wire ${Math.round(w.at - t0)}ms f${w.frame} ${what}`);
  }
  for (const s of samples) say(`draw ${Math.round(s.at - t0)}ms f${s.frame} offered[${s.offered}] canAct=${s.canAct} live=${s.live} stack=${s.stack}`);
  say(`frame intervals ${JSON.stringify(await frameIntervals(page))}`);
}

/** How many priority windows the server has shown seat 0 so far. */
const priorityShown = (stack: { serverLogFile: string }): number =>
  serverLog(stack).filter((r) => r.evt === 'prompt-forwarded' && r.seat === 0 && r.kind === 'priority').length;

test(titled('Nomads en-Kor: from activating to choosing its target to priority again, the offer never drops to nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'nf-nomads', { beforeAlice: asTheOperatorPlays });
    const page = seated.alice.page;
    await expect.poll(() => ownNamed(page, 'Nomads en-Kor'), { timeout: 30_000, message: 'Nomads en-Kor is out' }).toHaveLength(1);
    const nomads = (await ownNamed(page, 'Nomads en-Kor'))[0]!;
    const bears = (await ownNamed(page, 'Grizzly Bears'))[0]!;
    await expect
      .poll(async () => (await isOffered(page, nomads)) && (await holdsLiveWindow(page)), { timeout: 45_000, message: 'alice holds priority with Nomads offered' })
      .toBe(true);

    await startSampler(page);
    const t0 = Date.now();
    for (const round of [1, 2]) {
      const shown = priorityShown(stack);
      expect(await clickPermanent(page, nomads), `round ${round}: Nomads is activated`).toBe(true);
      expect(await clickPermanent(page, bears, 20_000), `round ${round}: the Bears are offered as its target`).toBe(true);
      await expect.poll(() => priorityShown(stack), { timeout: 30_000, message: `round ${round}: priority comes back to alice` }).toBeGreaterThan(shown);
      await expect
        .poll(async () => (await isOffered(page, nomads)) && !(await isOffered(page, bears)) && (await holdsLiveWindow(page)), {
          timeout: 10_000,
          message: `round ${round}: Nomads is offered again`,
        })
        .toBe(true);
    }
    // Anything that would blink late does so here.
    await page.waitForTimeout(800);
    const samples = await stopSampler(page);
    await evidence(page, stack, samples, t0);

    const dark = samples.filter((s) => s.offered === '').map((s) => `${Math.round(s.at - t0)}ms f${s.frame}`);
    expect(samples.length, 'the sampler saw the two rounds').toBeGreaterThan(4);
    expect(dark, 'no frame from the first click to priority again draws nothing on offer').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('Nomads en-Kor held by the opponent: while bob holds priority over the ability, alice’s board offers nothing'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'nf-nomads-held', { beforeAlice: asTheOperatorPlays });
    const page = seated.alice.page;
    const bob = seated.bob.page;
    await expect.poll(() => ownNamed(page, 'Nomads en-Kor'), { timeout: 30_000, message: 'Nomads en-Kor is out' }).toHaveLength(1);
    const nomads = (await ownNamed(page, 'Nomads en-Kor'))[0]!;
    const bears = (await ownNamed(page, 'Grizzly Bears'))[0]!;

    await startSampler(page);
    const t0 = Date.now();
    expect(await clickPermanent(page, nomads), 'Nomads is activated').toBe(true);
    expect(await clickPermanent(page, bears, 20_000), 'the Bears are offered as its target').toBe(true);
    await expect(enabledOk(bob).first(), 'bob holds priority over the ability').toBeVisible({ timeout: 30_000 });
    const bobLive = Date.now();
    // Nothing of alice's is on offer while bob decides: promptly, and for as long as he holds it.
    await expect.poll(() => offered(page), { timeout: 1_000, message: 'alice’s offer clears once bob holds priority' }).toEqual([]);
    await page.waitForTimeout(1_000);
    expect(await offered(page), 'and stays clear while he holds it').toEqual([]);
    const samples = await stopSampler(page);
    await evidence(page, stack, samples, t0);
    console.log(`[nf] bob live at ${bobLive - t0}ms`);

    await enabledOk(bob).first().click();
    await expect.poll(() => isOffered(page, nomads), { timeout: 30_000, message: 'priority comes back to alice with Nomads offered' }).toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
