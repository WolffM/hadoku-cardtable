/**
 * An ability chip never covers a card either player can click, on either screen. The operator,
 * 2026-11-02, on Cephalid Breakfast: *"the ability chips eventually start to cover the two cards,
 * might be better if ability chips also respect "click-able" cards on the battlefield when evaluating
 * collision"*, and then: *"we should avoid blocking the opponents playable cards as well."*
 *
 * `chips-clickable.state`: alice holds priority (Full control) with Cephalid Illusionist, Nomads
 * en-Kor and three duals; bob holds a Lightning Bolt with his Mountains up. Round after round, by real
 * presses, alice activates Nomads at the Illusionist (two more chips: the activation and the mill
 * trigger) and passes; bob, holding a real window with his lands clickable, passes too, and the top of
 * the stack resolves. Then the stack is let run dry.
 *
 * A sampler in each seat's page reads every animation frame. Against the cards its own board draws
 * clickable (`data-selectable`) it is strict: no frame may draw a standing chip over one. Against the
 * other seat's, which reach this screen as a message (`forge:offered`), it keeps a log of which chip
 * stood over which battlefield card when, and the test fails any frame from `RELAY_GRACE_MS` after
 * that seat's board first drew the card clickable. A resolved chip fading into its own source
 * (`placed.ts`'s `fadeInto`, `data-placed-leaving`) takes no pointer and is not standing, so it is not
 * counted. `[chips]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, clickTarget, enabledOk, isOffered, makeTitled, ownNamed, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ROUNDS = 6;
/** How long the other seat's clickable cards may take to reach this screen: one relay through the server, and a frame. */
const RELAY_GRACE_MS = 1_000;

interface Sampled {
  /** Frames where a standing chip covered a card this board drew clickable. */
  covers: { at: number; chip: string; box: string; card: string; px: number }[];
  /** This board's clickable battlefield cards, each time they changed (wall-clock ms). */
  clickable: { at: number; ids: number[] }[];
  /** Which standing chip stood over which battlefield card, each time that changed (wall-clock ms). */
  over: { at: number; pairs: [string, number][] }[];
  frames: number;
  peak: number;
}

