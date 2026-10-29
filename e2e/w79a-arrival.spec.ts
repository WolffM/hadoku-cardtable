/**
 * W79 lane A: a card arriving on the battlefield is drawn by ONE element, from the stack to its rest,
 * lands once, at the slot it rests in — on both screens. The operator, 2026-10-28, on Emrakul, the
 * Aeons Torn cast off Omniscience (`w79a-emrakul.state`, copied from the trailer's `promo-emrakul`):
 *
 *   "2a. when it resolved it showed a purple outline still as if it were activatable? 2b. when it
 *   dropped to the board it briefly snapped back upward and played the animation twice? 2c. when
 *   hitting the board it jerked down to a slightly different spot before correcting itself again
 *   afterwards?" — "this process looks super janky and points at duplicate code or duplicate pathways
 *   for cards to do their thing. we need to unify this process e2e."
 *
 * Every animation frame, on both pages, the recorder writes down every element drawing the arriving
 * card — its row card, the caster's stand-in (`data-cast-ghost`), the other screen's copy
 * (`.presence__handoff`), an entry stand-in (`.board-entry`), the stack's own card
 * (`[data-placed-spell]`) — with its box (transforms included: `getBoundingClientRect`) and whether
 * it is drawn as something on offer. The claims are read off the whole recording:
 *
 *  - 2a: from the release on, nothing drawing the card is drawn as on offer (`data-selectable`, or an
 *    outline) — the card it was cloned from in hand was, and the copy must not carry that;
 *  - 2b: from the moment the stack lets go of it until it rests, the card only ever closes on its rest:
 *    never moving away from it (a snap back upward), never growing, and reaching it once;
 *  - 2c: it rests where it lands — the last frame of whatever carried it is where the row card is first
 *    drawn, and the row card never moves after that;
 *  - one element: never two of them drawn at once.
 *
 * The same claims for a reanimated creature (`w79a-reanimate.state`): Griselbrand out of a graveyard.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, dragHandCard, makeTitled, pressPaymentAuto, resizeWindow, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[w79a-arrival] ${JSON.stringify({ step, data })}`);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One element drawing the card in one frame. */
interface Drawn {
  kind: 'row' | 'hand' | 'pile' | 'ghost' | 'echo' | 'entry' | 'stack';
  box: Box;
  /** Drawn as something on offer: `data-selectable` on it or inside it, or an outline on it or its face. */
  offer: string | null;
  /** Its own opacity: a stand-in fading in from nothing (a rise out of a pile) is not a jump. */
  alpha: number;
}

interface Frame {
  t: number;
  drawn: Drawn[];
}

/** Record every frame of `name`'s drawing on `page` until `stop`. The card is found by name: its id differs per screen only in the hand. */
async function record(page: Page, name: string): Promise<void> {
  await page.evaluate((cardName) => {
    const w = window as unknown as { __arr: unknown[]; __arrStop: boolean };
    w.__arr = [];
    w.__arrStop = false;
    const t0 = performance.now();
    const named = (el: Element): boolean => (el.querySelector('.card__name')?.textContent ?? el.textContent ?? '').includes(cardName);
    const shown = (el: Element): boolean => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
    };
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const offer = (el: Element): string | null => {
      if (el.matches('[data-selectable]') || el.querySelector('[data-selectable]') !== null) return 'data-selectable';
      for (const e of [el, el.querySelector('.card'), el.querySelector('.board-card')]) {
        if (e === null) continue;
        const s = getComputedStyle(e);
        if (s.outlineStyle !== 'none' && Number.parseFloat(s.outlineWidth) > 0) return `outline ${s.outlineStyle} ${s.outlineColor}`;
      }
      return null;
    };
    const tick = (): void => {
      if (w.__arrStop) return;
      const drawn: unknown[] = [];
      const add = (kind: string, els: Iterable<Element>): void => {
        for (const el of els) if (named(el) && shown(el)) drawn.push({ kind, box: box(el), offer: offer(el), alpha: Math.round(Number(getComputedStyle(el).opacity) * 100) / 100 });
      };
      add('row', document.querySelectorAll('[data-zone="battlefield"] [data-board-card]'));
      add('hand', document.querySelectorAll('[data-zone="hand"] [data-board-card]'));
      add('pile', document.querySelectorAll('[data-zone="graveyard"] [data-board-card]'));
      add('ghost', document.querySelectorAll('[data-cast-ghost]'));
      add('echo', document.querySelectorAll('.presence__handoff'));
      add('entry', document.querySelectorAll('.board-entry:not(.board-entry--shoved)'));
      add('stack', document.querySelectorAll('[data-placed-spell]'));
      w.__arr.push({ t: Math.round(performance.now() - t0), drawn });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __arr: Frame[]; __arrStop: boolean };
    w.__arrStop = true;
    return w.__arr;
  });
}

