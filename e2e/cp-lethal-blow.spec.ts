/**
 * The blow that ends the game is drawn before the game ends, against real Forge.
 *
 * The operator, 2026-10-17: *"the damage dealt and game end triggers cannot happen until the
 * animation is complete. at the moment, the final creature doesn't even get to attack because the
 * game ends immediately."* Paced (Fast Mode off, as the operator plays), on both screens:
 *
 * - `cp-lethal-ram`: bob's Hill Giant and Grizzly Bears attack alice at 5 life. They charge alice's
 *   avatar (`.board-ram`), the blow lands (`.effect-crash`), and only then does alice's life drop; the
 *   result screen comes once the charge is over — never before the Giant has moved. While a copy
 *   charges, the attacker's own card is not drawn in its row; no "lost" is drawn anywhere; and each
 *   screen hears the charge, the blow, the life lost and the end.
 * - `cp-lethal-bolt`: alice bolts bob at 3 life. The bolt flies (`.effect-hit`), lands
 *   (`.effect-impact`), bob's life drops, and only then the result screen.
 *
 * Each page records, from before the attack or the cast, when each of those first appeared on it (a
 * MutationObserver, wall clock) and when its socket received the end (`finishGame`) and the frame
 * carrying `GameOver`. `[cp]` lines are the evidence.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { castUntilOnStack, enabledOk, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import { passDeclareAttackers, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
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
  /** The first moment a rammer's own element was drawn while its copy was out: the duplicate. */
  dupe?: number;
  dupeAt?: string;
  /** The first moment a "lost" word was drawn anywhere on the page. */
  lostText?: number;
  lostAt?: string;
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
      /*
       * Every painted frame while a ram's copy is out: each copy past its first moment (the original is
       * hidden on the next task) has its rammer's own element undrawn — a live element with
       * `data-ramming` — else that element is drawn beside its copy. And no word "lost" anywhere.
       */
      const born = new WeakMap<Element, number>();
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const frame = (): void => {
        const now = Date.now();
        const copies = [...document.querySelectorAll('.board-ram')];
        for (const c of copies) if (!born.has(c)) born.set(c, now);
        const settled = copies.filter((c) => now - born.get(c)! > 100).length;
        const hidden = [...document.querySelectorAll('[data-ramming]')].filter((el) => el.isConnected && !visible(el)).length;
        if (settled > 0 && hidden < settled && marks.dupe === undefined) {
          marks.dupe = now;
          const shown = [...document.querySelectorAll('[data-zone="battlefield"] [data-board-card][data-attacking]')]
            .filter(visible)
            .map((el) => `${el.getAttribute('data-board-card')}${el.hasAttribute('data-ramming') ? ':ramming' : ''}`);
          marks.dupeAt = `copies=${copies.length} settled=${settled} hidden=${hidden} drawnAttackers=${shown.join(',')}`;
        }
        if (marks.lostText === undefined) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
            const word = (n.textContent ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
            if (word === 'lost' && n.parentElement !== null && visible(n.parentElement)) {
              marks.lostText = now;
              marks.lostAt = n.parentElement.className;
              break;
            }
          }
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
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

/** Every sound role `seat` reported playing (its client's `kind:"sound"` rows), seat suffixes and overflow counts dropped. */
function soundRoles(stack: PlayStack, seat: number): Set<string> {
  const roles = serverLog(stack)
    .filter((r) => r.evt === 'client' && r.kind === 'sound' && r.seat === seat && typeof r.roles === 'string')
    .flatMap((r) => (r.roles as string).split(','))
    .map((role) => role.replace(/ \+\d+$/, '').replace(/@opp$/, '').trim());
  return new Set(roles);
}

/** How many times this friend's screen asked the server for a resync: each one rebuilds the board's view and redraws what it ended on. */
function resyncs(friend: Friend): number {
  return friend.captures.filter((c) => c.dir === 'out' && c.text.includes('"forge:resync"')).length;
}

/** Every recorded moment as ms after `zero`, for the evidence line. */
function relative(zero: number, at: Record<string, number | string | undefined>): Record<string, number | string | null> {
  return Object.fromEntries(Object.entries(at).map(([k, v]) => [k, typeof v === 'number' ? v - zero : (v ?? null)]));
}

/**
 * A pack of attackers charges the avatar of the seat at 5 life: on `cp-lethal-ram` bob's were declared by
 * the scenario; on `cr-lethal-declared` alice, the viewer, declares hers by hand — they tap, as the
 * operator's own last attack did — and bob has nothing to block with.
 */
async function lethalCharge(browser: Browser, jar: { jar: string; res: string }, scenario: string, attacker: 'alice' | 'bob'): Promise<void> {
  const stack = await startPlayStack(jar);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, scenario);
    const { alice, bob } = seated;
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    const defender = attacker === 'bob' ? 'alice' : 'bob';
    await recordMarks(alice.page, defender === 'alice' ? 'viewer' : 'opponent', '5');
    await recordMarks(bob.page, defender === 'bob' ? 'viewer' : 'opponent', '5');
    const zero = Date.now();

    if (attacker === 'bob') await passDeclareAttackers(bob.page);
    else {
      await passToDeclareAttackers(alice.page);
      const creatures = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-selectable]');
      await expect(creatures, 'both creatures are offered to attack').toHaveCount(2, { timeout: 10_000 });
      for (const id of await creatures.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-board-card'))))) {
        const card = alice.page.locator(`[data-board-card="${id}"]`);
        const box = (await card.boundingBox())!;
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(card, `Forge declared ${id} attacking`).toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
      }
      await alice.page.locator('[data-testid="live-decision-ok"]:enabled').click();
    }
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
      console.log(`[cp] ram ${scenario} ${who} ${JSON.stringify(relative(zero, { ...marks, ...endFrames(friend) }))} resyncs=${resyncs(friend)}`);
      expect(marks.ram, `${who}: the pack charged`).toBeDefined();
      expect(marks.crash, `${who}: its blow landed`).toBeDefined();
      expect(marks.life, `${who}: ${defender}'s life moved`).toBeDefined();
      expect(marks.lifeNow, `${who}: to 0`).toBe('0');
      expect(marks.ram!, `${who}: the pack set off before the result screen`).toBeLessThan(marks.result!);
      expect(marks.crash!, `${who}: the blow landed before the result screen`).toBeLessThan(marks.result!);
      expect(marks.life!, `${who}: ${defender}'s life held until the pack set off`).toBeGreaterThan(marks.ram!);
      expect(marks.life! + 20, `${who}: ${defender}'s life dropped at the blow, not before it`).toBeGreaterThanOrEqual(marks.crash!);
      expect(marks.ramGone, `${who}: the charge was over`).toBeDefined();
      expect(marks.result!, `${who}: the result screen once the charge was over`).toBeGreaterThanOrEqual(marks.ramGone!);
      // The operator, 2026-10-17: "a duplicate copy of the tapped attacking creatures remains on the board while the attacks go through".
      expect.soft(marks.dupe, `${who}: no attacker drawn in its row while its copy charges (${marks.dupeAt ?? ''})`).toBeUndefined();
      // The end reaches the screen in the server's own order: a resync rebuilds the view and draws the killing blow a second time.
      expect.soft(resyncs(friend), `${who}: the end never sends the screen back for a resync`).toBe(0);
      // "weird [lost] text appears, we dont need that".
      expect.soft(marks.lostText, `${who}: no "lost" drawn (${marks.lostAt ?? ''})`).toBeUndefined();
    }
    // "sound effects didn't trigger as expected": the charge, the blow, the life lost, and the end, on each screen.
    for (const [who, seat] of [['alice', 0], ['bob', 1]] as const) {
      const want = ['g.charge', 'g.crash', 'g.damage-player', who === defender ? 'g.lose' : 'g.win'];
      await expect.soft
        .poll(() => want.filter((role) => !soundRoles(stack, seat).has(role)), { timeout: 10_000, message: `${who}: every sound of the killing blow` })
        .toEqual([])
        .finally(() => console.log(`[cp] sounds ${scenario} ${who} ${[...soundRoles(stack, seat)].sort().join(',')}`));
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
}

test(
  titled('a lethal attacker charges the avatar and lands its blow before the life drops and before the result screen'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    await lethalCharge(browser, forge, 'cp-lethal-ram', 'bob');
  },
);

test(
  titled('a pack the viewer declared by hand charges for the kill with no copy of it left in its row, no "lost", and every sound'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    await lethalCharge(browser, forge, 'cr-lethal-declared', 'alice');
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
      const bobsFace = alice.page.locator('[data-player-face]:not([data-viewer])');
      await castUntilOnStack(alice.page, stack, bolt!, [bobsFace]);
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
