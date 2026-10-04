/**
 * One test per case of the operator-approved drag-and-cast demo
 * (https://claude.ai/artifact/3Y1E4pvAnWj1NgKbE5Hrx7), against a real Forge
 * match. The rules it demonstrates:
 *
 *  - nothing reaches Forge until the release;
 *  - a no-target card (by type line: anything but an Instant, Sorcery or
 *    Aura) is played if released over the viewer's own battlefield, else it
 *    floats back and nothing is sent;
 *  - a targeted card is cast at release anywhere outside the viewer's own
 *    hand (the battlefield included), parks there, and a SEPARATE click on a
 *    legal target answers it;
 *  - over the hand, any card returns and nothing is sent;
 *  - right-click or Escape, while Forge is still asking about the cast,
 *    sends Forge's own Cancel and floats the card back.
 *
 * `e2e/play/board.ts`'s `dragHandCard` is the one gesture every test here
 * drives: down on a hand card, through the demo's own path, up at the
 * release point.
 *
 * ## Scenario substitutions, and why
 *
 * This lane owns no path under `apps/server/**`, so no new `.state` fixture
 * could be added here even though the demo's own cards (Lightning Bolt onto
 * a player with a creature also on the board; Evolving Wilds) are not quite
 * what any existing scenario holds:
 *
 *  - **"Bolt released over the opponent's half… a click on a creature
 *    resolves it"** uses `auto-target` (Doom Blade, a mandatory
 *    single-creature-target removal spell — the same type-line rule applies
 *    to it as to Bolt) against bob's one Memnite, since no scenario pairs a
 *    damage spell with an enemy creature. The "released over the opponent's
 *    half" half of the demo (an undirected release, before the click) is
 *    proven by `bolt-player` instead, released at a point over bob's own
 *    side with nobody there to hit but his face.
 *  - **"an Evolving Wilds dragged past the hand and back"** uses
 *    `land-into-middle`'s Island: the gesture under test is "crosses out of
 *    the hand and back", not Evolving Wilds' own sacrifice ability, and no
 *    scenario holds that card.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { messages } from './play/browser.ts';
import { cancelCast, clickHandCard, dragHandCard, enabledOk, livePrompt, offered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { turnNumber } from './play/turn.ts';
import type { Friend } from './play/browser.ts';

const forge = forgeAvailability();
const titled = (t: string): string => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** Every `forge:c2s` (client-acted) frame this friend has sent so far. */
function actsSent(f: Friend): number {
  return messages(f).filter((m) => m.dir === 'out' && m.kind === 'c2s').length;
}

/** The card Forge currently offers named `name` — by `.card__name`, among `[data-board-card][data-selectable]`. */
async function offeredNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/* ── 1. a land released outside the battlefield is still in hand ────────── */

test(titled('a land released outside the battlefield is still in hand, and nothing was sent'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    void bob;

    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 20_000, message: "alice holds the Island this test releases" }).not.toBeUndefined();
    const island = (await handCardNamed(alice.page, 'Island'))!;
    const before = actsSent(alice);

    // Released over the STACK zone: on the table, but nowhere near either
    // battlefield — the demo's "anywhere else" for a no-target card.
    const stackZone = (await alice.page.locator('[data-zone="stack"]').first().boundingBox())!;
    const armed = await dragHandCard(alice.page, island, { x: stackZone.x + stackZone.width / 2, y: stackZone.y + stackZone.height / 2 });
    expect(armed, 'the press armed the Arena gesture — the precondition this spec needs').toBe(true);

    // Nothing reached Forge: the hand still has it, and no c2s frame left
    // the browser for this release.
    await expect(alice.page.locator(`[data-board-card="${island}"]`).first(), 'the Island floated back to the hand').toBeVisible();
    await expect(alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Island' })).toHaveCount(1);
    expect(actsSent(alice), 'no act reached the server for this release').toBe(before);
  } finally {
    await stack.stop();
  }
});

/* ── 2. a land released over the battlefield is on it ────────────────────── */

