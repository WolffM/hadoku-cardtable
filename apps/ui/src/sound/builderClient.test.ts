/*
 * The sound builder's client, against a stub fetch — no DOM, no network.
 *
 * `environment: node` (the repo default) is enough: nothing here plays audio.
 */

import { describe, expect, it, vi } from 'vitest';

import { musicReviewClient, pickRandom, soundsClient, type Fetch } from './builderClient.ts';

const TAKE = {
  file: 'lib-water/take-001.ogg',
  sound: 'lib-water',
  name: 'Water',
  group: 'Water',
  section: 'Library' as const,
  label: 'Water · 1a',
  seconds: 2.1,
  prompt: 'a brook',
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function failed(status: number, body: unknown = { error: 'nope' }): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

describe('soundsClient.catalogue', () => {
  it('parses a valid catalogue', async () => {
    const fetchImpl: Fetch = vi.fn(async () => okJson({ takes: [TAKE] }));
    const client = soundsClient(fetchImpl, '/api/');
    expect(await client.catalogue()).toEqual([TAKE]);
    expect(fetchImpl).toHaveBeenCalledWith('/api/sounds/catalogue', { credentials: 'same-origin' });
  });

  it('is empty on a non-OK response', async () => {
    const client = soundsClient(vi.fn(async () => failed(500)), '/api/');
    expect(await client.catalogue()).toEqual([]);
  });

  it('is empty when the body does not parse as a catalogue', async () => {
    const client = soundsClient(vi.fn(async () => okJson({ takes: 'nope' })), '/api/');
    expect(await client.catalogue()).toEqual([]);
  });

  it('is empty when the server cannot be reached', async () => {
    const client = soundsClient(
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      '/api/',
    );
    expect(await client.catalogue()).toEqual([]);
  });
});

describe('soundsClient.assignments', () => {
  it('parses cells and canEdit, and an answer at all is canView', async () => {
    const client = soundsClient(
      vi.fn(async () => okJson({ cells: { 'W|spell': ['lib-water/take-001.ogg'] }, canEdit: true })),
      '/api/',
    );
    expect(await client.assignments()).toEqual({
      cells: { 'W|spell': ['lib-water/take-001.ogg'] },
      gains: {},
      canEdit: true,
      canView: true,
    });
  });

  it('refuses a cell key that is not a valid CellId', async () => {
    const client = soundsClient(vi.fn(async () => okJson({ cells: { bogus: ['x'] }, canEdit: true })), '/api/');
    // The superRefine fails the whole parse; the client's fallback is the empty case.
    expect(await client.assignments()).toEqual({ cells: {}, gains: {}, canEdit: false, canView: false });
  });

  it('is the empty, read-only case on a 403 or an unreachable server', async () => {
    const refused = soundsClient(vi.fn(async () => failed(403)), '/api/');
    expect(await refused.assignments()).toEqual({ cells: {}, gains: {}, canEdit: false, canView: false });
  });

  it('is not viewable below friend: the gate answers 404', async () => {
    const below = soundsClient(vi.fn(async () => failed(404, 'not found')), '/api/');
    expect((await below.assignments()).canView).toBe(false);
  });
});

describe('soundsClient.save', () => {
  it('PUTs the cell and returns the saved list', async () => {
    const fetchImpl: Fetch = vi.fn(async () => okJson({ cell: 'W|spell', files: ['a/take-1.ogg'] }));
    const client = soundsClient(fetchImpl, '/api/');
    const saved = await client.save('W|spell', ['a/take-1.ogg']);
    expect(saved).toEqual({ files: ['a/take-1.ogg'], gain: 1 });
    const [reqUrl, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(reqUrl).toBe('/api/sounds/assignments/W%7Cspell');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ files: ['a/take-1.ogg'] });
  });

  it('sends a gain when one is given, and returns the stored one', async () => {
    const fetchImpl: Fetch = vi.fn(async () => okJson({ cell: 'W|spell', files: [], gain: 0.3 }));
    const client = soundsClient(fetchImpl, '/api/');
    expect(await client.save('W|spell', [], 0.3)).toEqual({ files: [], gain: 0.3 });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ files: [], gain: 0.3 });
  });

  it('returns null on a 403 (friend, not admin)', async () => {
    const client = soundsClient(vi.fn(async () => failed(403)), '/api/');
    expect(await client.save('W|spell', [])).toBeNull();
  });

  it('returns null on a 400 (unknown file or malformed cell)', async () => {
    const client = soundsClient(vi.fn(async () => failed(400)), '/api/');
    expect(await client.save('W|spell', ['nope'])).toBeNull();
  });

  it('returns null when the server cannot be reached', async () => {
    const client = soundsClient(
      vi.fn(async () => {
        throw new Error('down');
      }),
      '/api/',
    );
    expect(await client.save('W|spell', [])).toBeNull();
  });
});

describe('soundsClient.takeUrl', () => {
  it('splits the folder and the file into two encoded segments', () => {
    const client = soundsClient(vi.fn(), '/api/');
    expect(client.takeUrl('lib-water/take-001.ogg')).toBe('/api/sounds/audio/lib-water/take-001.ogg');
  });
});

describe('pickRandom', () => {
  it('is null for an empty list', () => {
    expect(pickRandom([], null)).toBeNull();
  });

  it('returns the only file even when it equals "last" (nothing else to pick)', () => {
    expect(pickRandom(['a'], 'a')).toBe('a');
  });

  it('never repeats the last pick when more than one file is assigned', () => {
    const files = ['a', 'b'];
    let last: string | null = null;
    for (let i = 0; i < 200; i++) {
      const next = pickRandom(files, last, Math.random);
      expect(next).not.toBeNull();
      if (last !== null) expect(next).not.toBe(last);
      last = next;
    }
  });

  it('is deterministic given an injected rng', () => {
    expect(pickRandom(['a', 'b', 'c'], null, () => 0)).toBe('a');
    expect(pickRandom(['a', 'b', 'c'], null, () => 0.999)).toBe('c');
    // excludes 'a' (the last pick), so rng=0 lands on the first of the remainder
    expect(pickRandom(['a', 'b', 'c'], 'a', () => 0)).toBe('b');
  });
});

describe('musicReviewClient', () => {
  const RECORD = {
    at: '2026-10-17T12:00:00.000Z',
    userId: 'bob',
    name: 'Bob',
    slots: { 'music.match.W|play': { pick: 'music-w-tavern-jig/take-1.ogg', ratings: {}, note: '' } },
  };

  it('mine reads the latest review, and null for none or a failure', async () => {
    const fetchImpl = vi.fn(async () => okJson({ review: RECORD }));
    expect(await musicReviewClient(fetchImpl, '/api/').mine()).toEqual(RECORD);
    expect(fetchImpl).toHaveBeenCalledWith('/api/sounds/music-review/mine', { credentials: 'same-origin' });
    expect(await musicReviewClient(vi.fn(async () => okJson({ review: null })), '/api/').mine()).toBeNull();
    expect(await musicReviewClient(vi.fn(async () => failed(404)), '/api/').mine()).toBeNull();
    const down: Fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await musicReviewClient(down, '/api/').mine()).toBeNull();
  });

  it('submit POSTs the body and returns the stored record; null when refused', async () => {
    const fetchImpl = vi.fn<Fetch>(async () => okJson(RECORD));
    const body = { slots: RECORD.slots };
    expect(await musicReviewClient(fetchImpl, '/api/').submit(body)).toEqual(RECORD);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe('/api/sounds/music-review');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(await musicReviewClient(vi.fn(async () => failed(400)), '/api/').submit(body)).toBeNull();
  });
});