const fmt = (b: Box): string => `@${b.x},${b.y} ${b.w}x${b.h}`;

/** The recording, runs of identical frames folded, for a person to read. */
function timeline(fs: Frame[]): string {
  const lines: string[] = [];
  let last = '';
  for (const f of fs) {
    const key = JSON.stringify(f.drawn);
    if (key === last) continue;
    last = key;
    lines.push(`${String(f.t).padStart(6)}ms  ${f.drawn.map((d) => `${d.kind} ${fmt(d.box)}${d.offer === null ? '' : ` OFFER(${d.offer})`}`).join(' | ') || '—'}`);
  }
  return lines.join('\n');
}

const centreDist = (a: Box, b: Box): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Where the arrival starts and where, and from which frame, the card rests. */
function arrival(fs: Frame[], kinds: readonly Drawn['kind'][]): { from: number; rest: Box; restAt: number } {
  const last = fs[fs.length - 1];
  const row = last?.drawn.find((d) => d.kind === 'row');
  if (row === undefined) throw new Error(`the card is not resting on the battlefield at the end:\n${timeline(fs)}`);
  // The arrival starts at the last frame something outside the battlefield (`kinds`: the stack's card,
  // the hand) drew it.
  let from = -1;
  for (let i = 0; i < fs.length; i++) if (fs[i]!.drawn.some((d) => kinds.includes(d.kind))) from = i;
  // The rest: the first frame from which the row card alone draws it, where it stays.
  let restAt = fs.length - 1;
  while (restAt > 0) {
    const prev = fs[restAt - 1]!.drawn;
    if (prev.length === 1 && prev[0]!.kind === 'row' && centreDist(prev[0]!.box, row.box) <= 1) restAt--;
    else break;
  }
  return { from: Math.max(0, from + 1), rest: row.box, restAt };
}

interface Verdict {
  offered: string[];
  landings: number;
  rose: string[];
  jumps: string[];
  handover: string | null;
  moved: string[];
  doubled: string[];
}

/** A stand-in: anything drawing the card that is not its own row card, hand card or pile card. */
const standIn = (d: Drawn): boolean => d.kind === 'ghost' || d.kind === 'echo' || d.kind === 'entry';

/**
 * Every claim, on one screen's recording. The arrival runs from the last frame something outside the
 * battlefield drew the card (`kinds`) to its rest. The approved landing (AF413) lifts a card over its
 * slot and drops it there, as heavy as it is: travelling up to that hang is the design, and the claims
 * are about what is not — a stand-in reaching its slot and leaving it again, rising after the drop
 * began, or jumping from one element to the next.
 */
