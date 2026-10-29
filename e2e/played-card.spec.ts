/**
 * A card played to the battlefield waits where it was let go, against a real
 * Forge match, measured in every frame the browser draws.
 *
 * The operator, 2026-10-06, on Overgrown Tomb: *"i see the card tap in hand and
 * then move to board which is awkward. why isn't the land hovering over the
 * board while the question is being asked, and then after the question is
 * finished place the card on the board from the hover"*. On Dark Confidant:
 * *"i drag the card onto the board (it snaps back to hand) … it appears in the
 * stack briefly, then the stack resolves and it goes to board. i dont think we
 * need the stack to appear at all if the opponent doesn take priority … more
 * importantly i dont like the snap back to the hand."*
 *
 * Each test drags the card out with a held pointer, records the card's own
 * element (or its stand-in), the stack's count and the battlefield's overflow
 * once per animation frame from before the release until the card has landed,
 * and then reads the whole recording: the claim is about every frame, and a
 * poll would sample past the one that is wrong.
 *
 *  - `shockland`  Steam Vents: "pay 2 life?" is asked with the card still in
 *    Forge's hand zone.
 *  - `land-only-pass`  Raging Goblin for {R}: a payment, then a spell nobody
 *    can respond to.
 *  - `w49-a-counterspell-opponent`  Memnite into two Islands and a
 *    Counterspell: the opponent really does hold priority.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { dragHandCard, makeTitled, offered, offeredCard, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One animation frame of the played card, as the browser had it. */
interface Frame {
  t: number;
  /** The zone the card's own element is in, or null when the board draws none for it. */
  zone: string | null;
  owner: string | null;
  lift: string | null;
  landing: boolean;
  /** The card's own element is not drawn (`visibility: hidden`): its stand-in is what is seen. */
  hidden: boolean;
  tapped: boolean;
  /** The centre and size of the card's own element. */
  at: Box | null;
  /** The centre and size of its stand-in. */
  ghost: Box | null;
  ghostLift: string | null;
  gap: Box | null;
  /** Wave 59 §S: `live/placed.ts`'s own card, once a matching stack item exists and is shown — the ghost's handoff target. */
  placed: Box | null;
  /** That card exists but is held hidden (`data-placed-pending`): its stand-in is still gliding into the gap. */
  placedHeld: boolean;
  stack: number;
  /** Stack items Forge has that the stack is leaving to the played card (`data-carried`) — bookkeeping only now, see `Board.tsx`'s `StackView`. */
  carried: number;
  confirm: boolean;
  /** The viewer's own battlefield scrolls inside itself. */
  scrolls: boolean;
}

