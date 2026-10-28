/**
 * AF413 creature entries, the two gaps a browser never checked:
 *
 *  - the RISE motion: Reanimate puts Griselbrand on the battlefield, and the stand-in that carries
 *    it there (`entries.ts`'s `playEntry`) must actually draw `data-entry="rise"` — the real-Forge
 *    half already proves Griselbrand leaves the graveyard (`af413-reanimate.jvm.test.ts`), never
 *    whether a browser draws the rise;
 *  - a cast NONCREATURE permanent's landing weight: `gestures/cast.ts`'s `landCastGhost` weight tail
 *    used to read a creature's power off its row card's own P/T badge, so a cast artifact — nothing
 *    draws a badge for one — landed weightless (`castLandingWeight` fixes this: every permanent's
 *    weight comes from `entries.ts`'s `entryHeft`, off its own card data, a creature by power, any
 *    other permanent by mana value). Casting the 10-mana Aladdin's Lamp should draw the same thump,
 *    debris, cracks and shove a 10-power creature's landing would; and the shove — cards knocked away
 *    and glided home — must never actually change a card's own slot.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS
 * and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[af413-weight] ${JSON.stringify({ step, data })}`);

interface WeightFrame {
  t: number;
  /** An entry's stand-in (`entries.ts`'s `playEntry`): its motion and centre. */
  entries: { motion: string; x: number; y: number }[];
  /** `.board-entry__thump` elements up right now. */
  thump: number;
  /** Debris pieces (`.effect-crash__dust` + `.effect-crash__rock`) inside a `.board-entry__debris` layer. */
  debris: number;
  /** `.board-entry__crackle` layers up right now (one per battlefield a crack reaches). */
  cracks: number;
  /** Row card ids a shove stand-in (`.board-entry--shoved`) is carrying right now. */
  shoved: string[];
}

/** Record, every frame until `stop` is called, the marks a landing's weight effects draw. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __w: unknown[]; __wStop: boolean };
    w.__w = [];
    w.__wStop = false;
    const t0 = performance.now();
    const centre = (el: Element): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const tick = (): void => {
      if (w.__wStop) return;
      w.__w.push({
        t: Math.round(performance.now() - t0),
        entries: Array.from(document.querySelectorAll('.board-entry[data-entry]')).map((el) => ({ motion: el.getAttribute('data-entry') ?? '', ...centre(el) })),
        thump: document.querySelectorAll('.board-entry__thump').length,
        debris: document.querySelectorAll('.board-entry__debris .effect-crash__dust, .board-entry__debris .effect-crash__rock').length,
        cracks: document.querySelectorAll('.board-entry__crackle').length,
        shoved: Array.from(document.querySelectorAll('.board-entry--shoved[data-stand-in]')).map((el) => el.getAttribute('data-stand-in') ?? ''),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function frames(page: Page): Promise<WeightFrame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __w: WeightFrame[]; __wStop: boolean };
    w.__wStop = true;
    return w.__w;
  });
}

/** Every battlefield card's own box, by id — what the shove must never change. */
async function battlefieldBoxes(page: Page): Promise<Record<string, { left: number; top: number; width: number; height: number; name: string; tapped: boolean }>> {
  return page.evaluate(() => {
    const out: Record<string, { left: number; top: number; width: number; height: number; name: string; tapped: boolean }> = {};
    for (const el of document.querySelectorAll('[data-zone="battlefield"] [data-board-card]')) {
      const id = el.getAttribute('data-board-card');
      if (id === null) continue;
      const r = el.getBoundingClientRect();
      out[id] = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        name: el.querySelector('.card__name')?.textContent?.trim() ?? '',
        tapped: el.hasAttribute('data-tapped'),
      };
    }
    return out;
  });
}

/** `name`'s id in `owner`'s hand on `page`. */
async function handNamed(page: Page, name: string): Promise<number> {
  const card = page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: name });
  await expect(card, `${name} is in hand`).toHaveCount(1, { timeout: 15_000 });
  return Number(await card.first().getAttribute('data-board-card'));
}

/** `name`'s id on `owner`'s battlefield on `page`, once it is there. */
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

/**
 * No `.board-entry` stand-in (`playEntry`'s own climb, and every shoved neighbour — both carry the
 * class) and no `[data-cast-landing]` (`landCastGhost`'s own flight: the row card it hides stays
 * marked until its weight tail's `finish` runs, which is only once the landing AND its weight
 * effects, shove included, have all resolved) left anywhere: the landing has fully settled.
 */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.board-entry, [data-cast-landing]').count(), { timeout: 20_000, message: 'every stand-in is gone' }).toBe(0);
}