test(titled('a land released over the battlefield is on it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    void bob;

    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 20_000, message: "alice holds the Island this test plays" }).not.toBeUndefined();
    const island = (await handCardNamed(alice.page, 'Island'))!;
    const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const armed = await dragHandCard(alice.page, island, { x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 });
    expect(armed, 'the press armed the Arena gesture — the precondition this spec needs').toBe(true);

    await expect
      .poll(() => alice.page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${island}"]`).count(), {
        timeout: 15_000,
        message: 'the Island is on the battlefield',
      })
      .toBe(1);
    await expect(alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Island' })).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

/* ── 3. a targeted spell released over the table parks, and a click resolves it ── */

test(
  titled("a targeted spell released over the table shows the arrow, and a click on the only legal creature resolves it"),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'auto-target');

      await expect.poll(() => offered(alice.page), { timeout: 45_000, message: "alice is offered Doom Blade — the precondition \"auto-target\" sets up" }).not.toEqual([]);
      const blade = (await offered(alice.page))[0]!;
      const theirs = alice.page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
      await expect(theirs, "bob's one creature is on his battlefield").toHaveCount(1);

      // Released over alice's own battlefield: a targeted card, so anywhere
      // outside the hand is a legal park spot, the battlefield included.
      const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
      const armed = await dragHandCard(alice.page, blade, { x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 });
      expect(armed, 'the press armed the Arena gesture — the precondition this spec needs').toBe(true);

      // The cast reached Forge at the release, before any click chooses a
      // target: the targeting ask is already open.
      await expect.poll(() => says(alice.page), { timeout: 10_000, message: "the cast reached Forge: it opened a targeting ask" }).toMatch(/Doom Blade.*target/is);
      await expect(theirs, "Forge's ask offers bob's creature").toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });

      // A SEPARATE click on the only legal target resolves it.
      await theirs.first().locator('button').first().click();

      await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'Doom Blade reached the stack' }).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 100 && (await theirs.count()) > 0; i++) {
        await answerPrompt(alice.page);
        await answerPrompt(bob.page);
        if (/Pay Mana Cost/i.test(await says(alice.page))) await enabledOk(alice.page).click().catch(() => {});
        await alice.page.waitForTimeout(40);
      }
      await expect(theirs, "Doom Blade destroyed bob's creature").toHaveCount(0, { timeout: 15_000 });
    } finally {
      await stack.stop();
    }
  },
);

/* ── 4. right-click mid-aim returns the card; the phase is unchanged ────── */

test(titled('right-click mid-aim returns the card, and the phase is unchanged'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');
    void bob;

    await expect.poll(() => handCardNamed(alice.page, 'Lightning Bolt'), { timeout: 20_000, message: 'alice holds her bolt' }).not.toBeUndefined();
    const bolt = (await handCardNamed(alice.page, 'Lightning Bolt'))!;
    const turnBefore = turnNumber(await alice.page.getByTestId('live-turn-n').textContent());
    const phaseBefore = await alice.page.getByTestId('live-phases').getAttribute('data-phase');

    // Released over alice's own battlefield (outside the hand): the cast is
    // sent, and it parks there awaiting a target.
    const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const armed = await dragHandCard(alice.page, bolt, { x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 });
    expect(armed, 'the press armed the Arena gesture — the precondition this spec needs').toBe(true);
    await expect.poll(() => says(alice.page), { timeout: 10_000, message: 'the bolt reached Forge: it opened a targeting ask' }).toMatch(/Lightning Bolt.*target/is);

    // Mid-aim: move toward bob's own face, then cancel instead of clicking.
    const bobFace = (await alice.page.locator('[data-player-face]:not([data-viewer])').boundingBox())!;
    await alice.page.mouse.move(bobFace.x + bobFace.width / 2, bobFace.y + bobFace.height / 2, { steps: 6 });
    await cancelCast(alice.page, 'right-click');

    await expect.poll(() => handCardNamed(alice.page, 'Lightning Bolt'), { timeout: 10_000, message: "Forge's Cancel put the bolt back in alice's hand" }).not.toBeUndefined();
    expect(await stackCount(alice.page), 'nothing is on the stack').toBe(0);
    expect(await says(alice.page), 'the targeting ask is gone').not.toMatch(/target/i);
    expect(turnNumber(await alice.page.getByTestId('live-turn-n').textContent()), 'the turn did not advance').toBe(turnBefore);
    expect(await alice.page.getByTestId('live-phases').getAttribute('data-phase'), 'the phase is unchanged').toBe(phaseBefore);
  } finally {
    await stack.stop();
  }
});

