/*
 * The fixture source still renders unchanged — byte for byte — and the live
 * source renders the same bytes from the same game.
 *
 * ## The baseline
 *
 * Re-recorded in Wave 22 for `f9dc909` (§C.3: a seat's furniture moved out of
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

const BASELINE_SHA256 = '78d3849befc5fd43e0e388d78ba49b758f402ee6d93cc119664899af79239695';
const BASELINE_LENGTH = 34052;

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
