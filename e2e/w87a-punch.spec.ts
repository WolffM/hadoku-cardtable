/**
 * A creature's blow on a player moves the table as its landing would, less the cracks, and knocks the
 * struck player's avatar back, against real Forge.
 *
 * The operator, 2026-10-30: *"remember how we added that nice board animation for when emrakul hits the
 * board? i want to try something similar with when strong creatures hit the opponent"*, then *"we should
 * match the power of the board effects to how they scale with entry"*. So a charge's blow is
 * `entries.ts`'s `entryWeight` for its damage, drawn by the one module a landing draws with
 * (`quake.ts`): nothing at 2, the table shaking from 5, the cards around it knocked away from 8, each
 * further the heavier. Never a crack: that is a landing's alone (the operator, 2026-11-01, of a crack
 * out of the struck player's portrait: "the crack looks ugly. but something i would have liked is the
 * actual player avatar moving a bit from the impact"). So the struck avatar recoils from each blow, in
 * turn, further the heavier (`recoil.ts`).
 *
 * `w87a-punch`: bob's Grizzly Bears (2), Spined Wurm (5), Pelakka Wurm (7) and Ancient Brontodon (9)
 * charge alice at 30 life, paced (Fast Mode off, as the operator plays). Each screen records, every
 * frame, each blow's crash (`.effect-crash[data-crash]`, keyed by its attacker), every shake the board
 * starts (an additive animation on `.board`, paired with the crash that started on the same frame)
 * and every crack layer and knocked-away card a quake draws (`[data-quake]`, keyed as the crash is), and
 * every recoil of a face's avatar (`recoil:<crash key>`, its furthest push and when it started).
 * `[w87a]` lines are the evidence.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** What each blow drew, by its crash key (`crash:<attacker id>`). */
interface Blow {
  /** When its crash first appeared, ms from the recording's start. */
  at: number;
  /** The furthest the board was moved by the shake that started with it, px; 0 for none. */
  shakePx: number;
  cracks: number;
  shoved: number;
  /** The furthest the struck avatar was pushed by this blow's recoil, px; 0 for none. */
  recoilPx: number;
  /** When its recoil started, ms from the recording's start; -1 for none. */
  recoilAt: number;
}

async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t0 = performance.now();
    const blows: Record<string, { at: number; shakePx: number; cracks: number; shoved: number; recoilPx: number; recoilAt: number }> = {};
    const recoiled = new WeakSet<Animation>();
    (window as unknown as { __blows: typeof blows }).__blows = blows;
    const seenShakes = new WeakSet<Animation>();
    const shoved = new WeakSet<Element>();
    const cracked = new WeakSet<Element>();
    const furthest = (a: Animation): number => {
      const frames = a.effect instanceof KeyframeEffect ? a.effect.getKeyframes() : [];
      return Math.max(0, ...frames.map((f) => {
        const m = /(-?[\d.]+)px (-?[\d.]+)px/.exec(String(f.translate ?? ''));
        return m === null ? 0 : Math.hypot(Number(m[1]), Number(m[2]));
      }));
    };
    const frame = (): void => {
      const t = Math.round(performance.now() - t0);
      const fresh: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.effect-crash[data-crash^="crash:"]')) {
        const key = el.dataset.crash!;
        if (blows[key] === undefined) {
          blows[key] = { at: t, shakePx: 0, cracks: 0, shoved: 0, recoilPx: 0, recoilAt: -1 };
          fresh.push(key);
        }
      }
      const board = document.querySelector('.board');
      for (const a of board?.getAnimations() ?? []) {
        if (seenShakes.has(a) || !(a.effect instanceof KeyframeEffect) || a.effect.composite !== 'add') continue;
        seenShakes.add(a);
        // A shake starts with its blow's crash: the crash new on this frame, else the latest one.
        const key = fresh[0] ?? Object.entries(blows).sort((x, y) => y[1].at - x[1].at)[0]?.[0];
        if (key !== undefined) blows[key]!.shakePx = Math.max(blows[key]!.shakePx, furthest(a));
      }
      for (const art of document.querySelectorAll('[data-player-face] .face__avatar')) {
        for (const a of art.getAnimations()) {
          if (recoiled.has(a) || !a.id.startsWith('recoil:')) continue;
          recoiled.add(a);
          const b = blows[a.id.slice('recoil:'.length)];
          if (b !== undefined) [b.recoilPx, b.recoilAt] = [furthest(a), t];
        }
      }
      for (const el of document.querySelectorAll<HTMLElement>('.board-entry__crackle[data-quake]')) {
        if (cracked.has(el)) continue;
        cracked.add(el);
        const b = blows[el.dataset.quake!];
        if (b !== undefined) b.cracks += 1;
      }
      for (const el of document.querySelectorAll<HTMLElement>('.board-entry--shoved[data-quake]')) {
        if (shoved.has(el)) continue;
        shoved.add(el);
        const b = blows[el.dataset.quake!];
        if (b !== undefined) b.shoved += 1;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** Each attacker's name by its card id, on `page`. */
async function attackerNames(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-zone="battlefield"] [data-board-card][data-attacking]')].map((el) => [
        el.getAttribute('data-board-card') ?? '',
        el.querySelector('.card__name')?.textContent?.trim() ?? '',
      ]),
    ),
  );
}

