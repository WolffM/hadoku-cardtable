/**
 * The glow holds steady through normal play. The operator, 2026-10-28: *"i notice there is a lot
 * of flashing going on when proceeding through phases. this happens whenever cards are clickable
 * and briefly become not-clickable between phases. it feels janky and unecessary and i'd like to
 * try doing a pass at normal game flow and looking at all the places that the cards 'flash' and
 * try to minimize it."*
 *
 * `w80-normal.state`, played as the operator plays (Fast Mode off): alice's upkeep and draw, a land,
 * a Forest tapped for mana, Grizzly Bears cast and resolved, then through combat to her end; bob's
 * turn, where he casts his own Bears and alice answers with a Lightning Bolt at his Elves; then
 * on to alice's next main phase.
 *
 * A sampler in alice's page records, on every animation frame, which cards glow (`data-can-act`)
 * and which are outlined (`data-selectable`), the step, and whether bob's seat holds a decision
 * (`.seat[data-priority]`, drawn only while he genuinely has something open). The page's own socket
 * stamps every `forge:s2c` frame with the animation frame it arrived in (`frame-clock.ts`).
 *
 * A FLASH is a card whose glow or outline goes off and back on within `HOLD_MAX_MS` while the
 * decision never left alice: bob's seat held nothing in between, the server forwarded him no
 * decision, the turn did not move on, Forge named no set without the card (a target step's
 * selection is a real change), and alice had not just pressed that card herself (a press is the
 * card's own real change: dark until Forge says what came of it).
 *
 * Printed beside them, not asserted: a `withheld-lit` line for each stretch alice's board lit a set
 * Forge named for a window the server then passed for her (`prompt-withheld`). The server forwards
 * that `setWeaklySelectable` though it withholds the window's prompt and bar, so the browser lights
 * it until the clear; the fix is the server's, queued in `docs/handoff/w80a-closing.md`. A blink
 * whose lit side is one of those is that leak, not the hold, and is printed as such.
 * Each is printed as a `[w80]` line — the step, how long it was dark, the frames that cleared it and
 * the frames that named it again — and the spec asserts there are none.
 */
import { expect, test, type Page } from '@playwright/test';

import { installFrameClock, wireStamps, type WireStamp } from './frame-clock.ts';
import {
  BUTTON_ONE,
  BUTTON_TWO,
  boardCard,
  castUntilOnStack,
  clickHandCard,
  clickPermanent,
  enabledOk,
  handCardNamed,
  makeTitled,
  manaPool,
  ownNamed,
  serverLog,
} from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** `timed-hold.ts`'s `HOLD_MAX_MS`: a gap longer than this is no blink. Copied, not imported: the UI's chain does not type-check under the e2e tsconfig. */
const HOLD_MAX_MS = 2_000;
/** How long the driver looks at the board before a press, as a player does. */
const THINK_MS = 350;

interface Sample {
  at: number;
  frame: number;
  /** Glowing card ids (`data-can-act`), ascending, joined. */
  glow: string;
  /** Outlined card ids (`data-selectable`), ascending, joined. */
  outline: string;
  phase: string;
  turn: string;
  /** Bob's seat holds a decision. */
  theirs: boolean;
}

async function asTheOperatorPlays(page: Page): Promise<void> {
  await setPlayFastModeDefault(page.context(), false);
  await installFrameClock(page);
}

