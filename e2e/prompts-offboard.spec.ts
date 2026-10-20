/**
 * Wave 42 §P — W18 (the soft-lock) and W16 (World Breaker's never-explained
 * choice), in a real browser.
 *
 * **Can only pass once lane L mounts `SelectionPrompt` in `LiveBoard.tsx`**
 * (`docs/planning/wave42-evidence/P-contract.md`) — this lane's own files
 * build the component and prove the WIRE shapes against real Forge directly
 * (`apps/ui/src/play/prompts/offboard.jvm.test.ts`, `worldbreaker.jvm.test.ts`,
 * `sanctum-worldbreaker.jvm.test.ts`), never through a browser. This spec is
 * the other half: that a real person, in a real browser, sees the pop-up and
 * can click it. It asserts against `SelectionPrompt`'s OWN test ids
 * (`prompt-cards`/`prompt-choice`/`selection-cancel`/`selection-done`), not
 * against any particular host wrapper L chooses, so it does not need to
 * guess L's own markup.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, enabledOk, makeTitled, says, stackCount } from './play/board.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Every tile the open selection picker is drawing right now. */
const selectionTiles = (page: Page) => page.getByTestId('prompt-cards').getByTestId('prompt-choice');

/**
 * Press OK while Forge waits on a mana payment. Checking OK and clicking it are two steps, and an auto-paid
 * cost disables OK between them: in CI run 37384138984 the click then waited its full 20 s on a dead button
 * and starved the surrounding poll, though the game had already reached the next prompt. A short click
 * budget hands control back to the poll; only that timeout is tolerated, any other error still fails.
 */
async function pressOkIfEnabled(page: Page): Promise<void> {
  const ok = enabledOk(page).first();
  if ((await ok.count()) === 0) return;
  try {
    await ok.click({ timeout: 1_500 });
  } catch (e) {
    if (!(e instanceof Error && e.name === 'TimeoutError')) throw e;
  }
}

/**
 * Click a hand card to cast it, then drain everything between the click and
 * the selection this spec cares about: any ask (via `answerPrompt`), and a
 * live mana-payment bar's "Auto" (Kozilek's Return's own cost).
 * `castCard` (`play/board.ts`) only waits for ONE stack change inside a 3s
 * window, which is too tight for a chain this long; this drives the same
 * two steps itself with the budget a multi-trigger scenario needs. Returns
 * once the picker shows at least `atLeast` tiles.
 */
async function castAndReachTheSelection(page: Page, cardId: number, atLeast: number): Promise<void> {
  await clickHandCard(page, cardId);
  await expect
    .poll(
      async () => {
        // Look before acting: once the target picker is up, stop. The says line can still read "Pay Mana
        // Cost" for a frame after payment, and pressing OK then confirms the open target prompt, so the
        // picker vanishes before the caller can read it (seen locally, 1 run in 3, after the click fix).
        const tiles = await selectionTiles(page).count();
        if (tiles >= atLeast) return tiles;
        await answerPrompt(page);
        if (/Pay Mana Cost/i.test(await says(page))) await pressOkIfEnabled(page);
        return tiles;
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(atLeast);
}

/**
 * After the target is picked, pay what Forge asks — Kozilek's Return's own cost is already paid,
 * `TrigReturn`'s `{B}` is paid — and decline the `{X}` payment with Forge's own Cancel: a trigger
 * with a cost is declined by not paying it (`PlayerControllerHuman.confirmTrigger`). Returns once
 * the stack is empty and nothing is being asked, read off the board.
 */
async function declineTheXPayment(page: Page): Promise<void> {
  let declined = false;
  await expect
    .poll(
      async () => {
        await answerPrompt(page);
        const text = await says(page);
        if (/Pay Mana Cost/i.test(text)) {
          const cancel = page.getByTestId('live-payment-cancel');
          // `live-says` spells `{B}` as `B` (`plainRulesText`).
          if (!declined && !/Pay Mana Cost:\s*B\b/.test(text) && (await cancel.isEnabled().catch(() => false))) {
            await cancel.click({ timeout: 1_500 });
            declined = true;
          } else await pressOkIfEnabled(page);
        } else if (/^Priority:/.test(text) && !/Stack: Empty/.test(text)) await pressOkIfEnabled(page);
        if ((await page.getByTestId('live-prompt').count()) > 0 || (await stackCount(page)) !== 0) return false;
        return declined;
      },
      { timeout: 30_000, intervals: [150] },
    )
    .toBe(true);
}

test.describe.configure({ mode: 'serial' });

/* ── W18: Relentless Dead's graveyard target ─────────────────────────── */

test(titled('W18 — Relentless Dead’s graveyard target reaches the seat as a clickable off-board picker, and picking one returns it to the battlefield'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-relentless-dead');
    void bob;

    const kozileksReturn = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: "Kozilek's Return" });
    const cardId = Number(await kozileksReturn.first().getAttribute('data-board-card'));
    // Two graveyard cards, neither on a battlefield — the soft-lock's shape.
    await castAndReachTheSelection(alice.page, cardId, 2);
    const tiles = selectionTiles(alice.page);
    await expect(tiles).toHaveCount(2);

    const chosenId = await tiles.first().getAttribute('data-card-id');
    await tiles.first().click({ force: true });

    await expect.poll(() => alice.page.locator(`[data-board-card="${chosenId}"]`).count(), { timeout: 20_000 }).toBeGreaterThan(0);
  } finally {
    await stack.stop();
  }
});

