/*
 * The take mixer: `mix.ts`'s plan, played through WebAudio.
 *
 * Every voice is one buffer source through one gain node. A voice whose role
 * ducks goes straight to the master; every other voice goes through the duck
 * node, which a ducking voice pulls down for its own length and lets back up.
 * Levels are baked into each voice when it starts, so a slider moved mid-sound
 * changes the next sound, which is all a cue of a second or two needs. The
 * player's own two levels are the exception: the master and the music node
 * under it take them at once, because music plays for minutes.
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
/** Music fades in and out over this long. */
const MUSIC_FADE_S = 1.5;
/** The level everything else drops to under a ducking voice. */
const DUCK_LEVEL = 0.35;

/** What loops: one music role, the first of several that has a take, or nothing. */
export type MusicChoice = string | readonly string[] | null;

export interface Mixer {
  readonly planner: MixPlanner;
  settings: MixSettings;
  /** Plan and play one event. The plan comes back at once; audio follows its buffers. */
  play(event: SoundEvent, nowMs?: number): PlanResult;
  /** Audition one take at a level, bypassing roles. */
  playFile(file: string, gain?: number): void;
  /** Fetch and decode ahead of time, so a scenario's first beats are not late. */
  preload(files: Iterable<string>): void;
  /**
   * Loop a music role on the music bus, crossfading from whatever loops now;
   * `null` fades the music out. A list loops the first of its roles that has
   * a take. Unlike a cue, music waits for the first gesture rather than being
   * dropped: it is meant to be playing whenever the page can play.
   */
  loop(role: MusicChoice): void;
  /**
   * Loop one take on the music bus, outside any role, crossfading from whatever loops now; `null`
   * fades it out. The music review's audition (`#/sounds/music`): the same bus and fade a match uses.
   */
  loopFile(file: string | null): void;
  /** The player's levels (`./mute.ts`), 0..1, applied at once — music too, mid-loop. */
  setLevels(levels: { volume: number; music: number }): void;
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
  let musicNode: GainNode | null = null;
  let levels = { volume: 1, music: 1 };
  let live = 0;
  let loopRole: string | null = null;
  let loopVoice: { src: AudioBufferSourceNode; env: GainNode } | null = null;
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
    master.gain.value = levels.volume;
    master.connect(ctx.destination);
    duckNode = ctx.createGain();
    duckNode.connect(master);
    musicNode = ctx.createGain();
    musicNode.gain.value = levels.music;
    musicNode.connect(duckNode);
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

  /** A take backwards, decoded once: a copy, so the forward buffer still plays forward. */
  const reversed = new Map<string, Promise<AudioBuffer | null>>();
  const loadReversed = (file: string): Promise<AudioBuffer | null> => {
    const known = reversed.get(file);
    if (known !== undefined) return known;
    const task = load(file).then((buf) => {
      const ac = context();
      if (buf === null || ac === null) return null;
      const out = ac.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).slice().reverse());
      return out;
    });
    reversed.set(file, task);
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

  const start = (file: string, gain: number, ducks: boolean, reverse = false, rate = 1): void => {
    const ac = context();
    if (ac === null) return;
    const asked = performance.now();
    // Inside a gesture this unlocks the context; outside one the browser holds it, and the
    // staleness check below drops the sound rather than playing it whenever a gesture comes.
    const ready = ac.state === 'suspended' ? ac.resume().catch(() => undefined) : Promise.resolve();
    void Promise.all([reverse ? loadReversed(file) : load(file), ready]).then(([buf]) => {
      if (ac.state !== 'running' || performance.now() - asked > STALE_MS) return;
      if (buf === null || master === null || duckNode === null || live >= VOICE_CAP) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) src.playbackRate.value = rate;
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

  const fadeOutLoop = (ac: AudioContext): void => {
    if (loopVoice === null) return;
    const { src, env } = loopVoice;
    loopVoice = null;
    const now = ac.currentTime;
    env.gain.cancelScheduledValues(now);
    env.gain.setValueAtTime(env.gain.value, now);
    env.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    src.stop(now + MUSIC_FADE_S);
    src.onended = () => {
      src.disconnect();
      env.disconnect();
    };
  };

  /** Loop `file` under `key` once it decodes, unless the loop asked for has changed by then. */
  const startLoop = (key: string, file: string, gain: number): void => {
    const ac = context();
    if (ac === null) return;
    const ready = ac.state === 'suspended' ? ac.resume().catch(() => undefined) : Promise.resolve();
    void Promise.all([load(file), ready]).then(([buf]) => {
      if (buf === null || musicNode === null || loopRole !== key || loopVoice !== null) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const env = ac.createGain();
      env.gain.setValueAtTime(0, ac.currentTime);
      env.gain.linearRampToValueAtTime(gain, ac.currentTime + MUSIC_FADE_S);
      src.connect(env);
      env.connect(musicNode);
      src.start();
      loopVoice = { src, env };
    });
  };

  const mixer: Mixer = {
    planner,
    settings: DEFAULT_MIX,
    play(event, nowMs = performance.now()) {
      const plan = planner.plan(event, nowMs, mixer.settings);
      for (const v of plan.voices) start(v.file, v.gain, v.duck, v.reverse === true, v.rate ?? 1);
      return plan;
    },
    playFile(file, gain = 1) {
      start(file, gain, false);
    },
    preload(files) {
      for (const f of files) void load(f);
    },
    loop(choice) {
      const roles = choice === null ? [] : typeof choice === 'string' ? [choice] : choice;
      const role = roles.find((r) => planner.has(`${r}|play`)) ?? null;
      if (role === loopRole) return;
      loopRole = role;
      if (ctx !== null) fadeOutLoop(ctx);
      if (role === null) return;
      const voice = planner.plan({ role }, performance.now(), mixer.settings).voices[0];
      if (voice === undefined) {
        // Planned nothing (asked again within the collapse window): asking again
        // later must try again, and nothing is built for it.
        loopRole = null;
        return;
      }
      startLoop(role, voice.file, voice.gain);
    },
    loopFile(file) {
      const key = file === null ? null : `file:${file}`;
      if (key === loopRole) return;
      loopRole = key;
      if (ctx !== null) fadeOutLoop(ctx);
      if (key === null || file === null) return;
      startLoop(key, file, 1);
    },
    setLevels(next) {
      levels = next;
      if (master !== null) master.gain.value = next.volume;
      if (musicNode !== null) musicNode.gain.value = next.music;
    },
  };
  return mixer;
}