const POWER: Record<string, number> = { 'Grizzly Bears': 2, 'Spined Wurm': 5, 'Pelakka Wurm': 7, 'Ancient Brontodon': 9 };

test(titled('a charge’s blow on a player shakes and knocks the table as a landing of its power would, never cracks it, and knocks the avatar back'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w87a-punch');
    const { alice, bob } = seated;
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    const names = { alice: await attackerNames(alice.page), bob: await attackerNames(bob.page) };
    expect(Object.values(names.bob).sort(), 'all four attack').toEqual(Object.keys(POWER).sort());
    await Promise.all([record(alice.page), record(bob.page)]);

    await passDeclareAttackers(bob.page);
    // Whatever stop either seat is held at on the way through combat damage (alice declares no blocks), pressed through.
    await expect
      .poll(
        async () => {
          for (const page of [alice.page, bob.page]) if ((await enabledOk(page).count()) > 0) await enabledOk(page).click().catch(() => undefined);
          return (await Promise.all([alice.page, bob.page].map((p) => p.evaluate(() => Object.keys((window as unknown as { __blows: object }).__blows).length)))).every((n) => n === 4);
        },
        { timeout: 60_000, intervals: [100], message: 'all four blows land on both screens' },
      )
      .toBe(true);
    // The heaviest blow's knock-away runs on past the crash: give it time to be drawn.
    await alice.page.waitForTimeout(2500);

    for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const blows = await page.evaluate(() => (window as unknown as { __blows: Record<string, Blow> }).__blows);
      const byPower = Object.entries(blows)
        .map(([key, b]) => ({ name: names.bob[key.replace('crash:', '')] ?? names.alice[key.replace('crash:', '')] ?? key, ...b }))
        .map((b) => ({ ...b, power: POWER[b.name] ?? -1 }))
        .sort((x, y) => x.power - y.power);
      console.log(`[w87a] blows ${who} ${JSON.stringify(byPower)}`);
      expect(byPower.map((b) => b.power), `${who}: each blow is one attacker's`).toEqual([2, 5, 7, 9]);
      // The operator, 2026-10-31: "have the creature attack in order of strength with the strongest creatures hitting at the end".
      for (let i = 1; i < byPower.length; i++) expect(byPower[i]!.at, `${who}: the ${byPower[i]!.power} lands after the ${byPower[i - 1]!.power}`).toBeGreaterThan(byPower[i - 1]!.at);
      const [two, five, seven, nine] = byPower as [typeof byPower[0], typeof byPower[0], typeof byPower[0], typeof byPower[0]];
      expect([two.shakePx, two.shoved], `${who}: a blow of 2 moves no table`).toEqual([0, 0]);
      expect(five.shakePx, `${who}: 5 shakes the table`).toBeGreaterThan(0);
      expect(five.shoved, `${who}: 5 knocks nobody away`).toBe(0);
      expect(seven.shakePx, `${who}: 7 shakes harder than 5`).toBeGreaterThan(five.shakePx);
      expect(seven.shoved, `${who}: 7 knocks nobody away`).toBe(0);
      expect(nine.shakePx, `${who}: 9 shakes harder than 7`).toBeGreaterThan(seven.shakePx);
      expect(nine.shoved, `${who}: 9 knocks the cards around the avatar away`).toBeGreaterThan(0);
      expect(byPower.map((b) => b.cracks), `${who}: no blow cracks the table`).toEqual([0, 0, 0, 0]);
      for (const b of byPower) {
        expect(b.recoilPx, `${who}: the ${b.power} knocks the avatar back`).toBeGreaterThan(0);
        expect(Math.abs(b.recoilAt - b.at), `${who}: the ${b.power}'s recoil starts with its blow`).toBeLessThanOrEqual(50);
      }
      for (let i = 1; i < byPower.length; i++) expect(byPower[i]!.recoilPx, `${who}: the ${byPower[i]!.power} knocks it further than the ${byPower[i - 1]!.power}`).toBeGreaterThan(byPower[i - 1]!.recoilPx);
    }
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
