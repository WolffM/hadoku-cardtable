/**
 * The operator, 2026-10-23 (match m-90a27550a092): cast Charge of the Mites at the
 * AI's warded Brutal Cathar, had no mana left, the server auto-cancelled the ward
 * payment (correct — Forge said unpayable) and Forge countered the spell. *"i
 * understand why that got auto-skipped but i would have liked to at least see an
 * animation for what happened. everything happened too fast there."*
 *
 * `scenario-ward-defined-counter.jvm.test.ts` is the wire-level proof: ward's own
 * trigger counters by a Forge `Defined$` reference, never a target, and
 * `PlayBridge.stackTargetOf` had no branch for that shape, so `stackTargetSpells`
 * never named the pairing — `live/placed.ts`'s countered beat
 * (`data-placed-countered`, `w67-counter.spec.ts`'s own `MARKS`) never fired for a
 * ward counter. This is the browser-level twin: `ward-defined-counter.state` is
 * `auto-target.state` (Doom Blade, mandatory, single legal target) with Ward {1}
 * on the lone creature, and alice has exactly {1}{B} — nothing left for ward's
 * {1}. `drag.spec.ts`'s own gesture for that scenario (drag onto the battlefield,
 * click the one legal creature) casts it here too.
 *
 * Full control is ON for alice (as `w49-counterspell.spec.ts`/`w67-counter.spec.ts`
 * do for whichever seat needs a window to observe the arc): with it off, ward's
 * unpayable {1} auto-cancels under `decideCancel`'s policy and the whole cast→
 * trigger→counter→graveyard arc runs in ONE synchronous Forge burst with no
 * priority stop anywhere in it — measured against the real claws (runs
 * 39992188518, 39996981297, repeatable both times): the browser's socket drops
 * mid-burst (`LiveBoard`'s `Reconnecting…`, `match.connected` false) and the
 * resync that follows wipes `placed.ts`'s transient stack-item bookkeeping before
 * it can ever draw the pairing, so Doom Blade departs as a bare "leaving" with no
 * "resolving"/"countered" mark at all — the operator's "too fast", still open,
 * NOT fixed by this change (see the lane report; this is a transport/pacing
 * question, not the wire fact `stackTargetOf` was missing). With full control on,
 * `FULL_CONTROL_POLICY.unpayableCost` is `'ask'`, not `'cancel'`: Forge's own Pay/
 * Cancel window is shown to alice rather than pressed for her, which holds the
 * arc at a real priority stop and is what proves the fixed wire fact actually
 * draws the countered beat in a real browser.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickOnce, dragHandCard, makeTitled, offered, pressOffered, resizeWindow, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Mark = { t: number; mark: string };

const MARKS = ['data-placed-resolving', 'data-placed-countered', 'data-placed-leaving'];

/** Every mark Doom Blade's own placed element gets, and when it goes, on `page`. */
async function watchDoomBladeMarks(page: Page): Promise<void> {
  await page.evaluate((marks) => {
    const t0 = performance.now();
    const seen: { t: number; mark: string }[] = [];
    (window as unknown as { __wardMarks: () => typeof seen }).__wardMarks = () => seen;
    const isDoomBlade = (el: Element): boolean => /Doom Blade/.test(el.getAttribute('aria-label') ?? '');
    const tracked = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll('[data-placed-spell]'))) if (isDoomBlade(el)) tracked.add(el);
    new MutationObserver((records) => {
      const t = Math.round(performance.now() - t0);
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element && (tracked.has(r.target) || isDoomBlade(r.target)) && r.target.hasAttribute(r.attributeName!)) {
          tracked.add(r.target);
          seen.push({ t, mark: r.attributeName!.replace('data-placed-', '') });
        }
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof Element && isDoomBlade(n)) tracked.add(n);
        }
        for (const n of Array.from(r.removedNodes)) {
          if (n instanceof Element && tracked.has(n)) seen.push({ t, mark: 'gone' });
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: marks });
  }, MARKS);
}

const doomBladeMarks = (page: Page): Promise<Mark[]> => page.evaluate(() => (window as unknown as { __wardMarks: () => Mark[] }).__wardMarks());

test(
  titled('ward counters a mandatory single-target spell by a Defined reference — the countered beat still plays, never a bare vanish'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'ward-defined-counter');
      void bob;
      await resizeWindow(alice.page, { width: 1600, height: 1000 });

      // Full control: a real priority stop over the burst, not the policy auto-
      // cancelling ward's unpayable cost before this test (or a human) ever sees
      // anything (module header).
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'alice is offered Doom Blade' }).not.toEqual([]);
      const blade = (await offered(alice.page))[0]!;
      const armadillo = alice.page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
      await expect(armadillo, "bob's warded Armored Armadillo is on his battlefield").toHaveCount(1);

      await watchDoomBladeMarks(alice.page);

      // Released over alice's own battlefield: a targeted card, so anywhere
      // outside the hand is a legal park spot (`drag.spec.ts`'s own pattern for
      // this exact scenario shape).
      const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
      const armed = await dragHandCard(alice.page, blade, { x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 });
      expect(armed, 'the press armed the Arena gesture').toBe(true);

      await expect.poll(() => says(alice.page), { timeout: 10_000, message: 'the cast reached Forge: it opened a targeting ask' }).toMatch(/Doom Blade.*target/is);
      await expect(armadillo, "Forge's ask offers Armored Armadillo").toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
      expect(await pressOffered(armadillo.first()), 'Armored Armadillo pressed as the target').toBe(true);

      // Mana for Doom Blade itself ({1}{B}, two Swamps) is still unambiguous and
      // paid for her; her own priority with Doom Blade (and then the ward
      // trigger) on the stack is held by full control, and ward's unpayable {1}
      // is Forge's own Pay/Cancel — Pay dead, Cancel the only live answer — shown
      // to her rather than pressed by the server.
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (/^Priority:/.test(text)) await clickOnce(alice.page, text, 'ok');
            if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'cancel');
            return !(await armadillo.count()) ? 'armadillo-gone' : (await alice.page.locator('[data-placed-spell]').count()) === 0 ? 'settled' : null;
          },
          { timeout: 20_000, message: 'the ward arc settles — Armored Armadillo survives, the stack empties' },
        )
        .toBe('settled');

      await expect(armadillo, 'Armored Armadillo took no damage — Doom Blade never resolved').toHaveCount(1);

      const marks = await doomBladeMarks(alice.page);
      console.log(`[ward-defined-counter] alice: ${marks.map((m) => `${m.t}ms ${m.mark}`).join(' → ')}`);
      const first = (mark: string): number | undefined => marks.find((m) => m.mark === mark)?.t;
      expect(first('countered'), 'Doom Blade got the countered beat — never a bare vanish').not.toBeUndefined();
      expect(first('gone')!, 'Doom Blade’s element is removed only after the countered mark, never before').toBeGreaterThanOrEqual(first('countered')!);
    } finally {
      await stack.stop();
    }
  },
);
