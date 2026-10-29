/**
 * A board wipe: every creature dies after its own hit, once, from where it was drawn. The operator,
 * 2026-10-28, of Blasphemous Act into thirteen creatures in the trailer: "11a. two creatures instantly
 * disappeared with no animation (serra angel and baneslayer angel) 11b. 6 opponent creatures all did their
 * death animation immediately before being hit by a fireball 11c. the disappeared creature suddenly
 * reappeared underneath the ones that just died and got hit by the fireball properly."
 *
 * `w79c-blasphemous.state` is the trailer's board with a flyer on each side (Birds of Paradise for alice,
 * the two angels for bob): twelve creatures, flyers and ground, on both battlefields. Alice casts
 * Blasphemous Act and both screens play the wipe with Fast Mode off, as the operator watched it.
 *
 * A sampler in each page records, on every animation frame, how each creature is drawn: in its row (`R`),
 * as the gap its row keeps (`G`), as its stand-in waiting (`S`) or playing its exit (`X`), with a hit in
 * flight at it (`P`) or its hit's flash on it (`F`), and whether the stand-in is drawn where the card was.
 * Each change is printed as a `[w79c]` line. Per creature, on each screen:
 *
 *  - 11a: from the frame it leaves its row to the frame its exit starts, its stand-in is drawn where it was;
 *  - 11b: its exit starts no earlier than its hit lands;
 *  - 11c: its exit plays once, and once it is over nothing draws the card on the battlefield again.
 */
import { expect, test, type Page } from '@playwright/test';

import { castAndPassUntil, makeTitled, offeredCard, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';
import { setPlayFastModeDefault } from './prefsLocal.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** One creature's drawing in one frame. */
interface Look {
  /** `R` row, `G` the kept gap with no stand-in, `S` stand-in waiting, `X` stand-in playing its exit, `-` nothing. */
  how: 'R' | 'G' | 'S' | 'X' | '-';
  /** A hit in flight at it. */
  aimed: boolean;
  /** Its hit's flash is on it. */
  flash: boolean;
  /** The stand-in's centre off where its card was last drawn in its row, px; -1 for no stand-in. */
  off: number;
  /** The stand-in's own opacity times its first piece's, 0–1; -1 for none. */
  opacity: number;
}

interface Sample {
  at: number;
  id: number;
  look: Look;
}

/** Every creature on either battlefield, by id, with its name and whether it flies. */
async function creatures(page: Page): Promise<{ id: number; name: string; flying: boolean }[]> {
  return page.locator('[data-zone="battlefield"] [data-board-card]:has(.board-card__pt[data-pt=""])').evaluateAll((els) =>
    els.map((e) => ({
      id: Number(e.getAttribute('data-board-card')),
      name: e.querySelector('.card__name')?.textContent?.trim() ?? '?',
      flying: e.closest('[data-flying]') !== null || e.hasAttribute('data-flying'),
    })),
  );
}

/** Records every frame's look of each card in `ids` until `window.__w79cStop`; a card's sample is kept only when it changed. */
async function startSampler(page: Page, ids: readonly number[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = window as unknown as { __w79c: Sample[]; __w79cStop: boolean; __w79cRows: { at: number; rows: string }[] };
    w.__w79c = [];
    w.__w79cRows = [];
    w.__w79cStop = false;
    let lastRows = '';
    const last = new Map<number, string>();
    const was = new Map<number, { x: number; y: number }>();
    const centre = (r: DOMRect): { x: number; y: number } => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const tick = (): void => {
      if (w.__w79cStop) return;
      const at = performance.timeOrigin + performance.now();
      for (const id of ids) {
        const row = document.querySelector<HTMLElement>(`[data-zone="battlefield"] [data-board-card="${id}"]`);
        const gap = document.querySelector<HTMLElement>(`[data-leaving-gap="${id}"]`);
        const stand = document.querySelector<HTMLElement>(`[data-departure="${id}"]`);
        if (row !== null) was.set(id, centre(row.getBoundingClientRect()));
        let how: Look['how'] = row !== null ? 'R' : gap !== null ? 'G' : '-';
        let off = -1;
        let opacity = -1;
        if (stand !== null) {
          how = stand.hasAttribute('data-exit-go') ? 'X' : 'S';
          const piece = stand.querySelector<HTMLElement>('.board-departure__piece');
          const r = (piece ?? stand).getBoundingClientRect();
          const from = was.get(id);
          const c = centre(r);
          off = from === undefined || r.width === 0 ? 9999 : Math.round(Math.hypot(c.x - from.x, c.y - from.y));
          opacity = Number(getComputedStyle(stand).opacity) * (piece === null ? 1 : Number(getComputedStyle(piece).opacity));
          opacity = Math.round(opacity * 100) / 100;
        }
        const aimed = document.querySelector(`[data-projectile][data-hit^="card:${id}:"]`) !== null;
        const flash = (row?.hasAttribute('data-hit-flash') ?? false) || stand?.querySelector('[data-hit-flash]') !== null && stand !== null;
        const look: Look = { how, aimed, flash, off: how === 'S' || how === 'X' ? Math.min(off, 9999) : -1, opacity };
        // Small wobbles of a flyer's sway are not a change.
        const key = `${how}|${aimed}|${flash}|${look.off < 0 ? -1 : Math.round(look.off / 8)}|${opacity < 0 ? -1 : opacity > 0.05 ? 1 : 0}`;
        if (last.get(id) !== key) w.__w79c.push({ at, id, look });
        last.set(id, key);
      }
      // Each battlefield's columns in order, as drawn: a card (its id), a kept place (`g` and its id), a gap (`_`).
      const rows = [...document.querySelectorAll('[data-zone="battlefield"] ul')]
        .map((ul) => [...ul.children].map((li) => (li.hasAttribute('data-leaving-gap') ? `g${li.getAttribute('data-leaving-gap')}` : li.hasAttribute('data-gap') ? '_' : (li.getAttribute('data-board-card') ?? li.querySelector('[data-board-card]')?.getAttribute('data-board-card') ?? '?'))).join(','))
        .join(' | ');
      if (rows !== lastRows) w.__w79cRows.push({ at, rows });
      lastRows = rows;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ids);
}

async function stopSampler(page: Page): Promise<{ samples: Sample[]; rows: { at: number; rows: string }[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __w79c: Sample[]; __w79cStop: boolean; __w79cRows: { at: number; rows: string }[] };
    w.__w79cStop = true;
    return { samples: w.__w79c, rows: w.__w79cRows };
  });
}

