/**
 * Batterskull resolves without the board changing size. The operator, 2026-10-16: *"i noticed a
 * weird bug when i played batterskull. i saw the entire board resize briefly. i wonder if it had to
 * do with the germ being played and then the batterskull behind it?"*
 *
 * `bs-batterskull.state`: alice casts Batterskull with eight Plains out, a creature and an artifact
 * already in her front tier. It lands as an artifact; its living-weapon trigger makes a 0/0 Phyrexian Germ,
 * which arrives from Batterskull, and attaches Batterskull to it, so Batterskull joins the Germ's
 * pile. Batterskull is let go in a column the board already draws (over the sixth Plains), so the
 * Plains are the busiest tier before and after and nothing about the final board asks for a different
 * card size — and Batterskull stays where it was let go, the Germ arriving under it there.
 *
 * A sampler in alice's page records, on every animation frame from the cast until the Germ has
 * settled, each box whose size is the board's: the canvas, both battlefields, every battlefield
 * list's measured `--zone-w`/`--zone-h`, a Plains' drawn width (a card nothing here touches), and
 * whether the page or any zone of the board has to scroll. Every one must hold its first value in
 * every frame. Each change is printed as a `[bs]` line.
 */
import { expect, test, type Page } from '@playwright/test';

import { dragHandCard, handCardNamed, makeTitled, offered, ownNamed, pressPaymentAuto, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Frame {
  t: number;
  /** Every size the board is drawn at, as one comparable string per box. */
  sizes: Record<string, string>;
  /** Boxes that had to scroll this frame. */
  scrolls: string[];
  /** What the Germ and Batterskull are doing, for the evidence lines. */
  state: string;
}

/** Records every frame until `window.__bsStop` is set; each frame keeps only what changed. */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __bs: Frame[]; __bsStop: boolean };
    w.__bs = [];
    w.__bsStop = false;
    const t0 = performance.now();
    const box = (el: Element | null): string => {
      if (el === null) return '-';
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const named = (name: string): HTMLElement | null =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] li.board-card')).find(
        (el) => el.querySelector(':scope > .board-card__face .card__name')?.textContent?.includes(name) ?? false,
      ) ?? null;
    const describe = (el: HTMLElement | null): string => {
      if (el === null) return 'absent';
      const attrs = ['data-pile-size', 'data-pile-depth', 'data-attached', 'data-cast-landing', 'data-arriving-from']
        .filter((a) => el.hasAttribute(a))
        .map((a) => `${a.replace('data-', '')}=${el.getAttribute(a)}`);
      const tier = el.closest('[data-tier], .zone__cards')?.getAttribute('data-tier') ?? '';
      return `${box(el)}${tier === '' ? '' : ` ${tier}`}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}`;
    };
    const tick = (): void => {
      if (w.__bsStop) return;
      const sizes: Record<string, string> = {};
      const scrolls: string[] = [];
      const page = document.scrollingElement ?? document.documentElement;
      sizes.window = `${innerWidth}x${innerHeight}`;
      sizes.board = box(document.querySelector('.board'));
      if (page.scrollHeight > innerHeight || page.scrollWidth > innerWidth) scrolls.push(`page ${page.scrollWidth}x${page.scrollHeight}`);
      for (const owner of ['you', 'them']) {
        const zone = document.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="${owner}"]`);
        sizes[`${owner}.battlefield`] = box(zone);
        if (zone === null) continue;
        const lists = Array.from(zone.querySelectorAll<HTMLElement>('.zone__cards'));
        lists.forEach((list, i) => {
          const s = getComputedStyle(list);
          sizes[`${owner}.list${i}`] = `zone ${s.getPropertyValue('--zone-w')}x${s.getPropertyValue('--zone-h')} cols ${s.getPropertyValue('--cols')} rows ${s.getPropertyValue('--rows')}`;
        });
        for (const el of [zone, ...Array.from(zone.querySelectorAll<HTMLElement>('.zone__tiers, .zone__rows, .zone__row, .zone__cards'))]) {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
            scrolls.push(`${owner} ${el.className} ${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight}`);
          }
        }
        const card = zone.querySelector<HTMLElement>('li.board-card:not([data-pile-size])');
        sizes[`${owner}.cardWidth`] = card === null ? '-' : getComputedStyle(card).width;
      }
      const plains = named('Plains');
      sizes.plainsWidth = plains === null ? '-' : getComputedStyle(plains).width;
      const ghosts = document.querySelectorAll('[data-cast-ghost]').length;
      w.__bs.push({
        t: Math.round(performance.now() - t0),
        sizes,
        scrolls,
        state: `germ ${describe(named('Germ'))} | batterskull ${describe(named('Batterskull'))} | ghosts ${ghosts}`,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampler(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __bs: Frame[]; __bsStop: boolean };
    w.__bsStop = true;
    return w.__bs;
  });
}

test(titled('Batterskull: the Germ arrives and Batterskull joins its pile without the board changing size in any frame'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'bs-batterskull');
    const page = seated.alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    await expect.poll(() => ownNamed(page, 'Plains'), { timeout: 30_000, message: 'alice has her eight Plains out' }).toHaveLength(8);
    const batterskull = await handCardNamed(page, 'Batterskull');
    expect(batterskull, 'Batterskull is in alice’s hand').not.toBeUndefined();

    // Let go in the front tier, over the sixth Plains: a column the board already draws, whatever the
    // window's width leaves the battlefield. A release past the busiest tier's last column adds a column
    // (the player's own gap), which is not what this case is about.
    const at = await page.evaluate(() => {
      const zone = document.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
      const front = zone.querySelector<HTMLElement>('.zone__cards[data-tier="front"]')!.getBoundingClientRect();
      const plains = Array.from(zone.querySelectorAll<HTMLElement>('.zone__cards[data-tier="back"] > li.board-card'))
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      const column = plains[5]!;
      return { x: Math.round(column.left + column.width / 2), y: Math.round(front.top + front.height / 2) };
    });
    await startSampler(page);
    // Cast by a real drag. Nobody holds priority over it, so it can reach the stack and resolve
    // between two polls: the proof it was cast is that it left the hand.
    const inHand = () => page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${batterskull!}"]`).count();
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Batterskull is offered' }).toContain(batterskull!);
    expect(await dragHandCard(page, batterskull!, at), 'Batterskull lifted out of alice’s hand').toBe(true);
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(page);
          return inHand();
        },
        { timeout: 15_000, message: 'Batterskull was cast' },
      )
      .toBe(0);

    // The trigger resolves: the Germ is on the battlefield with Batterskull in its pile, nothing is
    // on the stack, and no landing is still in flight. Then a second more, for anything that settles late.
    const settled = () =>
      page.evaluate(() => {
        const germ = Array.from(document.querySelectorAll<HTMLElement>('[data-zone="battlefield"] li.board-card')).find(
          (el) => el.querySelector(':scope > .board-card__face .card__name')?.textContent?.includes('Germ') ?? false,
        );
        if (germ === undefined) return 'no Germ';
        if (germ.getAttribute('data-pile-size') !== '2') return `Germ pile ${germ.getAttribute('data-pile-size')}`;
        if (document.querySelector('[data-cast-ghost], [data-cast-landing], [data-arriving-from]') !== null) return 'landing';
        return 'settled';
      });
    await expect.poll(settled, { timeout: 30_000, message: 'the Germ is out, carrying Batterskull' }).toBe('settled');
    expect(await stackCount(page), 'the stack is empty').toBe(0);
    await page.waitForTimeout(1_000);
    const frames = await stopSampler(page);

    // The evidence: the first frame in full, then every frame where a size, a scroll or the cards' state changed.
    const first = frames[0]!;
    console.log(`[bs] ${frames.length} frames over ${frames.at(-1)!.t} ms; first: ${JSON.stringify(first.sizes)}`);
    let prev = first;
    const changed: string[] = [];
    for (const f of frames.slice(1)) {
      const diffs = Object.keys(f.sizes).filter((k) => f.sizes[k] !== prev.sizes[k]);
      const scroll = f.scrolls.join('; ') !== prev.scrolls.join('; ');
      if (diffs.length > 0 || scroll || f.state !== prev.state) {
        console.log(`[bs] t=${f.t} ${diffs.map((k) => `${k}: ${prev.sizes[k]} -> ${f.sizes[k]}`).join(', ')}${f.scrolls.length > 0 ? ` SCROLL ${f.scrolls.join('; ')}` : ''} || ${f.state}`);
      }
      for (const k of Object.keys(f.sizes)) if (f.sizes[k] !== first.sizes[k]) changed.push(`t=${f.t} ${k}: ${first.sizes[k]} -> ${f.sizes[k]}`);
      prev = f;
    }
    expect(frames.length, 'the sampler saw the resolution').toBeGreaterThan(30);
    expect(frames.some((f) => f.state.includes('arriving-from')), 'the Germ arrived from Batterskull while sampled').toBe(true);
    expect(
      frames.filter((f) => f.scrolls.length > 0).map((f) => `t=${f.t} ${f.scrolls.join('; ')}`),
      'no frame has a scrolling page or battlefield',
    ).toEqual([]);
    expect(changed, 'every board size holds its first value in every frame').toEqual([]);
    // Batterskull stays in the column it was let go at, and the Germ that carries it arrives there.
    const left = (state: string, name: string): number | null => {
      const m = new RegExp(`${name} (-?\\d+),`).exec(state);
      return m === null ? null : Number(m[1]);
    };
    const landed = frames.find((f) => /batterskull \d+,\d+ \S+ front cast-landing=/.test(f.state));
    expect(landed, 'Batterskull was drawn landing').not.toBeUndefined();
    console.log(`[bs] let go at x=${at.x}; landed ${left(landed!.state, 'batterskull')}; germ ${left(frames.at(-1)!.state, 'germ')}`);
    expect(left(frames.at(-1)!.state, 'germ'), 'the Germ is in the column Batterskull landed in').toBe(left(landed!.state, 'batterskull'));
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