/** Records every frame until `window.__w80Stop`; a frame is kept only when something changed. */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __w80: Sample[]; __w80Stop: boolean; __frameNo: number };
    w.__w80 = [];
    w.__w80Stop = false;
    let last = '';
    const ids = (sel: string): string =>
      Array.from(document.querySelectorAll(sel))
        .map((e) => Number(e.getAttribute('data-board-card')))
        .sort((a, b) => a - b)
        .join(',');
    const tick = (): void => {
      if (w.__w80Stop) return;
      const rail = document.querySelector('[data-testid="live-phases"]');
      const sample: Sample = {
        at: performance.timeOrigin + performance.now(),
        frame: w.__frameNo,
        glow: ids('[data-board-card][data-can-act]'),
        outline: ids('[data-board-card][data-selectable]'),
        phase: rail?.getAttribute('data-phase') ?? '',
        turn: rail?.getAttribute('data-turn') ?? '',
        theirs: document.querySelector('.seat:not([data-viewer])[data-priority]') !== null,
      };
      const key = `${sample.glow}|${sample.outline}|${sample.phase}|${sample.turn}|${sample.theirs}`;
      if (key !== last) w.__w80.push(sample);
      last = key;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampler(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __w80: Sample[]; __w80Stop: boolean };
    w.__w80Stop = true;
    return w.__w80;
  });
}