/** What the samples say of one creature: when it left its row, was hit, started and ended its exit, and what went wrong. */
function judge(samples: readonly Sample[], id: number, t0: number): { line: string; faults: string[] } {
  const mine = samples.filter((s) => s.id === id);
  const ms = (s: Sample | undefined): number | null => (s === undefined ? null : Math.round(s.at - t0));
  const leftRow = mine.find((s) => s.look.how !== 'R');
  const hit = mine.find((s) => s.look.flash);
  const go = mine.find((s) => s.look.how === 'X');
  const goIdx = go === undefined ? -1 : mine.indexOf(go);
  const end = goIdx < 0 ? undefined : mine.slice(goIdx).find((s) => s.look.how !== 'X');
  const faults: string[] = [];
  if (leftRow === undefined) faults.push('never left its row');
  if (hit === undefined) faults.push('no hit landed on it');
  if (go === undefined) faults.push('11a: no exit played');
  // 11a: from leaving its row to its exit, its stand-in is drawn, visibly, where the card was.
  const leftIdx = leftRow === undefined ? -1 : mine.indexOf(leftRow);
  const before = leftIdx < 0 ? [] : mine.slice(leftIdx, goIdx < 0 ? undefined : goIdx);
  const unseen = before.filter((s) => s.look.how !== 'S' || s.look.opacity <= 0.05 || s.look.off > 24);
  if (unseen.length > 0) faults.push(`11a: not drawn where it was from ${ms(unseen[0])}ms (${unseen.map((s) => `${ms(s)}:${s.look.how}/off${s.look.off}/op${s.look.opacity}`).join(' ')})`);
  // 11b: its exit starts after its hit lands (a few frames of grace: both are timers due at the same moment).
  if (go !== undefined && hit !== undefined && go.at < hit.at - 80) faults.push(`11b: exit at ${ms(go)}ms, before its hit at ${ms(hit)}ms`);
  // 11c: one exit, and nothing of it on the battlefield after.
  const goes = mine.filter((s, i) => s.look.how === 'X' && (i === 0 || mine[i - 1]!.look.how !== 'X')).length;
  if (goes > 1) faults.push(`11c: exit played ${goes} times`);
  const endIdx = end === undefined ? -1 : mine.indexOf(end);
  // The place it kept closes a frame later; a gap is no card drawn.
  const back = endIdx < 0 ? [] : mine.slice(endIdx).filter((s) => s.look.how !== '-' && s.look.how !== 'G');
  if (back.length > 0) faults.push(`11c: drawn again after its exit at ${back.map((s) => `${ms(s)}:${s.look.how}`).join(' ')}`);
  const line = `left ${ms(leftRow)} hit ${ms(hit)} go ${ms(go)} end ${ms(end)} | ${mine.map((s) => `${ms(s)}:${s.look.how}${s.look.aimed ? 'P' : ''}${s.look.flash ? 'F' : ''}${s.look.off >= 0 ? `/${s.look.off}` : ''}${s.look.opacity >= 0 ? `@${s.look.opacity}` : ''}`).join(' ')}`;
  return { line, faults };
}

