/**
 * Every instance of a life change lands whole, against real Forge, on both screens, paced.
 *
 * The operator, 2026-11-01: *"health loss/gain animation should happen in chunks not counting down.
 * individual instances of health gain or loss should land as a full instance rather than counting the
 * life total down."* `live/numbers.ts`'s `lifeChunks` splits a change into its instances and the counter
 * lands each one at once; this spec watches every value the life counters show, from a MutationObserver
 * on each page, through `wlife-chunks`: a Lightning Bolt at bob (−3), a Sovereign's Bite (bob −3, alice
 * +3), and an attack by Vampire Nighthawk (2, lifelink), Grizzly Bears (2) and Hill Giant (3). No
 * instance here is worth a single point, so a counter that ever moves by one is counting down. The three
 * blows land as separate chunks: bob's counter shows a value between 14 and 7 on the way.
 *
 * Fast Mode off on both seats (as the operator plays): Fast Mode lands every instance in one frame.
 * `[wlife]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { lifeSeen, playLifeChunks, watchLife } from './play/life-chunks.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(
  titled('each burn, drain, blow and lifelink gain lands on the life counter whole, on both screens, never counted down'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'wlife-chunks');
      const { alice, bob } = seated;
      await turnFastModeOff(alice.page, stack, 0);
      await turnFastModeOff(bob.page, stack, 1);
      await Promise.all([watchLife(alice.page), watchLife(bob.page)]);

      await playLifeChunks(seated, stack);
      // The last blow's number and punch play out; nothing more may move.
      await alice.page.waitForTimeout(1_500);

      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const seen = await lifeSeen(page);
        console.log(`[wlife] ${who} ${JSON.stringify(seen)}`);
        const sequences = Object.values(seen).map((values) => values.map(Number));
        const bobs = sequences.find((s) => s[s.length - 1] === 7);
        const alices = sequences.find((s) => s[s.length - 1] === 25);
        expect(bobs, `${who}: bob's counter ends on 7`).toBeDefined();
        expect(alices, `${who}: alice's counter ends on 25`).toBeDefined();
        for (const [whose, values] of [['bob', bobs!], ['alice', alices!]] as const) {
          const steps = values.slice(1).map((v, i) => v - values[i]!);
          expect(steps.filter((d) => Math.abs(d) < 2), `${who}: ${whose}'s counter never moves by a single point (${values.join(' → ')})`).toEqual([]);
        }
        expect(bobs!.filter((v) => v < 14 && v > 7), `${who}: the blows land one by one, not as one jump of 7 (${bobs!.join(' → ')})`).not.toEqual([]);
        expect(alices, `${who}: alice gains the drain, then the lifelink, each whole`).toEqual([20, 23, 25]);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
