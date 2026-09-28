/*
 * The fixture source still renders unchanged — byte for byte — and the live
 * source renders the same bytes from the same game.
 *
 * ## The baseline
 *
 * Re-recorded in Wave 25 for `3710618` (lane E: the hand gained the same free
 * arrangement the battlefield has, the graveyard moved under the portrait and
 * its counts, and a claimed press selects no text). That commit does not own
 * this file, so the pin is re-recorded here immediately after it, as the
 * paragraph below prescribes. 94 characters arrived, and the whole of the
 * change is the hand's new `draggable` plus one relabelled control:
 *
 *   +85  five `draggable="true"` attributes, 17 characters each — one per card
 *        of the VIEWER's own hand, which is the lane's first defect: the hand
 *        `<Zone>` was passed no arrangement, so `draggable` was false for every
 *        card in it. `draggable="true"` therefore goes 5 -> 10 in this markup:
 *        the five battlefield cards the ledger above pinned, plus these five.
 *        The opponent's hand is a count, not cards, so it contributes none.
 *    +9  `aria-label="Regroup your battlefield"` -> `"… battlefield and hand"`,
 *        because the one reset control now clears both slots of the store.
 *    ±0  BOTH graveyard `<section>`s moved — out of `.seat__piles`' column and
 *        into the foot of `.seat__who` — and the diff is an insert and a delete
 *        of the SAME bytes: 3498 for `data-owner="them"`, 3581 for
 *        `data-owner="you"`. A zone that moved without its markup changing is
 *        exactly what a grid-area move should look like here.
 *    ±0  `data-selectable` is still 0: this test renders `<Board>` with no
 *        `interaction` prop, so nothing Forge offers can reach it.
 *  ─────
 *   +94  34754 -> 34848, and 85 + 9 = 94 exactly.
 *
 * That ledger is a measurement, not an estimate, and it was checked the strong
 * way: `Board.tsx` alone was reverted to `c698ae5` in the working tree and this
 * test PASSED at the previous pin, which is what proves the whole delta is
 * `Board.tsx` and that neither `../adapter.ts` nor `../fixtures.ts` moved.
 *
 * Re-recorded in Wave 24 for `c239b6b` (lane A: the battlefield gained free
 * placement and stacking, equipment folded onto what it equips, a P/T badge
 * that distinguishes buffed from damaged, and haste stopped wearing the
 * summoning-sickness chip). That commit does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 702 characters arrived and the whole of the change is the P/T badge:
 *
 *  +702  three `.board-card__pt` badges, 234 characters each — one per creature
 *        on a battlefield in the fixture (Vulshok War Boar 5/5, Goblin Replica
 *        2/2, Fire Urchin 1/3). All three render PLAIN, because no card of the
 *        captured game is in the cube pool and the printed base is what decides
 *        whether a number is buffed — so none carries a state attribute or a
 *        marker glyph, and all three are the same length.
 *    ±0  piles: `data-pile-size` / `data-pile-depth` do not occur. The fixture
 *        carries no arrangement, and a lone card renders exactly the markup it
 *        rendered before — no wrapper, no nested list, no attribute.
 *    ±0  `data-attached` does not occur: the capture has no attachment.
 *    ±0  no damage chip was traded for a badge — no battlefield card in the
 *        fixture has `Damage`.
 *    ±0  `draggable` is unchanged at 5 and `data-selectable` at 0: this test
 *        renders `<Board>` with no `interaction` prop, so lane A's new rule
 *        that an offered card is not draggable cannot bite here.
 *  ─────
 *  +702  34052 -> 34754, and 3 x 234 = 702 exactly.
 *
 * That ledger is a measurement, not an estimate, and it was checked the strong
 * way: extract the three badges by walking their balanced `<span>`s and the
 * remainder is 34052 characters with sha256
 * `78d3849befc5fd43e0e388d78ba49b758f402ee6d93cc119664899af79239695` — byte for
 * byte the PREVIOUS baseline. So the three badges are the whole of the change
 * and nothing else in the board's markup moved, which is exactly what this
 * test exists to be able to say.
 *
 * Before that, re-recorded in Wave 22 for `f9dc909` (§C.3: a seat's furniture moved out of
 * its wide `seat__head` strip into the vertical `seat__who` bar — the avatar,
 * the name and the counts in one narrow column). 97 characters left, and the
 * whole of the change is that move; §C.1 (no rotated labels) and §C.2 (the
 * preview anchors top-left) are a stylesheet and a pure function and render no
 * markup. The ledger, both seats together:
 *
 *   -54  `<header class="seat__head">` gone
 *   +84  `<div class="seat__who" data-player-bar="">`
 *   +50  `<div class="seat__ident">`
 *    +6  each seat's `</header>` → `</div></div>`
 *    +2  `<span class="seat__meta">` → `<div class="seat__counts">`
 *    -2  and its `</span>` → `</div>`
 *   -10  `data-testid="face-life"` → `data-testid="life"`
 *  -173  the duplicate `.seat__life` pill, deleted: a seat drew its life twice,
 *        once on the avatar and once beside the name, and the narrow bar has
 *        room for one. `data-testid="life"` is the badge on the avatar now,
 *        which is what `e2e/play.spec.ts` reads.
 *
 * Before that, in Wave 20 at `dcb2e60` (§A: the battlefield grouped into
 * `data-board-row` rows with a gutter and a reset control, and the faces moved
 * to the ends), and in Wave 19 (Board gained faces, fixed zones and
 * stack art: 5c42535, 48d8266). `BASELINE_SHA256` / `BASELINE_LENGTH` are the static markup of
 * `<Board view={boardFromFixture(PLAY_FIXTURES[0])} />`, recorded at commit
 * 2709447 — Wave 9's base, BEFORE this lane touched `../adapter.ts` or added
 * anything under `live/`. If this test fails, the fixture path renders
 * differently than it did before the live source existed, which is precisely
 * the regression the fixture exists to catch. If the change is intended (a
 * deliberate Board or adapter change in a later wave), re-record both numbers
 * from the failure message and say so in that commit.
 *
 * `Board.test.ts` and `fold.test.ts` are the finer-grained net and are not
 * modified by this lane; this is the coarse one that sees every byte.
 *
 * **It renders `Board` and nothing else**, so a failure here is a change to
 * `../Board.tsx`, `../adapter.ts` or `../fixtures.ts` — never to anything under
 * `live/`. Re-recording the two numbers belongs with the commit that makes the
 * markup change — or, when that commit does not own this file, immediately
 * after it, naming it (as the paragraph above does for `dcb2e60`).
 */

