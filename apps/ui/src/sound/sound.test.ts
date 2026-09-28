// @vitest-environment jsdom
/*
 * The app's sound, proved without an audio device.
 *
 * ## Why there is no real `AudioContext` anywhere in here
 *
 * jsdom does not implement WebAudio. A test that reached for one would have to
 * fake an entire node graph and would then be a test of the fake, breaking on
 * the first change to how the sink wires its nodes rather than on a change to
 * what the app decides to play. So the interesting half is tested through the
 * INJECTED SINK (`setCueSink`): every case below asserts on the `CueRequest`s
 * the app made — which cue, at what volume, against which URL — and
 * *"constructs no AudioContext"* is itself an assertion, made with a counting
 * stub in `globalThis`.
 *
 * The one exception is the small `createWebAudioSink` block at the end, which
 * drives the sink against a hand-rolled fake context. It is here because §F.3's
 * *"the context starts suspended and resumes on the first real click"* is a
 * behaviour with no other witness, and it is deliberately the smallest fake that
 * can show it: nothing about the node graph is asserted beyond the frequency the
 * oscillator was given and the fact that it was stopped.
 *
 * `.test.ts` + `createElement`, and the jsdom pragma on line 1, for the reasons
 * `screens/lobby.test.ts` gives. The CardTile and MuteButton cases live in this
 * file rather than beside their components because this lane owns `sound/` and
 * these two files, and a wiring test belongs with the thing being wired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CardTile } from '../components/CardTile.tsx';
import type { DraftCard } from '../draft/types.ts';
import { CUES, CUE_SPECS, type Cue } from './cues.ts';
import { MuteButton } from './MuteButton.tsx';
import { resolveCueUrl, cueUrl, CUE_MANIFEST, type CueManifest } from './manifest.ts';
import { CUE_VOLUME, MUTE_KEY, isMuted, resetMutedForTests, setMuted } from './mute.ts';
import type { CueRequest } from './sink.ts';
import { cueHandler, currentCueSink, playCue, resetCueSinkForTests, setCueSink } from './index.ts';
import { createWebAudioSink, hasWebAudio } from './webaudio.ts';

/** A sink that records instead of sounding. The whole testing strategy. */
function recorder() {
  const requests: CueRequest[] = [];
  return { requests, sink: { play: (r: CueRequest) => void requests.push(r) } };
}

const cuesOf = (rs: CueRequest[]): Cue[] => rs.map((r) => r.cue);

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
  resetCueSinkForTests();
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
  // `restoreAllMocks` does NOT undo `stubGlobal`, and two cases here assert on
  // the ABSENCE of `AudioContext`. Without this they were answered by a stub a
  // previous case installed and failed for a reason that had nothing to do with
  // the code under test.
  vi.unstubAllGlobals();
  setCueSink(null);
});

/* ── the vocabulary ──────────────────────────────────────────────────── */

describe('the cue vocabulary', () => {
  it('is exactly the five cues the next wave will wire the board against', () => {
    expect([...CUES]).toEqual(['hover', 'select', 'drag', 'drop', 'deny']);
  });

  it('describes every one of them, so no cue can play nothing', () => {
    for (const cue of CUES) {
      const spec = CUE_SPECS[cue];
      expect(spec, cue).toBeDefined();
      expect(spec.ms, cue).toBeGreaterThan(0);
      expect(spec.gain, cue).toBeGreaterThan(0);
      expect(spec.gain, cue).toBeLessThanOrEqual(1);
      expect(spec.from, cue).toBeGreaterThan(0);
      expect(spec.to, cue).toBeGreaterThan(0);
    }
    // No spec beyond the vocabulary: a stale entry left behind after a rename
    // would be dead data nobody notices.
    expect(Object.keys(CUE_SPECS).sort()).toEqual([...CUES].sort());
  });

  it('keeps hover the quietest, because it fires on every tile crossed', () => {
    for (const cue of CUES) {
      if (cue === 'hover') continue;
      expect(CUE_SPECS.hover.gain, cue).toBeLessThan(CUE_SPECS[cue].gain);
    }
  });
});

/* ── the manifest is a lookup, and today it is empty ─────────────────── */

