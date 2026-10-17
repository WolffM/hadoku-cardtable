/**
 * The operator, 2026-10-14:
 *  - *"some effects happen a little too quickly. i just had Kalitas create a zombie and it was too
 *    instant i need to see some animation for stuff like that."*
 *  - *"same with effects like Sorin, Grim Nemesis +1 which reveals a card and then does damage. we
 *    need some kind of reveal and then damage dealt animation."*
 *
 * Forge applies a resolution in one frame (the match log, m-6e9b1831b9ba: the Kalitas resolution was
 * one view with `g.resolve,g.exile,g.token`; Sorin's +1 was a reveal notice and then ONE view with
 * `g.resolve,g.damage-player,g.draw` 0.7 s later). What this pins, on BOTH screens, every frame:
 *
 *  - Kalitas: the Zombie arrives FROM Kalitas — its row card is marked `data-arriving-from="<Kalitas>"`
 *    and a stand-in travels from Kalitas's place into the Zombie's slot;
 *  - Sorin: the revealed card has its beat first (`data-reveal-beat` on the notice), THEN a hit
 *    (`[data-hit="player:<bob>"]`) sets off from the revealed card and slams into bob's face
 *    (`[data-impact]` there), and only when it lands does bob's -2 rise.
 *
 * Scenarios: `fx-kalitas`, `fx-sorin`. Every step prints one `[fx]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, clickPermanent, enabledOk, makeTitled, offeredNamed, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[fx] ${JSON.stringify({ step, data })}`);

interface Frame {
  t: number;
  /** The reveal notice is up, and in its beat. */
  reveal: boolean;
  beat: boolean;
  /** The notice's first card's centre. */
  revealAt: { x: number; y: number } | null;
  hits: { key: string; x: number; y: number }[];
  /** Where each hit slammed in (`projectile.ts`'s impact): its key and centre. */
  impacts: { key: string; x: number; y: number }[];
  numbers: string[];
  arriving: { id: string; from: string }[];
  ghosts: { x: number; y: number }[];
  /** Row cards hidden while their stand-in travels to them. */
  landing: string[];
}

