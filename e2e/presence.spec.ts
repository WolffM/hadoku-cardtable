/**
 * Presence (ledger Z5), against real Forge and two real browsers: alice moves
 * her pointer and lifts a card; bob's board shows her cursor with her name, a
 * card back while she holds it, and her arrow while she aims — and never the
 * card itself. The operator: *"we shouldn't reveal the card they want to play,
 * still keep it hidden until they actually commit it to the stack"* and *"we
 * should see the pointer even when they aren't holding a card."*
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { dragHandCard, enabledOk, handCardNamed, makeTitled, offered, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const cursor = (page: Page) => page.locator('[data-board-overlay] .presence');
const back = (page: Page) => page.locator('[data-board-overlay] .presence__back');
const arrow = (page: Page) => page.locator('[data-board-overlay] .presence__arrow');

/**
 * `locator`'s box once it stops moving between two reads 80ms apart — a back
 * gliding into its waiting spot, or a placed card gliding into its column,
 * both do it over a real CSS transition (`presence.css`'s `[data-waiting]`,
 * ~300ms), so a single `boundingBox()` right after the element first appears
 * can read a mid-glide frame instead of where it actually settles.
 */
async function settled(locator: Locator, timeoutMs = 2000): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const deadline = Date.now() + timeoutMs;
  let last: { x: number; y: number; width: number; height: number } | null = null;
  for (;;) {
    const box = await locator.boundingBox();
    if (box !== null && last !== null && Math.abs(box.x - last.x) < 0.5 && Math.abs(box.y - last.y) < 0.5) return box;
    last = box;
    if (Date.now() > deadline) return box;
    await new Promise((r) => setTimeout(r, 80));
  }
}

test(titled('bob sees alice’s pointer, a card back while she holds a card, her arrow while she aims — and never which card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).not.toEqual([]);
    const memnite = (await offered(alice.page))[0]!;
    const name = (await alice.page.locator(`[data-board-card="${memnite}"] .card__name`).first().textContent())?.trim() ?? '';
    expect(name).not.toBe('');

    /* ── her pointer alone, over her own battlefield: on bob's board, over HER (his "them") battlefield ── */
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await alice.page.mouse.move(herField.x + herField.width * 0.3, herField.y + herField.height * 0.5, { steps: 6 });
    await expect(cursor(bob.page), 'bob sees her cursor').toHaveCount(1, { timeout: 10_000 });
    await expect(cursor(bob.page).locator('.presence__name')).toHaveText(/alice/i);
    const theirFieldOnBob = (await bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox())!;
    await expect
      .poll(async () => {
        const c = await cursor(bob.page).boundingBox();
        return c === null ? null : { inX: c.x >= theirFieldOnBob.x && c.x <= theirFieldOnBob.x + theirFieldOnBob.width, inY: c.y >= theirFieldOnBob.y && c.y <= theirFieldOnBob.y + theirFieldOnBob.height };
      }, { timeout: 5_000, message: 'her pointer lands inside her battlefield as bob draws it' })
      .toEqual({ inX: true, inY: true });
    await expect(back(bob.page), 'nothing held yet').toHaveCount(0);

    /* ── she lifts Memnite and carries it over her battlefield: a back under her cursor, not Memnite ── */
    const cardBox = (await alice.page.locator(`[data-board-card="${memnite}"]`).boundingBox())!;
    await alice.page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await alice.page.mouse.down();
    await expect(alice.page.locator(`[data-board-card="${memnite}"]`), 'the press lifted it').toHaveAttribute('data-cast-lift', 'lifted');
    await alice.page.mouse.move(herField.x + herField.width * 0.5, herField.y + herField.height * 0.5, { steps: 10 });
    await expect(back(bob.page), 'bob sees a card back under her cursor').toHaveCount(1, { timeout: 10_000 });
    const bobHtml = await bob.page.locator('[data-board-overlay]').innerHTML();
    expect(bobHtml, 'and nothing in what is drawn for him names the card').not.toContain(name);
    expect(bobHtml).not.toContain(`data-card-id`);

    /* ── she brings it back to her hand and lets go: the back is gone, the card never showed ── */
    const herHand = (await alice.page.locator('.seat[data-viewer] [data-zone="hand"]').boundingBox())!;
    await alice.page.mouse.move(herHand.x + herHand.width / 2, herHand.y + herHand.height / 2, { steps: 10 });
    await alice.page.mouse.up();
    await expect(back(bob.page), 'the back is gone once she let go').toHaveCount(0, { timeout: 10_000 });
    await expect(bob.page.locator('[data-zone="stack"]'), 'and nothing reached the stack').toHaveAttribute('data-count', '0');

    /* ── her pointer leaves the board: the cursor is taken down ── */
    await alice.page.mouse.move(2, 2);
    await expect(cursor(bob.page), 'her cursor goes when she leaves the board').toHaveCount(0, { timeout: 10_000 });
  } finally {
    await stack.stop();
  }
});

