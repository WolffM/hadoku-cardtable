// @vitest-environment jsdom
/*
 * The last pick dragged to the sideboard (feedback 2026-11-21): that pick ends
 * the draft, and the server's answer that confirms it is the same view that
 * says the draft is over, so the draft screen is gone in the very render that
 * would have sent the owed save. It is still saved, and a builder opening the
 * pod at that moment reads the save, not the build before it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftCard } from '../draft/types.ts';
import { deckStoreClient, type DeckStoreClient } from './deckStore.ts';
import { useDraftBuild } from './useDraftBuild.ts';

afterEach(cleanup);

function picks(n: number): DraftCard[] {
  const out = new Map<string, DraftCard>();
  for (const view of loadFixtures()) {
    if (view.viewer.kind !== 'seat') continue;
    for (const card of [...view.viewer.pack, ...view.viewer.pool]) out.set(card.name, card);
  }
  return [...out.values()].slice(0, n).map((c, i) => ({ ...c, cardId: `c${i}` }));
}

function fakeStore(): DeckStoreClient & { saves: string[] } {
  const saves: string[] = [];
  return {
    saves,
    mine: () => new Promise(() => {}),
    save: (_pod, dck) => {
      saves.push(dck);
      return Promise.resolve({ ok: true, deck: dck });
    },
  };
}

describe('the last pick, dragged to the sideboard', () => {
  it('is saved in the sideboard even when the screen goes before the pick is confirmed', () => {
    const pool = picks(3);
    const last = pool[2]!;
    const client = fakeStore();
    const { result, unmount } = renderHook(() => useDraftBuild('d', pool, { podId: 'pod', client }, false));
    result.current.move(last.cardId, 'pool');
    expect(client.saves).toEqual([]);
    // The confirmation and the draft's end arrive together: the hook never renders settled.
    unmount();
    expect(client.saves).toHaveLength(1);
    expect(client.saves[0]).toContain(last.name);
  });

  it('a pod read waits for that pod’s save still on its way, from any client', async () => {
    const order: string[] = [];
    let finish!: () => void;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      order.push(`${init?.method ?? 'GET'} ${url.slice(url.lastIndexOf('/'))}`);
      if (init?.method === 'PUT')
        return new Promise<Response>((res) => {
          finish = () => res(new Response(JSON.stringify({ deck: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    const saving = deckStoreClient(fetchImpl, '/api/').save('pod', '[Sideboard]\n1 Island\n');
    const reading = deckStoreClient(fetchImpl, '/api/').mine('pod');
    // Every step a read takes before its fetch is a microtask: flushed, an unblocked GET is already out.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(['PUT /deck']);
    finish();
    await saving;
    await reading;
    expect(order).toEqual(['PUT /deck', 'GET /mine']);
  });
});
