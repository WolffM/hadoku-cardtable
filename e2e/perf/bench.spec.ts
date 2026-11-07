/**
 * The perf bench: every intense moment of a match, played for real at normal pace (Fast Mode off on both
 * seats), measured on both screens (`measure.ts`). One test per scenario; a scenario can hold two moments.
 *
 * What a run prints, per moment and screen (`[perf]` and `[perf-json]` lines; the JSON also lands in
 * `e2e/.run/perf/<moment>.json`): the longest main-thread task on the thread's CPU clock (and the same scaled to
 * hokon by the CPU speed sampled right before and right after the moment, `cpu-speed.ts`), the worst long frame,
 * the time the screen skipped, the messages and their cost, React's commits, and — on an attributed run,
 * the default — each long frame's time split by mechanism, the hottest sources inside them, and which
 * scripts forced style or layout. Each moment is also a `(clean)` test, measured without the profiler
 * and the trace (both cost time themselves), for the frame numbers: `-g "perf bench \(clean\)"`.
 *
 * It judges nothing unless `CARDTABLE_PERF_BUDGET_MS` is set: then every screen's longest main-thread task, in CPU
 * ms scaled to hokon, must be within it — both sides on one clock, so a runner's contention moves neither. A fix
 * proves itself by setting the budget its moment must meet.
 *
 * Not in the full Forge run (`forge.yml` runs `e2e/*.spec.ts`): it is dispatched on purpose, e.g.
 * `-f specs='perf/bench.spec.ts -g worldfire'`, on a claw.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import { boardCard, castCard, castUntilOnStack, enabledOk, makeTitled, offeredCard, ownNamed, passOverStack, pressOffered, pressPaymentAuto, says, stackCount } from '../play/board.ts';
import { passToDeclareAttackers } from '../play/combat.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from '../play/harness.ts';
import { turnFastModeOff } from '../play/prefs.ts';
import { answerPrompt } from '../play/prompts.ts';
import { startScenarioMatch } from '../play/scenario.ts';
import { instrument, logReports, measure, type SeatReport } from './measure.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const BUDGET = process.env.CARDTABLE_PERF_BUDGET_MS === undefined ? null : Number(process.env.CARDTABLE_PERF_BUDGET_MS);
/** How long a moment is still recorded after the game settles: the beats and the deaths play out. */
const TAIL_MS = 3_000;

interface Table {
  attribute: boolean;
  browser: Browser;
  stack: PlayStack;
  alice: Page;
  bob: Page;
}

const life = (page: Page, whose: 'mine' | 'theirs') => page.locator(`.seat${whose === 'mine' ? '[data-viewer]' : ':not([data-viewer])'} [data-testid="life"]`).first();
const lifeOf = async (page: Page, whose: 'mine' | 'theirs'): Promise<number> => Number((await life(page, whose).textContent()) ?? 'NaN');
const prompts = async (t: Table): Promise<number> => (await t.alice.getByTestId('live-prompt').count()) + (await t.bob.getByTestId('live-prompt').count());

/** A scenario match, both screens instrumented, Fast Mode off on both. */
async function sit(browser: Browser, attribute: boolean, scenario: string, run: (t: Table) => Promise<void>): Promise<void> {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(10 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const arm = async (page: Page) => void (await page.addInitScript(instrument));
    const { alice, bob } = await startScenarioMatch(browser, stack, scenario, {
      beforeAlice: arm,
      beforeBob: arm,
    });
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    await alice.page.waitForLoadState('networkidle').catch(() => undefined);
    await run({ attribute, browser, stack, alice: alice.page, bob: bob.page });
  } finally {
    await stack.stop();
  }
}

/**
 * Measure `moment` on both screens: start, `play` it, then hold every window either seat is asked (a
 * target on bob's face, a "may" said yes to, a payment paid, the stack passed) until `done`, plus the tail.
 */
