/**
 * Floating combat numbers, against real Forge.
 *
 * The operator: *"we are gonna need some animation and floating combat
 * numbers for when players take damage and gain health."* `live/numbers.ts`
 * diffs the board's own view and draws the number; this spec proves it does
 * so from a REAL match, on both screens at once, from the two scenarios this
 * directory already has that fit: `bolt-player` (a player losing life to a
 * direct hit) and `w54-b-two-blockers` (a blocked attacker's damage, which
 * survives: a creature's hit is an impact with no number since 2026-10-15; the damage
 * that stays is the badge's own, proven in `w70-damage-pt.spec.ts`).
 *
 * A life-GAIN proof (a "Healing Salve spawns +3" case) has no scenario to
 * drive it from: every `.state` file in `scenarios/` was grepped for a hand
 * containing any life-gain card, and none exists. This file does not own a
 * scenario file, so that case is proven only in `numbers.test.ts` (jsdom,
 * the `lifeColour`/`formatDelta` pure functions and `installNumbers`'s DOM
 * output) — see the closing report for the scenario content a manager could
 * add to close this gap.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, clickHandCard, enabledOk, grindPriority, makeTitled, says, stackCount } from './play/board.ts';
import { assignBlock, attackingCards, ownBattlefieldCards, passDeclareAttackers, phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The one floating number currently drawn, if any — text, colour and its own box, read in one pass. */
async function currentNumber(page: Page): Promise<{ text: string; colour: string | null; box: { x: number; y: number } } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.board-number');
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { text: el.textContent ?? '', colour: el.getAttribute('data-number-colour'), box: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
  });
}

/** A card's P/T badge text and damage mark, read in one pass. */
async function badgeOf(page: Page, cardId: number): Promise<{ text: string; damage: string | null } | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-card-id="${id}"] > .board-card__pt`);
    return el === null ? null : { text: el.textContent ?? '', damage: el.getAttribute('data-damage') };
  }, cardId);
}

/** The hand card of this name that Forge offers, by id — the pattern every scenario-driven spec in this directory uses. */
async function offeredNamed(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]')
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is offered` },
    )
    .not.toBeUndefined();
  return id!;
}

