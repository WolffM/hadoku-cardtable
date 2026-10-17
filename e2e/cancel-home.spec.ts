/**
 * A cast cancelled mid-aim goes home on BOTH screens (playtest 15, 2026-10-09):
 *
 *   "i drag volcanic hammer onto the board and hover to target a creature. i
 *   cancel the spell cast. from the opponents side, this looks good except for
 *   when the spell is canceled, the phantom card back still remains on the
 *   board, it should have returned to the hand using the same animation as how
 *   cards return to the hand when viewed from the active players side."
 *
 * Two browsers, a real Forge match (`cancel-hammer`). Alice drags Volcanic
 * Hammer onto her battlefield, aims at bob's Grizzly Bears (bob sees her arrow),
 * presses Escape, and keeps moving her pointer the way a player does. Bob's page
 * records every animation frame from before the cast: the back standing in for
 * her card, any copy flying, and her hand's backs. Within a second of the
 * cancel nothing of hers may stand on the board, the last thing drawn must have
 * reached her hand, and her hand count must be what it was before the cast.
 * Her own screen still floats the card home.
 *
 * And the same cast CONFIRMED (the operator, the same day: "card flipped over
 * and showed a no-art version of the card … no-art version was replaced with
 * art version … card finished resolving and the old phantom cardback was still
 * visible"): from her release to two seconds after the Hammer resolves, bob's
 * page never draws a card face without its art, and no back of hers is left on
 * the board once it has resolved.
 */

import { expect, test, type Page } from '@playwright/test';

