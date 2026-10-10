/*
 * The placeholder cues' `AudioContext`. `./mixer.ts` owns the other one, for
 * recorded takes, until wave B moves these cues onto roles and deletes this
 * file (`docs/planning/audio.md`).
 *
 * Outside those two files, grep for `AudioContext`, `new Audio(`, `.mp3` or
 * `.ogg` and there is no hit. That is the deliverable: when the operator
 * replaces the placeholder cues, or wants them routed through a mixer, or wants
 * them off on a slow machine, there is one file to change and no component to
 * find. `../components/CardTile.tsx` and `../rooms/RoomList.tsx` call `playCue`
 * and know nothing about any of this.
 *
 * ## Suspended until a gesture — and why the listener lives here
 *
 * Every browser refuses audio until the page has been interacted with: a context
 * created before a gesture starts in `suspended` state and stays there until
 * something calls `resume()` from inside a trusted event handler. So this sink
 * installs a one-shot, capture-phase listener for `pointerdown`, `keydown` and
 * `touchend` the first time it is asked to play anything, and resumes there.
 *
 * The listener belongs to the SINK, not to the module core, because the context
 * is the sink's. `index.ts` has no DOM in it at all, which is what lets the
 * module be tested in an environment with no WebAudio and no document worth
 * speaking of. A hover before the first click is silently dropped — that is the
 * browser's rule, not a bug, and it is why `hover` is not the cue anything
 * important depends on.
 *
 * ## Files, when they exist
 *
 * `request.url` is non-null only once `cue-manifest.json` names a file, which it
 * does for nothing today. The fetch-and-decode path below is therefore written
 * and **unexercised in production**: no asset exists to exercise it. It is here
 * rather than deferred so that landing an asset is genuinely the one-row data
 * change the brief asks for, and it is written to fail soft — a fetch or decode
 * that fails marks the URL bad once and every later request for that cue takes
 * the synthesised envelope. A CDN outage costs you a worse sound, not silence
 * and not an unhandled rejection in a pointer handler.
 */

import type { CueRequest, CueSink } from './sink.ts';
import type { Cue } from './cues.ts';

/**
 * Minimum gap between two soundings of the SAME cue, in ms.
 *
 * A pointer skimming a 15-card pack crosses several tiles in a few frames, and
 * without this their hover cues pile into a buzz. The throttle is in the sink
 * rather than in `playCue` on purpose: it is a property of overlapping AUDIO,
 * not of the app's intent, and a test asserting "a hover requests a cue" should
 * see every request the app made. Injected sinks in tests have no throttle.
 */
const MIN_GAP_MS = 35;