/** Record, every frame until `stop` is called, the marks a resolution's beats draw. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fx: unknown[]; __fxStop: boolean };
    w.__fx = [];
    w.__fxStop = false;
    const t0 = performance.now();
    const centre = (el: Element): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const tick = (): void => {
      if (w.__fxStop) return;
      const notice = document.querySelector('[data-testid="live-reveal"]');
      const first = notice?.querySelector('.reveal-notice__cards > li') ?? null;
      w.__fx.push({
        t: Math.round(performance.now() - t0),
        reveal: notice !== null,
        beat: notice?.hasAttribute('data-reveal-beat') === true,
        revealAt: first === null ? null : centre(first),
        hits: Array.from(document.querySelectorAll('[data-hit]')).map((el) => ({ key: el.getAttribute('data-hit') ?? '', ...centre(el) })),
        impacts: Array.from(document.querySelectorAll('[data-impact]')).map((el) => ({ key: el.getAttribute('data-impact') ?? '', ...centre(el) })),
        numbers: Array.from(document.querySelectorAll('.board-number')).map((el) => el.textContent ?? ''),
        arriving: Array.from(document.querySelectorAll('[data-arriving-from]')).map((el) => ({ id: el.getAttribute('data-board-card') ?? '', from: el.getAttribute('data-arriving-from') ?? '' })),
        ghosts: Array.from(document.querySelectorAll('[data-cast-ghost]')).map(centre),
        landing: Array.from(document.querySelectorAll('[data-zone="battlefield"] [data-cast-landing]')).map((el) => el.getAttribute('data-board-card') ?? ''),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __fx: Frame[]; __fxStop: boolean };
    w.__fxStop = true;
    return w.__fx;
  });
}

/** The permanent named `name` on `owner`'s battlefield on `page`, by id. */
async function battlefieldNamed(page: Page, owner: 'you' | 'them', name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is on the ${owner} battlefield` },
    )
    .not.toBeUndefined();
  return id!;
}

/** Every card on the viewer's own battlefield on `page`, by id. */
function ownIds(page: Page): Promise<number[]> {
  return page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
}

async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} is not drawn`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, px: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= px;

test(titled('Kalitas’s Zombie arrives from Kalitas, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'fx-kalitas');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const kalitas = await battlefieldNamed(alice.page, 'you', 'Kalitas, Traitor of Ghet');
    const bears = await battlefieldNamed(alice.page, 'them', 'Grizzly Bears');
    const kalitasAt = {
      alice: await centreOf(alice.page, `[data-zone="battlefield"] [data-board-card="${kalitas}"]`),
      bob: await centreOf(bob.page, `[data-zone="battlefield"] [data-board-card="${kalitas}"]`),
    };

    // Full control holds alice's priority, so the target click never races an auto-pass (w56-numbers).
    await alice.page.getByTestId('live-full-control').click();
    await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const bolt = await offeredNamed(alice.page, 'Lightning Bolt');
    expect(bolt, 'Lightning Bolt is offered').not.toBeUndefined();
    const target = alice.page.locator(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${bears}"]`);
    await castUntilOnStack(alice.page, stack, bolt!, async () => {
      const ready = (await target.getAttribute('data-selectable')) !== null;
      if (ready) await target.locator('button').first().click();
      return ready;
    });
    expect(await stackCount(alice.page), 'the Bolt is on the stack, aimed at the Bears').toBe(1);

    const before = await ownIds(alice.page);
    await Promise.all([record(alice.page), record(bob.page)]);
    const deadline = Date.now() + 20_000;
    while ((await stackCount(alice.page)) > 0 && Date.now() < deadline) {
      for (const p of [alice.page, bob.page]) if ((await enabledOk(p).count()) > 0) await enabledOk(p).first().click().catch(() => undefined);
      await alice.page.waitForTimeout(60);
    }
    // The token is the one card on alice's battlefield she did not have before the Bolt.
    let zombie = 0;
    await expect
      .poll(
        async () => {
          const now = await ownIds(alice.page);
          zombie = now.find((id) => !before.includes(id)) ?? 0;
          return zombie;
        },
        { timeout: 30_000, message: 'a token joins alice’s battlefield' },
      )
      .not.toBe(0);
    await alice.page.waitForTimeout(1500);
    const slots = {
      alice: await centreOf(alice.page, `[data-zone="battlefield"] [data-board-card="${zombie}"]`),
      bob: await centreOf(bob.page, `[data-zone="battlefield"] [data-board-card="${zombie}"]`),
    };
    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      const seen = await frames(page);
      const arriving = seen.filter((f) => f.arriving.some((a) => a.id === String(zombie)));
      const ghosts = seen.filter((f) => f.ghosts.length > 0);
      log(`zombie arrives (${who})`, {
        kalitas,
        zombie,
        from: kalitasAt[who],
        slot: slots[who],
        frames: seen.length,
        arriving: arriving.length,
        marks: [...new Set(arriving.flatMap((f) => f.arriving.map((a) => `${a.id}<-${a.from}`)))],
        ghost: ghosts.map((f) => `${f.t}:${f.ghosts.map((g) => `${g.x},${g.y}`).join('|')}${f.landing.includes(String(zombie)) ? ' hidden' : ''}`).slice(0, 30),
      });
      expect(arriving.length, `${who}: the Zombie is drawn arriving`).toBeGreaterThan(0);
      expect(arriving[0]!.arriving.find((a) => a.id === String(zombie))!.from, `${who}: from Kalitas`).toBe(String(kalitas));
      expect(ghosts.length, `${who}: a stand-in travels`).toBeGreaterThan(0);
      expect(near(ghosts[0]!.ghosts[0]!, kalitasAt[who], 60), `${who}: it sets off from Kalitas (${JSON.stringify(ghosts[0]!.ghosts[0])} vs ${JSON.stringify(kalitasAt[who])})`).toBe(true);
      // Where it is between two frames depends on the runner's frame rate; what does not is that the
      // Zombie is hidden in its slot while its stand-in is up, and drawn there once it has arrived.
      expect(ghosts.every((f) => f.landing.includes(String(zombie))), `${who}: the Zombie waits hidden in its slot while the stand-in travels`).toBe(true);
      const last = seen.at(-1)!;
      expect(last.ghosts.length === 0 && !last.landing.includes(String(zombie)), `${who}: and is drawn there once it has arrived`).toBe(true);
      expect(ghosts.at(-1)!.t - ghosts[0]!.t, `${who}: the trip takes a visible moment`).toBeGreaterThanOrEqual(100);
    }
  } finally {
    await stack.stop();
  }
});

