/**
 * The blow that ends the game is drawn before the game ends, against real Forge.
 *
 * The operator, 2026-10-17: *"the damage dealt and game end triggers cannot happen until the
 * animation is complete. at the moment, the final creature doesn't even get to attack because the
 * game ends immediately."* Paced (Fast Mode off, as the operator plays), on both screens:
 *
 * - `cp-lethal-ram`: bob's Hill Giant attacks alice at 3 life. The Giant charges alice's avatar
 *   (`.board-ram`), the blow lands (`.effect-crash`), and only then does alice's life drop; the
 *   result screen comes once the charge is over — never before the Giant has moved.
 * - `cp-lethal-bolt`: alice bolts bob at 3 life. The bolt flies (`.effect-hit`), lands
 *   (`.effect-impact`), bob's life drops, and only then the result screen.
 *
 * Each page records, from before the attack or the cast, when each of those first appeared on it (a
 * MutationObserver, wall clock) and when its socket received the end (`finishGame`) and the frame
 * carrying `GameOver`. `[cp]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { castUntilOnStack, clickHandCard, enabledOk, makeTitled, offeredNamed, stackCount } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** When each mark first appeared on the page, and when the moving copy of a rammer was last seen. */
interface Marks {
  ram?: number;
  ramGone?: number;
  crash?: number;
  bolt?: number;
  impact?: number;
  /** When the life first moved off where it started — its counter then steps down to what it reads now. */
  life?: number;
  lifeNow?: string;
  result?: number;
}