describe('resolving a cue to a file', () => {
  it('ships with no assets, so every cue synthesises', () => {
    expect(CUE_MANIFEST.entries).toEqual({});
    for (const cue of CUES) expect(cueUrl(cue), cue).toBeNull();
  });

  it('turns one manifest row into a CDN url — the whole data change', () => {
    const key = `${'a'.repeat(64)}.ogg`;
    const manifest: CueManifest = { select: { source: 'cdn', key } };
    expect(resolveCueUrl('select', manifest)).toBe(`https://cdn.hadoku.me/${key}`);
    // And only that one. Repointing `select` must not touch `hover`.
    expect(resolveCueUrl('hover', manifest)).toBeNull();
  });

  it('honours a moved cdn base, because the hostname is expected to move', () => {
    const key = `${'b'.repeat(64)}.ogg`;
    expect(
      resolveCueUrl('drop', { drop: { source: 'cdn', key } }, { cdnBase: 'https://media.example/' }),
    ).toBe(`https://media.example/${key}`);
  });

  it('falls back to synthesis for a row it cannot use, and never throws', () => {
    // A key that is not a key, a missing key, and a source from the future. All
    // three are hand-edit mistakes and all three mean "no information", which is
    // the same situation as an absent row.
    expect(resolveCueUrl('deny', { deny: { source: 'cdn', key: 'deadbeef.ogg' } })).toBeNull();
    expect(resolveCueUrl('deny', { deny: { source: 'cdn' } })).toBeNull();
    expect(
      resolveCueUrl('deny', { deny: { source: 'sampler' as unknown as 'cdn', key: `${'c'.repeat(64)}.ogg` } }),
    ).toBeNull();
  });
});

/* ── playCue: the seam ───────────────────────────────────────────────── */

describe('playCue', () => {
  it('hands the injected sink one fully-resolved request', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);

    playCue('select');

    expect(requests).toHaveLength(1);
    expect(requests[0].cue).toBe('select');
    expect(requests[0].spec).toEqual(CUE_SPECS.select);
    // Null because no asset exists yet — the sink synthesises `spec`.
    expect(requests[0].url).toBeNull();
    expect(requests[0].volume).toBe(CUE_VOLUME);
  });

  it('is low by default, which is what "on at a low volume" means', () => {
    expect(CUE_VOLUME).toBeGreaterThan(0);
    expect(CUE_VOLUME).toBeLessThan(0.5);
  });

  it('constructs no AudioContext — the sink is the only thing that ever would', () => {
    let constructed = 0;
    class Counting {
      constructor() {
        constructed += 1;
      }
    }
    vi.stubGlobal('AudioContext', Counting);
    const { requests, sink } = recorder();
    setCueSink(sink);

    for (const cue of CUES) playCue(cue);

    expect(cuesOf(requests)).toEqual([...CUES]);
    expect(constructed).toBe(0);
  });

  it('is silent and safe where there is no way to make a sound at all', () => {
    // jsdom: no WebAudio. `currentCueSink` must answer null rather than throw,
    // and must keep answering null without re-probing.
    expect(hasWebAudio()).toBe(false);
    expect(currentCueSink()).toBeNull();
    expect(() => playCue('hover')).not.toThrow();
  });

  it('survives a sink that throws, because it is called from click handlers', () => {
    setCueSink({
      play: () => {
        throw new Error('speaker on fire');
      },
    });
    expect(() => playCue('deny')).not.toThrow();
  });

  it('gives one stable listener per cue, so a memoised tile stays memoised', () => {
    expect(cueHandler('hover')).toBe(cueHandler('hover'));
    expect(cueHandler('hover')).not.toBe(cueHandler('select'));
    const { requests, sink } = recorder();
    setCueSink(sink);
    cueHandler('drag')();
    expect(cuesOf(requests)).toEqual(['drag']);
  });
});

/* ── mute ────────────────────────────────────────────────────────────── */

describe('mute', () => {
  it('is off by default: a first visit hears the app', () => {
    expect(isMuted()).toBe(false);
  });

  it('silences every cue, and unmuting restores them', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);

    setMuted(true);
    for (const cue of CUES) playCue(cue);
    expect(requests).toEqual([]);

    setMuted(false);
    playCue('select');
    expect(cuesOf(requests)).toEqual(['select']);
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

    // The default stands, the toggle still works for this page, and nothing
    // anywhere throws — a blocked store costs a remembered preference, never
    // the page.
    expect(isMuted()).toBe(false);
    expect(() => setMuted(true)).not.toThrow();
    expect(isMuted()).toBe(true);

    const { requests, sink } = recorder();
    setCueSink(sink);
    playCue('hover');
    expect(requests).toEqual([]);
  });

  it('ignores junk in the store rather than trusting it', () => {
    globalThis.localStorage.setItem(MUTE_KEY, 'yes-please');
    resetMutedForTests();
    expect(isMuted()).toBe(false);
  });
});

/* ── the wiring: CardTile ────────────────────────────────────────────── */

