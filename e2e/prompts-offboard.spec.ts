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
 * the selection this spec cares about: `getAbilityToPlay`'s "play this
 * trigger?" (via `answerPrompt`), as many as Forge sends (Relentless Dead's
 * two dies triggers both go through it), and a live mana-payment bar's
 * "Auto" (Kozilek's Return's own cost, then the first trigger's `{B}`).
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
 * Click a hand card to cast it, answering every `getAbilityToPlay` ask
 * normally (the ability itself, via `prompt-choice`) EXCEPT the one whose
 * own text matches `declineTextMatch` — that one is declined by clicking
 * `GetAbilityToPlayPrompt`'s own existing "None" button (`prompt-cancel`),
 * exactly the real "you may pay {X}" decision (`OptionalDecider$ You` on
 * Relentless Dead's own second trigger — see `offboard.jvm.test.ts`'s
 * header). Also auto-pays any live mana window and passes its own priority
 * while the stack is busy: the caller turns Full control on, because a
 * one-ability offer is otherwise answered by the board itself (`rules.ts`
 * `autoAnswer`) and there would be nothing to decline. Returns once the
 * trigger was declined, the stack is empty and nothing is being asked, read
 * off the board.
 */
async function castAndDeclineTrigger(page: Page, cardId: number, declineTextMatch: RegExp): Promise<void> {
  await clickHandCard(page, cardId);
  let declined = false;
  await expect
    .poll(
      async () => {
        const sheet = page.getByTestId('live-prompt');
        if ((await sheet.count()) > 0 && (await sheet.getAttribute('data-method')) === 'getAbilityToPlay') {
          const choice = sheet.getByTestId('prompt-choice');
          if ((await choice.count()) > 0) {
            const text = (await choice.first().innerText()) ?? '';
            if (declineTextMatch.test(text)) {
              await sheet.getByTestId('prompt-cancel').click();
              declined = true;
            } else await choice.first().click();
          } else {
            await sheet.getByTestId('prompt-cancel').click();
          }
        } else {
          // An ability choice that opens between the two reads is the branch above's, next tick.
          await answerPrompt(page, { leave: ['getAbilityToPlay'] });
        }
        const text = await says(page);
        if (/Pay Mana Cost/i.test(text) || (/^Priority:/.test(text) && !/Stack: Empty/.test(text))) await pressOkIfEnabled(page);
        // Between the two triggers the stack can read 0 while the next one's offer is still open.
        return declined && (await stackCount(page)) === 0 && (await page.getByTestId('live-prompt').count()) === 0;
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
    // pay {X}" decline is a step EARLIER — see the next test.
    await expect(alice.page.getByTestId('selection-cancel')).toHaveCount(0);
    await expect(alice.page.getByTestId('selection-done')).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test(titled('W18 — the real "you may pay {X}" decision is answered by the ability-choice pop-up’s own "None" button, and declining it leaves both graveyard cards untouched with no lock'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-relentless-dead');
    void bob;

    const kozileksReturn = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: "Kozilek's Return" });
    const cardId = Number(await kozileksReturn.first().getAttribute('data-board-card'));
    // `relentless_dead.txt`'s second trigger carries `OptionalDecider$ You`:
    // the decision to even attempt it is the existing `getAbilityToPlay`
    // ask (already-built `GetAbilityToPlayPrompt`, `ChoicePrompts.tsx`),
    // never the later target selection — decline it by its own text. Under
    // Full control, the one mode in which the board draws a one-ability offer.
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    await castAndDeclineTrigger(alice.page, cardId, /another target Zombie/);

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

    // Forge's own words for the trigger, verbatim — not drawn anywhere
    // before this wave except the collapsed log.
    await expect(alice.page.getByRole('dialog', { name: /exile target artifact, enchantment, or land/i })).toBeVisible();
  } finally {
    await stack.stop();
  }
});