test(titled('a reanimated creature arrives with the rise motion'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // e2e's own default is Fast Mode ON (`play/browser.ts`'s `openFriend`, every other spec's
    // own need), which skips the climb `playEntry` draws (`entries.ts`'s own header: "Fast Mode:
    // landing only, no rise") — this spec is exactly the one that has to see it, so both screens
    // turn it off before either page loads, the same seam `startScenarioVsAi`'s own `fastMode`
    // option uses.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af413-reanimate', {
      beforeAlice: (page) => setPlayFastModeDefault(page.context(), false),
      beforeBob: (page) => setPlayFastModeDefault(page.context(), false),
    });
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });

    const reanimate = await handNamed(alice.page, 'Reanimate');
    // Griselbrand is the graveyard's own pile card (its only one): the "separate click on the
    // legal target" a parked targeted cast needs (`gestures/cast.ts`'s own doc header) — the
    // server auto-answers Forge's OWN target ask once it is the one legal, mandatory option
    // (`auto.ts`'s `onlyAnswer`, "one option, not optional"), so nothing opens a picker.
    const griselbrandInGy = alice.page.locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]', { hasText: 'Griselbrand' });
    await Promise.all([record(alice.page), record(bob.page)]);
    await castUntilOnStack(alice.page, stack, reanimate, [griselbrandInGy]);

    const griselbrand = await battlefieldNamed(alice.page, 'you', 'Griselbrand');
    // Forge's view has the arrival before its beat starts (`numbers.ts`'s own stagger delay): wait
    // for the rise to actually be drawn before waiting for it to be gone, or an empty-but-settled
    // DOM caught between the two looks identical to one the entry never reached at all.
    for (const page of [alice.page, bob.page]) await expect.poll(() => page.locator('.board-entry[data-entry="rise"]').count(), { timeout: 15_000, message: 'the rise starts' }).toBeGreaterThan(0);
    await settled(alice.page);
    await settled(bob.page);

    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      const seen = await frames(page);
      const rises = seen.flatMap((f) => f.entries).filter((e) => e.motion === 'rise');
      log(`griselbrand rises (${who})`, { griselbrand, frames: seen.length, rises: rises.length, motions: [...new Set(seen.flatMap((f) => f.entries.map((e) => e.motion)))] });
      expect(rises.length, `${who}: the stand-in draws data-entry="rise" at some point`).toBeGreaterThan(0);
    }
  } finally {
    await stack.stop();
  }
});

test(titled('a cast noncreature permanent lands with weight, and its shove never changes a card’s own slot'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af413-cast-weight');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });

    const before = {
      alice: await battlefieldBoxes(alice.page),
      bob: await battlefieldBoxes(bob.page),
    };
    expect(Object.keys(before.alice).length, 'alice’s battlefield is populated before the cast').toBeGreaterThan(0);
    expect(Object.keys(before.bob).length, 'bob’s battlefield is populated before the cast').toBeGreaterThan(0);

    const lamp = await handNamed(alice.page, "Aladdin's Lamp");
    await Promise.all([record(alice.page), record(bob.page)]);
    await castUntilOnStack(alice.page, stack, lamp, []);

    await battlefieldNamed(alice.page, 'you', "Aladdin's Lamp");
    await settled(alice.page);
    await settled(bob.page);

    const after = {
      alice: await battlefieldBoxes(alice.page),
      bob: await battlefieldBoxes(bob.page),
    };

    for (const [who, page] of [
      ['alice', alice.page],
      ['bob', bob.page],
    ] as const) {
      const seen = await frames(page);
      const thump = Math.max(0, ...seen.map((f) => f.thump));
      const debris = Math.max(0, ...seen.map((f) => f.debris));
      const cracks = Math.max(0, ...seen.map((f) => f.cracks));
      const shoved = new Set(seen.flatMap((f) => f.shoved));
      log(`the Lamp lands (${who})`, { frames: seen.length, thump, debris, cracks, shoved: [...shoved] });
      // entryWeight(10): thump from 2 power, a full spray of debris by 7, cracks from 7, one shove ring from 8.
      expect(thump, `${who}: the landing draws a thump`).toBeGreaterThan(0);
      expect(debris, `${who}: the landing throws debris`).toBeGreaterThan(0);
      expect(cracks, `${who}: the landing cracks the table`).toBeGreaterThan(0);
      expect(shoved.size, `${who}: at least one neighbour is shoved`).toBeGreaterThan(0);
    }

    // The shove knocks cards away and glides them home — it never changes a card's own slot. Every
    // battlefield card present before the cast, UNTAPPED both times (paying the Lamp's cost taps ten
    // Plains, which draws turned — a real, expected box change of its own, nothing to do with the
    // shove), is still at the exact same box once everything settled, on both screens (a card the
    // Lamp's own arrival added is new and has no "before" to compare).
    for (const [who, b, a] of [
      ['alice', before.alice, after.alice],
      ['bob', before.bob, after.bob],
    ] as const) {
      const common = Object.keys(b).filter((id) => id in a && !b[id]!.tapped && !a[id]!.tapped);
      expect(common.length, `${who}: at least the two Grizzly Bears neighbours were there, untapped, both times`).toBeGreaterThanOrEqual(2);
      for (const id of common) expect(a[id], `${who}: card ${id}'s box after the shove settled`).toEqual(b[id]);
    }
  } finally {
    await stack.stop();
  }
});