/** Start recording, on `page`, when each mark first appears and when the life of `playerSide` first moves off `lifeFrom`. */
async function recordMarks(page: Page, playerSide: 'viewer' | 'opponent', lifeFrom: string): Promise<void> {
  await page.evaluate(
    ([side, from]) => {
      const marks: Record<string, number | string> = {};
      (window as unknown as { __cpMarks: typeof marks }).__cpMarks = marks;
      const life = (): string | null =>
        document.querySelector(`[data-player-face]${side === 'viewer' ? '[data-viewer]' : ':not([data-viewer])'} [data-testid="life"]`)?.textContent ?? null;
      const first = (key: string, present: boolean): void => {
        if (present && marks[key] === undefined) marks[key] = Date.now();
      };
      const look = (): void => {
        const ramming = document.querySelector('.board-ram, [data-ramming]') !== null;
        first('ram', ramming);
        if (marks.ram !== undefined && !ramming && marks.ramGone === undefined) marks.ramGone = Date.now();
        first('crash', document.querySelector('.effect-crash') !== null);
        first('bolt', document.querySelector('.effect-hit') !== null);
        first('impact', document.querySelector('.effect-impact') !== null);
        const now = life();
        if (now !== null && now !== from && marks.life === undefined) marks.life = Date.now();
        if (now !== null) marks.lifeNow = now;
        first('result', document.querySelector('[data-testid="game-result"]') !== null);
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      look();
    },
    [playerSide, lifeFrom] as const,
  );
}

async function marksOf(page: Page): Promise<Marks> {
  return page.evaluate(() => (window as unknown as { __cpMarks: Marks }).__cpMarks);
}

/** Wait until the life that was hit reads 0 on every page — what the blow drew is over, whichever came first. */
async function lifeSettled(pages: readonly Page[], zero: number, friends: readonly Friend[]): Promise<void> {
  try {
    await expect
      .poll(async () => (await Promise.all(pages.map(async (p) => (await marksOf(p)).lifeNow ?? null))).every((to) => to === '0'), {
        timeout: 20_000,
        message: 'the life that was hit reads 0 on both screens',
      })
      .toBe(true);
  } finally {
    for (const f of friends) console.log(`[cp] settled ${f.name} ${JSON.stringify(relative(zero, { ...(await marksOf(f.page)), ...endFrames(f) }))}`);
  }
}

/** When this friend's socket received the end notice, and the first frame carrying `GameOver`. */
function endFrames(friend: Friend): { finishGame?: number; gameOverFrame?: number } {
  const out: { finishGame?: number; gameOverFrame?: number } = {};
  for (const m of messages(friend)) {
    if (m.dir !== 'in' || m.kind !== 's2c') continue;
    if (out.finishGame === undefined && m.raw.includes('"finishGame"')) out.finishGame = m.t;
    if (out.gameOverFrame === undefined && m.raw.includes('"GameOver"')) out.gameOverFrame = m.t;
  }
  return out;
}

/** Every recorded moment as ms after `zero`, for the evidence line. */
function relative(zero: number, at: Record<string, number | string | undefined>): Record<string, number | string | null> {
  return Object.fromEntries(Object.entries(at).map(([k, v]) => [k, typeof v === 'number' ? v - zero : (v ?? null)]));
}

test(
  titled('a lethal attacker charges the avatar and lands its blow before the life drops and before the result screen'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'cp-lethal-ram');
      const { alice, bob } = seated;
      await turnFastModeOff(alice.page, stack, 0);
      await turnFastModeOff(bob.page, stack, 1);
      await recordMarks(alice.page, 'viewer', '3');
      await recordMarks(bob.page, 'opponent', '3');
      const zero = Date.now();

      await passDeclareAttackers(bob.page);
      // Whatever stop either seat is held at on the way to combat damage, pressed through.
      await expect
        .poll(
          async () => {
            for (const page of [alice.page, bob.page]) if ((await enabledOk(page).count()) > 0) await enabledOk(page).click().catch(() => undefined);
            return (await Promise.all([alice.page, bob.page].map((p) => p.getByTestId('game-result').count()))).every((n) => n > 0);
          },
          { timeout: 60_000, intervals: [100], message: 'the result screen on both screens' },
        )
        .toBe(true);
      await lifeSettled([alice.page, bob.page], zero, [alice, bob]);

      for (const [who, friend] of [['alice', alice], ['bob', bob]] as const) {
        const marks = await marksOf(friend.page);
        console.log(`[cp] ram ${who} ${JSON.stringify(relative(zero, { ...marks, ...endFrames(friend) }))}`);
        expect(marks.ram, `${who}: the Giant charged`).toBeDefined();
        expect(marks.crash, `${who}: its blow landed`).toBeDefined();
        expect(marks.life, `${who}: alice's life moved`).toBeDefined();
        expect(marks.lifeNow, `${who}: to 0`).toBe('0');
        expect(marks.ram!, `${who}: the Giant set off before the result screen`).toBeLessThan(marks.result!);
        expect(marks.crash!, `${who}: the blow landed before the result screen`).toBeLessThan(marks.result!);
        expect(marks.life!, `${who}: alice's life held until the Giant set off`).toBeGreaterThan(marks.ram!);
        expect(marks.life! + 20, `${who}: alice's life dropped at the blow, not before it`).toBeGreaterThanOrEqual(marks.crash!);
        expect(marks.ramGone, `${who}: the charge was over`).toBeDefined();
        expect(marks.result!, `${who}: the result screen once the charge was over`).toBeGreaterThanOrEqual(marks.ramGone!);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

test(
  titled('a lethal Lightning Bolt lands before the life drops and before the result screen'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'cp-lethal-bolt');
      const { alice, bob } = seated;
      await turnFastModeOff(alice.page, stack, 0);
      await turnFastModeOff(bob.page, stack, 1);
      // Full control: alice's priority is held for this spec's own clicks (`w56-numbers.spec.ts`'s route through the same cast).
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
      await recordMarks(alice.page, 'opponent', '3');
      await recordMarks(bob.page, 'viewer', '3');
      const zero = Date.now();

      let bolt: number | undefined;
      await expect.poll(async () => (bolt = await offeredNamed(alice.page, 'Lightning Bolt')), { timeout: 30_000, message: 'Lightning Bolt is offered' }).not.toBeUndefined();
      await clickHandCard(alice.page, bolt!);
      const bobsFace = alice.page.locator('[data-player-face]:not([data-viewer])');
      await castUntilOnStack(alice.page, stack, async () => {
        const ready = (await bobsFace.getAttribute('data-selectable')) === 'true';
        if (ready) await bobsFace.click();
        return ready;
      });
      expect(await stackCount(alice.page), 'the bolt is on the stack, aimed at bob').toBe(1);

      await expect
        .poll(
          async () => {
            for (const page of [alice.page, bob.page]) if ((await enabledOk(page).count()) > 0) await enabledOk(page).click().catch(() => undefined);
            return (await Promise.all([alice.page, bob.page].map((p) => p.getByTestId('game-result').count()))).every((n) => n > 0);
          },
          { timeout: 60_000, intervals: [100], message: 'the result screen on both screens' },
        )
        .toBe(true);
      await lifeSettled([alice.page, bob.page], zero, [alice, bob]);

      for (const [who, friend] of [['alice', alice], ['bob', bob]] as const) {
        const marks = await marksOf(friend.page);
        console.log(`[cp] bolt ${who} ${JSON.stringify(relative(zero, { ...marks, ...endFrames(friend) }))}`);
        expect(marks.bolt, `${who}: the bolt flew`).toBeDefined();
        expect(marks.impact, `${who}: it landed`).toBeDefined();
        expect(marks.lifeNow, `${who}: bob's life to 0`).toBe('0');
        expect(marks.bolt!, `${who}: the bolt flew before the result screen`).toBeLessThan(marks.result!);
        expect(marks.life! + 20, `${who}: bob's life dropped as it landed, not before`).toBeGreaterThanOrEqual(marks.impact!);
        expect(marks.result!, `${who}: the result screen after the bolt landed`).toBeGreaterThanOrEqual(marks.impact!);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