import { eventsIn } from './frames.ts';
import { cancelCast, dragHandCard, handCardNamed, makeTitled, pressOffered, pressPaymentAuto, resizeWindow, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

type Box = { x: number; y: number; w: number; h: number };
type Frame = { t: number; backs: Box[]; flying: Box[]; hand: number; handBox: Box | null; noArt: string[]; stack: number; bears: number };

/** Bob's page: one entry per animation frame whose drawing changed — her back(s), any copy in flight, her hand. */
async function recordBob(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { __home: () => Frame[] }).__home = () => frames;
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    let last = '';
    const tick = (): void => {
      const hand = document.querySelector('[data-zone="hand"][data-owner="them"]');
      const frame: Frame = {
        t: Date.now(),
        backs: Array.from(document.querySelectorAll('[data-board-overlay] .presence__back:not([data-gliding])')).map(box),
        flying: Array.from(document.querySelectorAll('.presence__handoff')).map(box),
        hand: hand?.querySelectorAll('li.card-back').length ?? -1,
        handBox: hand === null ? null : box(hand),
        // A card face drawn without its art: CardTile's `img.card__art` absent, hidden by its own
        // onError, or not yet decoded (`complete` false or no natural width) — the text tile showing.
        noArt: Array.from(document.querySelectorAll('.presence__back .card, .presence__handoff .card, [data-placed-spell] .card'))
          .filter((card) => {
            const img = card.querySelector('img.card__art') as HTMLImageElement | null;
            return img === null || img.style.display === 'none' || !img.complete || img.naturalWidth === 0;
          })
          .map((card) => {
            const where = card.closest('[data-placed-spell]') !== null ? 'placed' : card.closest('.presence__handoff') !== null ? 'handoff' : 'back';
            return `${where}:${card.querySelector('.card__name')?.textContent ?? '?'}`;
          }),
        stack: Number(document.querySelector('[data-zone="stack"]')?.getAttribute('data-count') ?? '0'),
        bears: document.querySelectorAll('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').length,
      };
      const key = JSON.stringify({ ...frame, t: 0 });
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Alice's page: every state her own card's lift passes through (`data-cast-lift`), stamped. */
async function recordAlice(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: { t: number; lift: string }[] = [];
    (window as unknown as { __lift: () => typeof seen }).__lift = () => seen;
    let last = '';
    const tick = (): void => {
      const lift = Array.from(document.querySelectorAll('[data-cast-lift]')).map((el) => el.getAttribute('data-cast-lift')).join(',') || 'none';
      if (lift !== last) {
        last = lift;
        seen.push({ t: Date.now(), lift });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** How long bob's stand-in art server takes to answer: a cold CDN fetch, which the operator saw as a no-art face first. */
const ART_LATENCY_MS = 500;
/** A card-sized image, as text. */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#7a4a2a"/></svg>';

const bobFrames =(page: Page): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __home: () => Frame[] }).__home());
const aliceLifts = (page: Page): Promise<{ t: number; lift: string }[]> =>
  page.evaluate(() => (window as unknown as { __lift: () => { t: number; lift: string }[] }).__lift());
const at = (b: Box): string => `${b.x},${b.y}/${b.w}`;
const insideOf = (b: Box, z: Box, slack: number): boolean => Math.abs(b.x - z.x) <= z.w / 2 + slack && Math.abs(b.y - z.y) <= z.h / 2 + slack;

test(titled('a cast cancelled mid-aim flies home to her hand on the opponent’s screen too, and leaves nothing on the board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'cancel-hammer');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => handCardNamed(alice.page, 'Volcanic Hammer'), { timeout: 30_000, message: 'alice holds Volcanic Hammer' }).not.toBeUndefined();
    const hammer = (await handCardNamed(alice.page, 'Volcanic Hammer'))!;
    const theirHand = bob.page.locator('[data-zone="hand"][data-owner="them"] li.card-back');
    await expect(theirHand, 'bob sees her two cards').toHaveCount(2, { timeout: 10_000 });
    const handBefore = await theirHand.count();

    await recordBob(bob.page);
    await recordAlice(alice.page);
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    expect(await dragHandCard(alice.page, hammer, { x: herField.x + herField.width / 2, y: herField.y + herField.height / 2 }), 'the press lifted the Hammer').toBe(true);
    await expect.poll(() => says(alice.page), { timeout: 15_000, message: 'Forge asks for the Hammer’s target' }).toMatch(/Volcanic Hammer.*target/is);

    const bears = (await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]').first().boundingBox())!;
    await alice.page.mouse.move(bears.x + bears.width / 2, bears.y + bears.height / 2, { steps: 8 });
    await expect(bob.page.locator('.presence__arrow'), 'bob sees her arrow on his creature').toHaveCount(1, { timeout: 10_000 });
    await expect(bob.page.locator('[data-board-overlay] .presence__back'), 'bob sees her parked card as a back').toHaveCount(1);
    const handWhileAiming = await theirHand.count();

    const cancelAt = Date.now();
    await cancelCast(alice.page, 'escape');
    // A player's pointer does not freeze after a cancel: it drifts back toward her hand.
    const hers = (await alice.page.locator('[data-zone="hand"][data-owner="you"]').boundingBox())!;
    for (let i = 1; i <= 10; i++) {
      await alice.page.mouse.move(bears.x + ((hers.x + hers.width / 2 - bears.x) * i) / 10, bears.y + ((hers.y + hers.height / 2 - bears.y) * i) / 10, { steps: 2 });
      await alice.page.waitForTimeout(150);
    }
    await expect.poll(() => handCardNamed(alice.page, 'Volcanic Hammer'), { timeout: 10_000, message: 'Forge’s Cancel put the Hammer back in her hand' }).not.toBeUndefined();
    await bob.page.waitForTimeout(Math.max(0, cancelAt + 2000 - Date.now()));

    const frames = await bobFrames(bob.page);
    const after = frames.filter((f) => f.t >= cancelAt);
    const before = frames.filter((f) => f.t < cancelAt).at(-1);
    const relayed = bob.captures
      .flatMap(eventsIn)
      .filter((e) => e.t >= cancelAt - 20 && e.event !== 'forge:s2c')
      .map((e) => `${e.t - cancelAt}ms ${e.event} ${JSON.stringify(e.msg).slice(0, 160)}`);
    const s2c = bob.captures.flatMap(eventsIn).filter((e) => e.t >= cancelAt - 20 && e.event === 'forge:s2c').length;
    console.log(`[cancel-home] bob's hand of hers: before ${handBefore}, while aiming ${handWhileAiming}, now ${await theirHand.count()}`);
    console.log(`[cancel-home] bob received after the cancel (${s2c} forge:s2c frames besides): ${relayed.join(' | ') || 'nothing'}`);
    console.log(
      `[cancel-home] bob's frames from the cancel: ${before === undefined ? '' : `(before) backs ${before.backs.map(at).join(';')} → `}${after
        .map((f) => `${f.t - cancelAt}ms backs[${f.backs.map(at).join(';')}] flying[${f.flying.map(at).join(';')}] hand ${f.hand}`)
        .join(' → ')}`,
    );
    const lifts = (await aliceLifts(alice.page)).filter((s) => s.t >= cancelAt - 50);
    console.log(`[cancel-home] alice's lift from the cancel: ${lifts.map((s) => `${s.t - cancelAt}ms ${s.lift}`).join(' → ')}`);

    // The recorder keeps a frame only when the drawing changes: what stands at a moment is the last frame at or before it.
    const settled = [...after.filter((f) => f.t - cancelAt <= 1000).slice(-1), ...after.filter((f) => f.t - cancelAt > 1000)];
    const remains = settled.find((f) => f.backs.length > 0 || f.flying.length > 0);
    expect(remains, `a back remains on bob's board ${remains === undefined ? '' : `${remains.t - cancelAt} ms after the cancel, at ${remains.backs.map(at).join(';')}`}`).toBeUndefined();

    const drawn = after.filter((f) => f.backs.length > 0 || f.flying.length > 0);
    const lastDrawn = drawn.at(-1);
    const handZone = after.at(-1)?.handBox ?? null;
    const final = lastDrawn === undefined ? undefined : [...lastDrawn.flying, ...lastDrawn.backs][0];
    console.log(`[cancel-home] last drawn ${final === undefined ? 'nothing' : `${at(final)} at ${lastDrawn!.t - cancelAt}ms`}; her hand on bob's screen ${handZone === null ? 'none' : at(handZone)}`);
    expect(final, 'something of hers was still drawn after the cancel to fly home').not.toBeUndefined();
    expect(handZone).not.toBeNull();
    expect(insideOf(final!, handZone!, 12), `no flight home: the last place bob drew her card (${at(final!)}) is not her hand (${at(handZone!)})`).toBe(true);
    expect(drawn.some((f) => f.flying.length > 0 || f.backs.length > 0) && drawn.filter((f) => f.t - cancelAt < 1000).length > 2, 'the card moved across several frames, not in one jump').toBe(true);
    await expect(theirHand, 'her hand on bob’s screen is back to its count before the cast').toHaveCount(handBefore);

    expect(lifts.some((s) => s.lift.includes('returning')), 'her own screen floats the Hammer home').toBe(true);
  } finally {
    await stack.stop();
  }
});

test(titled('a cast she confirms turns over on the opponent’s screen with its art already there, and leaves no back behind once it resolves'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'cancel-hammer');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    await expect.poll(() => handCardNamed(alice.page, 'Volcanic Hammer'), { timeout: 30_000, message: 'alice holds Volcanic Hammer' }).not.toBeUndefined();
    const hammer = (await handCardNamed(alice.page, 'Volcanic Hammer'))!;
    const bearsOnBob = bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]');
    await expect(bearsOnBob, 'bob has his Grizzly Bears').toHaveCount(1, { timeout: 10_000 });

    // The harness blocks every request off 127.0.0.1, so no art could ever load. Bob's page serves
    // each art URL a card-sized stand-in instead (drawn here as SVG text — never image bytes), as
    // slowly as a real CDN can be on a first fetch; then reloads, so his page starts cold.
    const artRequests: { t: number; url: string }[] = [];
    await bob.page.route(/^https:\/\/(cards\.scryfall\.io|cdn\.hadoku\.me)\//, async (route) => {
      artRequests.push({ t: Date.now(), url: route.request().url() });
      await new Promise((r) => setTimeout(r, ART_LATENCY_MS));
      await route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN });
    });
    await bob.page.reload();
    await expect(bearsOnBob, 'bob is back at the table').toHaveCount(1, { timeout: 30_000 });
    await bob.page.waitForTimeout(1500);

    await recordBob(bob.page);
    const releasedAt = Date.now();
    const herField = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    expect(await dragHandCard(alice.page, hammer, { x: herField.x + herField.width / 2, y: herField.y + herField.height / 2 }), 'the press lifted the Hammer').toBe(true);
    await expect.poll(() => says(alice.page), { timeout: 15_000, message: 'Forge asks for the Hammer’s target' }).toMatch(/Volcanic Hammer.*target/is);
    const theirs = alice.page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
    await expect(theirs, 'Forge offers bob’s Bears').toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
    expect(await pressOffered(theirs.first()), 'bob’s Bears pressed as the target').toBe(true);
    for (let i = 0; i < 120 && (await bearsOnBob.count()) > 0; i++) {
      await pressPaymentAuto(alice.page);
      await answerPrompt(alice.page);
      await answerPrompt(bob.page);
      await alice.page.waitForTimeout(100);
    }
    await expect(bearsOnBob, 'the Hammer resolved: the Bears are dead on bob’s screen').toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => bob.page.locator('[data-zone="stack"]').getAttribute('data-count'), { timeout: 10_000, message: 'the stack is empty' }).toBe('0');
    // Her pointer keeps moving after the play, the way a player's does — a back tied to her pointer traffic shows here.
    for (let i = 0; i < 14; i++) {
      await alice.page.mouse.move(herField.x + herField.width * (0.2 + 0.05 * i), herField.y + herField.height * (i % 2 === 0 ? 0.3 : 0.7), { steps: 3 });
      await alice.page.waitForTimeout(140);
    }

    const frames = (await bobFrames(bob.page)).filter((f) => f.t >= releasedAt);
    const resolved = frames.find((f) => f.bears === 0 && f.stack === 0);
    const line = (f: Frame): string =>
      `${f.t - releasedAt}ms backs[${f.backs.map(at).join(';')}] flying[${f.flying.length}] stack ${f.stack} bears ${f.bears}${f.noArt.length > 0 ? ` NO-ART[${f.noArt.join(';')}]` : ''}`;
    console.log(`[cancel-home] confirm: bob's frames from the release: ${frames.map(line).join(' → ')}`);
    const noArt = frames.filter((f) => f.noArt.length > 0);
    const first = noArt[0];
    console.log(
      `[cancel-home] confirm: ${noArt.length} frame(s) with a face missing its art${first === undefined ? '' : `, first at ${first.t - releasedAt}ms: ${first.noArt.join(';')}`}; resolved at ${resolved === undefined ? '?' : `${resolved.t - releasedAt}ms`}`,
    );
    const hammerArt = artRequests.find((r) => /9db3f454-4aeb-4e48-b961-bea760ea8ddf|volcanic/i.test(r.url));
    console.log(
      `[cancel-home] confirm: bob's art requests ${artRequests.length} (${artRequests.filter((r) => r.t < releasedAt).length} before her release); ${artRequests
        .map((r) => `${r.t - releasedAt}ms ${r.url.split('/').pop()}`)
        .join(', ')}${hammerArt === undefined ? '' : `; the Hammer's at ${hammerArt.t - releasedAt}ms`}`,
    );
    expect(noArt.map((f) => `${f.t - releasedAt}ms ${f.noArt.join(';')}`), 'bob never sees a card face without its art').toEqual([]);
    expect(resolved, 'bob saw the Hammer resolve').not.toBeUndefined();
    const left = [...frames.filter((f) => f.t <= resolved!.t + 500).slice(-1), ...frames.filter((f) => f.t > resolved!.t + 500)].filter((f) => f.backs.length > 0);
    expect(left.map((f) => `${f.t - resolved!.t}ms after resolving: ${f.backs.map(at).join(';')}`), 'no back of hers is left on bob’s board once the Hammer has resolved').toEqual([]);
  } finally {
    await stack.stop();
  }
});
