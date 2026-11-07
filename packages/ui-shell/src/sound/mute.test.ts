// @vitest-environment jsdom
/*
 * `mute.ts` against the fleet's preference service, faked in memory. The
 * app's own wiring test (`apps/ui/src/sound/sound.test.ts`) covers the
 * interplay with `playRole`; what belongs here is `mute.ts` alone, and that
 * every key it writes is built from `appId()`, not a literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureShell } from '../app-id/index.ts';

const prefs = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  const saves: { appId: string; patch: Row; scope: string }[] = [];
  return {
    rows,
    saves,
    reset(): void {
      rows.clear();
      saves.length = 0;
    },
    client(appId: string) {
      return {
        appId,
        read: () => Promise.resolve({ ...rows.get(appId) }),
        save(patch: Row, opts?: { scope?: string }) {
          saves.push({ appId, patch, scope: opts?.scope ?? 'user' });
          rows.set(appId, { ...rows.get(appId), ...patch });
          return Promise.resolve();
        },
        subscribe() {
          return () => undefined;
        },
      };
    },
  };
});
vi.mock('@wolffm/prefs-client', () => ({ createPrefsClient: ({ appId }: { appId: string }) => prefs.client(appId) }));

beforeEach(() => {
  prefs.reset();
  configureShell({ appId: 'cardtable' });
});

afterEach(async () => {
  const { resetMutedForTests } = await import('./mute.ts');
  resetMutedForTests();
  try {
    globalThis.localStorage.clear();
  } catch {
    // jsdom always has one; here only so a hostile store cannot fail teardown.
  }
});

describe('mute and the levels', () => {
  it('is off by default, full volume, music at half', async () => {
    const { getLevel, isMuted } = await import('./mute.ts');
    expect(isMuted()).toBe(false);
    expect(getLevel('volume')).toBe(1);
    expect(getLevel('music')).toBe(0.5);
  });

  it('saves mute and volume in the fleet-shared "games" row, and the music level in this game’s own row', async () => {
    const { connectSoundPrefs, setLevel, setMuted } = await import('./mute.ts');
    await connectSoundPrefs().ready;
    setMuted(true);
    setLevel('volume', 0.4);
    setLevel('music', 0.15);
    expect(prefs.saves).toEqual([
      { appId: 'games', patch: { muted: true }, scope: 'device' },
      { appId: 'games', patch: { volume: 0.4 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { music: 0.15 }, scope: 'device' },
    ]);
  });

  it('a music pick is saved per player, not per device', async () => {
    const { connectSoundPrefs, setMusicPick } = await import('./mute.ts');
    await connectSoundPrefs().ready;
    setMusicPick('role-a', 'take-1.ogg');
    expect(prefs.saves).toEqual([{ appId: 'cardtable-sound', patch: { musicPicks: { 'role-a': 'take-1.ogg' } }, scope: 'user' }]);
  });
});

describe('the legacy localStorage keys', () => {
  it('are built from appId(): cardtable keeps the keys it always had', async () => {
    const { legacyKeys } = await import('./mute.ts');
    expect(legacyKeys()).toEqual({
      muted: 'cardtable.sound.muted',
      volume: 'cardtable.sound.volume',
      music: 'cardtable.sound.music',
      musicPicks: 'cardtable.sound.music-picks',
    });
  });

  it('a different game gets its own keys: the shell holds no game-specific literal', async () => {
    const { legacyKeys } = await import('./mute.ts');
    configureShell({ appId: 'bomberman' });
    expect(legacyKeys().muted).toBe('bomberman.sound.muted');
    configureShell({ appId: 'cardtable' }); // restored for every test after this one
  });

  it('are the first value, are moved into the service once, and are removed', async () => {
    const { connectSoundPrefs, getLevel, getMusicPick, isMuted, legacyKeys } = await import('./mute.ts');
    globalThis.localStorage.setItem(legacyKeys().muted, 'true');
    globalThis.localStorage.setItem(legacyKeys().volume, '0.4');
    globalThis.localStorage.setItem(legacyKeys().music, '0.15');
    globalThis.localStorage.setItem(legacyKeys().musicPicks, JSON.stringify({ 'role-a': 'take-1.ogg' }));
    const { ready } = connectSoundPrefs();
    expect([isMuted(), getLevel('volume'), getLevel('music'), getMusicPick('role-a')]).toEqual([true, 0.4, 0.15, 'take-1.ogg']);

    await ready;
    expect(prefs.saves).toEqual([
      { appId: 'games', patch: { muted: true, volume: 0.4 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { music: 0.15 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { musicPicks: { 'role-a': 'take-1.ogg' } }, scope: 'user' },
    ]);
    expect(Object.values(legacyKeys()).map((k) => globalThis.localStorage.getItem(k))).toEqual([null, null, null, null]);
  });

  it('never overwrite what the service already holds', async () => {
    const { connectSoundPrefs, isMuted, legacyKeys } = await import('./mute.ts');
    prefs.rows.set('games', { muted: false });
    globalThis.localStorage.setItem(legacyKeys().muted, 'true');
    await connectSoundPrefs().ready;
    expect(isMuted()).toBe(false);
    expect(prefs.saves).toEqual([]);
  });

  it('are ignored when they hold junk, and cost nothing when the store is blocked', async () => {
    const { connectSoundPrefs, getMusicPick, isMuted, legacyKeys, resetMutedForTests, setMuted } = await import('./mute.ts');
    globalThis.localStorage.setItem(legacyKeys().muted, 'yes-please');
    globalThis.localStorage.setItem(legacyKeys().musicPicks, '["not", "a map"]');
    await connectSoundPrefs().ready;
    expect([isMuted(), getMusicPick('role-a')]).toEqual([false, null]);
    expect(prefs.saves).toEqual([]);

    resetMutedForTests();
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('private window');
    });
    vi.spyOn(globalThis.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('private window');
    });
    await connectSoundPrefs().ready;
    expect(() => setMuted(true)).not.toThrow();
    expect(isMuted()).toBe(true);
    vi.restoreAllMocks();
  });
});
