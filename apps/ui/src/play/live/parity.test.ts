/*
 * The live source renders the same board as the fixture source, from the same
 * game: the committed capture replayed over a real socket into `startMatch`,
 * and its view rendered beside the one `boardFromFixture` folds directly. Any
 * difference is a fold or adapter path the two sources do not share.
 *
 * What the fixture board itself looks like is `../Board.test.ts`'s, case by
 * case; a whole-markup hash here could only say that something moved.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Board } from '../Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { closeMatch, socketIoMatchTransport, startMatch, type LiveMatch } from './match.ts';
import { fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';

const fixtureMarkup = (): string =>
  renderToStaticMarkup(createElement(Board, { view: boardFromFixture(PLAY_FIXTURES[0]!) }));

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterAll(async () => {
  if (match !== null) closeMatch(match);
  if (server !== null) await server.close();
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