/**
 * The operator: *"it's important that the cursor is correctly showing what
 * card is being hovered even if the screen size is vastly different"*
 * (2026-10-08), and *"lets delete the cursor correction logic on card hover
 * and instead try to better determine where an opponents cursor is relative
 * to our board"*, mirrored, *"on the opponents screen the cursor should
 * actually be on the top part of the card"* (2026-10-09). Two very
 * differently shaped screens: her cursor lands on the card she hovers, in the
 * mirrored part of it, and moves continuously onto it — never a snap.
 */
test(titled('her cursor lands on the exact card she hovers, mirrored, and moves onto it without a jump, even when the two screens are very differently shaped'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    await resizeWindow(alice.page, { width: 800, height: 900 });
    await resizeWindow(bob.page, { width: 1600, height: 600 });
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 20_000, message: 'alice has her two starting lands' }).toHaveLength(2);
    const [, second] = await fieldOrder(alice.page, 'you');

    const landBox = (await alice.page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${second}"]`).boundingBox())!;
    const landOnBob = (await bob.page.locator(`.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card[data-card-id="${second}"]`).boundingBox())!;
    const at = async (): Promise<{ x: number; y: number } | null> => {
      const c = await cursor(bob.page).boundingBox();
      return c === null ? null : { x: c.x, y: c.y };
    };
    const settled = async (): Promise<{ x: number; y: number }> => {
      let last = await at();
      for (let i = 0; i < 30; i += 1) {
        await bob.page.waitForTimeout(150);
        const now = await at();
        if (now !== null && last !== null && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5) return now;
        last = now;
      }
      throw new Error('her cursor never settled on bob’s board');
    };

    // Her pointer on the land's bottom text: on bob's board it is the land's TOP part — the seats
    // are mirrored, and so is the card (the operator, 2026-10-09).
    await alice.page.mouse.move(landBox.x + landBox.width * 0.3, landBox.y + landBox.height * 0.8, { steps: 6 });
    await expect(cursor(bob.page), 'bob sees her cursor').toHaveCount(1, { timeout: 10_000 });
    const onText = await settled();
    console.log(`[presence over] cursor=(${onText.x},${onText.y}) land box on bob=(${landOnBob.x},${landOnBob.y},${landOnBob.width},${landOnBob.height})`);
    expect(onText.x >= landOnBob.x && onText.x <= landOnBob.x + landOnBob.width, 'inside the land’s own columns on bob’s board').toBe(true);
    expect(onText.y - landOnBob.y, 'in its top part: 0.8 down hers is 0.2 down his').toBeCloseTo(0.2 * landOnBob.height, -1);

    // A slow sweep from beside the land into it: his cursor moves in proportion, never snaps onto it
    // at the edge (the operator: the old card-anchored correction "is very awkward looking").
    const scale = landOnBob.width / landBox.width;
    const y = landBox.y + landBox.height * 0.5;
    const steps: number[] = [];
    let prev: { x: number; y: number } | null = null;
    for (let x = landBox.x - 24; x <= landBox.x + 24; x += 6) {
      await alice.page.mouse.move(x, y);
      const now = await settled();
      if (prev !== null) steps.push(Math.hypot(now.x - prev.x, now.y - prev.y));
      prev = now;
    }
    console.log(`[presence over] sweep scale=${scale.toFixed(2)} steps=${steps.map((d) => d.toFixed(1)).join(',')}`);
    expect(Math.max(...steps), 'each 6px of hers is about 6×scale px of his — no jump at the card’s edge').toBeLessThan(6 * scale + 8);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator: *"I even saw a targeter arrow briefly? thats very
 * weird. this card has no targeter."* and *"the targeter arrow should only
 * be drawn if i'm actually selecting a target."* The MutationObserver is
 * installed BEFORE the release, so a frame-wide flash cannot be missed by a
 * poll that only starts afterward.
 */
test(titled('no arrow is ever drawn on the other screen while a no-target card is cast'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).not.toEqual([]);
    const memnite = (await offered(alice.page))[0]!;
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;

    await bob.page.evaluate(() => {
      const w = window as unknown as { __sawArrow: () => boolean };
      let saw = false;
      w.__sawArrow = () => saw;
      new MutationObserver(() => {
        if (document.querySelector('[data-board-overlay] .presence__arrow') !== null) saw = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    const cardBox = (await alice.page.locator(`[data-board-card="${memnite}"]`).boundingBox())!;
    await alice.page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await alice.page.mouse.down();
    await expect(alice.page.locator(`[data-board-card="${memnite}"]`), 'the press lifted it').toHaveAttribute('data-cast-lift', 'lifted');
    await alice.page.mouse.move(herField.x + herField.width * 0.5, herField.y + herField.height * 0.5, { steps: 10 });
    await alice.page.mouse.up();
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 10_000, message: 'Memnite landed — no target was ever asked' }).toContain(memnite);

    const sawArrow = await bob.page.evaluate(() => (window as unknown as { __sawArrow: () => boolean }).__sawArrow());
    console.log(`[presence over] bob ever saw an arrow while Memnite (no target) was cast: ${sawArrow}`);
    expect(sawArrow, 'no arrow at any point between release and the frame — Memnite has no target to aim at').toBe(false);
  } finally {
    await stack.stop();
  }
});

test(titled('letting go of a held card with no further pointer move takes the back down on the other screen at once'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'own-spell');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => offered(alice.page), { timeout: 30_000, message: 'alice is offered Memnite' }).not.toEqual([]);
    const memnite = (await offered(alice.page))[0]!;

    const cardBox = (await alice.page.locator(`[data-board-card="${memnite}"]`).boundingBox())!;
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await alice.page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(herField.x + herField.width * 0.5, herField.y + herField.height * 0.5, { steps: 10 });
    await expect(back(bob.page), 'bob sees a card back while she holds it').toHaveCount(1, { timeout: 10_000 });

    // Let go with NO further pointer move: the release message is the only thing that can move
    // the back now, since nothing will throttle a move in to do it instead. It leaves the cursor at
    // once — for the gap her row reserved, where it waits for the card (2026-10-08) — and hands over
    // to the card's own tile copy the moment Memnite is on her battlefield.
    //
    // Watched from BEFORE the release, as a record: the waiting back and the reserved gap live only
    // until Forge's frame, which on a CI runner is tens of milliseconds — a locator poll started after
    // `mouse.up()` resolves missed that window outright (wave 60's red at this line, 1 run in 3).
    // The record is printed for the server log's `placement` row to be read against.
    await bob.page.evaluate(() => {
      const t0 = performance.now();
      const seen: string[] = [];
      const w = window as unknown as { __memnite: () => string[] };
      w.__memnite = () => seen;
      const note = (what: string) => {
        if (!seen.some((s) => s.endsWith(what))) seen.push(`${Math.round(performance.now() - t0)}ms ${what}`);
      };
      new MutationObserver(() => {
        if (document.querySelector('.presence__back[data-waiting]') !== null) note('back waiting');
        if (document.querySelector('.seat:not([data-viewer]) [data-zone="battlefield"] li.zone__gap[data-expected]') !== null) note('gap reserved');
        if (document.querySelector('.presence__handoff') !== null) note('tile copy flying');
        if (document.querySelector('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card] .card__name') !== null) note('card drawn');
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-waiting', 'data-expected'] });
    });
    await alice.page.mouse.up();
    const record = () => bob.page.evaluate(() => (window as unknown as { __memnite: () => string[] }).__memnite());
    await expect(back(bob.page), 'the back is gone once the card is there').toHaveCount(0, { timeout: 20_000 });
    // AE26: if Memnite sat on the stack for a beat (bob held priority), the back turned into its face
    // at the release point first; the flight into the column comes when it resolves. Either way the
    // trip is made — wait for it, not for the back alone.
    await expect.poll(async () => (await record()).some((s) => s.endsWith('tile copy flying')), { timeout: 20_000 }).toBe(true);
    const seen = await record();
    console.log(`[presence memnite] bob saw: ${seen.join(' → ')}`);
    expect(seen.some((s) => s.endsWith('back waiting')), `the back left the cursor at once, for the reserved gap — bob saw: ${seen.join(' → ')}`).toBe(true);
    expect(seen.some((s) => s.endsWith('gap reserved')), `his screen reserved her column — bob saw: ${seen.join(' → ')}`).toBe(true);
    expect(seen.some((s) => s.endsWith('tile copy flying')), `and the card's tile copy finished the trip — bob saw: ${seen.join(' → ')}`).toBe(true);
    await expect(bob.page.locator('.presence__handoff'), 'the copy landed').toHaveCount(0, { timeout: 5_000 });
  } finally {
    await stack.stop();
  }
});