/** `webkitAudioContext` is still what older WebKit exposes. */
interface AudioContextGlobals {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

/** The constructor, or `undefined` where there is no WebAudio (jsdom, Node). */
function audioContextCtor(): typeof AudioContext | undefined {
  const g = globalThis as unknown as AudioContextGlobals;
  return g.AudioContext ?? g.webkitAudioContext;
}

/** True where a WebAudio sink could work at all. `index.ts` checks before building one. */
export function hasWebAudio(): boolean {
  return audioContextCtor() !== undefined;
}

/**
 * Build the production sink, or `null` where WebAudio does not exist.
 *
 * Nothing is constructed here — no context, no listener. Both happen on the
 * first actual `play`, so importing this module costs nothing and a page that
 * never plays a cue never creates a context.
 */
export function createWebAudioSink(): CueSink | null {
  const Ctor = audioContextCtor();
  if (Ctor === undefined) return null;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let armed = false;
  const lastAt = new Map<Cue, number>();
  /** url -> decoded buffer, or `null` once it has failed and must not be retried. */
  const buffers = new Map<string, AudioBuffer | null>();
  const pending = new Set<string>();

  /** Resume the context from inside a trusted gesture. Idempotent. */
  const unlock = (): void => {
    if (ctx !== null && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  };

  /** Install the one-shot gesture listeners, once. */
  const arm = (): void => {
    if (armed) return;
    armed = true;
    const target = globalThis.document;
    if (target === undefined || target === null) return;
    const once = (): void => {
      unlock();
      target.removeEventListener('pointerdown', once, true);
      target.removeEventListener('keydown', once, true);
      target.removeEventListener('touchend', once, true);
    };
    // Capture phase, so a handler that stops propagation cannot keep the page
    // permanently silent.
    target.addEventListener('pointerdown', once, true);
    target.addEventListener('keydown', once, true);
    target.addEventListener('touchend', once, true);
  };

  const context = (): AudioContext | null => {
    if (ctx !== null) return ctx;
    try {
      ctx = new Ctor();
    } catch {
      // A browser that has the constructor and still refuses (a hard limit on
      // live contexts, a policy). Treat it as "no sound" rather than crashing
      // the click that asked for it.
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  };

  /** Fetch and decode a file once; never retry a failure. */
  const load = (url: string, ac: AudioContext): void => {
    if (buffers.has(url) || pending.has(url)) return;
    pending.add(url);
    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        buffers.set(url, await ac.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // Recorded as a failure so the next hover does not re-fetch it. The cue
        // keeps working: `play` falls through to the envelope.
        buffers.set(url, null);
      } finally {
        pending.delete(url);
      }
    })();
  };

  /** One oscillator through one gain envelope. The placeholder cue. */
  const synth = (req: CueRequest, ac: AudioContext, out: GainNode): void => {
    const { spec } = req;
    const now = ac.currentTime;
    const end = now + spec.ms / 1000;
    const osc = ac.createOscillator();
    osc.type = spec.wave;
    osc.frequency.setValueAtTime(spec.from, now);
    // Exponential, because pitch is perceived logarithmically — a linear glide
    // from 440 to 220 spends most of its time sounding like the top note.
    osc.frequency.exponentialRampToValueAtTime(Math.max(spec.to, 1), end);
    const env = ac.createGain();
    const peak = Math.max(spec.gain * req.volume, 0.0001);
    env.gain.setValueAtTime(0.0001, now);
    // A 4ms attack: fast enough to feel instant, slow enough that the onset is
    // not a click of its own.
    env.gain.exponentialRampToValueAtTime(peak, now + Math.min(0.004, spec.ms / 2000));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env);
    env.connect(out);
    osc.start(now);
    osc.stop(end);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  };

  const play = (req: CueRequest): void => {
    try {
      arm();
      const ac = context();
      if (ac === null || master === null) return;
      // Still suspended: no gesture yet. Nothing to play and nothing to queue —
      // a cue is only meaningful at the moment it was asked for.
      if (ac.state === 'suspended') return;

      // The throttle gates actual SOUNDINGS, and is therefore checked after the
      // two bail-outs above. Checking it first meant a hover dropped for having
      // no gesture yet also ate the window, so the very first audible cue after
      // the unlocking click could be swallowed.
      const now = Date.now();
      const last = lastAt.get(req.cue);
      if (last !== undefined && now - last < MIN_GAP_MS) return;
      lastAt.set(req.cue, now);

      if (req.url !== null) {
        const buf = buffers.get(req.url);
        if (buf === undefined) {
          // Not loaded yet. Start the load and synthesise THIS one, so the very
          // first click still makes a noise instead of waiting on a network.
          load(req.url, ac);
        } else if (buf !== null) {
          const src = ac.createBufferSource();
          src.buffer = buf;
          const env = ac.createGain();
          env.gain.value = Math.max(req.spec.gain * req.volume, 0);
          src.connect(env);
          env.connect(master);
          src.start();
          src.onended = () => {
            src.disconnect();
            env.disconnect();
          };
          return;
        }
        // `buf === null` means this URL has already failed. Fall through.
      }
      synth(req, ac, master);
    } catch {
      // `play` is called from pointer handlers. A cue that cannot sound must not
      // take the interaction down with it.
    }
  };

  return { play };
}