/** One `forge:s2c` input frame as a short line: its method, and the cards a set names; `null` for state deltas. */
function gist(text: string): string | null {
  const m = /^42(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/.exec(text);
  if (m === null) return null;
  const [event, body] = JSON.parse(m[1]!) as [string, { frame?: Record<string, unknown> }];
  if (event !== 'forge:s2c') return null;
  const frame = body.frame ?? {};
  const method = String(frame.method ?? '?');
  if (method === 'applyDelta') return null;
  const ids = (list: unknown): string => (Array.isArray(list) ? list.map((c) => String((c as { id?: unknown }).id)).join(',') : '');
  if (method === 'setSelectables' || method === 'setWeaklySelectable') return `${method}[${ids(frame.cards)}]`;
  if (method === 'showPromptMessage') return `${method} "${String(frame.message ?? '').replace(/\s+/g, ' ').slice(0, 30)}"`;
  if (method === 'updateButtons') return `${method} ${String(frame.label1)}:${String(frame.enable1)} ${String(frame.label2)}:${String(frame.enable2)}`;
  return `${String(frame.kind)}:${method}`;
}

/** What alice's driver did, and when (wall clock), and the cards it pressed: a cause no wire frame carries. */
const acts: { at: number; what: string; pressed: number[] }[] = [];
const act = (what: string, pressed: number[] = []): void => {
  acts.push({ at: Date.now(), what, pressed });
};

interface Flash {
  card: number;
  name: string;
  attr: 'glow' | 'outline';
  phase: string;
  turn: string;
  offAt: number;
  darkMs: number;
  /** The input frames that arrived between the last lit frame and the first dark one; `client` when none did. */
  clearedBy: string;
  /** The input frames that arrived between the last dark frame and the frame it lit again. */
  namedBy: string;
  /** The driver's last act before it went dark. */
  after: string;
}

/** Every off-then-on of one card's `attr` within `HOLD_MAX_MS` while the decision stayed with alice. */
function flashes(samples: Sample[], wire: WireStamp[], bobShown: number[], leaked: ReadonlySet<number>, names: Record<number, string>): Flash[] {
  const inputs = wire.map((w) => ({ ...w, gist: gist(w.text) })).filter((w): w is WireStamp & { gist: string } => w.gist !== null);
  const between = (from: number, to: number): string =>
    inputs
      .filter((w) => w.frame >= from && w.frame < to)
      .map((w) => w.gist)
      .join(' + ') || 'client';
  const out: Flash[] = [];
  for (const attr of ['glow', 'outline'] as const) {
    const sets = samples.map((s) => new Set(s[attr] === '' ? [] : s[attr].split(',').map(Number)));
    const cards = new Set(sets.flatMap((s) => [...s]));
    for (const card of cards) {
      for (let i = 1; i < samples.length; i++) {
        if (!sets[i - 1]!.has(card) || sets[i]!.has(card)) continue;
        const back = sets.findIndex((s, j) => j > i && s.has(card));
        if (back === -1) continue;
        const off = samples[i]!;
        const on = samples[back]!;
        if (on.at - off.at >= HOLD_MAX_MS || on.turn !== off.turn) continue;
        if (leaked.has(i - 1) || leaked.has(back)) continue;
        if (acts.some((a) => a.pressed.includes(card) && a.at <= off.at && off.at - a.at < HOLD_MAX_MS)) continue;
        if (samples.slice(i, back).some((s) => s.theirs)) continue;
        if (bobShown.some((t) => t >= off.at - 50 && t <= on.at)) continue;
        // Forge naming a set without the card is a real change, and it shows (a target step's selection).
        const named = inputs
          .filter((w) => w.frame >= samples[i - 1]!.frame && w.frame < on.frame)
          .map((w) => /^set(?:Selectables|WeaklySelectable)\[(.+)\]$/.exec(w.gist)?.[1]);
        if (named.some((ids) => ids !== undefined && !ids.split(',').map(Number).includes(card))) continue;
        out.push({
          card,
          name: names[card] ?? '?',
          attr,
          phase: off.phase,
          turn: off.turn,
          offAt: off.at,
          darkMs: Math.round(on.at - off.at),
          clearedBy: between(samples[i - 1]!.frame, off.frame),
          namedBy: between(samples[back - 1]!.frame, on.frame),
          after: acts.filter((a) => a.at <= off.at).at(-1)?.what ?? '-',
        });
      }
    }
  }
  return out.sort((a, b) => a.offAt - b.offAt);
}

const step = (page: Page): Promise<{ phase: string; turn: number }> =>
  page.evaluate(() => {
    const rail = document.querySelector('[data-testid="live-phases"]');
    return { phase: rail?.getAttribute('data-phase') ?? '', turn: Number(rail?.getAttribute('data-turn') ?? '0') };
  });

const live = async (page: Page): Promise<boolean> => (await page.locator(`${BUTTON_ONE}, ${BUTTON_TWO}`).count()) > 0;

const stackSize = async (page: Page): Promise<number> => Number((await page.locator('[data-zone="stack"]').getAttribute('data-count')) ?? '0');

/** Press `page`'s enabled OK after a player's look at the board; `false` when it has none. */
async function pass(page: Page, who: 'alice' | 'bob'): Promise<boolean> {
  const ok = enabledOk(page).first();
  if ((await ok.count()) === 0) return false;
  await page.waitForTimeout(THINK_MS);
  if ((await ok.count()) === 0) return false;
  const label = ((await ok.textContent().catch(() => '')) ?? '').trim();
  const { phase, turn } = await step(page);
  if (who === 'alice') act(`alice pressed "${label}" in ${phase} t${turn}`);
  await ok.click({ timeout: 1_000 }).catch(() => undefined);
  await expect(ok).toHaveCount(0, { timeout: 2_000 }).catch(() => undefined);
  return true;
}

/** Answer and press until `until()`, letting `mayPass(who, page)` decide which seats press OK. */
async function drive(
  pages: { alice: Page; bob: Page },
  until: () => Promise<boolean>,
  mayPass: (who: 'alice' | 'bob', page: Page) => Promise<boolean>,
  message: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    for (const who of ['alice', 'bob'] as const) {
      const page = pages[who];
      if (await until()) return;
      await answerPrompt(page);
      if ((await live(page)) && (await mayPass(who, page))) await pass(page, who);
    }
    await pages.alice.waitForTimeout(60);
  }
}