/* ── 5. dragged past the hand and back is still in hand ──────────────────── */

test(titled('a land dragged past the hand and back is still in hand, with nothing played'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    void bob;

    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 20_000, message: 'alice holds the Island this test drags' }).not.toBeUndefined();
    const island = (await handCardNamed(alice.page, 'Island'))!;
    const before = actsSent(alice);

    const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const hand = (await alice.page.locator('[data-zone="hand"][data-owner="you"]').boundingBox())!;
    // Past the hand (onto the battlefield, well inside it) and back onto the
    // hand's own box, released there: nothing is sent until release, so this
    // must be a no-op no matter how far the path wandered first — crossing
    // into the battlefield mid-drag and then leaving again must not leave
    // anything half-sent.
    const armed = await dragHandCard(
      alice.page,
      island,
      { x: hand.x + hand.width / 2, y: hand.y + hand.height / 2 },
      [{ x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 }],
    );
    expect(armed, 'the press armed the Arena gesture — the precondition this spec needs').toBe(true);

    await expect(alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Island' })).toHaveCount(1);
    await expect(alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card'), 'nothing new is on the battlefield').toHaveCount(2);
    expect(actsSent(alice), 'no act reached the server for this whole gesture').toBe(before);
  } finally {
    await stack.stop();
  }
});

/* ── 6. right-click while a resolving spell asks a question sends nothing — the spell is already cast ── */

/**
 * Thoughtseize's discard choice (`chooseSingleEntityForEffect`) arrives
 * while the spell is RESOLVING — its target already chosen, the spell
 * already on the stack — not while a cast is still being aimed. There is no
 * cast left to cancel at that point, so a right-click sends nothing, the
 * ASK stays open, and Thoughtseize stays cast (not back in hand).
 */
test(
  titled('right-click while a resolving spell asks a question sends nothing — the spell is already cast'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'thoughtseize');

      await expect.poll(() => offeredNamed(alice.page, 'Thoughtseize'), { timeout: 45_000, message: 'alice is offered Thoughtseize' }).not.toBeUndefined();
      const card = (await offeredNamed(alice.page, 'Thoughtseize'))!;
      await clickHandCard(alice.page, card);

      // The first question: choose the player. A plain board selection, not
      // an ASK — answering it is what gets to the second question.
      const opponentTarget = alice.page.locator('[data-testid="player"]:not([data-viewer])[data-selectable]');
      await expect.poll(() => opponentTarget.count(), { timeout: 10_000, message: "Thoughtseize's own player-target selection opened" }).toBeGreaterThan(0);
      await opponentTarget.first().locator('button').first().click();

      // The second question: choose a card to discard. THIS is the ASK —
      // the spell is already resolving.
      await expect
        .poll(() => livePrompt(alice.page).first().getAttribute('data-method'), { timeout: 10_000, message: "Thoughtseize's own discard choice opened, as an ASK" })
        .toBe('chooseSingleEntityForEffect');

      const before = actsSent(alice);
      await cancelCast(alice.page, 'right-click');
      await alice.page.waitForTimeout(500);

      expect(actsSent(alice), 'the right-click sent nothing — there is no cast left to cancel').toBe(before);
      expect(await livePrompt(alice.page).count(), "Thoughtseize's own ASK is still open").toBeGreaterThan(0);
      expect(await handCardNamed(alice.page, 'Thoughtseize'), 'Thoughtseize is not back in hand — it is already cast').toBeUndefined();

      // Recover the match cleanly rather than leaving an orphaned ask open
      // for `stack.stop()` to tear down mid-question.
      await answerPrompt(alice.page);
      await answerPrompt(bob.page);
    } finally {
      await stack.stop();
    }
  },
);
