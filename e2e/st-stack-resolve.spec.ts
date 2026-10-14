/**
 * The operator, 2026-10-13: *"needs to be more clear when a card is still on the stack or whether it
 * has resolved"*.
 *
 * A spell is drawn where its caster let it go — over their own battlefield — so a creature spell on
 * the stack sat exactly where the permanent would, drawn exactly like one, and its resolution was a
 * swap in place: nothing on the table said which of the two it was.
 *
 * Alice drags Grizzly Bears and then Divination onto her battlefield; bob keeps a priority stop over
 * each (Brainstorm, an Island up), and his OK resolves it. What this pins, on alice's screen:
 *
 *  - ON the stack, the spell is drawn lifted off the table — tilted, with a drop shadow — on both
 *    screens, and a permanent on the battlefield is drawn flat;
 *  - the Bears RESOLVE by lying down: the permanent, once shown on the battlefield, visibly settles
 *    — the stack's shadow under it collapses — and ends flat (a filter: a transform on a battlefield
 *    card would count toward its zone's overflow, and the landing draws one object at a time);
 *  - Divination RESOLVES by travelling into alice's graveyard, not by fading where it stood.
 *
 * Scenario: `st-stack-resolve`. Every step prints one `[st]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, enabledOk, handCardNamed, makeTitled, offered, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[st] ${JSON.stringify({ step, data })}`);

interface Look {
  rotate: string;
  filter: string;
}

/** How the one placed stack card is drawn on `page`: its tilt and its shadow. */
async function stackLook(page: Page): Promise<Look | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-placed-spell]:not([data-placed-leaving])');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return { rotate: cs.rotate, filter: cs.filter };
  });
}

const tilted = (rotate: string): boolean => rotate !== 'none' && Math.abs(parseFloat(rotate)) >= 1;
const lifted = (look: Look | null): boolean => look !== null && tilted(look.rotate) && look.filter.includes('drop-shadow');

interface Sample {
  t: number;
  x: number;
  y: number;
  rotate: string;
  opacity: number;
  what: string;
}

/** Start recording the placed stack card's centre every frame, until it has been gone for half a second. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __stSamples: unknown[]; __stDone: boolean };
    w.__stSamples = [];
    w.__stDone = false;
    const t0 = performance.now();
    let seen = false;
    let goneSince: number | null = null;
    const tick = (): void => {
      const now = performance.now() - t0;
      const el = document.querySelector<HTMLElement>('[data-placed-spell]');
      if (el !== null) {
        seen = true;
        goneSince = null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        w.__stSamples.push({ t: now, x: r.x + r.width / 2, y: r.y + r.height / 2, rotate: cs.rotate, opacity: Number(cs.opacity), what: el.className });
      } else if (seen) {
        goneSince ??= now;
        if (now - goneSince > 500) {
          w.__stDone = true;
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function samples(page: Page): Promise<Sample[]> {
  await page.waitForFunction(() => (window as unknown as { __stDone: boolean }).__stDone, null, { timeout: 20_000 });
  return page.evaluate(() => (window as unknown as { __stSamples: Sample[] }).__stSamples);
}

/** The centre of the first element `selector` names on `page`. */
async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} is not drawn`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}


interface Landed {
  t: number;
  /** The permanent is drawn on alice's battlefield in this frame (not hidden under a landing). */
  visible: boolean;
  filter: string;
  /** Every `data-*` attribute on the permanent's `<li>` this frame, for the evidence line. */
  attrs: string;
}

/** Record, every frame for a second after it first shows, how alice's permanent `name` is drawn. */
async function watchLanding(page: Page, name: string): Promise<void> {
  await page.evaluate((card) => {
    const w = window as unknown as { __stLanding: unknown[]; __stLandingDone: boolean };
    w.__stLanding = [];
    w.__stLandingDone = false;
    const t0 = performance.now();
    let firstShown: number | null = null;
    const seenEls = new Map<Element, number>();
    const tick = (): void => {
      const now = performance.now() - t0;
      const li = Array.from(document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] li.board-card')).find(
        (el) => el.querySelector(':scope > .board-card__face .card__name')?.textContent?.trim() === card,
      );
      const face = li?.querySelector<HTMLElement>(':scope > .board-card__face') ?? null;
      if (face !== null) {
        const visible = getComputedStyle(li!).visibility !== 'hidden' && getComputedStyle(face).visibility !== 'hidden';
        if (visible) firstShown ??= now;
        if (!seenEls.has(li!)) seenEls.set(li!, seenEls.size + 1);
        const attrs = `li#${seenEls.get(li!)} ${li!.getAttributeNames().filter((n) => /^data-(stack|cast|placed)/.test(n)).join(' ')}`;
        w.__stLanding.push({ t: now, visible, filter: getComputedStyle(face).filter, attrs });
      }
      if (firstShown !== null && now - firstShown > 1000) {
        w.__stLandingDone = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);
}

