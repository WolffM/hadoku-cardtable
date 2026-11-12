/**
 * Every permanent that reaches a battlefield plays its entry, however it got there. The operator,
 * 2026-11-11: *"when creatures enter the battlefield from cards like show and they should still play
 * their entry effect. (cover eveything including things like cascade and reanimate as well. if they
 * ever hit the board, all the effect should always happen consistently)"*.
 *
 * Reanimate's `rise` is `af413-weight.spec.ts`'s. Here, against the Forge AI, on alice's screen:
 *
 *  - Show and Tell puts Griselbrand out of her own hand, and the AI's Hill Giant out of a hand she
 *    cannot see (`entry-show-and-tell.state`);
 *  - cascade casts Grizzly Bears that nobody let go anywhere (`entry-cascade.state`), beside the
 *    Bloodbraid Elf she cast herself;
 *  - the AI casts Ravenous Chupacabra on its own turn (`aa-ai-turn.state`).
 *
 * Each card must be drawn arriving by an entry stand-in (`entries.ts`'s `playEntry`:
 * `.board-entry[data-entry]`, `data-stand-in` its card id), and by one at a time: a card a play
 * lands itself is never drawn a second time by the board. Fast Mode is off: it draws the landing
 * alone, with no stand-in to see.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one every test SKIPS
 * and its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, handCardNamed, makeTitled, passOverStack, pressOffered, resizeWindow } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[entry] ${JSON.stringify({ step, data })}`);

/** One card's entry stand-ins as recorded: how many at once at most, for how many frames and when, and the widest drawn (px). */
interface Entry {
  motion: string;
  most: number;
  frames: number;
  firstMs: number;
  lastMs: number;
  widest: number;
}

/** Record, every frame, how many entry stand-ins each card id has up. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __entries: Record<string, Entry> };
    w.__entries = {};
    const t0 = performance.now();
    const tick = (): void => {
      const t = Math.round(performance.now() - t0);
      const now: Record<string, number> = {};
      for (const el of document.querySelectorAll('.board-entry[data-entry]')) {
        const id = el.getAttribute('data-stand-in') ?? '';
        now[id] = (now[id] ?? 0) + 1;
        const r = el.getBoundingClientRect();
        const seen = (w.__entries[id] ??= { motion: el.getAttribute('data-entry') ?? '', most: 0, frames: 0, firstMs: t, lastMs: t, widest: 0 });
        seen.frames += 1;
        seen.lastMs = t;
        seen.widest = Math.max(seen.widest, Math.round(r.width));
      }
      for (const [id, n] of Object.entries(now)) w.__entries[id]!.most = Math.max(w.__entries[id]!.most, n);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function entries(page: Page): Promise<Record<string, Entry>> {
  return page.evaluate(() => (window as unknown as { __entries: Record<string, Entry> }).__entries);
}

/** `name`'s id on `owner`'s battlefield, or undefined while it is not there. */
async function battlefieldId(page: Page, owner: 'you' | 'them', name: string): Promise<number | undefined> {
  const cards = await page
    .locator(`[data-zone="battlefield"][data-owner="${owner}"] [data-board-card]`)
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** Every stand-in is gone: the landings have settled. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.board-entry, [data-cast-landing]').count(), { timeout: 20_000, message: 'every stand-in is gone' }).toBe(0);
}

/** Each of `cards` was drawn arriving by an entry stand-in, never two at once. */
async function judge(page: Page, cards: Record<string, number>): Promise<void> {
  const seen = await entries(page);
  log('entries', { cards, seen });
  for (const [name, id] of Object.entries(cards)) {
    const e = seen[String(id)];
    expect(e, `${name} (${id}) is drawn arriving by an entry stand-in`).toBeDefined();
    expect(e!.most, `${name} (${id}) is drawn arriving once, never twice at once`).toBe(1);
  }
}

test(titled('Show and Tell: a creature put onto the battlefield out of either hand plays its entry'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'entry-show-and-tell', { fastMode: false });
    const page = alice.page;
    await resizeWindow(page, { width: 1600, height: 1000 });
    await record(page);
    const showAndTell = (await handCardNamed(page, 'Show and Tell'))!;
    await castUntilOnStack(page, stack, showAndTell, []);

    const griselbrandInHand = page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]', { hasText: 'Griselbrand' });
    let ids: { griselbrand?: number; giant?: number } = {};
    await expect
      .poll(
        async () => {
          ids = { griselbrand: await battlefieldId(page, 'you', 'Griselbrand'), giant: await battlefieldId(page, 'them', 'Hill Giant') };
          if (ids.griselbrand !== undefined && ids.giant !== undefined) return true;
          if (!(await pressOffered(griselbrandInHand))) await answerPrompt(page);
          await passOverStack(page);
          return false;
        },
        { timeout: 60_000, intervals: [250], message: 'Griselbrand and Hill Giant are on the battlefield' },
      )
      .toBe(true);
    await settled(page);
    await judge(page, { Griselbrand: ids.griselbrand!, 'Hill Giant': ids.giant! });
  } finally {
    await stack.stop();
  }
});

test(titled('cascade: a creature cast for free, that no play lands, plays its entry'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'entry-cascade', { fastMode: false });
    const page = alice.page;
    await resizeWindow(page, { width: 1600, height: 1000 });
    await record(page);
    const elf = (await handCardNamed(page, 'Bloodbraid Elf'))!;
    await castUntilOnStack(page, stack, elf, []);

    let ids: { elf?: number; bears?: number } = {};
    await expect
      .poll(
        async () => {
          ids = { elf: await battlefieldId(page, 'you', 'Bloodbraid Elf'), bears: await battlefieldId(page, 'you', 'Grizzly Bears') };
          if (ids.elf !== undefined && ids.bears !== undefined) return true;
          if (await confirmOpen(page)) await answerConfirm(page, 'yes');
          else await answerPrompt(page);
          await passOverStack(page);
          return false;
        },
        { timeout: 60_000, intervals: [250], message: 'Bloodbraid Elf and Grizzly Bears are on the battlefield' },
      )
      .toBe(true);
    await settled(page);
    await judge(page, { 'Bloodbraid Elf': ids.elf!, 'Grizzly Bears': ids.bears! });
  } finally {
    await stack.stop();
  }
});

test(titled("the AI's own creature spell plays its entry on the other screen"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'aa-ai-turn', { fastMode: false, beforeKeep: (f) => record(f.page) });
    const page = alice.page;
    let chupacabra: number | undefined;
    await expect
      .poll(async () => (chupacabra = await battlefieldId(page, 'them', 'Ravenous Chupacabra')), { timeout: 60_000, message: 'Ravenous Chupacabra is on the battlefield' })
      .not.toBeUndefined();
    await settled(page);
    await judge(page, { 'Ravenous Chupacabra': chupacabra! });
  } finally {
    await stack.stop();
  }
});
