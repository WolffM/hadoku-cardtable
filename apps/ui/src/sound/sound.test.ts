// @vitest-environment jsdom
/*
 * The app's sound, proved without an audio device.
 *
 * jsdom has no WebAudio, so the interesting half is tested through the
 * INJECTED PLAYER (`setRolePlayer`): every case asserts on the sound events
 * the app raised (which role, from which seat, layered with which colour),
 * never on audio. What the mixer does with an event is `mix.test.ts`'s job.
 *
 * `.test.ts` + `createElement`, and the jsdom pragma on line 1, for the reasons
 * `screens/lobby.test.ts` gives. The CardTile and sound-settings cases live here
 * because a wiring test belongs with the thing being wired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

import { CardTile } from '../components/CardTile.tsx';
import type { DraftCard } from '../draft/types.ts';
import type { SoundEvent } from './mix.ts';
import { SoundSettings } from '../settings/SoundSettings.tsx';
import { LEGACY_KEYS, connectSoundPrefs, getLevel, getMusicPick, isMuted, resetMutedForTests, setMusicPick, setMuted } from './mute.ts';
import { matchMusicRoles, useMatchMusic } from './match-music.ts';
import {
  holdMatchQuiet,
  hoverControl,
  playRole,
  playSoundEvents,
  resetRolePlayerForTests,
  roleHandler,
  setMatchMusic,
  setRolePlayer,
  setScreenMusic,
  setTrackNames,
  takeUiTally,
} from './index.ts';

/**
 * The fleet's preference service, one row per app id, in memory. Every save is recorded with its
 * scope, and `push` is a save from somewhere else — another tab, or another host on the page.
 */
const prefs = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  const saves: { appId: string; patch: Row; scope: string }[] = [];
  const subscribers = new Map<string, Set<(row: Row) => void>>();
  const listenersOf = (appId: string): Set<(row: Row) => void> => {
    let set = subscribers.get(appId);
    if (set === undefined) subscribers.set(appId, (set = new Set()));
    return set;
  };
  return {
    rows,
    saves,
    reset(): void {
      rows.clear();
      saves.length = 0;
      subscribers.clear();
    },
    push(appId: string, patch: Row): void {
      const row = { ...rows.get(appId), ...patch };
      rows.set(appId, row);
      for (const fn of listenersOf(appId)) fn(row);
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
        subscribe(fn: (row: Row) => void) {
          listenersOf(appId).add(fn);
          return () => void listenersOf(appId).delete(fn);
        },
      };
    },
  };
});
vi.mock('@wolffm/prefs-client', () => ({ createPrefsClient: ({ appId }: { appId: string }) => prefs.client(appId) }));

/** A player that records instead of sounding. The whole testing strategy. */
function recorder() {
  const events: SoundEvent[] = [];
  setRolePlayer({ play: (e) => void events.push(e) });
  return events;
}

const rolesOf = (es: SoundEvent[]): string[] => es.map((e) => e.role);

const CARD: DraftCard = {
  cardId: 'c-1',
  name: 'Llanowar Elves',
  manaCost: ['{G}'],
  manaValue: 1,
  colors: ['G'],
  typeLine: 'Creature — Elf Druid',
  oracleText: '{T}: Add {G}.',
  power: '1',
  toughness: '1',
  setCode: 'm12',
  collectorNumber: '187',
  rarity: 'common',
};