test(titled('Sorin’s +1: the revealed card has its beat, then the hit travels from it to bob’s face, then bob’s life drops'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'fx-sorin');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });
    const sorin = await battlefieldNamed(alice.page, 'you', 'Sorin, Grim Nemesis');
    const bobId = await alice.page.locator('[data-player-face]:not([data-viewer])').first().getAttribute('data-player-id');
    const bobFace = {
      alice: await centreOf(alice.page, '[data-player-face]:not([data-viewer])'),
      bob: await centreOf(bob.page, '[data-player-face][data-viewer]'),
    };

    await Promise.all([record(alice.page), record(bob.page)]);
    expect(await clickPermanent(alice.page, sorin), 'Sorin is offered').toBe(true);
    const plusOne = alice.page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]').filter({ hasText: 'Reveal the top card' });
    await expect(plusOne, 'the +1 is among his abilities').toHaveCount(1, { timeout: 15_000 });
    await plusOne.click();
    const bobLife = alice.page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    await expect
      .poll(
        async () => {
          for (const p of [alice.page, bob.page]) if ((await stackCount(p)) > 0 && (await enabledOk(p).count()) > 0) await enabledOk(p).first().click().catch(() => undefined);
          return (await bobLife.textContent())?.trim();
        },
        { timeout: 30_000, message: 'bob loses 2 to the revealed Grizzly Bears' },
      )
      .toBe('18');
    await alice.page.waitForTimeout(1200);

    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      const seen = await frames(page);
      const beat = seen.find((f) => f.beat);
      const hits = seen.filter((f) => f.hits.some((h) => h.key === `player:${bobId}`));
      const number = seen.find((f) => f.numbers.includes('-2'));
      log(`sorin +1 (${who})`, {
        frames: seen.length,
        beatAt: beat?.t ?? null,
        revealAt: beat?.revealAt ?? seen.find((f) => f.revealAt !== null)?.revealAt ?? null,
        hits: hits.map((f) => `${f.t}:${f.hits.map((h) => `${h.x},${h.y}`).join('|')}`).slice(0, 20),
        impacts: seen.flatMap((f) => f.impacts.map((i) => `${f.t}:${i.key}@${i.x},${i.y}`)).slice(0, 5),
        numberAt: number?.t ?? null,
        face: bobFace[who],
      });
      expect(beat, `${who}: the revealed card has its beat`).not.toBeUndefined();
      expect(hits.length, `${who}: a hit travels to bob`).toBeGreaterThan(0);
      expect(hits[0]!.t, `${who}: after the reveal’s beat began`).toBeGreaterThanOrEqual(beat!.t);
      const from = hits[0]!.hits[0]!;
      const revealAt = seen.filter((f) => f.t <= hits[0]!.t && f.revealAt !== null).at(-1)?.revealAt ?? null;
      expect(revealAt === null || near(from, revealAt, 80), `${who}: it sets off from the revealed card (${JSON.stringify(from)} vs ${JSON.stringify(revealAt)})`).toBe(true);
      // The bolt creeps off and then snaps in (`projectile.ts`), so where a frame catches it says little;
      // where it lands does: its impact, on bob's face.
      const impact = seen.flatMap((f) => f.impacts).find((i) => i.key === `player:${bobId}`);
      expect(impact, `${who}: it slams into bob`).not.toBeUndefined();
      expect(near(impact!, bobFace[who], 80), `${who}: on bob’s face (${JSON.stringify(impact)} vs ${JSON.stringify(bobFace[who])})`).toBe(true);
      expect(number, `${who}: bob’s -2 rises`).not.toBeUndefined();
      expect(number!.t, `${who}: once the hit has landed, not with it`).toBeGreaterThan(hits[0]!.t);
    }
  } finally {
    await stack.stop();
  }
});