/*
 * AD4 rules 2 and 3 (wave 59): a cast card is a back at its RELEASE POINT on
 * the opponent's screen until it is committed to the stack, then its face —
 * never a battlefield gap, a spell has none until it resolves. The owner can
 * still drag it while it waits; the move crosses, and a reload still shows
 * it where she left it (the last move is replayed as a joiner's own).
 *
 * `bolt-player` (Lightning Bolt, "any target", one untapped Mountain), not
 * `own-spell`'s Memnite: Memnite needs no target, so `gestures/install.ts`'s
 * own `spell ? null : placementAt(point)` still sends it through the OLD
 * `forge:placement` battlefield-column channel the moment she releases it
 * over her battlefield — this wire's own `placing.at` wait is for a spell
 * that channel never fires for. A targeted spell always takes this path.
 */
test(titled('a cast spell is a back at the release point on bob’s screen, then its face once it is on the stack — survives a drag, and his reload'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');
    await resizeWindow(alice.page, { width: 1280, height: 800 });
    // Wider: the full-control banner adds a row that overlaps the hand button at the harness's
    // default size (`w49-counterspell.spec.ts`'s own note).
    await resizeWindow(bob.page, { width: 1600, height: 1000 });
    // The caster's own priority on her own spell auto-passes by default (`auto.ts`'s
    // `passStackWindows`) — with nothing else, the bolt would resolve before this test ever gets to
    // look at it. Full control for BOB (not the caster) means HIS priority on her spell is a real
    // stop: nothing auto-answers, so it waits on the stack until he is asked, and this test simply
    // never answers that ask.
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control'), 'full control is on for bob — the precondition this spec needs').toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => handCardNamed(alice.page, 'Lightning Bolt'), { timeout: 20_000, message: 'alice holds her bolt' }).not.toBeUndefined();
    const bolt = (await handCardNamed(alice.page, 'Lightning Bolt'))!;

    // She parks it over her own battlefield — released outside the hand, a targeted spell is sent
    // to Forge right there (no target chosen yet), and a real targeting ask opens.
    //
    // Done by hand rather than `dragHandCard`: the ghost's own box — the SAME element,
    // `drawCastLift`'s CSS centres it on wherever it was last positioned — has to be read right
    // before `mouse.up()`, which no further pointer move follows; `dragHandCard` releases with no
    // hook in between.
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const releaseAt = { x: herField.x + herField.width * 0.5, y: herField.y + herField.height * 0.5 };
    const boltBox = (await alice.page.locator(`[data-board-card="${bolt}"]`).boundingBox())!;
    await alice.page.mouse.move(boltBox.x + boltBox.width / 2, boltBox.y + boltBox.height / 2);
    await alice.page.mouse.down();
    await expect(alice.page.locator(`[data-board-card="${bolt}"]`), 'the press lifted it').toHaveAttribute('data-cast-lift', 'lifted');
    await alice.page.mouse.move(releaseAt.x, releaseAt.y, { steps: 8 });
    const ghostBeforeRelease = (await alice.page.locator(`[data-board-card="${bolt}"]`).boundingBox())!;
    const ghostCentre = { x: ghostBeforeRelease.x + ghostBeforeRelease.width / 2, y: ghostBeforeRelease.y + ghostBeforeRelease.height / 2 };
    console.log(`[presence over] bolt release: pointer=(${releaseAt.x},${releaseAt.y}) ghostCentre=(${ghostCentre.x},${ghostCentre.y}) dx=${ghostCentre.x - releaseAt.x} dy=${ghostCentre.y - releaseAt.y}`);
    await alice.page.mouse.up();
    await expect.poll(() => says(alice.page), { timeout: 10_000, message: 'the bolt reached Forge: it opened a targeting ask' }).toMatch(/Lightning Bolt.*target/is);

    // Bob's screen: a back waits at her release point, inside HER side of HIS board. Its own CSS
    // glides it there over 300ms (`presence.css`'s `[data-waiting]`) — settled() waits that out so
    // the box read below is where it actually stops, not a frame mid-glide.
    const waitingBack = bob.page.locator('.presence__back');
    const theirFieldOnBob = (await bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"]').boundingBox())!;
    await expect(waitingBack.and(bob.page.locator('[data-waiting]')), 'a back waits at her release point').toHaveCount(1, { timeout: 10_000 });
    const backBox = (await settled(waitingBack))!;
    expect(backBox.x + backBox.width / 2, 'inside her side of his board').toBeGreaterThanOrEqual(theirFieldOnBob.x);
    expect(backBox.x + backBox.width / 2).toBeLessThanOrEqual(theirFieldOnBob.x + theirFieldOnBob.width);
    // His back centres on where her GHOST was at release — not merely somewhere on her side
    // of the board. The two screens are different sizes (1280x800 / 1600x1000), so the ghost's
    // centre is converted to a board FRACTION on her board, mirrored top-to-bottom the same way
    // the wire itself does (`placeSpot`'s own rule), then compared to bob's board in HIS pixels.
    const aliceBoard = (await alice.page.locator('[data-board-overlay]').boundingBox())!;
    const bobBoard = (await bob.page.locator('[data-board-overlay]').boundingBox())!;
    const ghostFraction = { x: (ghostCentre.x - aliceBoard.x) / aliceBoard.width, y: (ghostCentre.y - aliceBoard.y) / aliceBoard.height };
    const expectedOnBob = { x: bobBoard.x + ghostFraction.x * bobBoard.width, y: bobBoard.y + (1 - ghostFraction.y) * bobBoard.height };
    const backCentre = { x: backBox.x + backBox.width / 2, y: backBox.y + backBox.height / 2 };
    console.log(`[presence over] bob's back centre=(${backCentre.x},${backCentre.y}) vs alice's ghost centre mapped to bob's board=(${expectedOnBob.x},${expectedOnBob.y})`);
    expect(Math.abs(backCentre.x - expectedOnBob.x), 'his back’s x centres on her ghost’s, not merely somewhere on her side').toBeLessThan(4);
    expect(Math.abs(backCentre.y - expectedOnBob.y), 'his back’s y centres on her ghost’s').toBeLessThan(4);

    // Now that she IS actually aiming (the targeting ask is open, `match.selectables`
    // non-null), moving toward a legal target must draw the arrow on bob's screen — the
    // legitimate case the `aiming` gate must not also suppress, proven beside the no-target case
    // above which proves the gate DOES suppress the illegitimate one.
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    const bobFaceBox = (await bobFace.boundingBox())!;
    await alice.page.mouse.move(bobFaceBox.x + bobFaceBox.width / 2, bobFaceBox.y + bobFaceBox.height / 2, { steps: 6 });
    await expect(arrow(bob.page), 'bob sees her arrow while she is actually aiming at his face').toHaveCount(1, { timeout: 10_000 });

    // She targets bob's own face and pays the Mountain's mana — the cast completes.
    await bobFace.click();
    await expect
      .poll(
        async () => {
          const text = await says(alice.page);
          if (/Pay Mana Cost/i.test(text)) await enabledOk(alice.page).click();
          return stackCount(alice.page);
        },
        { timeout: 15_000, message: 'the bolt, targeted and paid for, is on the stack' },
      )
      .toBe(1);

    // The stand-in turns over to its face, in the same spot — the CENTRE, which is what a `.placed`
    // element and a `.presence__back` both centre themselves on; their boxes are different sizes.
    const placedOnBob = bob.page.locator('[data-placed-spell]');
    await expect(placedOnBob, 'her placed spell draws as a card, not a back').toHaveCount(1, { timeout: 10_000 });
    await expect(bob.page.locator('.presence__back'), 'the back is gone — the placed-cards layer draws it now').toHaveCount(0, { timeout: 5_000 });
    const placedBoxBefore = (await settled(placedOnBob))!;
    const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    expect(Math.abs(centre(placedBoxBefore).x - centre(backBox).x), 'in the same place the back was waiting').toBeLessThan(5);
    expect(Math.abs(centre(placedBoxBefore).y - centre(backBox).y)).toBeLessThan(5);

    // She drags it while it waits on the stack: his copy follows (AD4 rule 3).
    const ownPlaced = alice.page.locator('[data-placed-spell]');
    const ownBox = (await ownPlaced.boundingBox())!;
    await alice.page.mouse.move(ownBox.x + ownBox.width / 2, ownBox.y + ownBox.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(herField.x + herField.width * 0.85, herField.y + herField.height * 0.25, { steps: 10 });
    await alice.page.mouse.up();
    // Where she let it go, on bob's board: her own copy's centre as a fraction of her board, mirrored top
    // to bottom, the back's own rule above. His copy is followed there, not merely moved: the drag's moves
    // cross in several messages, and a busy runner can leave a gap between two of them longer than any
    // quiet spell `settled` waits for.
    const ownDropped = centre((await settled(ownPlaced))!);
    const droppedOnBob = {
      x: bobBoard.x + ((ownDropped.x - aliceBoard.x) / aliceBoard.width) * bobBoard.width,
      y: bobBoard.y + (1 - (ownDropped.y - aliceBoard.y) / aliceBoard.height) * bobBoard.height,
    };
    await expect
      .poll(
        async () => {
          const b = await placedOnBob.boundingBox();
          return b !== null && Math.abs(centre(b).x - droppedOnBob.x) < 4 && Math.abs(centre(b).y - droppedOnBob.y) < 4;
        },
        { timeout: 10_000, message: `bob’s copy followed her drag to where she let it go (${droppedOnBob.x}, ${droppedOnBob.y})` },
      )
      .toBe(true);

    // A reload of bob's tab is sent her spell's last move as it joins.
    const movedBox = (await settled(placedOnBob))!;
    console.log(`[presence over] dropped: hers mapped to bob's board=(${droppedOnBob.x},${droppedOnBob.y}) his centre=(${centre(movedBox).x},${centre(movedBox).y})`);
    await bob.page.reload();
    await expect
      .poll(
        async () => {
          const b = await bob.page.locator('[data-placed-spell]').boundingBox();
          return b === null ? null : { x: Math.round(b.x), y: Math.round(b.y) };
        },
        { timeout: 30_000, message: 'still where she left it after his reload' },
      )
      .toEqual({ x: Math.round(movedBox.x), y: Math.round(movedBox.y) });
  } finally {
    await stack.stop();
  }
});

/**
 * The other seat's hidden hand, measured on alice's board: its row count, the drawn height of a
 * back, and the content height of the strip it sits in.
 */
async function theirHand(page: Page): Promise<{ rows: number; backH: number; zoneH: number; zone: string; aspect: string | null }> {
  return page.locator('.seat:not([data-viewer]) > [data-zone="hand"]').evaluate((zone) => {
    const lis = Array.from(zone.querySelectorAll<HTMLElement>('.card-backs > li'));
    const r = zone.getBoundingClientRect();
    return {
      rows: new Set(lis.map((li) => Math.round(li.getBoundingClientRect().top))).size,
      backH: Math.round(Math.max(0, ...lis.map((li) => li.getBoundingClientRect().height))),
      zoneH: zone.clientHeight,
      zone: `${Math.round(r.width)}x${Math.round(r.height)}`,
      aspect: zone.getAttribute('data-zone-aspect'),
    };
  });
}

test(titled('each screen lays the other seat’s hidden hand out by its OWN space: seven backs are one full-height row on a wide window, two rows on a narrow one, whatever the other window is'), async ({ browser }) => {
  // The operator, 2026-10-16, on a ~2000px window: "why is the hand showing reduced size here? i would
  // think we have space for a lot more than just 6 cards. i would guess up to 10 cards fit here until
  // we need two rows" — their seven-card hand was two rows of small backs because THEIR narrower
  // screen drew their own hand in two.
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // `ai-seven-card-hand`: bob (`ai…`) holds seven cards, alice one.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ai-seven-card-hand');
    const bobOwnRows = () =>
      bob.page.locator('.seat[data-viewer] [data-zone="hand"] .zone__cards > li.board-card').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size);
    const bobField = async () => (await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;

    for (const { aliceSize, bobSize, bobRows, rows } of [
      // The operator's case: alice wide, bob's own window narrow enough that his own hand wraps.
      { aliceSize: { width: 2000, height: 1140 }, bobSize: { width: 420, height: 1400 }, bobRows: 2, rows: 1 },
      // And the other way about: alice's own strip is narrow, so seven wrap on HER screen.
      { aliceSize: { width: 420, height: 1400 }, bobSize: { width: 1600, height: 800 }, bobRows: 1, rows: 2 },
    ] as const) {
      await resizeWindow(alice.page, aliceSize);
      await resizeWindow(bob.page, bobSize);
      await expect.poll(bobOwnRows, { timeout: 10_000, message: `bob’s own hand drew ${bobRows} row(s) at ${bobSize.width}x${bobSize.height}` }).toBe(bobRows);
      // His pointer over his board, so his screen is talking to hers.
      const field = await bobField();
      await bob.page.mouse.move(field.x + field.width * 0.4, field.y + field.height * 0.4, { steps: 4 });
      await expect(alice.page.locator('[data-board-overlay] .presence'), 'bob’s cursor is drawn on alice’s board').toHaveCount(1, { timeout: 10_000 });
      await alice.page.waitForTimeout(600);
      const seen = await theirHand(alice.page);
      console.log(`[hr] alice ${aliceSize.width}x${aliceSize.height}, bob ${bobSize.width}x${bobSize.height} (his own ${bobRows} row(s)): alice draws his hand in ${seen.rows} row(s), back ${seen.backH}px in a ${seen.zone} strip (content ${seen.zoneH}px, aspect ${seen.aspect})`);
      expect(seen.rows, `alice’s ${aliceSize.width}x${aliceSize.height} screen draws bob’s seven backs in ${rows} row(s), by her own strip`).toBe(rows);
      if (rows === 1) expect(seen.backH, 'one row of backs is as tall as the strip allows').toBeGreaterThan(seen.zoneH * 0.85);
      await bob.page.mouse.move(2, 2, { steps: 2 });
    }
  } finally {
    await stack.stop();
  }
});