beforeEach(() => {
  resetRolePlayerForTests();
  resetMutedForTests();
  prefs.reset();
  try {
    globalThis.localStorage.clear();
  } catch {
    // jsdom always has one; this is here so a hostile store cannot fail setup.
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setRolePlayer(null);
});

describe('playRole', () => {
  it('raises one event for the role, from the viewer’s seat', () => {
    const events = recorder();
    playRole('ui.select');
    expect(events).toEqual([{ role: 'ui.select' }]);
  });

  it('survives a player that throws, because it is called from click handlers', () => {
    setRolePlayer({
      play: () => {
        throw new Error('boom');
      },
    });
    expect(() => playRole('ui.select')).not.toThrow();
  });

  it('gives one stable listener per role, so a memoised tile stays memoised', () => {
    expect(roleHandler('ui.hover-card')).toBe(roleHandler('ui.hover-card'));
    expect(roleHandler('ui.hover-card')).not.toBe(roleHandler('ui.select'));
  });
});

describe('hoverControl', () => {
  it('plays the card hover when the pointer arrives on an enabled button, not within it, nor on a card or a disabled one', () => {
    const events = recorder();
    const { container } = render(
      createElement('div', { onPointerOver: hoverControl }, [
        createElement('button', { key: 'ok', type: 'button' }, createElement('span', null, 'OK')),
        createElement('button', { key: 'off', type: 'button', disabled: true }, 'Off'),
        createElement('button', { key: 'card', type: 'button', 'data-card-id': 7 }, 'Card'),
        createElement('p', { key: 'text' }, 'text'),
      ]),
    );
    const [ok, off, card] = Array.from(container.querySelectorAll('button'));
    const label = ok!.querySelector('span')!;
    fireEvent.pointerOver(ok!, { relatedTarget: container.querySelector('p') });
    fireEvent.pointerOver(label, { relatedTarget: ok });
    fireEvent.pointerOver(off!);
    fireEvent.pointerOver(card!);
    fireEvent.pointerOver(container.querySelector('p')!);
    expect(events).toEqual([{ role: 'ui.hover-card' }]);
  });
});

describe('the interface tally', () => {
  it('counts each interface role raised, muted or not, and starts again once taken', () => {
    recorder();
    takeUiTally();
    playRole('ui.hover-card');
    playRole('ui.hover-card');
    setMuted(true);
    playRole('ui.lift');
    playRole('g.tap');
    playRole('ui.pass');
    expect(takeUiTally()).toEqual({ 'ui.hover-card': 2, 'ui.lift': 1 });
    expect(takeUiTally()).toEqual({});
  });
});

describe('playSoundEvents', () => {
  it('plays an undelayed event at once and a delayed one after its delay', () => {
    vi.useFakeTimers();
    const events = recorder();
    playSoundEvents([
      { role: 'g.creature', colourCell: 'G|creature', seat: 'opp', delayMs: 0 },
      { role: 'g.enter', seat: 'opp', delayMs: 400 },
    ]);
    expect(events).toEqual([{ role: 'g.creature', colourCell: 'G|creature', seat: 'opp' }]);
    vi.advanceTimersByTime(400);
    expect(rolesOf(events)).toEqual(['g.creature', 'g.enter']);
  });
});

describe('music', () => {
  function looper() {
    const loops: unknown[] = [];
    setRolePlayer({ play: () => undefined, loop: (role) => void loops.push(role) });
    return loops;
  }

  it("loops the screen's music, the match's while a match is on it, and nothing on a silent screen", () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    setMatchMusic(['music.match.R', 'music.match']);
    setMatchMusic(null);
    setScreenMusic(null);
    expect(loops).toEqual(['music.lobby', ['music.match.R', 'music.match'], 'music.lobby', null]);
  });

  it('a match held quiet keeps the screen’s music, and gets its own back once released', () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    const release = holdMatchQuiet();
    setMatchMusic(['music.match']);
    expect(loops.at(-1)).toBe('music.lobby');
    release();
    release();
    expect(loops.at(-1)).toEqual(['music.match']);
    setMatchMusic(null);
    setScreenMusic(null);
  });

  it('a match mounted before the screen sets its music still plays the match music', () => {
    const loops = looper();
    setMatchMusic(['music.match']);
    setScreenMusic('music.lobby');
    expect(loops.at(-1)).toEqual(['music.match']);
  });

  it('a match whose music is not known yet plays none, not the screen music', () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    setMatchMusic([]);
    expect(loops.at(-1)).toEqual([]);
  });

  it('a match plays its slot; leaving silences it back to the screen’s music', () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    const { unmount } = renderHook(() => useMatchMusic('m-slot', ['B', 'R', 'G']));
    const roles = loops.at(-1) as string[];
    expect(roles).toEqual(matchMusicRoles('m-slot', ['B', 'R', 'G']));
    expect(roles[0]).toMatch(/^music\.match\.(BR|RG|BG)$/);
    unmount();
    expect(loops.at(-1)).toBe('music.lobby');
  });

  it('loops with the player’s pick for the role', () => {
    const picks: (string | null)[] = [];
    setRolePlayer({ play: () => undefined, loop: (_role, pick) => void picks.push(pick?.('music.match.UB') ?? null) });
    setMusicPick('music.match.UB', 'music-b/take-1.ogg');
    setScreenMusic('music.lobby');
    setMatchMusic(['music.match.UB']);
    expect(picks.at(-1)).toBe('music-b/take-1.ogg');
  });

  it('muting fades it out and unmuting brings it back', () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    setMuted(true);
    setMuted(false);
    expect(loops).toEqual(['music.lobby', null, 'music.lobby']);
  });
});