test(titled('Blasphemous Act into twelve creatures: each one, flyer or not, dies after its own hit, once, from where it stood, on both screens'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  const slow = async (page: Page): Promise<void> => setPlayFastModeDefault(page.context(), false);
  try {
    seated = await startScenarioMatch(browser, stack, 'w79c-blasphemous', { beforeAlice: slow, beforeBob: slow });
    const pages = [seated.alice.page, seated.bob.page] as const;
    const alice = pages[0];
    await expect.poll(async () => (await creatures(alice)).length, { timeout: 30_000, message: 'the creatures are out' }).toBeGreaterThan(10);
    await alice.waitForTimeout(1_000);
    const board = await creatures(alice);
    const ids = board.map((c) => c.id);
    console.log(`[w79c] board ${JSON.stringify(board)}`);
    expect(board, 'all twelve creatures are out').toHaveLength(12);
    expect(board.filter((c) => c.flying).map((c) => c.name).sort(), 'the flyers fly').toEqual(['Baneslayer Angel', 'Birds of Paradise', 'Serra Angel']);

    const act = await offeredCard(alice, 'Blasphemous Act', { zone: 'hand' });
    for (const page of pages) await startSampler(page, ids);
    const t0 = Date.now();
    // Both screens: the opponent's plays Forge's views paced, after the caster's.
    const gone = async (): Promise<boolean> =>
      (await stackCount(alice)) === 0 &&
      (await Promise.all(pages.map(async (p) => (await p.locator('[data-departure], [data-leaving-gap]').count()) + (await creatures(p)).length))).every((n) => n === 0);
    await castAndPassUntil(pages, stack, act, [], gone, { timeoutMs: 60_000 });
    // Anything drawn late shows here.
    await alice.waitForTimeout(1_500);

    const faults: string[] = [];
    for (const [who, page] of [['alice', pages[0]], ['bob', pages[1]]] as const) {
      const { samples, rows } = await stopSampler(page);
      for (const r of rows) console.log(`[w79c] ${who} rows ${Math.round(r.at - t0)}ms ${r.rows}`);
      for (const c of board) {
        const { line, faults: f } = judge(samples, c.id, t0);
        console.log(`[w79c] ${who} ${c.name}${c.flying ? ' (flying)' : ''} #${c.id}: ${f.length === 0 ? 'ok' : f.join('; ')} :: ${line}`);
        for (const fault of f) faults.push(`${who} ${c.name}: ${fault}`);
      }
    }
    expect(faults, 'every creature dies after its own hit, once, from where it stood').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});