async function record(page: Page, cardId: number): Promise<void> {
  await page.evaluate((id) => {
    const frames: unknown[] = [];
    const state = { frames, run: true };
    (window as unknown as { __played: typeof state }).__played = state;
    const box = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const tick = (): void => {
      if (!state.run) return;
      const el = document.querySelector(`[data-board-card="${id}"]`);
      // Its stand-in: the ghost while it waits, then its arrival (`entries.ts`'s `.board-entry`, standing in for the row card).
      const ghost = document.querySelector(`[data-cast-ghost="${id}"]`) ?? document.querySelector(`.board-entry[data-stand-in="${id}"]`);
      // §S: once Forge actually has the spell on the stack, `live/placed.ts` draws it — the ghost's
      // own handoff target, found by the SAME card id, through the CardTile it mounts (`w<id>`).
      // The WRAPPER's own existence is the continuity signal — its position
      // is set in the same synchronous pass that creates it; `CardTile`'s own
      // React root may commit a task later in a real browser (unlike jsdom's
      // synchronous first-render guarantee `placed.test.ts` relies on), so
      // requiring its `data-card-id` here as well read as a gap that never
      // existed in the DOM. Matching by id is still exact — only one spell of
      // this test's own card is ever on the stack at a time.
      const placedAll = Array.from(document.querySelectorAll<HTMLElement>('[data-placed-spell][data-mine]'));
      const placed = placedAll.find((e) => e.querySelector(`[data-card-id="w${id}"]`) !== null) ?? (placedAll.length === 1 ? placedAll[0] : null);
      const zone = el?.closest('[data-zone]') ?? null;
      const battlefield = document.querySelector('[data-zone="battlefield"][data-owner="you"]');
      frames.push({
        t: Math.round(performance.now()),
        zone: zone?.getAttribute('data-zone') ?? null,
        owner: zone?.getAttribute('data-owner') ?? null,
        lift: el?.getAttribute('data-cast-lift') ?? null,
        landing: el?.hasAttribute('data-cast-landing') ?? false,
        hidden: el !== null && getComputedStyle(el).visibility === 'hidden',
        tapped: el?.hasAttribute('data-tapped') ?? false,
        at: box(el),
        ghost: box(ghost),
        ghostLift: ghost === null ? null : (ghost.getAttribute('data-cast-lift') ?? 'entry'),
        // The gap the row reserved for the card at its release (`Board`'s `notePlayedTo`): where its stand-in waits.
        gap: box(document.querySelector('[data-zone="battlefield"][data-owner="you"] li.zone__gap[data-expected]')),
        placed: placed !== null && getComputedStyle(placed).visibility !== 'hidden' ? box(placed) : null,
        placedHeld: placed !== null && getComputedStyle(placed).visibility === 'hidden',
        // The zone itself draws nothing at all now (§S) — every item is `live/placed.ts`'s, in the
        // overlay, never a child of this zone; `stack` keeps the same meaning it always had ("how
        // many things does the row show"), now trivially 0, always, by construction.
        stack: document.querySelectorAll('[data-zone="stack"] > *').length,
        carried: Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-carried') ?? '0'),
        confirm: document.querySelector('[data-testid="prompt-confirm-yes"]') !== null,
        scrolls:
          battlefield !== null &&
          (battlefield.scrollWidth > battlefield.clientWidth + 1 || battlefield.scrollHeight > battlefield.clientHeight + 1),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, cardId);
}

async function recording(page: Page): Promise<Frame[]> {
  return page.evaluate(async () => {
    const state = (window as unknown as { __played: { frames: Frame[]; run: boolean } }).__played;
    // The state the caller just waited for was reached between two frames: let it be drawn, and recorded, first.
    for (let i = 0; i < 3; i++) await new Promise<void>((done) => requestAnimationFrame(() => done()));
    state.run = false;
    return state.frames;
  });
}

/** The recording with runs of identical frames folded to their first, for a person to read. */
function timeline(frames: Frame[]): string {
  const lines: string[] = [];
  let last = '';
  const t0 = frames[0]?.t ?? 0;
  for (const f of frames) {
    const { t, ...rest } = f;
    const key = JSON.stringify(rest);
    if (key === last) continue;
    last = key;
    const where = f.at === null ? 'no element' : `${f.zone ?? '?'}/${f.owner ?? '?'} @${f.at.x},${f.at.y} ${f.at.w}x${f.at.h}`;
    lines.push(
      `${String(t - t0).padStart(6)}ms  ${where}${f.lift === null ? '' : ` lift=${f.lift}`}${f.landing ? ' landing' : ''}${f.hidden ? ' hidden' : ''}${f.tapped ? ' tapped' : ''}` +
        `${f.ghost === null ? '' : `  ghost @${f.ghost.x},${f.ghost.y} ${f.ghost.w}x${f.ghost.h} ${f.ghostLift ?? ''}`}` +
        `${f.placed === null ? '' : `  placed @${f.placed.x},${f.placed.y} ${f.placed.w}x${f.placed.h}`}${f.placedHeld ? '  placed held' : ''}  stack=${f.stack}${f.carried > 0 ? ` carried=${f.carried}` : ''}${f.confirm ? ' confirm' : ''}${f.scrolls ? ' SCROLLS' : ''}`,
    );
  }
  const end = frames[frames.length - 1];
  if (end !== undefined) lines.push(`${String(end.t - t0).padStart(6)}ms  end of recording, ${frames.length} frames`);
  return lines.join('\n');
}

/**
 * Where the card is SEEN in a frame: its stand-in (the ghost, pre-stack) or
 * `live/placed.ts`'s own card (post-stack — §S's handoff, `gestures/
 * install.ts`'s `syncParkedGhost`, retires the ghost the moment the matching
 * item appears), then its own element unless that is hidden under a landing.
 */
function seenAt(f: Frame): Box | null {
  if (f.ghost !== null) return f.ghost;
  if (f.placed !== null) return f.placed;
  return f.hidden ? null : f.at;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, px = 3): boolean => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px;

/** A point in the middle of the viewer's own battlefield, where the card is let go. */
/**
 * The operator, 2026-10-09 (ledger AE25): "if the card is a permanent, it should drop to the closest spot
 * to where it would snap to" — the column nearest the release x, never the row's first slot. On an
 * EMPTY battlefield nothing measured the column pitch, so the first permanent of a game went to column 0.
 */
async function expectNearestColumn(page: Page, id: number, released: { x: number; y: number }): Promise<void> {
  const box = await onMyBattlefield(page, id).boundingBox();
  if (box === null) throw new Error(`card ${id} is not on the battlefield`);
  const centre = box.x + box.width / 2;
  console.log(`[played-card] released x=${released.x}, landed centre x=${Math.round(centre)} (card ${Math.round(box.width)} wide)`);
  expect(Math.abs(centre - released.x), 'the card landed at the column nearest the release, not the row\'s first slot').toBeLessThanOrEqual(box.width);
}

async function releasePoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox();
  if (box === null) throw new Error('the viewer has no battlefield to release over');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

const onMyBattlefield = (page: Page, id: number) => page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${id}"]`);

async function setFastMode(page: Page, on: boolean): Promise<void> {
  const toggle = (await openSettings(page)).locator('[data-testid="live-settings-fast-mode"]');
  await toggle.setChecked(on);
  await closeSettings(page);
}

/** The frames from the release on: the first one whose card is parked, through to the end. */
function afterRelease(frames: Frame[]): Frame[] {
  const from = frames.findIndex((f) => f.lift === 'parked' || f.ghostLift === 'parked');
  if (from < 0) throw new Error(`the card was never parked:\n${timeline(frames)}`);
  return frames.slice(from);
}

/**
 * Where a played card may be seen while it waits: at the point it was let go, in the gap its row
 * reserved for it (`gap`, the last one seen), or between the two while it glides there — the same
 * motion the other screen draws (2026-10-08).
 */
function waitingAt(seen: { x: number; y: number }, released: { x: number; y: number }, gap: Box | null): boolean {
  if (near(seen, released)) return true;
  if (gap === null) return false;
  return (
    near(seen, gap, 6) ||
    (Math.min(gap.x, released.x) - 6 <= seen.x &&
      seen.x <= Math.max(gap.x, released.x) + 6 &&
      Math.min(gap.y, released.y) - 6 <= seen.y &&
      seen.y <= Math.max(gap.y, released.y) + 6)
  );
}

/** Each frame of `flight` with the last reserved gap seen by then. */
function withGaps(flight: Frame[]): { f: Frame; gap: Box | null }[] {
  let gap: Box | null = null;
  return flight.map((f) => {
    if (f.gap !== null) gap = f.gap;
    return { f, gap };
  });
}

/**
 * The claims every played card shares, read off the whole recording:
 *  - from the release until it is on the battlefield it is seen at the point
 *    it was let go, or travelling from there to its place — never back in the
 *    hand;
 *  - it is never drawn tapped anywhere but on the battlefield;
 *  - the battlefield never scrolls inside itself while it arrives.
 */
function expectWaitedThere(frames: Frame[], released: { x: number; y: number }): Frame[] {
  const flight = afterRelease(frames);
  const story = timeline(flight);
  const held = flight.filter((f) => f.placedHeld);
  console.log(`[played-card] stack card held hidden under its gliding stand-in in ${held.length} frame(s)${held.length === 0 ? '' : `, ghost drawn in ${held.filter((f) => f.ghost !== null).length} of them`}`);
  // The reserved gap is consumed the frame the card arrives, while the stand-in still sits where it
  // was: the last gap seen is where it waited.
  for (const { f, gap } of withGaps(flight)) {
    const landed = f.zone === 'battlefield' && f.owner === 'you' && f.lift === null && !f.landing && f.ghost === null;
    if (landed) continue;
    const seen = seenAt(f);
    expect(seen, `the card is drawn somewhere in every frame until it lands (t=${f.t})\n${story}`).not.toBeNull();
    const travelling = f.ghostLift === 'returning' || f.ghostLift === 'entry';
    if (!travelling) expect(waitingAt(seen!, released, gap), `the card is at the point it was let go or in its reserved gap (t=${f.t}), not ${seen!.x},${seen!.y}\n${story}`).toBe(true);
    expect(f.zone === 'hand' && f.lift === null, `the card is never back in the hand's own row (t=${f.t})\n${story}`).toBe(false);
    expect(f.tapped && !f.hidden && f.zone !== 'battlefield', `the card is never drawn tapped off the battlefield (t=${f.t})\n${story}`).toBe(false);
    expect(f.ghost !== null && f.at !== null && !f.hidden, `the card is never drawn twice, itself and its stand-in (t=${f.t})\n${story}`).toBe(false);
    expect(f.placed !== null && f.at !== null && !f.hidden, `nor itself and live/placed.ts's own card (t=${f.t})\n${story}`).toBe(false);
    expect(f.ghost !== null && f.placed !== null, `nor the ghost and live/placed.ts's card at once — the handoff is a swap, never an overlap (t=${f.t})\n${story}`).toBe(false);
  }
  expect(flight.some((f) => f.scrolls), `the battlefield never scrolls inside itself\n${story}`).toBe(false);
  const end = flight[flight.length - 1]!;
  expect(end.zone === 'battlefield' && end.owner === 'you' && end.lift === null && !end.landing && end.ghost === null, `it ends on the battlefield with nothing left over it\n${story}`).toBe(true);
  return flight;
}

/** It left the point it was let go: a stand-in seen away from it (the glide into its gap), or a flight. */
function travelledFrom(flight: Frame[], released: { x: number; y: number }): boolean {
  return flight.some((f) => f.ghostLift === 'returning' || f.ghostLift === 'entry' || (f.ghostLift === 'parked' && seenAt(f) !== null && !near(seenAt(f)!, released, 6)));
}

/** The recording, kept beside the run's other evidence (`e2e/.run/`) whether the test passes or not. */
async function attach(testInfo: TestInfo, name: string, frames: Frame[]): Promise<void> {
  const dir = resolve(import.meta.dirname, '.run', 'played-card');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.txt`), `${timeline(frames)}\n`);
  await testInfo.attach(name, { body: timeline(frames), contentType: 'text/plain' });
}

for (const fast of [true, false]) {
  test(titled(`a shockland waits over the board while "pay 2 life?" is asked, and lands from there when it is answered (Fast Mode ${fast ? 'on' : 'off'})`), async ({ browser }, testInfo) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'shockland');
    if (!fast) await setFastMode(alice.page, false);
    const land = await offeredCard(alice.page, 'Steam Vents', { zone: 'hand' });
    const to = await releasePoint(alice.page);
    await record(alice.page, land);
    expect(await dragHandCard(alice.page, land, to), 'the press lifted the land').toBe(true);

    await expect.poll(() => confirmOpen(alice.page), { timeout: 15_000, message: 'the shockland asks to pay 2 life' }).toBe(true);
    // Long enough to be seen waiting, which is the whole of the complaint.
    await alice.page.waitForTimeout(600);
    await answerConfirm(alice.page, 'no');
    await expect(onMyBattlefield(alice.page, land), 'declining the life let it enter').toHaveCount(1, { timeout: 15_000 });
    await expectNearestColumn(alice.page, land, to);
    await expect(alice.page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'and nothing is left over the board').toHaveCount(0, { timeout: 5_000 });

    const frames = await recording(alice.page);
    await attach(testInfo, `shockland-fast-${fast}`, frames);
    const flight = expectWaitedThere(frames, to);
    const asked = withGaps(flight).filter(({ f }) => f.confirm);
    expect(asked.length, 'the question was up for many frames').toBeGreaterThan(10);
    for (const { f, gap } of asked) expect(waitingAt(seenAt(f)!, to, gap), `while the question is up the land waits over the board (t=${f.t})`).toBe(true);
    expect(flight.some((f) => f.stack > 0 || f.carried > 0), 'a land never shows on the stack, nor is ever on Forge’s').toBe(false);
    expect(travelledFrom(flight, to), 'it travels from the hover to its place, Fast Mode or not').toBe(true);
  } finally {
    await stack.stop();
  }
  });
}

for (const fast of [true, false]) {
  test(titled(`a creature nobody responds to never shows on its caster's stack, and lands from where it was let go (Fast Mode ${fast ? 'on' : 'off'})`), async ({ browser }, testInfo) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'land-only-pass');
      if (!fast) await setFastMode(alice.page, false);
      // The untapped Mountains are offered too (for their mana): the creature is the offered card in the hand.
      const inHand = await alice.page
        .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
      const creature = (await offered(alice.page)).find((id) => inHand.includes(id));
      if (creature === undefined) throw new Error(`no creature in hand to cast: ${await says(alice.page)}`);
      const to = await releasePoint(alice.page);
      await record(alice.page, creature);
      const logFrom = serverLog(stack).length;
      expect(await dragHandCard(alice.page, creature, to), 'the press lifted the creature').toBe(true);

      // {R} from one of three Mountains: Forge's own Auto pays it.
      await expect
        .poll(
          async () => {
            await pressPaymentAuto(alice.page);
            return onMyBattlefield(alice.page, creature).count();
          },
          { timeout: 20_000, intervals: [50], message: 'the creature resolved onto the battlefield' },
        )
        .toBe(1);
      await expect(alice.page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'nothing is left over the board').toHaveCount(0, { timeout: 5_000 });

      const frames = await recording(alice.page);
      await attach(testInfo, `creature-fast-${fast}`, frames);
      const flight = expectWaitedThere(frames, to);
      // §S: the zone draws nothing at all now, so this is a trivial 0 — kept as the regression guard
      // against a row ever coming back. `live/placed.ts`'s own card, found through `seenAt` above, is
      // where "the caster's stack stays aside" actually lives now.
      expect(Math.max(...flight.map((f) => f.stack)), `the caster's stack zone draws nothing\n${timeline(flight)}`).toBe(0);
      // Not vacuous: Forge did have the spell on the stack. Read off the server's record of every
      // priority it decided (`stop-decided`, the probe trace), never off the sampled frames: in Fast
      // Mode the spell can come and go between two of them (208 → 331 ms on a busy CI runner).
      const withSpell = serverLog(stack)
        .slice(logFrom)
        .filter((r) => r.evt === 'stop-decided' && r.window === 'priority' && r.stackEmpty === false);
      console.log(`[played-card] fast=${fast}: ${withSpell.length} priority decision(s) with the spell on Forge's stack: ${withSpell.map((r) => `seat ${String(r.seat)} ${String(r.decision)}`).join(', ')}`);
      expect(withSpell.length, `the spell was on Forge's stack while the card stood in for it\n${timeline(flight)}`).toBeGreaterThan(0);
      // Fast Mode is pacing, not motion: the card travels either way (2026-10-08) — by its stand-in's
      // glide into the gap it lands in (the landing is then a swap in place), or by a flight.
      expect(travelledFrom(flight, to), 'it travels from the hover to its place, Fast Mode or not').toBe(true);
    } finally {
      await stack.stop();
    }
  });
}

test(titled('a creature the opponent can answer stays the card where it was let go, however long they take: no row for one spell'), async ({ browser }, testInfo) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w49-a-counterspell-opponent');
    const memnite = await offeredCard(alice.page, 'Memnite', { zone: 'hand' });
    const to = await releasePoint(alice.page);
    await record(alice.page, memnite);
    expect(await dragHandCard(alice.page, memnite, to), 'the press lifted Memnite').toBe(true);

    // Bob holds Counterspell with two Islands up and is never auto-passed: the
    // spell sits on the stack, alone, for as long as he likes. The stack
    // redesign (2026-10-06): one item is drawn as the card, never as a row, so
    // the caster's stack keeps standing aside and Memnite keeps waiting.
    await expect
      .poll(() => alice.page.locator('[data-zone="stack"]').getAttribute('data-carried'), { timeout: 15_000, message: 'the stack is leaving the spell to the card' })
      .toBe('1');
    await alice.page.waitForTimeout(4000);
    const frames = await recording(alice.page);
    await attach(testInfo, 'contested', frames);
    const flight = afterRelease(frames);
    const story = timeline(flight);
    expect(flight.length, 'recorded well past any old stand-in time').toBeGreaterThan(60);
    const first = flight.findIndex((f) => f.carried === 1);
    expect(first, `the stack stood aside once Forge had the spell\n${story}`).toBeGreaterThanOrEqual(0);
    expect(flight.slice(first).every((f) => f.carried === 1), `and kept standing aside the whole time\n${story}`).toBe(true);
    expect(Math.max(...flight.map((f) => f.stack)), `and drew no row\n${story}`).toBe(0);
    for (const { f, gap } of withGaps(flight)) {
      const seen = seenAt(f);
      expect(seen !== null && waitingAt(seen, to, gap), `Memnite waits over the board the whole time (t=${f.t})\n${story}`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