describe('mute', () => {
  it('is off by default: a first visit hears the app', () => {
    expect(isMuted()).toBe(false);
  });

  it('silences every sound, and unmuting restores them', () => {
    const events = recorder();
    setMuted(true);
    playRole('ui.select');
    playSoundEvents([{ role: 'g.draw' }]);
    expect(events).toEqual([]);

    setMuted(false);
    playRole('ui.select');
    expect(rolesOf(events)).toEqual(['ui.select']);
  });

  it('is saved per device in the games row every hadoku game shares, and read back on the next page', async () => {
    await connectSoundPrefs().ready;
    setMuted(true);
    expect(prefs.saves).toEqual([{ appId: 'games', patch: { muted: true }, scope: 'device' }]);

    // A fresh page load: the page forgets, the service does not.
    resetMutedForTests();
    await connectSoundPrefs().ready;
    expect(isMuted()).toBe(true);
  });

  it('follows a change saved elsewhere: another tab, or another host on the page', async () => {
    prefs.rows.set('games', { muted: true, volume: 0.3 });
    await connectSoundPrefs().ready;
    expect([isMuted(), getLevel('volume')]).toEqual([true, 0.3]);

    prefs.push('games', { muted: false });
    expect(isMuted()).toBe(false);
  });

  it('holds a change for the page before it connects, and saves nothing once disconnected', async () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    const { ready, disconnect } = connectSoundPrefs();
    await ready;
    disconnect();
    setMuted(false);
    expect(prefs.saves).toEqual([]);
  });
});

