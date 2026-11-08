/**
 * A dual land's ring shows once, where it was pressed, and stays put (the operator, 2026-11-08: "the
 * dual-land mana ring effect is a bit janky. it seems to display multiple times and move. let's make
 * sure it only displays once").
 *
 * `mana-ring`, at alice's own priority, a plain click on each source and the pointer moving on before
 * Forge asks, as a hand does on its way to a disc:
 *   Tundra — its two abilities: Forge's `getAbilityToPlay`; a click on W adds {W}.
 *   City of Brass — Forge's list of five colours (`getChoices`), asked after it taps; the R disc adds {R}.
 * From the press to the pick exactly one ring element is ever mounted (a MutationObserver counts
 * them), the ring Forge's question opens is that same element (`data-method` lands on it), and its
 * hub never stands anywhere but where the press was (sampled every frame).
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, type Page, test } from '@playwright/test';

import { manaPool as pool, makeTitled, ownNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { centreOf, expectRingOn, pathTo, pressPoint, ring, ringOption } from './mana-ring.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface RingTrace {
  mounts: number;
  centres: string[];
}

/** Count every ring element mounted, and every distinct place its hub stood, from now until the stop. */
async function traceRing(page: Page): Promise<() => Promise<RingTrace>> {
  await page.evaluate(() => {
    const trace = { mounts: 0, centres: [] as string[], on: true };
    (window as unknown as { __ringOnce?: typeof trace }).__ringOnce = trace;
    const isRing = (n: Node): boolean => n instanceof Element && (n.matches('[data-testid="mana-ring"]') || n.querySelector('[data-testid="mana-ring"]') !== null);
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (isRing(n)) trace.mounts += 1;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const tick = (): void => {
      if (!trace.on) {
        observer.disconnect();
        return;
      }
      const hub = document.querySelector('[data-testid="mana-ring-hub"]');
      if (hub !== null) {
        const b = hub.getBoundingClientRect();
        const at = `${Math.round(b.left + b.width / 2)},${Math.round(b.top + b.height / 2)}`;
        if (trace.centres[trace.centres.length - 1] !== at) trace.centres.push(at);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () =>
    page.evaluate(() => {
      const trace = (window as unknown as { __ringOnce?: { mounts: number; centres: string[]; on: boolean } }).__ringOnce;
      if (trace === undefined) return { mounts: -1, centres: [] };
      trace.on = false;
      return { mounts: trace.mounts, centres: trace.centres };
    });
}

test(titled('a dual land’s ring shows once, where it was pressed, and stays put from the press to the pick'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'mana-ring');
    const page = alice.page;
    const [tundra] = await ownNamed(page, 'Tundra');
    const [brass] = await ownNamed(page, 'City of Brass');
    if (tundra === undefined || brass === undefined) throw new Error('the scenario board is not drawn');

    const tapThenPick = async (id: number, name: string, method: string, mana: 'W' | 'R'): Promise<void> => {
      const at = await pressPoint(page, id);
      await page.mouse.move(at.x, at.y);
      const stop = await traceRing(page);
      await page.mouse.down();
      await page.mouse.up();
      await expectRingOn(page, at, name);
      // The hand moves on before Forge has asked: off the land, round, and back over to the disc.
      const off = { x: at.x + 70, y: at.y + 45 };
      for (const p of pathTo(at, off, 6)) await page.mouse.move(p.x, p.y);
      await expect(ring(page), `${name}: Forge's question is on the ring that opened on the press`).toHaveAttribute('data-method', method, { timeout: 15_000 });
      const disc = await centreOf(ringOption(page, mana));
      for (const p of pathTo(off, disc, 6)) await page.mouse.move(p.x, p.y);
      await page.mouse.click(disc.x, disc.y);
      await expect(ring(page), `${name}: the ring closed on the pick`).toHaveCount(0);
      const trace = await stop();
      expect(trace.mounts, `${name}: one ring mounted from the press to the pick`).toBe(1);
      expect(trace.centres, `${name}: the ring's hub stood in one place from the press to the pick`).toHaveLength(1);
      await expect.poll(async () => (await pool(page))[mana], { timeout: 10_000, message: `${name} added {${mana}}` }).toBe(1);
    };

    await tapThenPick(tundra, 'Tundra', 'getAbilityToPlay', 'W');
    await tapThenPick(brass, 'City of Brass', 'getChoices', 'R');
  } finally {
    await stack.stop();
  }
});
