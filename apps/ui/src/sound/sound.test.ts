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
import { LEVEL_KEYS, MUSIC_PICKS_KEY, MUTE_KEY, getLevel, getMusicPick, isMuted, resetMutedForTests, setMusicPick, setMuted } from './mute.ts';
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

  it('is remembered per viewer', () => {
    setMuted(true);
    expect(globalThis.localStorage.getItem(MUTE_KEY)).toBe('true');
    // A fresh page load: forget the in-memory value, keep the store.
    resetMutedForTests();
    expect(isMuted()).toBe(true);
  });

  it('survives a blocked store on read AND on write', () => {
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('private window');
    });
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('private window');
    });
    expect(isMuted()).toBe(false);
    expect(() => setMuted(true)).not.toThrow();
    expect(isMuted()).toBe(true);

    const events = recorder();
    playRole('ui.hover-card');
    expect(events).toEqual([]);
  });

  it('ignores junk in the store rather than trusting it', () => {
    globalThis.localStorage.setItem(MUTE_KEY, 'yes-please');
    resetMutedForTests();
    expect(isMuted()).toBe(false);
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
  it('turns sound off and on, persists it, and is silent going off and audible coming back', () => {
    const events = recorder();
    render(createElement(SoundSettings));
    const on = screen.getByTestId('settings-sound-on') as HTMLInputElement;
    expect(on.checked).toBe(true);

    fireEvent.click(on);
    expect(isMuted()).toBe(true);
    expect(globalThis.localStorage.getItem(MUTE_KEY)).toBe('true');
    expect(on.checked).toBe(false);
    expect(events).toEqual([]);

    fireEvent.click(on);
    expect(isMuted()).toBe(false);
    expect(rolesOf(events)).toEqual(['ui.select']);
  });

  it('sets the two levels, persists them, and samples the new level once the slider is let go', () => {
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
    expect(globalThis.localStorage.getItem(LEVEL_KEYS.volume)).toBe('0.4');
    expect(globalThis.localStorage.getItem(LEVEL_KEYS.music)).toBe('0.15');
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

    it('offers every track when the role holds several; a choice is persisted and plays', () => {
      playing('music.match.UB', ['music-a/take-1.ogg', 'music-b/take-1.ogg']);
      setScreenMusic('music.lobby');
      render(createElement(SoundSettings));
      const select = screen.getByTestId('settings-music-track') as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(['Deep current', 'Cipher in the Fog']);
      expect(select.value).toBe('music-a/take-1.ogg');

      fireEvent.change(select, { target: { value: 'music-b/take-1.ogg' } });
      expect(getMusicPick('music.match.UB')).toBe('music-b/take-1.ogg');
      expect(JSON.parse(globalThis.localStorage.getItem(MUSIC_PICKS_KEY)!)).toEqual({ 'music.match.UB': 'music-b/take-1.ogg' });
      expect((screen.getByTestId('settings-music-track') as HTMLSelectElement).value).toBe('music-b/take-1.ogg');

      resetMutedForTests();
      expect(getMusicPick('music.match.UB')).toBe('music-b/take-1.ogg');
    });

    it('shows nothing while nothing loops', () => {
      setRolePlayer({ play: () => undefined, loop() {}, nowPlaying: () => null });
      setScreenMusic(null);
      render(createElement(SoundSettings));
      expect(screen.queryByTestId('settings-music-track')).toBeNull();
    });
  });

  it('music picks survive a blocked or garbled store: none on read, held for the page on write', () => {
    globalThis.localStorage.setItem(MUSIC_PICKS_KEY, '["not", "a map"]');
    expect(getMusicPick('music.match.W')).toBeNull();
    resetMutedForTests();
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getMusicPick('music.match.W')).toBeNull();
    setMusicPick('music.match.W', 'music-a/take-1.ogg');
    expect(getMusicPick('music.match.W')).toBe('music-a/take-1.ogg');
  });

  it('reads the stored levels back, and the sliders rest while sound is off', () => {
    globalThis.localStorage.setItem(LEVEL_KEYS.volume, '0.25');
    globalThis.localStorage.setItem(LEVEL_KEYS.music, 'not a number');
    setMuted(true);
    render(createElement(SoundSettings));
    const volume = screen.getByTestId('settings-volume') as HTMLInputElement;
    expect(volume.value).toBe('25');
    // An unreadable music level is its default, half.
    expect((screen.getByTestId('settings-music') as HTMLInputElement).value).toBe('50');
    expect(volume.disabled).toBe(true);
  });

});
