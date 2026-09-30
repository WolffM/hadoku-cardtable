/*
 * The fixture source still renders unchanged — byte for byte — and the live
 * source renders the same bytes from the same game.
 *
 * ## The baseline
 *
 * Re-recorded in Wave 30 §A for item 11: `single` — one undivided battlefield,
 * no type sections — is now `boardLayout`'s default, and `fixtureMarkup()`
 * renders `<Board>` with no `boardLayout` prop at all, so this pin is exactly
 * the case that has to move. 42868 -> 41422, and every one of the 1446
 * characters is accounted for — computed by rendering both the old
 * (`boardLayout: 'type-separated'`) and new (no prop) markup for the same
 * fixture and diffing the real strings, not estimated:
 *
 *  -1538  removed from each seat's battlefield, the type-separated alternate's
 *         own wrapping, now drawn only when `boardLayout: 'type-separated'`
 *         is passed explicitly: two `<ul class="zone__rows" style="--cols:N">`
 *         (+`</ul>`, 90B), eight `<li class="zone__row" data-board-row="…"
 *         [data-empty="true"] style="--cols:N">` lane wrappers (+`</li>`,
 *         624B), eight `<h5 class="zone__row-head">Lands <span
 *         class="zone__count">N</span></h5>`-shaped lane labels (592B), and
 *         the eight bare `<ul class="zone__cards">` (+`</ul>`) those lanes
 *         held their cards in (232B) — 90 + 624 + 592 + 232 = 1538.
 *   +92   added, one per seat: the single flat `<ul class="zone__cards"
 *         style="--cols:N">` (+`</ul>`) that replaces all of the above —
 *         `Battlefield`'s `single` branch reusing the hand's own `--cols`
 *         device (`board.css`'s `.seat > .zone--battlefield > .zone__cards`
 *         header has the sizing this enables) rather than inventing a second.
 *  ─────
 *  -1446  42868 -> 41422, and 92 - 1538 = -1446 exactly. Nothing else on the
 *         page changed: no seat furniture, no piles, no hand, no stack — item
 *         11 touches only the battlefield's own markup.
 *
 * Re-recorded in Wave 28 §A for the play surface's state layer (§A.15) and the
 * seat's symbol counts (§A.10). That change does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 42286 -> 42868, and every one of the 582 characters is accounted for:
 *
 * +1226  the four seat COUNTS became a drawn mark and a number (§A.10, the
 *        operator: *"can we get symbols to display hand/deck size instead of
 *        words?"*). `<span data-testid="hand-count">hand 2</span>` (44) became
 *        337, and the library's 51 became 371: a wrapper class, an `aria-label`
 *        carrying the word the symbol replaced, a three-path `<svg>` for the hand
 *        and a four-path one for the library, and the number in its own span.
 *        190 -> 1416 over the four of them.
 *  -644  every status CHIP, gone (§A.15, *"all the shitty text you have written
 *        on the card looks ugly"*). Six cards on this board are tapped — Izzet
 *        Guildgate 8, Island 24, Izzet Guildgate 6, Mountain 87, Mountain 78 and
 *        Vulshok War Boar 99 — and each carried a one-chip list at
 *        `96 + len(name)` characters: 6 x 96 plus 68 characters of card name.
 *    ±0  the rest of the state layer contributes NOTHING here, and that is the
 *        fixture being honest rather than the layer being absent: no card in the
 *        captured game is summoning sick, attacking, blocking, a token, damaged
 *        or carrying a counter (checked, card by card), so no `data-sick`,
 *        `data-attacking`, `data-blocking`, `data-token`, `data-damage`,
 *        `.board-card__marks` or `.board-card__counters` is emitted. The
 *        `Board.test.ts` cases for those build their own view.
 *    ±0  `data-question` on `.board__mid` (§A.7/§13) is absent: this test renders
 *        `<Board>` with no `interaction` prop, so no question can be open.
 *    ±0  `data-avatar` on a face (§A.4) is absent: nothing populates
 *        `BoardPlayer.avatarId` yet, which the field's own doc says is the state
 *        of the feature, and `PlayerFace` draws the generated mark for a seat
 *        without one.
 *  ─────
 *  +582  42286 -> 42868, and 1226 - 644 = 582 exactly.
 *
 * Re-recorded in Wave 27 for `3bb983d` (lane A: a lane's `flex-grow` stopped
 * being its PILE count and became the COLUMNS it draws, and `--rows` became one
 * decision per battlefield instead of one per lane — the budget bug that let a
 * two-row lane ask for two rows of width and spend one, starving its neighbour
 * down to 27px cards). That commit does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 42233 -> 42286, and every one of the 53 characters is accounted for:
 *
 *   +28  the two `<ul class="zone__rows">` gained `style="--cols:N"`. This is
 *        the fix itself: the zone decides `--rows` once, so the zone is where
 *        the total column count has to be written. CSS could not take it —
 *        a lane is `contain: size`, so nothing inside one contributes to its
 *        width, and no selector sums across the four lanes.
 *   -18  six lanes swapped `style="flex-grow:N"` (11 chars) for
 *        `style="--cols:N"` (8). The other two lanes' swaps are folded into
 *        the +28 above, because each is the same tag as its `zone__rows`.
 *   +17  the viewer's hand list gained `style="--cols:5"`. Graveyards and
 *        exiles did NOT: they are piles sized by their own box, so `--cols` there
 *        would be dead markup — and writing it would have made this delta
 *        roughly +150 instead of +53.
 *   +26  four `<span>` wrappers, and these are §A.7: `inOurWords` no longer
 *        rewrites `{T}` to the literal word `TAP`, so rules text is now split
 *        into `ManaPip` symbols and `<span>` text pieces. `ms-tap` appears 10
 *        times both before and after and the word `TAP` zero times both times —
 *        this fixture's text carries no `{T}` at all, so what the pin sees of
 *        §A.7 is the span split, not the symbol.
 *   ─────
 *   +53  42233 -> 42286, and 28 - 18 + 17 + 26 = 53 exactly.
 *
 * Checked the strong way the paragraph below demands, and the answer is
 * narrower than lane A predicted. Of the five files the pin depends on, only
 * two moved this wave: `../Board.tsx` (lane A) and `../../components/CardTile.tsx`
 * (lane F, which wired hover/select sound cues). Reverting `CardTile.tsx` ALONE
 * leaves 42286 — F moved nothing here, because a cue is an event handler and an
 * event handler is not markup. Reverting `../Board.tsx` alone makes this test
 * PASS at 42233. So the whole +53 is lane A's, and `../adapter.ts`,
 * `../fixtures.ts` and `ManaPip.tsx` did not move.
 *
 * Lane D deleted `styles.css`'s 16 pre-D20 `.pip` rules this wave and that is
 * invisible here, as it must be: Wave 26's note below predicted the
 * `display: contents` shim would "collapse once that section is gone", but the
 * shim lives in `ManaPip.tsx`, which no lane owned, so it is still emitted on
 * every pip. The 2537 characters it costs are still in this number. Deleting
 * it is a later wave's, and it will move this pin again.
 *
 * Re-recorded in Wave 26 for `473571d` (lane C: every mana pip, the tap symbol
 * and the set symbols became Keyrune/Mana glyphs under D20) and `f6d15b6`
 * (lane A: the table re-blocked as the operator drew it — four rows with the
 * hands outermost, the piles moved into the left column's lower cell, every
 * zone panel and caption deleted, the turn bar deleted, a right gutter
 * reserved for the permanent overlays, and the seat's mana pool drawn for the
 * first time). NEITHER commit owns this file, so the pin is re-recorded here
 * immediately after them, as the paragraph below prescribes. 7385 characters
 * arrived, 34848 -> 42233, and the two lanes are separable:
 *
 * +7988  lane C, measured by reverting `../../components/ManaPip.tsx` and
 *        `CardTile.tsx` alone: 2537 the `display: contents` compatibility shim
 *        on 59 pips, 3692 the new set symbols, 929 the pip markup itself, and
 *        830 the hover `title` added to the glyph. The shim is there because
 *        `styles.css` still carries the pre-D20 `.pip` disc rules and no lane
 *        this wave owned that file; deleting that section collapses it.
 *  -603  lane A: -219 the `<header class="board__bar">`, -562 eight
 *        `<h4 class="zone__head">` (two battlefields, two hands, two
 *        graveyards, two exiles), -32 the `<div class="zone__gutter">`, +210
 *        two `<ul class="seat__mana">` at 105 each. The graveyard `<section>`
 *        moved again and, as in Wave 25, the diff is an insert and a delete of
 *        the SAME bytes; `zone__regroup` -> `seat__regroup` is the same length.
 *  ─────
 * +7385  34848 -> 42233, and 7988 - 603 = 7385 exactly.
 *
 * Checked the strong way, and this is worth recording because the first
 * diagnosis of it was WRONG: reverting only `../Board.tsx` and `../adapter.ts`
 * leaves 42836, which reads like a pre-existing red and was reported as one.
 * It is not. Reverting all FOUR files the pin actually depends on —
 * `../Board.tsx`, `../adapter.ts`, `../../components/CardTile.tsx` and
 * `ManaPip.tsx` — to `origin/main` makes this test PASS at 34848, which is
 * what proves the whole delta is this wave's and that `../fixtures.ts` did not
 * move. `2939301` shipped the font FILES and moved no markup. A revert that
 * leaves another lane's change in the tree is not a baseline.
 *
 * Lane B moved nothing here, as this file's own rule predicts: it renders
 * `Board` alone, and B owns nothing `Board` imports.
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
 * **It renders `Board` and nothing else** — but `Board` is not a leaf, and in
 * Wave 26 that distinction cost a wrong diagnosis. A failure here is a change
 * to `../Board.tsx`, `../adapter.ts` or `../fixtures.ts`, OR to anything they
 * render: `../../components/CardTile.tsx` and, through it,
 * `../../components/ManaPip.tsx`. Never to anything under `live/`. Before
 * blaming a commit, revert ALL of those to the last green ref and confirm this
 * test passes — a revert that leaves a sibling lane's change in the tree
 * measures both and reads like a pre-existing red. Re-recording the two numbers belongs with the commit that makes the
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

const BASELINE_SHA256 = 'f08df2ae50d3b03e9f4842ff1bd565df004690273d50308f31139da1353e73cf';
const BASELINE_LENGTH = 41422;

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
