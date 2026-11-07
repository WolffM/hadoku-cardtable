/*
 * The take mixer: `mix.ts`'s plan, played through WebAudio. One `AudioContext`
 * a game needs. Every voice is one buffer source through one gain node; a
 * ducking voice goes straight to the master and pulls the duck node (every
 * other voice's path) down for its own length. Levels are baked in at
 * start, except the player's own two, which the master and music node
 * take live. Browsers start a context `suspended`, resumable only inside a
 * real gesture, so it installs a one-shot listener and resumes there; a
 * sound asked for before that first gesture is dropped. Fails soft
 * throughout: a take that will not fetch or decode is skipped, never thrown.
 */

import { createMixPlanner, DEFAULT_MIX, type MixPlanner, type MixSettings, type PlanResult, type SoundEvent } from './mix.ts';

/** Above this many live voices, a new one is dropped rather than stacked. */
const VOICE_CAP = 12;
/** Above this many live voices of one cell, a new one is dropped: a combo looped several times must not stack into a wall. */
export const CELL_VOICE_CAP = 2;
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
  /** Decode every cue take the planner holds, from `pack`'s bytes where it has them, fetched one by one otherwise. Music is left to {@link loop}. */
  preload(pack?: ReadonlyMap<string, ArrayBuffer>): void;
  /**
   * Loop a music role on the music bus, crossfading from whatever loops now; `null` fades it out. A
   * list loops the first role that has a take; music waits for the first gesture rather than being
   * dropped. A role with several takes loops `pick`'s choice while its cell still holds it, else one
   * at random; a new pick crossfades to it.
   */
  loop(role: MusicChoice, pick?: (role: string) => string | null): void;
  /** The role looping now and the take it plays, or `null`: what sound settings names as the track. */
  nowPlaying(): { role: string; file: string } | null;
  /** A cell's takes, as assigned. */
  takes(cell: string): readonly string[];
  /** Loop one take on the music bus, outside any role, crossfading from whatever loops now; `null` fades it out. */
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
  /** Live voices per cell, for {@link CELL_VOICE_CAP}. */
  const liveByCell = new Map<string, number>();
  let loopRole: string | null = null;
  /** The take `loopRole` plays. */
  let loopTake: string | null = null;
  let loopVoice: { src: AudioBufferSourceNode; env: GainNode } | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  /**
   * The one music take kept decoded: the loop's. Decoded audio is float32 PCM, about 70 MB for three minutes
   * of 48 kHz stereo, so a take the loop has moved off is let go rather than kept beside the cues; a voice
   * still fading out holds its own buffer until it stops.
   */
  let loopBuffer: { file: string; task: Promise<AudioBuffer | null> } | null = null;

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

  const decode = async (ac: AudioContext, file: string): Promise<AudioBuffer | null> => {
    try {
      const res = await fetch(takeUrl(file));
      if (!res.ok) return null;
      return await ac.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  };

  /** A cue's buffer, decoded once and kept for the page's life. */
  const load = (file: string): Promise<AudioBuffer | null> => {
    const known = buffers.get(file);
    if (known !== undefined) return known;
    const ac = context();
    if (ac === null) return Promise.resolve(null);
    const task = decode(ac, file);
    buffers.set(file, task);
    return task;
  };

  /** A music take's buffer, held only while it is the loop's (`loopBuffer`). */
  const loadLoop = (file: string): Promise<AudioBuffer | null> => {
    if (loopBuffer?.file === file) return loopBuffer.task;
    const ac = context();
    if (ac === null) return Promise.resolve(null);
    loopBuffer = { file, task: buffers.get(file) ?? decode(ac, file) };
    return loopBuffer.task;
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

  /** `cell` null: an audition, outside any cell's cap. */
  const start = (cell: string | null, file: string, gain: number, ducks: boolean, reverse = false, rate = 1): void => {
    const ac = context();
    if (ac === null) return;
    const asked = performance.now();
    // Inside a gesture this unlocks the context; outside one the browser holds it, and the
    // staleness check below drops the sound rather than playing it whenever a gesture comes.
    const ready = ac.state === 'suspended' ? ac.resume().catch(() => undefined) : Promise.resolve();
    void Promise.all([reverse ? loadReversed(file) : load(file), ready]).then(([buf]) => {
      if (ac.state !== 'running' || performance.now() - asked > STALE_MS) return;
      if (buf === null || master === null || duckNode === null || live >= VOICE_CAP) return;
      if (cell !== null && (liveByCell.get(cell) ?? 0) >= CELL_VOICE_CAP) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) src.playbackRate.value = rate;
      const env = ac.createGain();
      env.gain.value = Math.max(gain, 0);
      src.connect(env);
      env.connect(ducks ? master : duckNode);
      if (ducks) duck(ac, buf.duration);
      live += 1;
      if (cell !== null) liveByCell.set(cell, (liveByCell.get(cell) ?? 0) + 1);
      src.onended = () => {
        live -= 1;
        if (cell !== null) {
          const left = (liveByCell.get(cell) ?? 1) - 1;
          if (left > 0) liveByCell.set(cell, left);
          else liveByCell.delete(cell);
        }
        src.disconnect();
        env.disconnect();
      };
      src.start();
    });
  };

  const fadeOutLoop = (ac: AudioContext): void => {
    loopBuffer = null;
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
    void Promise.all([loadLoop(file), ready]).then(([buf]) => {
      if (buf === null || musicNode === null || loopRole !== key || loopTake !== file || loopVoice !== null) return;
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
      for (const v of plan.voices) start(v.cell, v.file, v.gain, v.duck, v.reverse === true, v.rate ?? 1);
      return plan;
    },
    playFile(file, gain = 1) {
      start(null, file, gain, false);
    },
    preload(pack) {
      const ac = context();
      if (ac === null) return;
      for (const f of planner.cueTakes()) {
        const bytes = pack?.get(f);
        if (bytes === undefined) void load(f);
        else if (!buffers.has(f)) buffers.set(f, ac.decodeAudioData(bytes).catch(() => null));
      }
    },
    loop(choice, pick) {
      const roles = choice === null ? [] : typeof choice === 'string' ? [choice] : choice;
      const role = roles.find((r) => planner.has(`${r}|play`)) ?? null;
      const wanted = role === null ? null : (pick?.(role) ?? null);
      const picked = wanted !== null && planner.takes(`${role}|play`).includes(wanted) ? wanted : null;
      if (role === loopRole && (picked === null || picked === loopTake)) return;
      loopRole = role;
      loopTake = null;
      if (ctx !== null) fadeOutLoop(ctx);
      if (role === null) return;
      if (picked !== null) {
        loopTake = picked;
        startLoop(role, picked, planner.gainOf(`${role}|play`) * mixer.settings.bus.music);
        return;
      }
      const voice = planner.plan({ role }, performance.now(), mixer.settings).voices[0];
      if (voice === undefined) {
        // Planned nothing (asked again within the collapse window): asking again
        // later must try again, and nothing is built for it.
        loopRole = null;
        return;
      }
      loopTake = voice.file;
      startLoop(role, voice.file, voice.gain);
    },
    loopFile(file) {
      const key = file === null ? null : `file:${file}`;
      if (key === loopRole) return;
      loopRole = key;
      loopTake = file;
      if (ctx !== null) fadeOutLoop(ctx);
      if (key === null || file === null) return;
      startLoop(key, file, 1);
    },
    takes: (cell) => planner.takes(cell),
    nowPlaying() {
      return loopRole === null || loopTake === null || loopRole.startsWith('file:') ? null : { role: loopRole, file: loopTake };
    },
    setLevels(next) {
      levels = next;
      if (master !== null) master.gain.value = next.volume;
      if (musicNode !== null) musicNode.gain.value = next.music;
    },
  };
  return mixer;
}