test(
  titled('a Lightning Bolt to the face spawns -3 at the opponent’s face on BOTH screens, in the danger colour'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'bolt-player');
      const { alice, bob } = seated;
      const opponentFace = alice.page.locator('[data-player-face]:not([data-viewer])');
      const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
      const lifeBefore = Number((await bobLife.textContent()) ?? 'NaN');
      expect(lifeBefore, 'bob’s life is readable before the cast').not.toBeNaN();

      // Full control (`w51-control-box.spec.ts`'s own proven route through this exact scenario):
      // without it the server auto-passes priority on its own schedule, which can race a target
      // click; full control holds alice's priority so every step here is driven by this spec,
      // never the auto-pass policy.
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

      const bolt = await offeredNamed(alice.page, 'Lightning Bolt');
      await clickHandCard(alice.page, bolt);

      // Drain whatever Forge asks next — the ability choice, the target, the payment — until
      // the bolt is on the stack (T6: `board.ts`'s own `castUntilOnStack`, the loop
      // `w51-control-box.spec.ts` already proved against this same scenario, under full control).
      await castUntilOnStack(alice.page, stack, async () => {
        const ready = (await opponentFace.getAttribute('data-selectable')) === 'true';
        if (ready) await opponentFace.click();
        return ready;
      });
      expect(await stackCount(alice.page), 'the bolt is on the stack, aimed at bob').toBe(1);

      // Watch BOTH screens for the number BEFORE resolving, so neither poll starts late and
      // misses the one window (`RISE_MS` is 700ms, short next to a network round trip).
      // `expect.poll(...)` itself resolves to `undefined` on success — the matcher proves the
      // number arrived, but the VALUE has to be captured from inside the polled function, the
      // last time it saw something, or there is nothing left to read the text and colour off.
      type NumberInfo = { text: string; colour: string | null; box: { x: number; y: number } };
      const seenOn = async (page: Page): Promise<NumberInfo> => {
        let captured: NumberInfo | null = null;
        await expect
          .poll(
            async () => {
              const n = await currentNumber(page);
              if (n !== null) captured = n;
              return n !== null;
            },
            { timeout: 20_000, intervals: [30], message: 'the floating number appears' },
          )
          .toBe(true);
        return captured!;
      };
      const aliceWatch = seenOn(alice.page);
      const bobWatch = seenOn(bob.page);

      await alice.page.getByTestId('live-decision-ok').click().catch(() => undefined); // if Forge's own OK is in the pop-up
      // Nobody can respond: it resolves on its own either way, but a stray full-control stop
      // still gets an OK if one shows up on bob's side.
      const resolvedBy = Date.now() + 15_000;
      while ((await stackCount(alice.page)) > 0 && Date.now() < resolvedBy) {
        if ((await bob.page.getByTestId('live-decision-ok').count()) > 0) await bob.page.getByTestId('live-decision-ok').click();
        await alice.page.waitForTimeout(40);
      }

      const [onAlice, onBob] = await Promise.all([aliceWatch, bobWatch]);
      console.log(`W56-N-EVIDENCE ${JSON.stringify({ step: 'bolt', onAlice, onBob })}`);
      for (const [who, n] of [['alice', onAlice], ['bob', onBob]] as const) {
        expect(n!.text, `${who}: the number reads -3`).toBe('-3');
        expect(n!.colour, `${who}: the danger colour`).toBe('danger');
      }
      // Alice sees it over bob's face; bob sees it over his OWN face — the same anchor, mirrored.
      const aliceFaceBox = (await opponentFace.boundingBox())!;
      expect(Math.hypot(onAlice!.box.x - (aliceFaceBox.x + aliceFaceBox.width / 2), onAlice!.box.y - (aliceFaceBox.y + aliceFaceBox.height / 2)), 'alice: the number is at bob’s face, not somewhere else on the board').toBeLessThan(120);

      await expect(bobLife, 'and the hit actually landed').toHaveText(String(lifeBefore - 3), { timeout: 15_000 });
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

test(
  titled('a blocked attacker’s damage — surviving — slams into the blocker as an impact, with no number on the creature'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      // bob (ai, seat 1) already attacks alice with two Memnites; alice holds two Wall of Stone
      // (0/8, Defender) — the same scenario, and the same route to Combat Damage Step,
      // `w54-blockers.spec.ts` already proved the blocker/arrow claim against.
      seated = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
      const { alice, bob } = seated;

      const attackerIds = (
        await attackingCards(alice.page).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))
      ).sort((a, b) => a - b);
      const blockerIds = (
        await ownBattlefieldCards(alice.page).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))
      ).sort((a, b) => a - b);
      expect(attackerIds, 'two attackers declared').toHaveLength(2);
      expect(blockerIds, 'two blockers on alice’s battlefield').toHaveLength(2);
      const [attackerA] = attackerIds as [number, number];
      const [blockerX] = blockerIds as [number, number];

      await passDeclareAttackers(bob.page);
      await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'the block window is open' }).toMatch(/select creatures to block/i);
      await assignBlock(alice.page, blockerX, attackerA);
      await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'X is marked blocking').toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });

      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
      await enabledOk(alice.page).click(); // "Done blocking"
      await expect.poll(() => enabledOk(alice.page).count(), { timeout: 10_000, message: 'alice’s own priority opens, held by full control' }).toBeGreaterThan(0);

      // Start watching BEFORE passing the held priority, so the window combat damage opens in
      // (a turn-based action, no priority stop of its own) is not missed. `expect.poll` itself
      // resolves to `undefined`, so the value is captured from inside the polled function.
      // A creature's hit is the impact alone, no number (the operator, 2026-10-15: "we dont have to show a
      // number, just the impact would be fine"); combat damage has no projectile, only the slam.
      type ImpactInfo = { key: string; box: { x: number; y: number }; numbers: { text: string; x: number; y: number }[] };
      let captured: ImpactInfo | null = null;
      const watch = expect
        .poll(
          async () => {
            const n = await alice.page.evaluate(() => {
              const el = document.querySelector<HTMLElement>('.effect-impact');
              if (el === null) return null;
              const r = el.getBoundingClientRect();
              // Every floating number on the board: the unblocked attacker's hit on alice's life is one of them, rightly.
              const numbers = Array.from(document.querySelectorAll('.board-number')).map((n) => {
                const b = n.getBoundingClientRect();
                return { text: n.textContent ?? '', x: b.x + b.width / 2, y: b.y + b.height / 2 };
              });
              return { key: el.dataset.impact ?? '', box: { x: r.x, y: r.y }, numbers };
            });
            if (n !== null) captured = n;
            return n !== null;
          },
          { timeout: 15_000, intervals: [30], message: 'the impact lands on the blocker' },
        )
        .toBe(true);
      await enabledOk(alice.page).click();

      await expect
        .poll(async () => (await phaseOf(alice.page))?.phase ?? '', { timeout: 15_000, message: 'held at Combat Damage Step' })
        .toBe('COMBAT_DAMAGE');
      await watch;
      const impact: ImpactInfo | null = captured;
      console.log(`W56-N-EVIDENCE ${JSON.stringify({ step: 'blocked-damage', impact })}`);
      expect(impact!.key, 'Forge’s own hit, on Wall of Stone').toMatch(new RegExp(`^card:${blockerX}:`));
      await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'the blocker survived — the damage-stays case, not the dying one').toHaveCount(1);
      const blockerBox = (await alice.page.locator(`[data-board-card="${blockerX}"]`).boundingBox())!;
      const onBlocker = impact!.numbers.filter(
        (n) => n.x >= blockerBox.x && n.x <= blockerBox.x + blockerBox.width && n.y >= blockerBox.y && n.y <= blockerBox.y + blockerBox.height,
      );
      expect(onBlocker, 'no number on the creature: the impact is the hit').toEqual([]);
      expect(
        Math.hypot(impact!.box.x - (blockerBox.x + blockerBox.width / 2), impact!.box.y - (blockerBox.y + blockerBox.height / 2)),
        'on the blocker, not somewhere else on the board',
      ).toBeLessThan(150);

      // The damage stays on the creature, on its own badge: Wall of Stone's 0/8 reads 0/7.
      const damaged = await badgeOf(alice.page, blockerX);
      console.log(`W56-N-EVIDENCE ${JSON.stringify({ step: 'badge-damaged', damaged })}`);
      expect(damaged, 'the badge holds the damage: what is left of the toughness').toEqual({ text: '0/7', damage: '1' });

      // Keep passing alice's own held priority (full control holds every stop) forward through
      // end of combat, main 2 and the end step, until the turn's cleanup wipes the damage off —
      // a turn-based action, never a priority stop of its own, so what this waits for is the
      // badge's own damage mark going away, not a named phase. T6: `board.ts`'s own `grindPriority`.
      await grindPriority([alice.page, bob.page], async () => (await badgeOf(alice.page, blockerX))?.damage === null, {
        intervalMs: 60,
      });
      const afterCleanup = await badgeOf(alice.page, blockerX);
      console.log(`W56-N-EVIDENCE ${JSON.stringify({ step: 'badge-after-cleanup', afterCleanup })}`);
      expect(afterCleanup, 'cleanup wiped the damage off: a plain 0/8').toEqual({ text: '0/8', damage: null });
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