/** Every frame until `window.__chipsStop`. */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __chips: Sampled; __chipsStop: boolean };
    w.__chips = { covers: [], clickable: [], over: [], frames: 0, peak: 0 };
    w.__chipsStop = false;
    let clickableKey = '';
    let overKey = '';
    const tick = (): void => {
      if (w.__chipsStop) return;
      const at = performance.timeOrigin + performance.now();
      const chips = [...document.querySelectorAll<HTMLElement>('.placed:not([data-placed-pending]):not([data-placed-leaving]) [data-ability-chip]')];
      const cards = [...document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] [data-board-card]')];
      w.__chips.frames += 1;
      w.__chips.peak = Math.max(w.__chips.peak, chips.length);
      const clickable = cards.filter((c) => c.hasAttribute('data-selectable')).map((c) => Number(c.getAttribute('data-board-card')));
      if (clickable.join(',') !== clickableKey) {
        clickableKey = clickable.join(',');
        w.__chips.clickable.push({ at, ids: clickable });
      }
      const pairs: [string, number][] = [];
      for (const chip of chips) {
        const a = chip.getBoundingClientRect();
        const placed = chip.closest('[data-placed-spell]');
        const id = placed?.getAttribute('data-placed-spell') ?? '?';
        for (const card of cards) {
          const b = card.getBoundingClientRect();
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x <= 0 || y <= 0) continue;
          const cardId = Number(card.getAttribute('data-board-card'));
          pairs.push([id, cardId]);
          if (!card.hasAttribute('data-selectable')) continue;
          const marks = ['data-placed-held', 'data-placed-waiting'].filter((m) => placed?.hasAttribute(m) === true).map((m) => m.slice(12));
          w.__chips.covers.push({
            at: Math.round(at),
            chip: id,
            box: `${Math.round(a.width)}×${Math.round(a.height)}@${Math.round(a.left)},${Math.round(a.top)}${marks.length > 0 ? ` ${marks.join(',')}` : ''}`,
            card: `${cardId} ${card.querySelector('.card__name')?.textContent?.trim() ?? ''}`.trim(),
            px: Math.round(x * y),
          });
        }
      }
      const key = pairs.map((p) => p.join(':')).join(',');
      if (key !== overKey) {
        overKey = key;
        w.__chips.over.push({ at, pairs });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const sampled = (page: Page): Promise<Sampled> => page.evaluate(() => (window as unknown as { __chips: Sampled }).__chips);

/** The frames so far where a chip covered a card this page's own board drew clickable (the first few). */
async function ownCovers(page: Page, who: string, when: string): Promise<string[]> {
  const s = await sampled(page);
  console.log(`[chips] ${who}, ${when}: ${s.frames} frames, up to ${s.peak} chips, ${s.covers.length} covering its own clickable cards`);
  return s.covers.slice(0, 8).map((c) => `${c.chip} ${c.box} over ${c.card} (${c.px} px²) at ${c.at % 100_000}`);
}

/**
 * The stretches where a chip on `screen` stood over a card the `other` seat's board had drawn clickable
 * at least `RELAY_GRACE_MS` before: the other seat's cards, kept clear for the rest of the turn once
 * clickable (`placed.ts`'s `clickable`), as this screen heard of them.
 */
function peerCovers(screen: Sampled, other: Sampled, until: number): string[] {
  const firstClickable = new Map<number, number>();
  for (const { at, ids } of other.clickable) for (const id of ids) if (!firstClickable.has(id)) firstClickable.set(id, at);
  const out: string[] = [];
  screen.over.forEach(({ at, pairs }, i) => {
    const end = screen.over[i + 1]?.at ?? until;
    for (const [chip, card] of pairs) {
      const since = firstClickable.get(card);
      if (since !== undefined && end > since + RELAY_GRACE_MS) out.push(`chip ${chip} over card ${card} from ${Math.round(Math.max(at, since + RELAY_GRACE_MS)) % 100_000} to ${Math.round(end) % 100_000}`);
    }
  });
  return out;
}

test(titled('Breakfast, six rounds deep against a seat with a window of its own: no ability chip covers a card either player can click, on either screen'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    // As the operator plays: Fast Mode off, so each board draws every chip at its own pace.
    const asTheOperatorPlays = (p: Page): Promise<void> => setPlayFastModeDefault(p.context(), false);
    seated = await startScenarioMatch(browser, stack, 'chips-clickable', { beforeAlice: asTheOperatorPlays, beforeBob: asTheOperatorPlays });
    const page = seated.alice.page;
    const bob = seated.bob.page;
    await resizeWindow(page, { width: 1600, height: 1000 });
    await resizeWindow(bob, { width: 1600, height: 1000 });
    await expect.poll(() => ownNamed(page, 'Nomads en-Kor'), { timeout: 30_000, message: 'Nomads en-Kor is out' }).toHaveLength(1);
    const nomads = (await ownNamed(page, 'Nomads en-Kor'))[0]!;
    const illusionist = (await ownNamed(page, 'Cephalid Illusionist'))[0]!;
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');
    await startSampler(page);
    await startSampler(bob);

    /** Both screens so far: nothing over a card its own board draws clickable, nor over one the other seat's did. */
    const check = async (when: string): Promise<void> => {
      expect(await ownCovers(page, 'alice', when), `${when}: alice's screen drew no chip over a card she can click`).toEqual([]);
      expect(await ownCovers(bob, 'bob', when), `${when}: bob's screen drew no chip over a card he can click`).toEqual([]);
      const [a, b] = [await sampled(page), await sampled(bob)];
      const now = Date.now();
      expect(peerCovers(a, b, now).slice(0, 8), `${when}: alice's screen drew no chip over a card bob can click`).toEqual([]);
      expect(peerCovers(b, a, now).slice(0, 8), `${when}: bob's screen drew no chip over a card alice can click`).toEqual([]);
    };

    for (let round = 1; round <= ROUNDS; round++) {
      const before = await stackCount(page);
      expect(await clickPermanent(page, nomads), `round ${round}: Nomads en-Kor is pressed`).toBe(true);
      expect(await clickTarget(page, illusionist), `round ${round}: the Illusionist is offered as its target, and pressed`).toBe(true);
      // The activation, then the Illusionist's mill trigger, each a chip.
      await expect.poll(() => stackCount(page), { timeout: 20_000, message: `round ${round}: the activation and its trigger are on the stack` }).toBeGreaterThanOrEqual(before + 2);
      await expect.poll(() => isOffered(page, nomads), { timeout: 20_000, message: `round ${round}: priority is back with Nomads offered` }).toBe(true);
      // Alice passes; bob holds a window of his own (his Bolt), his lands clickable, and passes; the top resolves.
      await enabledOk(page).first().click();
      await expect(enabledOk(bob).first(), `round ${round}: bob holds priority over the stack`).toBeVisible({ timeout: 20_000 });
      await enabledOk(bob).first().click();
      await expect.poll(() => stackCount(page), { timeout: 20_000, message: `round ${round}: the top resolves` }).toBe(before + 1);
      await expect.poll(() => isOffered(page, nomads), { timeout: 20_000, message: `round ${round}: priority is back with alice` }).toBe(true);
      await check(`round ${round}, stack ${await stackCount(page)}`);
    }

    // Both pass until the stack is dry, the chips leaving one by one.
    await expect
      .poll(
        async () => {
          if ((await stackCount(page)) === 0) return true;
          for (const seat of [page, bob]) {
            const ok = enabledOk(seat);
            if ((await ok.count()) > 0) await ok.first().click({ timeout: 1_000 }).catch(() => undefined);
          }
          return false;
        },
        { timeout: 120_000, intervals: [250], message: 'the stack resolves' },
      )
      .toBe(true);
    // Every chip's dwell and fade, and anything that would settle late.
    await page.waitForTimeout(2_500);
    const [a, b] = [await sampled(page), await sampled(bob)];
    expect(a.peak, 'alice saw the stack deep in chips').toBeGreaterThanOrEqual(ROUNDS);
    expect(b.peak, 'and so did bob').toBeGreaterThanOrEqual(ROUNDS);
    expect(new Set(a.clickable.flatMap((c) => c.ids)).size, 'alice could click cards').toBeGreaterThan(0);
    expect(new Set(b.clickable.flatMap((c) => c.ids)).size, 'and so could bob').toBeGreaterThan(0);
    await check('resolved');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
