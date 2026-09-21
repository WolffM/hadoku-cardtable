/*
 * The fixture source still renders unchanged — byte for byte — and the live
 * source renders the same bytes from the same game.
 *
 * ## The baseline
 *
 * `BASELINE_SHA256` / `BASELINE_LENGTH` are the static markup of
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
 */

import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Board } from '../Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { closeMatch, socketIoMatchTransport, startMatch, type LiveMatch } from './match.ts';
import { fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';

const BASELINE_SHA256 = 'b92179c358b63d65580a7bd38931d3dd1d6bb6f82b654c2fdcdbe81ed19139c5';
const BASELINE_LENGTH = 27524;

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