async function landing(page: Page): Promise<Landed[]> {
  await page.waitForFunction(() => (window as unknown as { __stLandingDone: boolean }).__stLandingDone, null, { timeout: 20_000 });
  return page.evaluate(() => (window as unknown as { __stLanding: Landed[] }).__stLanding);
}

/** Cast `name` by a drag onto alice's battlefield, then wait for bob's stop over it and read both screens' look. */
async function castAndHold(alice: Page, bob: Page, stack: { serverLogFile: string }, name: string, at: { x: number; y: number }): Promise<void> {
  const id = await handCardNamed(alice, name);
  expect(id, `${name} is in alice’s hand`).not.toBeUndefined();
  await castByDrag(alice, stack, id!, at);
  await expect.poll(() => stackCount(alice), { timeout: 10_000, message: `${name} is on the stack` }).toBe(1);
  // Bob's stop over it: he is offered Brainstorm and holds Forge's OK.
  await expect.poll(async () => (await offered(bob)).length > 0 && (await enabledOk(bob).count()) > 0, { timeout: 20_000, message: `bob holds priority over ${name}` }).toBe(true);
  for (const [who, page] of [
    ['alice', alice],
    ['bob', bob],
  ] as const) {
    let look: Look | null = null;
    try {
      await expect.poll(async () => lifted((look = await stackLook(page))), { timeout: 5_000, message: `${who}: ${name} is drawn lifted off the table while it is on the stack` }).toBe(true);
    } finally {
      log(`${name} on the stack (${who})`, look);
    }
  }
}

test(titled('a spell on the stack is drawn lifted; resolving, a permanent settles into its slot and a sorcery travels to the graveyard'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'st-stack-resolve');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1600, height: 1000 });
    const field = (await alice.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
    const at = { x: Math.round(field.x + field.width * 0.6), y: Math.round(field.y + field.height * 0.5) };

    /* ── Grizzly Bears: on the stack, then onto the battlefield ── */
    await castAndHold(alice.page, bob.page, stack, 'Grizzly Bears', at);
    // A permanent already on the table is drawn flat.
    const forest = await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().evaluate((li) => getComputedStyle(li.querySelector('.board-card__face')!).rotate);
    log('a land on the battlefield', { rotate: forest });
    expect(tilted(forest), 'a permanent on the battlefield is not tilted').toBe(false);

    await watchLanding(alice.page, 'Grizzly Bears');
    await enabledOk(bob.page).first().click();
    const bears = await landing(alice.page);
    const shown = bears.filter((s) => s.visible);
    const settling = shown.filter((s) => s.filter.includes('drop-shadow'));
    log('bears resolve', {
      frames: bears.length,
      shown: shown.length,
      settling: settling.length,
      trace: bears.slice(0, 24).map((s) => `${Math.round(s.t)}${s.visible ? '' : ' hidden'} ${/drop-shadow/.test(s.filter) ? 'shadow' : 'flat'} [${s.attrs}]`),
    });
    expect(settling.length, 'once on the battlefield the Bears visibly settle: the stack’s shadow under them collapses').toBeGreaterThanOrEqual(1);
    // How long the settle is on screen, by the page's clock — from its first drawn frame to the first
    // frame drawn flat after it — never by a count of frames, which a busy runner halves.
    const flatAfter = shown.find((s) => s.t > settling[0]!.t && !s.filter.includes('drop-shadow'));
    expect(flatAfter, 'the settle ends').not.toBeUndefined();
    expect(flatAfter!.t - settling[0]!.t, 'and is on screen for a visible moment').toBeGreaterThanOrEqual(100);
    expect(bears.at(-1)!.filter, 'and they lie flat on the table').toBe('none');

    /* ── Divination: on the stack, then into the graveyard ── */
    await castAndHold(alice.page, bob.page, stack, 'Divination', at);
    const start = await centre(alice.page, '[data-placed-spell]');
    await record(alice.page);
    await enabledOk(bob.page).first().click();
    const div = await samples(alice.page);
    const yard = (await alice.page.locator('.seat[data-viewer] .zone--graveyard').boundingBox())!;
    const last = div.at(-1)!;
    log('divination resolves', { frames: div.length, start, first: div[0], last, yard });
    const inside = last.x >= yard.x - 8 && last.x <= yard.x + yard.width + 8 && last.y >= yard.y - 8 && last.y <= yard.y + yard.height + 8;
    expect(inside, `it travels into alice’s graveyard (ends at ${Math.round(last.x)},${Math.round(last.y)}; started ${Math.round(start.x)},${Math.round(start.y)})`).toBe(true);
  } finally {
    await stack.stop();
  }
});
