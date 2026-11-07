/*
 * `createSound`, against a synthetic registry — no real role name needed.
 * Cardtable's own wiring (`apps/ui/src/sound/sound.test.ts`) proves the same
 * mechanics through its actual registry and server client, plus the
 * CardTile and SoundSettings wiring, which are Magic's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSound, isMuted, resetMutedForTests, setMuted, type SoundClient } from './index.ts';

type Role = 'cue.ui' | 'cue.a' | 'cue.b' | 'music.lobby' | 'music.match';

const REGISTRY = {
  roles: new Map([
    ['cue.ui', { bus: 'ui' as const }],
    ['cue.a', { bus: 'game' as const }],
    ['cue.b', { bus: 'game' as const }],
    ['music.lobby', { bus: 'music' as const }],
    ['music.match', { bus: 'music' as const }],
  ]),
  fallback: {},
  reversed: {},
};

function stubClient(): SoundClient {
  return {
    takeUrl: (f) => f,
    loadAssignments: async () => ({ cells: {}, gains: {}, names: {}, versions: {}, pack: '' }),
    loadPack: async () => undefined,
  };
}

function recorder(sound: ReturnType<typeof createSound<Role>>): { events: unknown[] } {
  const events: unknown[] = [];
  sound.setRolePlayer({ play: (e) => void events.push(e) });
  return { events };
}

beforeEach(() => resetMutedForTests());
afterEach(() => resetMutedForTests());

describe('role safety (type half)', () => {
  it('refuses a role outside the injected list at compile time', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    // @ts-expect-error 'not-a-real-role' is not one of Role
    sound.playRole('not-a-real-role');
  });

  // The runtime half — a role outside the registry plans no voice and never reaches an audio
  // node — lives in `mix.test.ts` / `mixer.test.ts`, where the enforcement actually is: a role
  // this type would refuse that still reached `playRole` (an id the type lost track of) is handed
  // to whatever `RolePlayer` is current unexamined, by design — `setRolePlayer`'s whole point is
  // recording exactly what was asked for, play it or not, without the mixer's own opinion.
});

describe('playRole', () => {
  it('raises one event for the role, silenced when muted', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    const { events } = recorder(sound);
    sound.playRole('cue.a');
    expect(events).toEqual([{ role: 'cue.a' }]);
    setMuted(true);
    sound.playRole('cue.a');
    expect(events).toHaveLength(1);
  });

  it('gives one stable listener per role', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    expect(sound.roleHandler('cue.a')).toBe(sound.roleHandler('cue.a'));
    expect(sound.roleHandler('cue.a')).not.toBe(sound.roleHandler('cue.b'));
  });

  it('survives a player that throws', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    sound.setRolePlayer({
      play: () => {
        throw new Error('boom');
      },
    });
    expect(() => sound.playRole('cue.a')).not.toThrow();
  });
});

describe('the interface tally', () => {
  it('counts a `ui`-bus role by the registry (not a name prefix), and starts again once taken', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    recorder(sound);
    sound.playRole('cue.ui');
    sound.playRole('cue.ui');
    sound.playRole('cue.a'); // `game` bus: not tallied
    expect(sound.takeUiTally()).toEqual({ 'cue.ui': 2 });
    expect(sound.takeUiTally()).toEqual({});
  });

  it('excludes a role already logged one by one elsewhere', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient(), individuallyLogged: new Set<Role>(['cue.ui']) });
    recorder(sound);
    sound.playRole('cue.ui');
    expect(sound.takeUiTally()).toEqual({});
  });
});

describe('music', () => {
  function looper(sound: ReturnType<typeof createSound<Role>>): unknown[] {
    const loops: unknown[] = [];
    sound.setRolePlayer({ play: () => undefined, loop: (role) => void loops.push(role) });
    return loops;
  }

  it("loops the screen's music, the match's while a match is on it, and nothing on a silent screen", () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    const loops = looper(sound);
    sound.setScreenMusic('music.lobby');
    sound.setMatchMusic(['music.match']);
    sound.setMatchMusic(null);
    sound.setScreenMusic(null);
    expect(loops).toEqual(['music.lobby', ['music.match'], 'music.lobby', null]);
  });

  it('a match held quiet keeps the screen’s music, and gets its own back once released', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    const loops = looper(sound);
    sound.setScreenMusic('music.lobby');
    const release = sound.holdMatchQuiet();
    sound.setMatchMusic(['music.match']);
    expect(loops.at(-1)).toBe('music.lobby');
    release();
    release();
    expect(loops.at(-1)).toEqual(['music.match']);
  });

  it('a quiet hold still lets interface sounds through', () => {
    const sound = createSound<Role>({ registry: REGISTRY, client: stubClient() });
    const { events } = recorder(sound);
    sound.holdMatchQuiet();
    sound.playRole('cue.ui');
    sound.playRole('cue.a');
    expect(events).toEqual([{ role: 'cue.ui' }]);
  });
});

describe('isMuted (re-exported from ./mute.ts, unrelated to the registry)', () => {
  it('is off by default', () => {
    expect(isMuted()).toBe(false);
  });
});