test(titled('a normal turn each, Fast Mode off: no card’s glow blinks off and back on while the decision stays with alice'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(6 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w80-normal', {
      beforeAlice: asTheOperatorPlays,
      beforeBob: (p) => setPlayFastModeDefault(p.context(), false),
    });
    const alice = seated.alice.page;
    const bob = seated.bob.page;
    const pages = { alice, bob };
    acts.length = 0;
    await startSampler(alice);
    const t0 = Date.now();

    // Alice's upkeep and draw, to her main phase.
    await drive(
      pages,
      async () => (await step(alice)).phase === 'MAIN1' && (await live(alice)) && (await handCardNamed(alice, 'Forest')) !== undefined,
      async (who, page) => who === 'bob' || (await step(page)).phase !== 'MAIN1',
      'alice reaches her main phase',
    );

    // A land, a Forest tapped for mana, and Grizzly Bears.
    await alice.waitForTimeout(THINK_MS);
    const forestsBefore = (await ownNamed(alice, 'Forest')).length;
    const land = (await handCardNamed(alice, 'Forest'))!;
    act('alice played a Forest', [land]);
    expect(await clickHandCard(alice, land), 'the Forest is lifted').toBe(true);
    await expect.poll(async () => (await ownNamed(alice, 'Forest')).length, { timeout: 20_000, message: 'the Forest is played' }).toBe(forestsBefore + 1);
    await alice.waitForTimeout(THINK_MS);
    const tapped = (await ownNamed(alice, 'Forest'))[0]!;
    act('alice tapped a Forest', [tapped]);
    expect(await clickPermanent(alice, tapped), 'a Forest is tapped for mana').toBe(true);
    await expect.poll(async () => (await manaPool(alice)).G, { timeout: 20_000, message: 'green is in the pool' }).toBe(1);
    await alice.waitForTimeout(THINK_MS);
    const bears = (await handCardNamed(alice, 'Grizzly Bears'))!;
    act('alice cast Grizzly Bears', [bears]);
    await castUntilOnStack(alice, stack, bears, []);
    await drive(
      pages,
      async () => (await ownNamed(alice, 'Grizzly Bears')).length === 1 && (await live(alice)),
      async () => (await stackSize(alice)) > 0,
      'the Bears resolve and priority comes back to alice',
    );

    // Through combat to her end, and into bob's main phase.
    await drive(
      pages,
      async () => {
        const s = await step(bob);
        return s.turn === 3 && s.phase === 'MAIN1' && (await live(bob)) && (await handCardNamed(bob, 'Forest')) !== undefined;
      },
      async (who, page) => {
        const s = await step(page);
        return who === 'alice' || s.turn !== 3 || s.phase !== 'MAIN1';
      },
      'bob reaches his main phase',
    );

    // Bob plays a land and casts his Bears; alice answers with a Bolt at his Elves.
    await bob.waitForTimeout(THINK_MS);
    expect(await clickHandCard(bob, (await handCardNamed(bob, 'Forest'))!), 'bob lifts his Forest').toBe(true);
    await expect.poll(async () => (await ownNamed(bob, 'Forest')).length, { timeout: 20_000, message: 'bob plays his Forest' }).toBe(2);
    await bob.waitForTimeout(THINK_MS);
    await castUntilOnStack(bob, stack, (await handCardNamed(bob, 'Grizzly Bears'))!, []);
    await expect
      .poll(async () => (await live(alice)) && (await stackSize(alice)) === 1, { timeout: 30_000, message: 'alice holds priority over bob’s Bears' })
      .toBe(true);
    await alice.waitForTimeout(THINK_MS);
    const elves = (await ownNamed(bob, 'Llanowar Elves'))[0]!;
    const bolt = (await handCardNamed(alice, 'Lightning Bolt'))!;
    act('alice cast Lightning Bolt at the Elves', [bolt, elves]);
    await castUntilOnStack(alice, stack, bolt, [boardCard(alice, elves)]);
    await drive(
      pages,
      async () => (await ownNamed(bob, 'Grizzly Bears')).length === 1 && (await ownNamed(bob, 'Llanowar Elves')).length === 0,
      async (_who, page) => (await stackSize(page)) > 0,
      'the Bolt and the Bears resolve',
    );

    // Bob's turn out, to alice's next main phase.
    await drive(
      pages,
      async () => {
        const s = await step(alice);
        return s.turn === 4 && s.phase === 'MAIN1' && (await live(alice));
      },
      async (who, page) => {
        const s = await step(page);
        return who === 'bob' || s.turn !== 4 || s.phase !== 'MAIN1';
      },
      'alice reaches her next main phase',
    );
    // Anything that would blink late does so here.
    await alice.waitForTimeout(1_000);
    const samples = await stopSampler(alice);
    const names = await alice.evaluate(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll('[data-board-card]')).map((e) => [Number(e.getAttribute('data-board-card')), e.querySelector('.card__name')?.textContent?.trim() ?? '?']),
      ),
    );
    const wire = await wireStamps(alice);
    const log = serverLog(stack);
    const bobShown = log.filter((r) => r.evt === 'prompt-forwarded' && r.seat === 1).map((r) => Date.parse(String(r.t)));

    const say = (line: string): void => console.log(`[w80] ${line}`);
    for (const r of log) {
      const at = Date.parse(String(r.t));
      if (Number.isNaN(at) || at < t0 - 200) continue;
      if (!['prompt-forwarded', 'prompt-withheld', 'auto-passed', 'stop-fired'].includes(String(r.evt))) continue;
      const { t: _t, svc: _svc, matchId: _m, evt, ...rest } = r;
      say(`server ${Math.round(at - t0)}ms ${String(evt)} ${JSON.stringify(rest).slice(0, 140)}`);
    }
    for (const a of acts) say(`act ${a.at - t0}ms ${a.what}`);
    for (const w of wire) {
      const what = gist(w.text);
      if (what !== null && w.at >= t0 - 200) say(`wire ${Math.round(w.at - t0)}ms f${w.frame} ${what}`);
    }
    for (const s of samples) say(`draw ${Math.round(s.at - t0)}ms f${s.frame} t${s.turn} ${s.phase} glow[${s.glow}] outline[${s.outline}]${s.theirs ? ' theirs' : ''}`);
    // A lit stretch between two dark frames, within a beat of a window the server passed for alice.
    const withheld = log.filter((r) => r.evt === 'prompt-withheld' && r.seat === 0).map((r) => Date.parse(String(r.t)));
    const leaked = new Set<number>();
    for (const [i, s] of samples.entries()) {
      const next = samples[i + 1];
      if (s.glow === '' || samples[i - 1]?.glow !== '' || next === undefined || next.glow !== '') continue;
      if (!withheld.some((t) => t >= s.at - 400 && t <= next.at)) continue;
      leaked.add(i);
      say(`withheld-lit t${s.turn} ${s.phase} at ${Math.round(s.at - t0)}ms for ${Math.round(next.at - s.at)}ms glow[${s.glow}]`);
    }
    const found = flashes(samples, wire, bobShown, leaked, names);
    for (const f of found) {
      say(
        `FLASH ${f.attr} ${f.name} #${f.card} t${f.turn} ${f.phase} at ${Math.round(f.offAt - t0)}ms dark ${f.darkMs}ms | after: ${f.after} | cleared by: ${f.clearedBy} | named by: ${f.namedBy}`,
      );
    }
    const byCause = new Map<string, { n: number; dark: number[] }>();
    for (const f of found) {
      const key = `${f.attr} t${f.turn} ${f.phase} | after: ${f.after.replace(/ in \w+ t\d+$/, '')} | cleared: ${f.clearedBy.replace(/\[[^\]]*\]/g, '[…]')} | named: ${f.namedBy.replace(/\[[^\]]*\]/g, '[…]')}`;
      const row = byCause.get(key) ?? { n: 0, dark: [] };
      row.n += 1;
      row.dark.push(f.darkMs);
      byCause.set(key, row);
    }
    for (const [key, row] of byCause) say(`CAUSE ×${row.n} dark ${Math.min(...row.dark)}–${Math.max(...row.dark)}ms | ${key}`);

    expect(samples.length, 'the sampler saw the game').toBeGreaterThan(10);
    expect(
      found.map((f) => `${f.attr} ${f.name} t${f.turn} ${f.phase} ${f.darkMs}ms`),
      'no card blinks off and back on while the decision stays with alice',
    ).toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
