/*
 * The take mixer: `mix.ts`'s plan, played through WebAudio.
 *
 * Every voice is one buffer source through one gain node. A voice whose role
 * ducks goes straight to the master; every other voice goes through the duck
 * node, which a ducking voice pulls down for its own length and lets back up.
 * Levels are baked into each voice when it starts, so a slider moved mid-sound
 * changes the next sound, which is all a cue of a second or two needs.
 *
 * The only `AudioContext` in the app: the builder, the sandbox and the game
 * (`./index.ts`) all play through one of these.
 *
 * ## Unlocked by the first gesture
 *
 * Browsers start a context `suspended` and only let it resume inside a real
 * gesture. Most of the game's sounds come from server frames and hovers, which
 * are not gestures, so the context installs a one-shot capture-phase listener
 * for `pointerdown`, `keydown` and `touchend` the moment it exists and resumes
 * there. Capture phase, so a handler that stops propagation cannot keep the
 * page silent. Sounds asked for before that first gesture are dropped: a cue
 * only means something at the moment it was asked for.
 *
 * Fails soft throughout: a take that will not fetch or decode is remembered as
 * bad and skipped, and nothing here throws into the click that asked for a
 * sound.
 */

import { createMixPlanner, DEFAULT_MIX, type MixPlanner, type MixSettings, type PlanResult, type SoundEvent } from './mix.ts';

/** Above this many live voices, a new one is dropped rather than stacked. */
const VOICE_CAP = 12;
/** A sound that could not start within this long of being asked for is dropped, not played late. */
const STALE_MS = 1500;
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

function unlockOnGesture(ac: AudioContext): void {
  const target = globalThis.document;
  if (target === undefined || target === null || ac.state !== 'suspended') return;
  const once = (): void => {
    void ac.resume().catch(() => undefined);
    target.removeEventListener('pointerdown', once, true);
    target.removeEventListener('keydown', once, true);
    target.removeEventListener('touchend', once, true);
  };
  target.addEventListener('pointerdown', once, true);
  target.addEventListener('keydown', once, true);
  target.addEventListener('touchend', once, true);
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
    unlockOnGesture(ctx);
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
    const asked = performance.now();
    // Inside a gesture this unlocks the context; outside one the browser holds it, and the
    // staleness check below drops the sound rather than playing it whenever a gesture comes.
    const ready = ac.state === 'suspended' ? ac.resume().catch(() => undefined) : Promise.resolve();
    void Promise.all([load(file), ready]).then(([buf]) => {
      if (ac.state !== 'running' || performance.now() - asked > STALE_MS) return;
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
