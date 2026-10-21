// @vitest-environment jsdom
/*
 * The mixer against the smallest fake `AudioContext` that can show its rules:
 * it is built lazily, the first real gesture unlocks it, a sound asked for
 * while it is locked is dropped rather than played late, and an unlocked one
 * starts a buffer at its planned gain. Nothing about the node graph is
 * asserted beyond that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMixPlanner } from './mix.ts';
import { CELL_VOICE_CAP, createMixer } from './mixer.ts';

interface FakeSource {
  buffer: unknown;
  started: boolean;
  stopped: boolean;
  loop?: boolean;
  onended: (() => void) | null;
  connect: () => void;
  disconnect: () => void;
  start: () => void;
  stop: () => void;
}

let contexts: FakeContext[] = [];

class FakeBuffer {
  duration = 0.3;
  sampleRate = 48000;
  constructor(private readonly channels: Float32Array[]) {}
  get numberOfChannels(): number {
    return this.channels.length;
  }
  get length(): number {
    return this.channels[0]!.length;
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch]!;
  }
}

class FakeContext {
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  gains: { gain: { value: number } }[] = [];
  private pendingResumes: (() => void)[] = [];
  constructor() {
    contexts.push(this);
  }
  createGain() {
    const g = {
      gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} },
      connect() {},
      disconnect() {},
    };
    this.gains.push(g);
    return g;
  }
  createBufferSource(): FakeSource {
    const s: FakeSource = {
      buffer: null,
      started: false,
      stopped: false,
      onended: null,
      connect() {},
      disconnect() {},
      start() {
        s.started = true;
      },
      stop() {
        s.stopped = true;
      },
    };
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(): Promise<FakeBuffer> {
    return new FakeBuffer([new Float32Array([1, 2, 3])]);
  }
  createBuffer(channels: number, length: number): FakeBuffer {
    return new FakeBuffer(Array.from({ length: channels }, () => new Float32Array(length)));
  }
  /** Held until `grant()`: the browser only lets a gesture resume a context, and then every pending resume settles. */
  resume(): Promise<void> {
    return new Promise((resolve) => this.pendingResumes.push(resolve));
  }
  grant(): void {
    this.state = 'running';
    for (const resolve of this.pendingResumes.splice(0)) resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  contexts = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mixer() {
  const planner = createMixPlanner(() => 0);
  planner.setAssignments({ 'ui.select|play': ['a/take-1.ogg'] }, { 'ui.select|play': 0.5 });
  return createMixer((f) => `/takes/${f}`, planner);
}

describe('the mixer', () => {
  it('builds no context until something plays', () => {
    mixer();
    expect(contexts).toHaveLength(0);
  });

  it('the player’s levels set the master and the music node, before the context exists and live after', () => {
    const m = mixer();
    m.setLevels({ volume: 0.5, music: 0.2 });
    m.play({ role: 'ui.select' });
    const ctx = contexts[0]!;
    // Built in order: the master, the duck node, the music node under it.
    const [master, duck, music] = ctx.gains;
    expect([master!.gain.value, duck!.gain.value, music!.gain.value]).toEqual([0.5, 1, 0.2]);
    m.setLevels({ volume: 0.9, music: 0 });
    expect([master!.gain.value, music!.gain.value]).toEqual([0.9, 0]);
  });

  it('a gesture unlocks it, and an unlocked sound starts at its planned gain', async () => {
    const m = mixer();
    m.play({ role: 'ui.select' });
    const ctx = contexts[0]!;
    document.dispatchEvent(new Event('pointerdown'));
    ctx.grant();
    await flush();
    expect(ctx.state).toBe('running');
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.started).toBe(true);
    // ui bus 0.5 × the cell's 0.5.
    expect(ctx.gains.at(-1)!.gain.value).toBeCloseTo(0.25);
  });

  it('plays Untap as the Tap take backwards, and Tap still forwards', async () => {
    const planner = createMixPlanner(() => 0);
    planner.setAssignments({ 'g.tap|play': ['a/take-1.ogg'] }, {});
    const m = createMixer((f) => `/takes/${f}`, planner);
    m.play({ role: 'g.untap' });
    const ctx = contexts[0]!;
    ctx.grant();
    await flush();
    m.play({ role: 'g.tap' }, performance.now() + 1000);
    await flush();
    const [untap, tap] = ctx.sources.map((s) => Array.from((s.buffer as FakeBuffer).getChannelData(0)));
    expect(untap).toEqual([3, 2, 1]);
    expect(tap).toEqual([1, 2, 3]);
  });

  it('loops the first music role of a list that has a take, and keeps it while that stays the first', async () => {
    const planner = createMixPlanner(() => 0);
    planner.setAssignments({ 'music.match.G|play': ['music-g/take-1.ogg'] }, {});
    const m = createMixer((f) => `/takes/${f}`, planner);
    m.loop(['music.match.R', 'music.match', 'music.match.G']);
    const ctx = contexts[0]!;
    ctx.grant();
    await flush();
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual(['/takes/music-g/take-1.ogg']);
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(1);
    m.loop(['music.match', 'music.match.G']);
    await flush();
    expect(ctx.sources).toHaveLength(1);
  });

  it('loops the player’s pick among a role’s takes, crossfades to a new pick, and ignores a pick the cell no longer holds', async () => {
    const planner = createMixPlanner(() => 0);
    planner.setAssignments({ 'music.match.UB|play': ['music-a/take-1.ogg', 'music-b/take-1.ogg'] }, { 'music.match.UB|play': 0.5 });
    const m = createMixer((f) => `/takes/${f}`, planner);
    let pick: string | null = 'music-b/take-1.ogg';
    m.loop(['music.match.UB'], () => pick);
    const ctx = contexts[0]!;
    ctx.grant();
    await flush();
    expect(m.nowPlaying()).toEqual({ role: 'music.match.UB', file: 'music-b/take-1.ogg' });
    expect(ctx.sources).toHaveLength(1);
    m.loop(['music.match.UB'], () => pick);
    await flush();
    expect(ctx.sources).toHaveLength(1);

    pick = 'music-a/take-1.ogg';
    m.loop(['music.match.UB'], () => pick);
    await flush();
    expect(ctx.sources[0]!.stopped).toBe(true);
    expect(ctx.sources).toHaveLength(2);
    expect(m.nowPlaying()).toEqual({ role: 'music.match.UB', file: 'music-a/take-1.ogg' });

    pick = 'music-gone/take-1.ogg';
    m.loop(['music.match.UB'], () => pick);
    await flush();
    expect(ctx.sources).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual(['/takes/music-b/take-1.ogg', '/takes/music-a/take-1.ogg']);
    m.loop(null);
    expect(m.nowPlaying()).toBeNull();
  });

  it('loopFile loops one take outside any role, switches with a fade, and null stops it', async () => {
    const m = mixer();
    m.loopFile('music-w-tavern-jig/take-1.ogg');
    const ctx = contexts[0]!;
    ctx.grant();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.loop).toBe(true);
    m.loopFile('music-w-tavern-jig/take-1.ogg');
    await flush();
    expect(ctx.sources).toHaveLength(1);
    m.loopFile('music-dawnlight-sanctum/take-1.ogg');
    await flush();
    expect(ctx.sources[0]!.stopped).toBe(true);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.started).toBe(true);
    m.loopFile(null);
    expect(ctx.sources[1]!.stopped).toBe(true);
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual([
      '/takes/music-w-tavern-jig/take-1.ogg',
      '/takes/music-dawnlight-sanctum/take-1.ogg',
    ]);
  });

  it('a music list with nothing assigned builds nothing', () => {
    const m = mixer();
    m.loop(['music.match.R', 'music.match']);
    expect(contexts).toHaveLength(0);
  });

  it('one cell plays at most CELL_VOICE_CAP voices at once: overlapping loops do not stack into a wall', async () => {
    const planner = createMixPlanner(() => 0);
    planner.setAssignments({ 'g.lifegain|play': ['a/take-1.ogg'], 'g.tap|play': ['b/take-1.ogg'] }, {});
    const m = createMixer((f) => `/takes/${f}`, planner);
    m.play({ role: 'g.lifegain' });
    const ctx = contexts[0]!;
    ctx.grant();
    await flush();
    // Past the collapse window each time: every ask is a voice of its own until the cap.
    for (let i = 1; i <= CELL_VOICE_CAP + 2; i++) {
      m.play({ role: 'g.lifegain' }, performance.now() + i * 1000);
      await flush();
    }
    expect(ctx.sources).toHaveLength(CELL_VOICE_CAP);
    // Another cell is not held back by it.
    m.play({ role: 'g.tap' }, performance.now() + 10_000);
    await flush();
    expect(ctx.sources).toHaveLength(CELL_VOICE_CAP + 1);
    // One ending lets the next one of its cell play.
    ctx.sources[0]!.onended?.();
    m.play({ role: 'g.lifegain' }, performance.now() + 20_000);
    await flush();
    expect(ctx.sources).toHaveLength(CELL_VOICE_CAP + 2);
  });

  it('a sound asked for while locked is dropped, not played when the gesture finally comes', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const m = mixer();
    m.play({ role: 'ui.select' });
    const ctx = contexts[0]!;
    await flush();
    expect(ctx.sources).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    ctx.grant();
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });
});