describe('the old localStorage keys', () => {
  it('are the first value, are moved into the service once, and are removed', async () => {
    globalThis.localStorage.setItem(LEGACY_KEYS.muted, 'true');
    globalThis.localStorage.setItem(LEGACY_KEYS.volume, '0.4');
    globalThis.localStorage.setItem(LEGACY_KEYS.music, '0.15');
    globalThis.localStorage.setItem(LEGACY_KEYS.musicPicks, JSON.stringify({ 'music.match.UB': 'music-b/take-1.ogg' }));
    const { ready } = connectSoundPrefs();
    expect([isMuted(), getLevel('volume'), getLevel('music'), getMusicPick('music.match.UB')]).toEqual([true, 0.4, 0.15, 'music-b/take-1.ogg']);

    await ready;
    expect(prefs.saves).toEqual([
      { appId: 'games', patch: { muted: true, volume: 0.4 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { music: 0.15 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { musicPicks: { 'music.match.UB': 'music-b/take-1.ogg' } }, scope: 'user' },
    ]);
    expect(Object.values(LEGACY_KEYS).map((k) => globalThis.localStorage.getItem(k))).toEqual([null, null, null, null]);
  });

  it('never overwrite what the service already holds', async () => {
    prefs.rows.set('games', { muted: false });
    globalThis.localStorage.setItem(LEGACY_KEYS.muted, 'true');
    await connectSoundPrefs().ready;
    expect(isMuted()).toBe(false);
    expect(prefs.saves).toEqual([]);
  });

  it('are ignored when they hold junk, and cost nothing when the store is blocked', async () => {
    globalThis.localStorage.setItem(LEGACY_KEYS.muted, 'yes-please');
    globalThis.localStorage.setItem(LEGACY_KEYS.musicPicks, '["not", "a map"]');
    await connectSoundPrefs().ready;
    expect([isMuted(), getMusicPick('music.match.W')]).toEqual([false, null]);
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
  });
});

/* ── the wiring: CardTile ────────────────────────────────────────────── */

describe('a card tile plays roles', () => {
  it('plays the card hover on the pointer arriving and select on the pick', () => {
    const events = recorder();
    const picked: string[] = [];
    render(createElement(CardTile, { card: CARD, onPick: (id: string) => void picked.push(id) }));

    const tile = screen.getByTestId('card');
    // `mouseOver`, not `mouseEnter`: React derives onMouseEnter from the
    // root's mouseover/mouseout listeners, so a non-bubbling `mouseenter`
    // dispatched at the node never reaches it.
    fireEvent.mouseOver(tile);
    expect(rolesOf(events)).toEqual(['ui.hover-card']);

    fireEvent.click(tile);
    expect(rolesOf(events)).toEqual(['ui.hover-card', 'ui.select']);
    expect(picked).toEqual(['c-1']);
  });

  it('plays the role its caller names for a pick (the draft pack: ui.draft-pick)', () => {
    const events = recorder();
    render(createElement(CardTile, { card: CARD, onPick: () => undefined, pickRole: 'ui.draft-pick' }));
    fireEvent.click(screen.getByTestId('card'));
    expect(rolesOf(events)).toEqual(['ui.draft-pick']);
  });

  it('plays the hover on a pool tile too, which has nothing to pick', () => {
    const events = recorder();
    render(createElement(CardTile, { card: CARD }));
    fireEvent.mouseOver(screen.getByTestId('card'));
    expect(rolesOf(events)).toEqual(['ui.hover-card']);
  });

  it('says nothing at all when the player has muted, and the pick still lands', () => {
    const events = recorder();
    setMuted(true);
    const picked: string[] = [];
    render(createElement(CardTile, { card: CARD, onPick: (id: string) => void picked.push(id) }));
    const tile = screen.getByTestId('card');
    fireEvent.mouseOver(tile);
    fireEvent.click(tile);
    expect(events).toEqual([]);
    expect(picked).toEqual(['c-1']);
  });
});

/* ── the wiring: the sound settings ──────────────────────────────────── */

describe('the sound settings', () => {
  it('turns sound off and on, saves it, and is silent going off and audible coming back', async () => {
    await connectSoundPrefs().ready;
    const events = recorder();
    render(createElement(SoundSettings));
    const on = screen.getByTestId('settings-sound-on') as HTMLInputElement;
    expect(on.checked).toBe(true);

    fireEvent.click(on);
    expect(isMuted()).toBe(true);
    expect(prefs.saves).toEqual([{ appId: 'games', patch: { muted: true }, scope: 'device' }]);
    expect(on.checked).toBe(false);
    expect(events).toEqual([]);

    fireEvent.click(on);
    expect(isMuted()).toBe(false);
    expect(rolesOf(events)).toEqual(['ui.select']);
  });

  it('sets the two levels, saves them per device, and samples the new level once the slider is let go', async () => {
    await connectSoundPrefs().ready;
    const events = recorder();
    render(createElement(SoundSettings));
    const volume = screen.getByTestId('settings-volume') as HTMLInputElement;
    const music = screen.getByTestId('settings-music') as HTMLInputElement;
    // Nothing stored: everything full, the music at half.
    expect([volume.value, music.value]).toEqual(['100', '50']);

    fireEvent.change(volume, { target: { value: '40' } });
    fireEvent.change(music, { target: { value: '15' } });
    expect(getLevel('volume')).toBe(0.4);
    expect(getLevel('music')).toBe(0.15);
    expect(prefs.saves).toEqual([
      { appId: 'games', patch: { volume: 0.4 }, scope: 'device' },
      { appId: 'cardtable-sound', patch: { music: 0.15 }, scope: 'device' },
    ]);
    expect(events).toEqual([]);

    fireEvent.pointerUp(volume);
    expect(rolesOf(events)).toEqual(['ui.select']);
  });

  describe('the track', () => {
    /** A player looping `role`, whose cell holds `files`, playing the picked one or else the first. */
    function playing(role: string, files: string[]) {
      setRolePlayer({
        play: () => undefined,
        loop() {},
        nowPlaying: () => ({ role, file: files.find((f) => f === getMusicPick(role)) ?? files[0]! }),
        takes: (cell) => (cell === `${role}|play` ? files : []),
      });
      setTrackNames({ 'music-a/take-1.ogg': 'UB · deep current', 'music-b/take-1.ogg': 'Cipher in the Fog' });
    }

    it('names the one track a role holds, without its slot code', () => {
      playing('music.match.U', ['music-a/take-1.ogg']);
      setScreenMusic('music.lobby');
      render(createElement(SoundSettings));
      const track = screen.getByTestId('settings-music-track');
      expect(track.tagName).toBe('OUTPUT');
      expect(track.textContent).toBe('Deep current');
    });

    it('offers every track when the role holds several; a choice is saved for the player and plays', async () => {
      await connectSoundPrefs().ready;
      playing('music.match.UB', ['music-a/take-1.ogg', 'music-b/take-1.ogg']);
      setScreenMusic('music.lobby');
      render(createElement(SoundSettings));
      const select = screen.getByTestId('settings-music-track') as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(['Deep current', 'Cipher in the Fog']);
      expect(select.value).toBe('music-a/take-1.ogg');

      fireEvent.change(select, { target: { value: 'music-b/take-1.ogg' } });
      expect(getMusicPick('music.match.UB')).toBe('music-b/take-1.ogg');
      expect(prefs.saves).toEqual([{ appId: 'cardtable-sound', patch: { musicPicks: { 'music.match.UB': 'music-b/take-1.ogg' } }, scope: 'user' }]);
      expect((screen.getByTestId('settings-music-track') as HTMLSelectElement).value).toBe('music-b/take-1.ogg');

      resetMutedForTests();
      await connectSoundPrefs().ready;
      expect(getMusicPick('music.match.UB')).toBe('music-b/take-1.ogg');
    });

    it('shows nothing while nothing loops', () => {
      setRolePlayer({ play: () => undefined, loop() {}, nowPlaying: () => null });
      setScreenMusic(null);
      render(createElement(SoundSettings));
      expect(screen.queryByTestId('settings-music-track')).toBeNull();
    });
  });

  it('reads the saved levels back, and the sliders rest while sound is off', async () => {
    prefs.rows.set('games', { volume: 0.25 });
    await connectSoundPrefs().ready;
    setMuted(true);
    render(createElement(SoundSettings));
    const volume = screen.getByTestId('settings-volume') as HTMLInputElement;
    expect(volume.value).toBe('25');
    // A music level nobody saved is its default, half.
    expect((screen.getByTestId('settings-music') as HTMLInputElement).value).toBe('50');
    expect(volume.disabled).toBe(true);
  });

});