import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Board } from '../Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { closeMatch, socketIoMatchTransport, startMatch, type LiveMatch } from './match.ts';
import { fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';

const BASELINE_SHA256 = 'c2a8bb754745f97a2ecc27d8ee13b0bd4cc81aad03e703782f2f4145cf15d32e';
const BASELINE_LENGTH = 34848;

const fixtureMarkup = (): string =>
  renderToStaticMarkup(createElement(Board, { view: boardFromFixture(PLAY_FIXTURES[0]!) }));

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterAll(async () => {
  if (match !== null) closeMatch(match);
  if (server !== null) await server.close();
});

describe('the fixture source', () => {
  it('renders exactly the markup it rendered before the live source existed', () => {
    const html = fixtureMarkup();
    const digest = createHash('sha256').update(html).digest('hex');
    expect({ length: html.length, sha256: digest }).toEqual({ length: BASELINE_LENGTH, sha256: BASELINE_SHA256 });
  });
});

describe('the live source', () => {
  it('renders the same bytes as the fixture, from the same game over a real socket', async () => {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    await until('the join snapshot', () => m.stats.snapshots === 1);
    const frames = fixtureFrames();
    for (const f of frames) s.send(f);
    await until('every frame applied', () => m.stats.applied === frames.length);

    expect(renderToStaticMarkup(createElement(Board, { view: m.view! }))).toBe(fixtureMarkup());
  });
});
