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

import { clickOnce, dragHandCard, makeTitled, offered, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeHeaderSettings, openHeaderSettings } from './play/w32.ts';

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
  stack: number;
  /** Stack items Forge has that the stack is leaving to the played card (`data-carried`). */
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
      const ghost = document.querySelector(`[data-cast-ghost="${id}"]`);
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
        ghostLift: ghost?.getAttribute('data-cast-lift') ?? null,
        // The gap the row reserved for the card at its release (`Board`'s `notePlayedTo`): where its stand-in waits.
        gap: box(document.querySelector('[data-zone="battlefield"][data-owner="you"] li.zone__gap[data-expected]')),
        // What the stack DRAWS: `data-count` is everything Forge has, `data-carried` the items a played card stands in for.
        stack: document.querySelectorAll('[data-zone="stack"] .stack__item').length,
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
        `${f.ghost === null ? '' : `  ghost @${f.ghost.x},${f.ghost.y} ${f.ghost.w}x${f.ghost.h} ${f.ghostLift ?? ''}`}  stack=${f.stack}${f.carried > 0 ? ` carried=${f.carried}` : ''}${f.confirm ? ' confirm' : ''}${f.scrolls ? ' SCROLLS' : ''}`,
    );
  }
  const end = frames[frames.length - 1];
  if (end !== undefined) lines.push(`${String(end.t - t0).padStart(6)}ms  end of recording, ${frames.length} frames`);
  return lines.join('\n');
}

/** Where the card is SEEN in a frame: its stand-in when one is drawn, else its own element unless that is hidden under a landing. */
function seenAt(f: Frame): Box | null {
  if (f.ghost !== null) return f.ghost;
  return f.hidden ? null : f.at;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, px = 3): boolean => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px;

/** A point in the middle of the viewer's own battlefield, where the card is let go. */
async function releasePoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox();
  if (box === null) throw new Error('the viewer has no battlefield to release over');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

const onMyBattlefield = (page: Page, id: number) => page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${id}"]`);

async function setFastMode(page: Page, on: boolean): Promise<void> {
  const toggle = (await openHeaderSettings(page)).locator('[data-testid="live-settings-fast-mode"]');
  await toggle.setChecked(on);
  await closeHeaderSettings(page);
}