function judge(fs: Frame[], released: number, kinds: readonly Drawn['kind'][]): Verdict {
  const { from, rest, restAt } = arrival(fs, kinds);
  const v: Verdict = { offered: [], landings: 0, rose: [], jumps: [], handover: null, moved: [], doubled: [] };
  for (const f of fs.slice(released)) for (const d of f.drawn) if (d.offer !== null && standIn(d)) v.offered.push(`${f.t}ms ${d.kind} ${d.offer}`);
  const trip = fs.slice(Math.max(0, from - 1), restAt + 1);
  // The farthest the stand-in gets from its slot: the hang, or where it started. From there it only falls.
  let peak = -1;
  let far = -1;
  trip.forEach((f, i) => {
    const d = f.drawn.find(standIn);
    if (d !== undefined && centreDist(d.box, rest) >= far) [peak, far] = [i, centreDist(d.box, rest)];
  });
  let best = Infinity;
  let landed = false;
  let last: { d: Drawn; t: number } | null = null;
  trip.forEach((f, i) => {
    if (f.drawn.length > 1) v.doubled.push(`${f.t}ms ${f.drawn.map((d) => `${d.kind} ${fmt(d.box)}`).join(' + ')}`);
    const d = f.drawn[0];
    if (d === undefined) return;
    // How far a card in motion can get between two painted frames: a busy browser skips paints, and the
    // glide goes on meanwhile (the fastest leg, the drop, runs about a px a millisecond).
    const reach = last === null ? 0 : 24 + 1.5 * (f.t - last.t);
    if (last !== null && last.d.kind !== d.kind && d.alpha >= 0.5 && (centreDist(last.d.box, d.box) > reach || Math.abs(last.d.box.w - d.box.w) > reach))
      v.jumps.push(`${f.t}ms ${last.d.kind} ${fmt(last.d.box)} → ${d.kind} ${fmt(d.box)} after ${f.t - last.t}ms`);
    last = { d, t: f.t };
    if (!standIn(d)) return;
    const dist = centreDist(d.box, rest);
    if (i > peak && peak >= 0 && dist > best + 8) v.rose.push(`${f.t}ms ${d.kind} ${fmt(d.box)} is ${Math.round(dist)}px from its slot, was ${Math.round(best)}`);
    if (i >= peak) best = Math.min(best, dist);
    const at = dist <= 6 && Math.abs(d.box.w - rest.w) <= 6;
    if (at && !landed) v.landings++;
    landed = at;
  });
  // A stand-in that never quite touched (the row card took over mid-squish) still landed once.
  if (v.landings === 0 && trip.some((f) => f.drawn.some(standIn))) v.landings = 1;
  // The hand-over: what drew it in the frame before the row card took over, against the row card — as
  // far as a drop still under way can get in the time between the two painted frames.
  const before = fs[restAt - 1]?.drawn.find((d) => d.kind !== 'row');
  const gap = (fs[restAt]?.t ?? 0) - (fs[restAt - 1]?.t ?? 0);
  const reach = 6 + 1.5 * Math.max(0, gap - 17);
  if (before !== undefined && (centreDist(before.box, rest) > reach || Math.abs(before.box.w - rest.w) > reach))
    v.handover = `${before.kind} ${fmt(before.box)} → row ${fmt(rest)} after ${gap}ms`;
  // After the rest, the row card does not move: up to the end of the recording.
  let first: Box | null = null;
  for (const f of fs.slice(restAt)) {
    const r = f.drawn.find((d) => d.kind === 'row');
    if (r === undefined) continue;
    first ??= r.box;
    if (centreDist(r.box, first) > 2) v.moved.push(`${f.t}ms row ${fmt(r.box)} from ${fmt(first)}`);
  }
  return v;
}

function expectOneArrival(who: string, fs: Frame[], released: number, kinds: readonly Drawn['kind'][]): void {
  const v = judge(fs, released, kinds);
  log(`${who} verdict`, { frames: fs.length, ...v, offered: v.offered.slice(0, 5), rose: v.rose.slice(0, 5), moved: v.moved.slice(0, 5), doubled: v.doubled.slice(0, 5) });
  console.log(`[w79a-arrival] ${who} timeline\n${timeline(fs.slice(Math.max(0, released - 2)))}`);
  expect.soft(v.offered, `${who} 2a: no stand-in for the card is drawn on offer once it is let go`).toEqual([]);
  expect.soft(v.landings, `${who} 2b: it lands once — never reaching its slot and leaving it again`).toBe(1);
  expect.soft(v.rose, `${who} 2b: once it starts to drop it only falls`).toEqual([]);
  expect.soft(v.jumps, `${who} 2b/2c: each element takes over where the last one drew it`).toEqual([]);
  expect.soft(v.handover, `${who} 2c: the row card is drawn exactly where its stand-in's last frame was`).toBeNull();
  expect.soft(v.moved, `${who} 2c: once at rest the row card does not move`).toEqual([]);
  expect.soft(v.doubled, `${who}: one element draws it at a time`).toEqual([]);
}

/**
 * The trip starts where the stack last drew the card: each screen's own landing report (`handover-report.ts`,
 * through the server's log) says where its arrival started from, and the recording says where the stack's
 * card stood — still, so no frame the browser skipped can hide a jump between the two.
 */
function expectStartsFromTheStack(who: string, fs: Frame[], screen: 'caster' | 'receiver', log: Record<string, unknown>[]): void {
  const last = fs.findLast((f) => f.drawn.some((d) => d.kind === 'stack'))?.drawn.filter((d) => d.kind === 'stack').at(-1);
  const landing = log.find((r) => r.evt === 'client' && r.kind === 'landing' && r.screen === screen);
  expect(last, `${who}: the stack drew the spell`).toBeDefined();
  expect(landing, `${who}: the screen reported its landing`).toBeDefined();
  const from = { x: Number(landing!.fromX), y: Number(landing!.fromY) };
  const off = Math.hypot(from.x - last!.box.x, from.y - last!.box.y);
  expect.soft(off, `${who} 2b/2c: the arrival starts at ${from.x},${from.y}, where the stack drew the card (${fmt(last!.box)})`).toBeLessThanOrEqual(12);
}