describe('a card tile asks for cues', () => {
  it('cues hover on the pointer arriving and select on the pick', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);
    const picked: string[] = [];
    render(createElement(CardTile, { card: CARD, onPick: (id: string) => void picked.push(id) }));

    const tile = screen.getByTestId('card');
    // `mouseOver`, not `mouseEnter`: React derives onMouseEnter from the
    // root's mouseover/mouseout listeners, so a non-bubbling `mouseenter`
    // dispatched at the node never reaches it.
    fireEvent.mouseOver(tile);
    expect(cuesOf(requests)).toEqual(['hover']);

    fireEvent.click(tile);
    expect(cuesOf(requests)).toEqual(['hover', 'select']);
    // And the pick itself still happened — the cue decorates, it does not replace.
    expect(picked).toEqual(['c-1']);
  });

  it('cues hover on a pool tile too, which has nothing to pick', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);
    render(createElement(CardTile, { card: CARD }));

    fireEvent.mouseOver(screen.getByTestId('card'));
    expect(cuesOf(requests)).toEqual(['hover']);
  });

  it('says nothing at all when the player has muted', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);
    setMuted(true);
    const picked: string[] = [];
    render(createElement(CardTile, { card: CARD, onPick: (id: string) => void picked.push(id) }));

    const tile = screen.getByTestId('card');
    fireEvent.mouseOver(tile);
    fireEvent.click(tile);

    expect(requests).toEqual([]);
    // Muting sound must not mute the app: the pick still lands.
    expect(picked).toEqual(['c-1']);
  });
});

/* ── the wiring: the mute button ─────────────────────────────────────── */

describe('the mute button', () => {
  it('shows the state, flips it, and persists it', () => {
    render(createElement(MuteButton, {}));
    const button = screen.getByTestId('sound-mute');

    expect(button.getAttribute('data-muted')).toBe('false');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('Sound on');

    fireEvent.click(button);

    expect(button.getAttribute('data-muted')).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Sound off');
    expect(isMuted()).toBe(true);
    expect(globalThis.localStorage.getItem(MUTE_KEY)).toBe('true');
  });

  it('is silent when muting and audible when unmuting', () => {
    const { requests, sink } = recorder();
    setCueSink(sink);
    render(createElement(MuteButton, {}));
    const button = screen.getByTestId('sound-mute');

    fireEvent.click(button); // → muted
    expect(requests).toEqual([]);

    fireEvent.click(button); // → unmuted, and it says so
    expect(cuesOf(requests)).toEqual(['select']);
  });
});

/* ── the sink, against the smallest fake that can show the rule ──────── */

describe('the WebAudio sink', () => {
  /** Enough of an `AudioContext` to watch the sink's decisions. Nothing more. */
  function fakeContext() {
    const ramps: { to: number; at: number }[] = [];
    const oscillators: { type: string; started: number; stopped: number }[] = [];
    let resumes = 0;
    const param = () => ({
      value: 0,
      setValueAtTime: () => {},
      exponentialRampToValueAtTime: (to: number, at: number) => {
        ramps.push({ to, at });
      },
    });
    class Fake {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      createGain() {
        return { gain: param(), connect: () => {}, disconnect: () => {} };
      }
      createOscillator() {
        const osc = {
          type: '',
          started: -1,
          stopped: -1,
          frequency: param(),
          onended: null as null | (() => void),
          connect: () => {},
          disconnect: () => {},
          start(t: number) {
            osc.started = t;
          },
          stop(t: number) {
            osc.stopped = t;
          },
        };
        oscillators.push(osc);
        return osc;
      }
      async resume(): Promise<void> {
        resumes += 1;
        this.state = 'running';
      }
    }
    return { Fake, oscillators, ramps, resumes: () => resumes };
  }

  it('starts suspended, plays nothing, and resumes on the first real gesture', async () => {
    const fake = fakeContext();
    vi.stubGlobal('AudioContext', fake.Fake);
    const sink = createWebAudioSink();
    expect(sink).not.toBeNull();

    // Before any gesture the context is suspended, so there is nothing to hear.
    sink?.play({ cue: 'hover', spec: CUE_SPECS.hover, url: null, volume: CUE_VOLUME });
    expect(fake.oscillators).toHaveLength(0);

    // A real click anywhere on the document unlocks it.
    fireEvent.pointerDown(globalThis.document.body);
    await Promise.resolve();
    expect(fake.resumes()).toBe(1);

    // And now a cue sounds: one oscillator, of the cue's own wave, gliding to
    // the cue's own target pitch, and stopped rather than left running.
    sink?.play({ cue: 'select', spec: CUE_SPECS.select, url: null, volume: CUE_VOLUME });
    expect(fake.oscillators).toHaveLength(1);
    expect(fake.oscillators[0].type).toBe(CUE_SPECS.select.wave);
    expect(fake.oscillators[0].stopped).toBeCloseTo(CUE_SPECS.select.ms / 1000, 6);
    expect(fake.ramps.some((r) => r.to === CUE_SPECS.select.to)).toBe(true);
  });

  it('is the one place that builds a context, and only where WebAudio exists', () => {
    // No stub: jsdom has no AudioContext, so there is nothing to build and the
    // sink says so instead of constructing something broken.
    expect(createWebAudioSink()).toBeNull();
  });
});