async function moment(t: Table, name: string, play: () => Promise<void>, done: () => Promise<boolean>, opts: { faceTargets?: boolean; x?: number; pressOk?: boolean } = {}): Promise<SeatReport[]> {
  const m = measure(
    t.browser,
    `${name}${t.attribute ? '' : '-clean'}`,
    [
      { name: 'alice', page: t.alice },
      { name: 'bob', page: t.bob },
    ],
    t.attribute,
  );
  await m.start();
  await play();
  const bobFace = t.alice.locator('[data-player-face][data-selectable]:not([data-viewer])');
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        if (opts.faceTargets === true && (await bobFace.count()) > 0) {
          const same = t.alice.getByTestId('live-same-target');
          if ((await same.count()) > 0 && !(await same.isChecked())) await same.check().catch(() => undefined);
          await bobFace
            .first()
            .click({ timeout: 1_000 })
            .catch(() => undefined);
          return false;
        }
        const yes = t.alice.locator('[data-testid="prompt-confirm-yes"]:enabled');
        if ((await yes.count()) > 0)
          await yes
            .first()
            .click({ timeout: 1_000 })
            .catch(() => undefined);
        await pressPaymentAuto(t.alice);
        for (const page of [t.alice, t.bob]) await answerPrompt(page, opts.x === undefined ? {} : { x: opts.x }).catch(() => null);
        for (const page of [t.alice, t.bob]) await passOverStack(page);
        // Combat: every stop on the way to damage, pressed through on both screens.
        if (opts.pressOk === true)
          for (const page of [t.alice, t.bob])
            if ((await enabledOk(page).count()) > 0)
              await enabledOk(page)
                .first()
                .click({ timeout: 1_000 })
                .catch(() => undefined);
        return false;
      },
      {
        timeout: 150_000,
        intervals: [250],
        message: `${name}: the moment plays out — alice says "${await says(t.alice)}"`,
      },
    )
    .toBe(true);
  await t.alice.waitForTimeout(TAIL_MS);
  const reports = await m.stop();
  logReports(reports);
  return reports;
}

/** Done once the stack has emptied, nobody is asked anything, and `also` holds — twice in a row. */
function settled(t: Table, also: () => Promise<boolean> = async () => true): () => Promise<boolean> {
  let quiet = 0;
  return async () => {
    quiet = (await stackCount(t.alice)) === 0 && (await prompts(t)) === 0 && (await also()) ? quiet + 1 : 0;
    return quiet >= 2;
  };
}

/** The spell named `name` from alice's hand, cast (paid, X set) until it is on the stack. */
const cast = (t: Table, name: string, x?: number) => async () => castCard(t.alice, await offeredCard(t.alice, name, { zone: 'hand' }), x === undefined ? {} : { x });

function judge(reports: SeatReport[]): void {
  if (BUDGET === null) return;
  for (const r of reports) {
    expect(r.longestTask, `${r.moment} on ${r.seat}'s screen: the trace names its main thread`).not.toBeNull();
    expect(r.longestTask!.norm, `${r.moment} on ${r.seat}'s screen: the longest main-thread task, CPU ms scaled to hokon`).toBeLessThanOrEqual(BUDGET);
  }
}