/** Nothing of the arrival left: no stand-in, no hidden row card, no landing shove. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.board-entry, [data-cast-landing], [data-cast-ghost], .presence__handoff').count(), { timeout: 20_000, message: 'every stand-in is gone' }).toBe(0);
}

const onBattlefield = (page: Page, owner: 'you' | 'them', name: string) =>
  page.locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`, { hasText: name });

test(titled('a cast creature arrives once, by one element, where it rests — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // The trailer was shot with motion on: Fast Mode skips the travel this spec is about.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w79a-emrakul', {
      beforeAlice: (page) => setPlayFastModeDefault(page.context(), false),
      beforeBob: (page) => setPlayFastModeDefault(page.context(), false),
    });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const name = 'Emrakul, the Aeons Torn';
    const card = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name });
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    const id = Number(await card.getAttribute('data-board-card'));
    const field = await alice.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox();
    if (field === null) throw new Error('alice has no battlefield');
    await Promise.all([record(alice.page, 'Emrakul'), record(bob.page, 'Emrakul')]);
    const logFrom = serverLog(stack).length;
    const released = { alice: 0, bob: 0 };
    const to = { x: field.x + field.width / 2, y: field.y + field.height * 0.35 };
    expect(await dragHandCard(alice.page, id, to), 'Emrakul lifted out of the hand').toBe(true);
    released.alice = await alice.page.evaluate(() => (window as unknown as { __arr: unknown[] }).__arr.length);
    released.bob = await bob.page.evaluate(() => (window as unknown as { __arr: unknown[] }).__arr.length);
    // Omniscience's "cast without paying?", then both seats pass the cast trigger and the spell.
    const deadline = Date.now() + 90_000;
    while ((await onBattlefield(alice.page, 'you', name).count()) === 0 || (await onBattlefield(bob.page, 'them', name).count()) === 0) {
      if (Date.now() > deadline) throw new Error('Emrakul never reached the battlefield on both screens');
      for (const page of [alice.page, bob.page]) {
        await answerPrompt(page).catch(() => null);
        await pressPaymentAuto(page);
        const ok = page.locator('[data-testid="live-decision-ok"]:enabled');
        if ((await ok.count()) > 0) await ok.first().click({ timeout: 1_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(150);
    }
    await settled(alice.page);
    await settled(bob.page);
    // A beat at rest, so a late move would be on the recording.
    await alice.page.waitForTimeout(1_200);
    const seen = { alice: await frames(alice.page), bob: await frames(bob.page) };
    expectOneArrival('alice (caster)', seen.alice, released.alice, ['stack', 'hand']);
    expectOneArrival('bob (opponent)', seen.bob, released.bob, ['stack']);
    const reports = serverLog(stack).slice(logFrom);
    expectStartsFromTheStack('alice (caster)', seen.alice, 'caster', reports);
    expectStartsFromTheStack('bob (opponent)', seen.bob, 'receiver', reports);
  } finally {
    await stack.stop();
  }
});

test(titled('a reanimated creature arrives once, by one element, where it rests — on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w79a-reanimate', {
      beforeAlice: (page) => setPlayFastModeDefault(page.context(), false),
      beforeBob: (page) => setPlayFastModeDefault(page.context(), false),
    });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const reanimate = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Reanimate' });
    await expect(reanimate).toHaveCount(1, { timeout: 15_000 });
    const id = Number(await reanimate.getAttribute('data-board-card'));
    const inGraveyard = alice.page.locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]', { hasText: 'Griselbrand' });
    await Promise.all([record(alice.page, 'Griselbrand'), record(bob.page, 'Griselbrand')]);
    await castUntilOnStack(alice.page, stack, id, [inGraveyard]);
    const deadline = Date.now() + 60_000;
    while ((await onBattlefield(alice.page, 'you', 'Griselbrand').count()) === 0 || (await onBattlefield(bob.page, 'them', 'Griselbrand').count()) === 0) {
      if (Date.now() > deadline) throw new Error('Griselbrand never reached the battlefield on both screens');
      const ok = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
      if ((await ok.count()) > 0) await ok.first().click({ timeout: 1_000 }).catch(() => undefined);
      await alice.page.waitForTimeout(150);
    }
    await settled(alice.page);
    await settled(bob.page);
    await alice.page.waitForTimeout(1_200);
    const seen = { alice: await frames(alice.page), bob: await frames(bob.page) };
    // The graveyard pile draws Griselbrand until it leaves; the arrival is from there.
    expectOneArrival('alice (caster)', seen.alice, 0, ['pile']);
    expectOneArrival('bob (opponent)', seen.bob, 0, ['pile']);
  } finally {
    await stack.stop();
  }
});