/** The ids of one side's battlefield, in the order the screen draws them. */
async function fieldOrder(page: Page, side: 'you' | 'them'): Promise<number[]> {
  const seat = side === 'you' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  return page.locator(`${seat} [data-zone="battlefield"] li.board-card[data-card-id]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-card-id'))));
}

test(titled('where alice puts a card on her battlefield is where bob sees it: her placement crosses to his screen, and survives his reload'), async ({ browser }) => {
  // The operator, 2026-10-08: "the location for where a card is placed on the opponent's board should
  // match where they actually put it. at the moment the two seem to be completely desynced."
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'land-into-middle');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => handCardNamed(alice.page, 'Island'), { timeout: 20_000, message: 'alice holds the Island' }).not.toBeUndefined();
    const island = (await handCardNamed(alice.page, 'Island'))!;
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 20_000 }).toHaveLength(2);
    const [first, second] = await fieldOrder(alice.page, 'you');
    await expect.poll(() => fieldOrder(bob.page, 'them'), { timeout: 20_000, message: 'bob draws her two lands' }).toHaveLength(2);

    // Bob's screen records, from now on, the position every new card of hers is FIRST drawn at — and
    // whether a reserved gap stood where it went. The operator, 2026-10-08, from this seat: "i first
    // briefly see it flash to the default position, then correct itself to where it was actually placed."
    await bob.page.evaluate(() => {
      const field = document.querySelector('.seat:not([data-viewer]) [data-zone="battlefield"]')!;
      const seen = new Map<string, { index: number; gapBefore: boolean }>();
      let gapSeen = false;
      const w = window as unknown as { __firstSeen: Map<string, { index: number; gapBefore: boolean }>; __gapSeen: () => boolean };
      w.__firstSeen = seen;
      w.__gapSeen = () => gapSeen;
      new MutationObserver(() => {
        if (field.querySelector('li.zone__gap[data-expected]') !== null) gapSeen = true;
        const lis = Array.from(field.querySelectorAll('li.board-card[data-card-id], li.zone__gap[data-expected]'));
        lis.forEach((li, i) => {
          const id = li.getAttribute('data-card-id');
          if (id !== null && !seen.has(id)) seen.set(id, { index: i, gapBefore: gapSeen });
        });
      }).observe(field, { childList: true, subtree: true, attributes: true });
    });

    // She lets the Island go between her two lands: on the first land's right-hand edge.
    const firstBox = (await alice.page.locator(`.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id="${first}"]`).boundingBox())!;
    expect(await dragHandCard(alice.page, island, { x: firstBox.x + firstBox.width - 4, y: firstBox.y + firstBox.height / 2 }), 'the press lifted the Island').toBe(true);
    // Her own row reserves the column at once, and so does his — before Forge has the card anywhere.
    await expect(alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.zone__gap[data-expected]'), 'her row reserved the gap').toHaveCount(1, { timeout: 5_000 });
    await expect(bob.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.zone__gap[data-expected]'), 'his screen reserved the same gap').toHaveCount(1, { timeout: 5_000 });
    await expect(bob.page.locator('.presence__back[data-waiting]'), 'and her back waits in it').toHaveCount(1, { timeout: 5_000 });
    await expect.poll(() => fieldOrder(alice.page, 'you'), { timeout: 20_000, message: 'the Island is on her battlefield, between the two' }).toEqual([first, island, second]);

    // Bob's screen draws her side in HER order — not the view's (the Island last) — from the FIRST frame
    // it draws the Island at all: it took the gap, it never flashed at the end of the row.
    await expect.poll(() => fieldOrder(bob.page, 'them'), { timeout: 10_000, message: 'bob sees it where she put it' }).toEqual([first, island, second]);
    const firstSeen = await bob.page.evaluate((id) => (window as unknown as { __firstSeen: Map<string, { index: number; gapBefore: boolean }> }).__firstSeen.get(String(id)) ?? null, island);
    expect(firstSeen, 'the Island was first drawn between the two, with the reserved gap having stood there').toEqual({ index: 1, gapBefore: true });
    await expect(bob.page.locator('.presence__back'), 'the back is gone once the card is there').toHaveCount(0, { timeout: 5_000 });

    // A reload of bob's tab is sent her last arrangement as it joins.
    await bob.page.reload();
    await expect.poll(() => fieldOrder(bob.page, 'them'), { timeout: 30_000, message: 'and still after his reload' }).toEqual([first, island, second]);
  } finally {
    await stack.stop();
  }
});

/** The viewer's own hand, in DOM order. */
async function handIds(page: Page): Promise<number[]> {
  return page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
}

/**
 * Bob sees a back in alice's hand move from position 0 to 2. Installed
 * BEFORE her drag, because the glide is a transient 300ms ghost
 * (`presence.ts`'s `glideHandMove`) that a poll started afterward could
 * easily miss entirely.
 */
test(titled('a hand reorder is mirrored: bob sees a back in alice’s hand glide from one position to another, never the card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // `w60-thirst` is borrowed read-only for its three-card hand — no scenario
    // here deals one big enough to reorder for its own sake.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w60-thirst');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });

    const before = await handIds(alice.page);
    expect(before.length, 'w60-thirst’s own three-card hand').toBeGreaterThan(2);
    const moved = before.at(-1)!;
    const target = before[0]!;

    await bob.page.evaluate(() => {
      const overlay = document.querySelector('[data-board-overlay]')!;
      const w = window as unknown as { __sawHandBack: () => boolean };
      let saw = false;
      w.__sawHandBack = () => saw;
      // `data-gliding` (J3, wave 64): the hand reorder's own attribute, never
      // `data-waiting` (a placement wait) — the two used to share one mark.
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.target instanceof Element && r.target.matches('.presence__back[data-gliding]')) saw = true;
          if (r.addedNodes.length > 0 && overlay.querySelector('.presence__back[data-gliding]') !== null) saw = true;
        }
      }).observe(overlay, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-gliding'] });
    });

    const targetBox = (await alice.page.locator(`[data-board-card="${target}"]`).boundingBox())!;
    const armed = await dragHandCard(alice.page, moved, { x: targetBox.x + 2, y: targetBox.y + targetBox.height / 2 });
    expect(armed, 'the press armed the Arena gesture').toBe(true);
    await expect.poll(() => handIds(alice.page), { timeout: 10_000, message: 'alice’s own hand settled in its new order' }).toEqual([moved, ...before.slice(0, -1)]);

    await expect
      .poll(() => bob.page.evaluate(() => (window as unknown as { __sawHandBack: () => boolean }).__sawHandBack()), {
        timeout: 5_000,
        message: 'bob saw a card back glide — never which card',
      })
      .toBe(true);
    // Never the card itself: nothing drawn for bob at any point named alice's cards.
    const bobHtml = await bob.page.locator('[data-board-overlay]').innerHTML();
    expect(bobHtml, 'the hand reorder reached the wire as indices only').not.toContain('data-card-id');
  } finally {
    await stack.stop();
  }
});
