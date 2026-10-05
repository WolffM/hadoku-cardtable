# Carried over from wave 42: the browser half of Sanctum of Ugin + World Breaker

The real-Forge jar proof landed (`apps/ui/src/play/prompts/sanctum-worldbreaker.jvm.test.ts`, 4/4
green in the manager's run after the priority guard): World Breaker's own target selection, then
Sanctum of Ugin's own "Sacrifice Sanctum of Ugin?" yes/no, both answers.

These three Playwright tests did NOT land. In the manager's two runs (2026-10-05 ~04:00 and ~04:20
UTC), one of them failed each time (once test 7, once test 5); the others passed. Both failure frames
show the same state: `status: Connecting…`, Stack 2 = [Sanctum of Ugin · ability, World Breaker], NO
World Breaker cast trigger on the stack, and Sanctum's "Sacrifice Sanctum of Ugin?" pop-up already up.
So the target selection the test waits for (>= 7 tiles) never showed. Not diagnosed: either Forge
sometimes orders Sanctum's trigger first (the test assumes World Breaker's target first), or the
socket dropped and the resync lost the selection. Start from the server log `openAsks` and a
`CARDTABLE_PLAY_DUMP` of a failing run.

The tests, verbatim from `e2e/prompts-offboard.spec.ts` as written by lane P (they use that file's
`castAndReachTheSelection` and `selectionTiles` helpers):

```ts
/* ── W18+W16: Sanctum of Ugin and World Breaker are ONE event ──────────── */

test(titled('W18+W16 — casting World Breaker with Sanctum of Ugin in play: the target pop-up shows World Breaker’s own text, never Sanctum’s'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-sanctum-worldbreaker');
    void bob;

    const worldBreaker = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'World Breaker' });
    const cardId = Number(await worldBreaker.first().getAttribute('data-board-card'));
    // Seven lands (Sanctum of Ugin included — it IS a land) are all legal
    // targets for World Breaker's own "exile target …" trigger.
    await castAndReachTheSelection(alice.page, cardId, 7);
    await expect(selectionTiles(alice.page)).toHaveCount(7);

    const dialog = alice.page.getByRole('dialog', { name: /exile target artifact, enchantment, or land/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText(/Sacrifice Sanctum/);
  } finally {
    await stack.stop();
  }
});

test(titled('W18+W16 — after picking World Breaker’s own target, Sanctum of Ugin’s OWN Yes/No pop-up appears next, and both answers work'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-sanctum-worldbreaker');
    void bob;

    const worldBreaker = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'World Breaker' });
    const cardId = Number(await worldBreaker.first().getAttribute('data-board-card'));
    await castAndReachTheSelection(alice.page, cardId, 7);

    // Target a Mountain, not Sanctum of Ugin itself — Sanctum IS a legal
    // target for World Breaker's own trigger (it is a land), and exiling it
    // THAT way would make Sanctum's own separate Yes/No untestable (it
    // would already be gone regardless of the answer below).
    const tiles = selectionTiles(alice.page);
    const mountain = alice.page.getByTestId('prompt-cards').locator('li', { hasText: 'Mountain' }).getByTestId('prompt-choice');
    await (((await mountain.count()) > 0 ? mountain : tiles).first()).click({ force: true });

    const confirm = alice.page.getByTestId('live-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await expect(confirm).toContainText('Sacrifice Sanctum of Ugin?');
    await expect(confirm).not.toContainText(/World Breaker/);

    await confirm.getByTestId('prompt-confirm-no').click();
    await expect.poll(() => says(alice.page), { timeout: 20_000 }).toMatch(/Stack: Empty/);
    await expect(alice.page.locator('[data-board-card]', { hasText: 'Sanctum of Ugin' })).toHaveCount(1);
  } finally {
    await stack.stop();
  }
});

test(titled('W18+W16 — answering Yes to Sanctum of Ugin’s own question sacrifices it and searches the library'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w42-sanctum-worldbreaker');
    void bob;

    const worldBreaker = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'World Breaker' });
    const cardId = Number(await worldBreaker.first().getAttribute('data-board-card'));
    await castAndReachTheSelection(alice.page, cardId, 7);

    const tiles = selectionTiles(alice.page);
    const mountain = alice.page.getByTestId('prompt-cards').locator('li', { hasText: 'Mountain' }).getByTestId('prompt-choice');
    await (((await mountain.count()) > 0 ? mountain : tiles).first()).click({ force: true });

    const confirm = alice.page.getByTestId('live-confirm');
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    await confirm.getByTestId('prompt-confirm-yes').click();

    // Sacrificing resolves into the library search (`chooseSingleEntityForEffect`
    // or `chooseEntitiesForEffect`, already-handled asks) — `answerPrompt`
    // takes its own default (the first choosable card) each poll.
    await expect
      .poll(
        async () => {
          await answerPrompt(alice.page);
          return alice.page.locator('[data-board-card]', { hasText: 'Sanctum of Ugin' }).count();
        },
        { timeout: 20_000 },
      )
      .toBe(0);
  } finally {
    await stack.stop();
  }
});
```