/** The frames from the release on: the first one whose card is parked, through to the end. */
function afterRelease(frames: Frame[]): Frame[] {
  const from = frames.findIndex((f) => f.lift === 'parked' || f.ghostLift === 'parked');
  if (from < 0) throw new Error(`the card was never parked:\n${timeline(frames)}`);
  return frames.slice(from);
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
  for (const f of flight) {
    const landed = f.zone === 'battlefield' && f.owner === 'you' && f.lift === null && !f.landing && f.ghost === null;
    if (landed) continue;
    const seen = seenAt(f);
    expect(seen, `the card is drawn somewhere in every frame until it lands (t=${f.t})\n${story}`).not.toBeNull();
    const travelling = f.ghostLift === 'returning';
    // It waits at the point it was let go, or — gliding there from it — in the gap the row reserved
    // (2026-10-08: the same motion the other screen draws); a frame mid-glide is between the two.
    const inGap = f.gap !== null && near(seen!, f.gap, 6);
    const between = f.gap !== null && seen !== null && Math.min(seen.x, f.gap.x, released.x) - 6 <= seen.x && seen.x <= Math.max(seen.x, f.gap.x, released.x) + 6 && Math.min(f.gap.y, released.y) - 6 <= seen.y && seen.y <= Math.max(f.gap.y, released.y) + 6;
    if (!travelling) expect(near(seen!, released) || inGap || between, `the card is at the point it was let go or in its reserved gap (t=${f.t}), not ${seen!.x},${seen!.y}\n${story}`).toBe(true);
    expect(f.zone === 'hand' && f.lift === null, `the card is never back in the hand's own row (t=${f.t})\n${story}`).toBe(false);
    expect(f.tapped && !f.hidden && f.zone !== 'battlefield', `the card is never drawn tapped off the battlefield (t=${f.t})\n${story}`).toBe(false);
    expect(f.ghost !== null && f.at !== null && !f.hidden, `the card is never drawn twice, itself and its stand-in (t=${f.t})\n${story}`).toBe(false);
  }
  expect(flight.some((f) => f.scrolls), `the battlefield never scrolls inside itself\n${story}`).toBe(false);
  const end = flight[flight.length - 1]!;
  expect(end.zone === 'battlefield' && end.owner === 'you' && end.lift === null && !end.landing && end.ghost === null, `it ends on the battlefield with nothing left over it\n${story}`).toBe(true);
  return flight;
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
    const land = (await offered(alice.page))[0];
    if (land === undefined) throw new Error(`the shockland scenario offered nothing to play: ${await says(alice.page)}`);
    const to = await releasePoint(alice.page);
    await record(alice.page, land);
    expect(await dragHandCard(alice.page, land, to), 'the press lifted the land').toBe(true);

    await expect.poll(() => confirmOpen(alice.page), { timeout: 15_000, message: 'the shockland asks to pay 2 life' }).toBe(true);
    // Long enough to be seen waiting, which is the whole of the complaint.
    await alice.page.waitForTimeout(600);
    await answerConfirm(alice.page, 'no');
    await expect(onMyBattlefield(alice.page, land), 'declining the life let it enter').toHaveCount(1, { timeout: 15_000 });
    await expect(alice.page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'and nothing is left over the board').toHaveCount(0, { timeout: 5_000 });

    const frames = await recording(alice.page);
    await attach(testInfo, `shockland-fast-${fast}`, frames);
    const flight = expectWaitedThere(frames, to);
    const asked = flight.filter((f) => f.confirm);
    expect(asked.length, 'the question was up for many frames').toBeGreaterThan(10);
    for (const f of asked) expect(near(seenAt(f)!, to), `while the question is up the land is over the board (t=${f.t})`).toBe(true);
    expect(flight.some((f) => f.stack > 0 || f.carried > 0), 'a land never shows on the stack, nor is ever on Forge’s').toBe(false);
    expect(flight.some((f) => f.ghostLift === 'returning'), 'it travels from the hover to its place, Fast Mode or not').toBe(true);
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
      expect(await dragHandCard(alice.page, creature, to), 'the press lifted the creature').toBe(true);

      // {R} from one of three Mountains: Forge's own Auto pays it.
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
            return onMyBattlefield(alice.page, creature).count();
          },
          { timeout: 20_000, intervals: [50], message: 'the creature resolved onto the battlefield' },
        )
        .toBe(1);
      await expect(alice.page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'nothing is left over the board').toHaveCount(0, { timeout: 5_000 });

      const frames = await recording(alice.page);
      await attach(testInfo, `creature-fast-${fast}`, frames);
      const flight = expectWaitedThere(frames, to);
      expect(Math.max(...flight.map((f) => f.stack)), `the caster's stack stays empty the whole way\n${timeline(flight)}`).toBe(0);
      // Not vacuous: Forge did have the spell on the stack, and the stack left it to the card.
      expect(flight.some((f) => f.carried === 1), `the spell was on Forge's stack while the card stood in for it\n${timeline(flight)}`).toBe(true);
      const travelled = flight.some((f) => f.ghostLift === 'returning');
      // Fast Mode is pacing, not motion: the card travels either way (2026-10-08).
      expect(travelled, 'it travels from the hover to its place, Fast Mode or not').toBe(true);
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
    const memnite = (await offered(alice.page))[0];
    if (memnite === undefined) throw new Error(`nothing to cast: ${await says(alice.page)}`);
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
    for (const f of flight) {
      const seen = seenAt(f);
      expect(seen !== null && near(seen, to), `Memnite waits over the board the whole time (t=${f.t})\n${story}`).toBe(true);
    }
  } finally {
    await stack.stop();
  }
});
