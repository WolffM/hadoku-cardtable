/*
 * The sound builder's client, against a stub fetch — no DOM, no network.
 *
 * `environment: node` (the repo default) is enough: `createAudioPool`'s own
 * tests inject `createAudio`, so no real `HTMLAudioElement` is needed either.
 */

import { describe, expect, it, vi } from 'vitest';

import { createAudioPool, pickRandom, soundsClient, type Fetch } from './builderClient.ts';

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
  it('parses cells and canEdit', async () => {
    const client = soundsClient(
      vi.fn(async () => okJson({ cells: { 'W|spell': ['lib-water/take-001.ogg'] }, canEdit: true })),
      '/api/',
    );
    expect(await client.assignments()).toEqual({ cells: { 'W|spell': ['lib-water/take-001.ogg'] }, canEdit: true });
  });

  it('refuses a cell key that is not a valid CellId', async () => {
    const client = soundsClient(vi.fn(async () => okJson({ cells: { bogus: ['x'] }, canEdit: true })), '/api/');
    // The superRefine fails the whole parse; the client's fallback is the empty case.
    expect(await client.assignments()).toEqual({ cells: {}, canEdit: false });
  });

  it('is the empty, read-only case on a 403 or an unreachable server', async () => {
    const refused = soundsClient(vi.fn(async () => failed(403)), '/api/');
    expect(await refused.assignments()).toEqual({ cells: {}, canEdit: false });
  });
});

describe('soundsClient.save', () => {
  it('PUTs the cell and returns the saved list', async () => {
    const fetchImpl: Fetch = vi.fn(async () => okJson({ cell: 'W|spell', files: ['a/take-1.ogg'] }));
    const client = soundsClient(fetchImpl, '/api/');
    const saved = await client.save('W|spell', ['a/take-1.ogg']);
    expect(saved).toEqual(['a/take-1.ogg']);
    const [reqUrl, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(reqUrl).toBe('/api/sounds/assignments/W%7Cspell');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ files: ['a/take-1.ogg'] });
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
    expect(client.takeUrl('lib-water/take-001.ogg')).toBe('/api/sounds/takes/lib-water/take-001.ogg');
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

describe('createAudioPool', () => {
  function stubAudio(): HTMLAudioElement {
    const a = {
      src: '',
      currentTime: 0,
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
    };
    return a as unknown as HTMLAudioElement;
  }

  it('fetches a take once and plays it through a pooled element', async () => {
    const blob = { size: 1 } as Blob;
    const fetchImpl: Fetch = vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response);
    const original = (globalThis as { URL: typeof URL }).URL.createObjectURL;
    (globalThis as unknown as { URL: { createObjectURL: (b: Blob) => string } }).URL.createObjectURL = vi.fn(
      () => 'blob:fake',
    );
    const audios = [stubAudio(), stubAudio()];
    let i = 0;
    const pool = createAudioPool(
      { takeUrl: (f) => `/x/${f}` },
      { voices: 2, fetchImpl, createAudio: () => audios[i++ % audios.length] },
    );
    await pool.play('a/take-1.ogg');
    await pool.play('a/take-1.ogg');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached after the first fetch
    expect(audios[0]!.play).toHaveBeenCalledTimes(1);
    expect(audios[1]!.play).toHaveBeenCalledTimes(1); // round-robins across voices
    (globalThis as unknown as { URL: { createObjectURL: unknown } }).URL.createObjectURL = original;
  });

  it('fails soft when the fetch rejects — no throw, nothing played', async () => {
    const fetchImpl: Fetch = vi.fn(async () => {
      throw new Error('404');
    });
    const audio = stubAudio();
    const pool = createAudioPool({ takeUrl: (f) => `/x/${f}` }, { voices: 1, fetchImpl, createAudio: () => audio });
    await expect(pool.play('missing/take-1.ogg')).resolves.toBeUndefined();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('does nothing when there is no audio element available (no voices)', async () => {
    const pool = createAudioPool({ takeUrl: (f) => f }, { voices: 0, createAudio: () => stubAudio() });
    await expect(pool.play('a/take-1.ogg')).resolves.toBeUndefined();
  });
});
