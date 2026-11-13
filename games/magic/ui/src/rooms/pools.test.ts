/*
 * A cube's card list, read once for the page: the draft lobby and the pod each hold a pools
 * client of their own and warm the same cube's art from it, and the list changes only when the
 * cube is refreshed, re-imported or deleted.
 */
import { describe, expect, it } from 'vitest';

import type { DraftCard } from '@hadoku/shared';
import type { Fetch } from '@hadoku/game-ui/http.ts';
import { poolsClient } from './api.ts';

const CARD: DraftCard = {
  cardId: 'c-1',
  name: 'Island',
  manaCost: [],
  manaValue: 0,
  colors: [],
  typeLine: 'Basic Land — Island',
  oracleText: '',
  setCode: 'LEA',
  collectorNumber: '1',
  rarity: 'common',
};
const SUMMARY = { id: 'cc-vintage', name: 'Vintage', size: 1, origin: 'cubecobra', cubeCobraId: 'vintage', importedBy: 'p-alice', importedAt: '', refreshedAt: null, verdict: null, artId: null };

/** A server with one cube; `cardsFail` answers its card list 503 once. */
function stubServer() {
  const reads: string[] = [];
  let cardsFail = false;
  const fetchImpl: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/cards')) {
      reads.push(url);
      if (cardsFail) {
        cardsFail = false;
        return new Response('{}', { status: 503 });
      }
      return Response.json([CARD]);
    }
    if (method === 'POST' && url.endsWith('/refresh')) return Response.json(SUMMARY);
    if (method === 'POST' && url.endsWith('/import')) return Response.json(SUMMARY, { status: 201 });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('{}', { status: 404 });
  };
  return {
    fetch: fetchImpl,
    reads,
    failNextRead: () => {
      cardsFail = true;
    },
  };
}

describe("a cube's card list", () => {
  it('is read once for the page, by every screen that asks, at once or later', async () => {
    const server = stubServer();
    const lobby = poolsClient(server.fetch, '/api/');
    const pod = poolsClient(server.fetch, '/api/');
    expect(await Promise.all([lobby.cubeCards('cc-vintage'), pod.cubeCards('cc-vintage')])).toEqual([[CARD], [CARD]]);
    expect(await pod.cubeCards('cc-vintage')).toEqual([CARD]);
    expect(server.reads).toEqual(['/api/pools/cubes/cc-vintage/cards']);
  });

  it('is read again once the cube is refreshed, re-imported or deleted', async () => {
    const server = stubServer();
    const lobby = poolsClient(server.fetch, '/api/');
    const pod = poolsClient(server.fetch, '/api/');
    await pod.cubeCards('cc-vintage');
    expect((await lobby.refreshCube('cc-vintage')).ok).toBe(true);
    await pod.cubeCards('cc-vintage');
    expect((await lobby.importCube('https://cubecobra.com/cube/list/vintage')).ok).toBe(true);
    await pod.cubeCards('cc-vintage');
    expect((await lobby.deleteCube('cc-vintage')).ok).toBe(true);
    await pod.cubeCards('cc-vintage');
    expect(server.reads).toHaveLength(4);
  });

  it('is asked again after a read that failed', async () => {
    const server = stubServer();
    const pod = poolsClient(server.fetch, '/api/');
    server.failNextRead();
    expect(await pod.cubeCards('cc-vintage')).toBeNull();
    expect(await pod.cubeCards('cc-vintage')).toEqual([CARD]);
    expect(server.reads).toHaveLength(2);
  });
});