for (const [mode, attribute] of [
  ['', true],
  [' (clean)', false],
] as const) {
  test(titled(`perf bench${mode}: worldfire`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-worldfire', async (t) => {
      judge(
        await moment(
          t,
          'worldfire',
          cast(t, 'Worldfire'),
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) === 1 && (await lifeOf(t.alice, 'mine')) === 1),
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: blasphemous`), async ({ browser }) => {
    await sit(browser, attribute, 'w80c-blasphemous', async (t) => {
      const creatures = () => t.alice.locator('[data-zone="battlefield"] [data-board-card]:has(.board-card__pt)').count();
      judge(
        await moment(
          t,
          'blasphemous',
          cast(t, 'Blasphemous Act'),
          settled(t, async () => (await creatures()) === 0),
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: pyroclasm, wrath`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-wipes', async (t) => {
      judge(
        await moment(
          t,
          'pyroclasm',
          cast(t, 'Pyroclasm'),
          settled(t, async () => (await t.alice.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').count()) === 1),
        ),
      );
      const creatures = () => t.alice.locator('[data-zone="battlefield"] [data-board-card]:has(.board-card__pt)').count();
      judge(
        await moment(
          t,
          'wrath',
          cast(t, 'Wrath of God'),
          settled(t, async () => (await creatures()) === 0),
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: storm`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-storm', async (t) => {
      // Five Rites first, unmeasured: the storm count.
      for (let i = 0; i < 5; i++) {
        await castCard(t.alice, await offeredCard(t.alice, 'Rite of Flame', { zone: 'hand' }));
        await expect
          .poll(
            async () => {
              await passOverStack(t.alice);
              await passOverStack(t.bob);
              return stackCount(t.alice);
            },
            { timeout: 30_000, message: `Rite ${i + 1} resolves` },
          )
          .toBe(0);
      }
      const grapeshot = async () => castUntilOnStack(t.alice, t.stack, await offeredCard(t.alice, 'Grapeshot', { zone: 'hand' }), [t.alice.locator('[data-player-face]:not([data-viewer])')]);
      judge(
        await moment(
          t,
          'storm',
          grapeshot,
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) === 14),
          { faceTargets: true },
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: valakut`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf3-valakut', async (t) => {
      judge(
        await moment(
          t,
          'valakut',
          cast(t, 'Splendid Reclamation'),
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) === 10),
          { faceTargets: true },
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: craterhoof, attack12`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-hoof', async (t) => {
      judge(
        await moment(
          t,
          'craterhoof',
          cast(t, 'Craterhoof Behemoth'),
          settled(t, async () => (await t.alice.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').count()) === 0),
        ),
      );
      judge(
        await moment(
          t,
          'attack12',
          async () => {
            await passToDeclareAttackers(t.alice);
            await t.alice.getByTestId('live-attack-all').first().click();
            await t.alice.locator('[data-testid="live-decision-ok"]:enabled').first().click();
          },
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) < 200),
          { pressOk: true },
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: tokens`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-tremors', async (t) => {
      // Six Warriors, each triggering two Impact Tremors (1) and Purphoros (2): 24 to bob.
      judge(
        await moment(
          t,
          'tokens',
          cast(t, 'Secure the Wastes', 6),
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) === 16),
          { x: 6 },
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: gary`), async ({ browser }) => {
    await sit(browser, attribute, 'wperf4-gary', async (t) => {
      judge(
        await moment(
          t,
          'gary',
          cast(t, 'Gray Merchant of Asphodel'),
          settled(t, async () => (await lifeOf(t.alice, 'theirs')) === 3),
        ),
      );
    });
  });

  test(titled(`perf bench${mode}: thopter`), async ({ browser }) => {
    await sit(browser, attribute, 'tf-thopter-sword', async (t) => {
      const page = t.alice;
      await expect
        .poll(() => ownNamed(page, 'Thopter Foundry'), {
          timeout: 60_000,
          message: 'alice has her Thopter Foundry',
        })
        .toHaveLength(1);
      const [foundry] = await ownNamed(page, 'Thopter Foundry');
      /** Pass both seats over whatever is on the stack; never true, so it reads as a step of a poll. */
      const pump = async (): Promise<false> => {
        await passOverStack(t.alice);
        await passOverStack(t.bob);
        return false;
      };
      const lifeIs = (n: number) =>
        expect
          .poll(async () => (await pump()) || lifeOf(page, 'mine'), {
            timeout: 30_000,
            message: `alice at ${n}`,
          })
          .toBe(n);
      const loop = async (first: boolean): Promise<void> => {
        const [sword] = await ownNamed(page, 'Sword of the Meek');
        await expect.poll(async () => (await pump()) || pressOffered(boardCard(page, foundry!)), { timeout: 30_000, message: 'the Foundry is pressed' }).toBe(true);
        const pick = page.locator(`[data-testid="live-selection-host"] li[data-card-id="${sword}"] label`);
        await pick.waitFor({ timeout: 20_000 });
        await pick.click();
        if (first) {
          await expect(page.getByTestId('live-confirm'), 'the Sword asks its "may"').toHaveCount(1, { timeout: 20_000 });
          await page.getByTestId('live-confirm-always').check();
          await page.getByTestId('prompt-confirm-yes').click();
        }
      };
      // The first loop answers the Sword's "may" once; the measured four are the loop as played.
      await loop(true);
      await lifeIs(21);
      let loops = 1;
      judge(
        await moment(
          t,
          'thopter',
          async () => {
            for (; loops < 5; loops++) {
              await loop(false);
              await lifeIs(21 + loops);
            }
          },
          settled(t),
        ),
      );
    });
  });
}
