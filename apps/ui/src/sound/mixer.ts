/*
 * The take mixer: `mix.ts`'s plan, played through WebAudio.
 *
 * Every voice is one buffer source through one gain node. A voice whose role
 * ducks goes straight to the master; every other voice goes through the duck
 * node, which a ducking voice pulls down for its own length and lets back up.
 * Levels are baked into each voice when it starts, so a slider moved mid-sound
 * changes the next sound, which is all a cue of a second or two needs.
 *
 * `webaudio.ts` still owns the synthesised placeholder cues' context. Wave B
 * moves those cues onto roles and deletes it, leaving this the only one.
 *
 * Fails soft throughout: a take that will not fetch or decode is remembered as
 * bad and skipped, and nothing here throws into the click that asked for a
 * sound.
 */

import { createMixPlanner, DEFAULT_MIX, type MixPlanner, type MixSettings, type PlanResult, type SoundEvent } from './mix.ts';

/** Above this many live voices, a new one is dropped rather than stacked. */
const VOICE_CAP = 12;
/** The level everything else drops to under a ducking voice. */
const DUCK_LEVEL = 0.35;

export interface Mixer {
  readonly planner: MixPlanner;
  settings: MixSettings;
  /** Plan and play one event. The plan comes back at once; audio follows its buffers. */
  play(event: SoundEvent, nowMs?: number): PlanResult;
  /** Audition one take at a level, bypassing roles. */
  playFile(file: string, gain?: number): void;
  /** Fetch and decode ahead of time, so a scenario's first beats are not late. */
  preload(files: Iterable<string>): void;
}

interface AudioContextGlobals {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export function createMixer(takeUrl: (file: string) => string, planner: MixPlanner = createMixPlanner()): Mixer {
  const g = globalThis as unknown as AudioContextGlobals;
  const Ctor = g.AudioContext ?? g.webkitAudioContext;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let duckNode: GainNode | null = null;
  let live = 0;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();

  const context = (): AudioContext | null => {
    if (ctx !== null) return ctx;
    if (Ctor === undefined) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.connect(ctx.destination);
    duckNode = ctx.createGain();
    duckNode.connect(master);
    return ctx;
  };

  const load = (file: string): Promise<AudioBuffer | null> => {
    const known = buffers.get(file);
    if (known !== undefined) return known;
    const ac = context();
    if (ac === null) return Promise.resolve(null);
    const task = (async () => {
      try {
        const res = await fetch(takeUrl(file));
        if (!res.ok) return null;
        return await ac.decodeAudioData(await res.arrayBuffer());
      } catch {
        return null;
      }
    })();
    buffers.set(file, task);
    return task;
  };

  const duck = (ac: AudioContext, seconds: number): void => {
    if (duckNode === null) return;
    const now = ac.currentTime;
    const p = duckNode.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(DUCK_LEVEL, now + 0.03);
    p.setValueAtTime(DUCK_LEVEL, now + Math.min(seconds, 1.2));
    p.linearRampToValueAtTime(1, now + Math.min(seconds, 1.2) + 0.4);
  };

  const start = (file: string, gain: number, ducks: boolean): void => {
    const ac = context();
    if (ac === null) return;
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    void load(file).then((buf) => {
      if (buf === null || master === null || duckNode === null || live >= VOICE_CAP) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const env = ac.createGain();
      env.gain.value = Math.max(gain, 0);
      src.connect(env);
      env.connect(ducks ? master : duckNode);
      if (ducks) duck(ac, buf.duration);
      live += 1;
      src.onended = () => {
        live -= 1;
        src.disconnect();
        env.disconnect();
      };
      src.start();
    });
  };

  const mixer: Mixer = {
    planner,
    settings: DEFAULT_MIX,
    play(event, nowMs = performance.now()) {
      const plan = planner.plan(event, nowMs, mixer.settings);
      for (const v of plan.voices) start(v.file, v.gain, v.duck);
      return plan;
    },
    playFile(file, gain = 1) {
      start(file, gain, false);
    },
    preload(files) {
      for (const f of files) void load(f);
    },
  };
  return mixer;
}
