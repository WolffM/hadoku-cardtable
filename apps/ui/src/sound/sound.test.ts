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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CardTile } from '../components/CardTile.tsx';
import type { DraftCard } from '../draft/types.ts';
import type { SoundEvent } from './mix.ts';
import { SoundSettings } from '../settings/SoundSettings.tsx';
import { LEVEL_KEYS, MUTE_KEY, getLevel, isMuted, resetMutedForTests, setMuted } from './mute.ts';
import {
  playRole,
  playSoundEvents,
  resetRolePlayerForTests,
  roleHandler,
  setMatchMusic,
  setRolePlayer,
  setScreenMusic,
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
    const loops: (string | null)[] = [];
    setRolePlayer({ play: () => undefined, loop: (role) => void loops.push(role) });
    return loops;
  }

  it("loops the screen's music, the match's while a match is on it, and nothing on a silent screen", () => {
    const loops = looper();
    setScreenMusic('music.lobby');
    setMatchMusic(true);
    setMatchMusic(false);
    setScreenMusic(null);
    expect(loops).toEqual(['music.lobby', 'music.match', 'music.lobby', null]);
  });

  it('a match mounted before the screen sets its music still plays the match music', () => {
    const loops = looper();
    setMatchMusic(true);
    setScreenMusic('music.lobby');
    expect(loops.at(-1)).toBe('music.match');
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
    expect([volume.value, music.value]).toEqual(['100', '100']);

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

  it('reads the stored levels back, and the sliders rest while sound is off', () => {
    globalThis.localStorage.setItem(LEVEL_KEYS.volume, '0.25');
    globalThis.localStorage.setItem(LEVEL_KEYS.music, 'not a number');
    setMuted(true);
    render(createElement(SoundSettings));
    const volume = screen.getByTestId('settings-volume') as HTMLInputElement;
    expect(volume.value).toBe('25');
    expect((screen.getByTestId('settings-music') as HTMLInputElement).value).toBe('100');
    expect(volume.disabled).toBe(true);
  });
});