test(titled('W18 — Relentless Dead’s graveyard target is mandatory (two legal Zombies, min 1): the SelectionPrompt popup draws no Cancel, matching Forge’s own disabled bar'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-relentless-dead');
    void bob;

    const kozileksReturn = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: "Kozilek's Return" });
    const cardId = Number(await kozileksReturn.first().getAttribute('data-board-card'));
    await castAndReachTheSelection(alice.page, cardId, 2);

    // Measured against the real jar (`offboard.jvm.test.ts`): with a legal
    // target available, Forge's own bar has `enable2: false` here — the
    // targeting step itself offers no decline, only picking one of the two
    // (`SelectionPrompt` never draws a button Forge has not enabled, the
    // same rule `done`/`cancel` follow everywhere else). The REAL "you may
    // pay {X}" decline is the payment AFTER it — see the next test.
    await expect(alice.page.getByTestId('selection-cancel')).toHaveCount(0);
    await expect(alice.page.getByTestId('selection-done')).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(titled('W18 — the real "you may pay {X}" decision is the payment after the target: declining it with Cancel leaves both graveyard cards untouched with no lock'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-relentless-dead');
    void bob;

    const kozileksReturn = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: "Kozilek's Return" });
    const cardId = Number(await kozileksReturn.first().getAttribute('data-board-card'));
    // `relentless_dead.txt`'s second trigger costs `{X}`, X the chosen target's mana value: the
    // target is picked first, and the payment that follows is where the seat says no.
    await castAndReachTheSelection(alice.page, cardId, 2);
    await selectionTiles(alice.page).first().click({ force: true });
    await declineTheXPayment(alice.page);

    await expect(alice.page.getByTestId('prompt-cards')).toHaveCount(0);
    const graveyard = alice.page.locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]');
    await expect(graveyard.filter({ hasText: 'Diregraf Ghoul' })).toHaveCount(1);
    await expect(graveyard.filter({ hasText: 'Dread Wanderer' })).toHaveCount(1);
    // Priority genuinely returns — no lock.
    await expect(enabledOk(alice.page)).toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

/* ── W16: World Breaker's never-explained choice ─────────────────────── */

test(titled('W16 — World Breaker’s cast trigger shows Forge’s own prompt text in a pop-up, not just the collapsed log'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-worldbreaker');
    void bob;

    const worldBreaker = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'World Breaker' });
    const cardId = Number(await worldBreaker.first().getAttribute('data-board-card'));
    // 8 lands on the table — every one already a battlefield permanent
    // ('on-board'), so the board's own highlight also offers each of them;
    // the pop-up is the thing that was missing, not the click.
    await castAndReachTheSelection(alice.page, cardId, 8);
    await expect(selectionTiles(alice.page)).toHaveCount(8);

    // The pop-up asks the decision, and the trigger's own words — drawn
    // nowhere before this wave except the collapsed log — are the line under
    // it (the operator, 2026-10-19, AF193: "ideally the text here is just for
    // the decision that has to be made … if we have to show both can we put a
    // line break between the effect and what is actually being asked?"; a
    // target keeps the effect). None of the trigger objects Forge appends to
    // a trigger's text (the operator, 2026-10-16, AF100: "this text seems
    // useless").
    const sheet = alice.page.getByRole('dialog', { name: /^Select target artifact, enchantment or land/i });
    await expect(sheet).toBeVisible();
    const effect = sheet.getByTestId('prompt-source-text');
    await expect(effect).toHaveText(/^When you cast this spell, exile target artifact, enchantment, or land\.$/);
  } finally {
    await stack.stop();
  }
});
