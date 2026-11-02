/**
 * Wave 90 lane B, item 6 — the hub strip. The operator: "a real bug here for the site … this
 * appears to be totally broken on desktop also." Measured, both widths: another table's strip
 * draws its left side empty and the score on top of the opponent's name ("0–0night"), "Game 1"
 * sits under the score, and the "⋯" drops to a second row.
 *
 * Cause (`TableCard.tsx` / `TableCard.css`): `.table-card__strip` is a 4-column grid
 * (`minmax(0,1fr) auto minmax(0,1fr) 32px`). Anybody else's card renders a FIFTH child, the go
 * link (`{!mine && goLink}`), explicitly placed at `grid-row: 1; grid-column: 1`. The four
 * auto-placed children (player 0, the score, player 1, the ⋯ or its slot) shift one column right
 * to avoid that occupied cell, overlapping and wrapping. My own table never shows the bug: its way
 * in is a chip inside the score, never a fifth grid child.
 *
 * A Gauntlet tournament of two humans + two AI, seated 0..3: round 1's pairing is deterministic by
 * seat (`@hadoku/draft`'s `round1`, seat `i` against seat `i + half`), so seats [alice, bob, AI,
 * AI] always pairs alice-vs-AI and bob-vs-AI — never AI-vs-AI, which the server settles on the
 * spot with no table at all (`#pairRound`'s own note) and so never shows the bug. Bob never opens
 * a page; his own table stays live (not done) because nobody has pressed Ready at it.
 *
 * At 1440 and at phone width, on the OTHER (bob-vs-AI) table's strip: player 0, the score,
 * player 1 and the ⋯ sit on one row, left to right, no two rects overlapping. Watch still opens
 * it. Needs a Forge build (the Gauntlet's eras come from its decks); without one the test SKIPS
 * with a title that says why. `[w90b-hub-strip]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { SESSION_COOKIE } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;

interface StripMeasure {
  found: boolean;
  rows: string[];
  sameRow: boolean;
  overlaps: string[];
}

/** The hub's "other" (not-mine) table card's strip: player 0, the score, player 1 and the ⋯ (or its slot). */
async function measureOtherStrip(page: Page): Promise<StripMeasure> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="pod-tables-row"]:not([data-mine])');
    if (card === null) return { found: false, rows: [], sameRow: true, overlaps: [] };
    const pick = (sel: string): HTMLElement | null => card.querySelector<HTMLElement>(sel);
    const named: [string, HTMLElement | null][] = [
      ['player0', pick('.table-card__player[data-side="left"]')],
      ['score', pick('.table-card__score')],
      ['player1', pick('.table-card__player[data-side="right"]')],
      ['more', pick('.table-card__more') ?? pick('.table-card__more-slot')],
    ];
    const rects = named.map(([name, el]) => [name, el === null ? null : el.getBoundingClientRect()] as const);
    const rows = rects.map(([name, r]) => `${name} ${r === null ? 'MISSING' : `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`}`);
    const present = rects.filter((r): r is [string, DOMRect] => r[1] !== null);
    const tops = present.map(([, r]) => r.top);
    // A grid row's own children can sit a few px apart (`align-items: center` over different
    // heights — the score is taller than a player row); a wrap to a second row moves a whole row
    // height (≈30px+), so 15px tells the two apart without being pedantic about centering.
    const sameRow = tops.length > 0 && Math.max(...tops) - Math.min(...tops) <= 15;
    const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const overlaps: string[] = [];
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        if (overlap(present[i]![1], present[j]![1])) overlaps.push(`${present[i]![0]}~${present[j]![0]}`);
      }
    }
    return { found: true, rows, sameRow, overlaps };
  });
}

test(titled('a tournament hub’s OTHER table strip keeps player 0, the score, player 1 and ⋯ on one row at 1440 and phone width, and Watch still opens it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = async <T>(method: 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> => {
      const res = await alice.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data: data ?? {} });
      return { status: res.status(), body: (await res.json()) as T };
    };
    const created = await api<{ id: string }>('POST', '/rooms', { name: `e2e w90b hub strip ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
    // Bob never opens a page: his own seat is enough to keep his table a real, live pairing
    // instead of an instantly-settled AI-vs-AI one (see the header).
    const bob = await alice.context.browser()?.newContext();
    if (bob === undefined) throw new Error('could not open a second context for bob');
    await bob.addCookies([{ name: SESSION_COOKIE, value: 'bob', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    for (const [path, data] of [
      ['join', {}],
      ['pod/sit', { seat: 1 }],
      // `#lockTournament` requires every HUMAN ready before it deals round 1 at all; bob's own
      // table must stay live afterwards, which it does — being ready paired it, it does not play it.
      ['ready', { ready: true }],
    ] as const) {
      const res = await bob.request.post(`${stack.origin}${PREFIX}/api/rooms/${roomId}/${path}`, { data });
      expect(res.status(), `bob: ${path}`).toBe(200);
    }
    for (const seat of [2, 3]) expect((await api('POST', `/rooms/${roomId}/pod/ai`, { seat, on: true })).status).toBe(200);

    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.getByTestId('pod-seat-3'), 'the lobby seats the second AI').toHaveAttribute('data-ai', '', { timeout: UI_TIMEOUT });
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('table-page'), 'paired: carried to my table').toBeVisible({ timeout: UI_TIMEOUT });
    await alice.page.getByTestId('table-hub').click();
    await expect(alice.page.getByTestId('pod-rounds'), 'the hub').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.locator('[data-testid="pod-tables-row"]:not([data-mine])'), 'the other (bob vs AI) table exists').toHaveCount(1, { timeout: UI_TIMEOUT });

    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await resizeWindow(alice.page, size);
      const m = await measureOtherStrip(alice.page);
      console.log(`[w90b-hub-strip] ${size.width}×${size.height}: ${m.rows.join(' | ')}`);
      expect(m.found, `${size.width}: the other table's strip is found`).toBe(true);
      expect(m.sameRow, `${size.width}: player0/score/player1/⋯ on one row — ${m.rows.join(' | ')}`).toBe(true);
      expect(m.overlaps, `${size.width}: no two rects overlap — ${m.rows.join(' | ')}`).toEqual([]);
    }

    // The go link still works: Watch opens the table.
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    const other = alice.page.locator('[data-testid="pod-tables-row"]:not([data-mine])');
    await other.click({ position: { x: 20, y: 20 } });
    await expect(alice.page.getByTestId('table-page'), 'Watch opened the other table').toBeVisible({ timeout: UI_TIMEOUT });
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});
