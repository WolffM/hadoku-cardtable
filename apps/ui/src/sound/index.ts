/*
 * The app's sound, behind one function.
 *
 * ## The API, in full
 *
 *     import { playCue, cueHandler } from '../sound/index.ts';
 *
 *     playCue('select');                            // make a noise, now
 *     <div onMouseEnter={cueHandler('hover')} />    // a stable listener
 *
 * That is the whole call surface a component ever touches. Five cue names —
 * `hover`, `select`, `drag`, `drop`, `deny` (`./cues.ts`) — and no arguments
 * beyond the name. No component constructs audio, imports `AudioContext`, holds
 * a URL, or decides whether the player wants sound.
 *
 * ## Why it is shaped this way
 *
 * This is the discipline that kept card art to one resolver and one `<img>`, and
 * the reason is the same one, stated in `packages/carddata/src/art/index.ts`:
 * twelve call sites cannot be re-pointed later. The moment `new Audio('…')`
 * appears in a component, the operator's *"replace all the placeholder sounds"*
 * becomes a survey of the codebase instead of an edit to a JSON file. So:
 *
 *   playCue(cue) ─┬─ isMuted()?           → ./mute.ts      (the player's say)
 *                 ├─ CUE_SPECS[cue]       → ./cues.ts      (data: the envelope)
 *                 ├─ cueUrl(cue)          → ./manifest.ts  (data: the file, if any)
 *                 └─ sink.play(request)   → ./webaudio.ts  (the only AudioContext)
 *
 * Each of those four is a file with one job, and three of the four are testable
 * without an audio device.
 *
 * ## The sink is injectable, and that is the testing story
 *
 * jsdom has no WebAudio. A test that needed one would have to fake the whole
 * node graph and would rot the first time this file changed shape. Instead
 * `setCueSink` replaces the output device with a recorder, and tests assert on
 * the `CueRequest`s the app made: which cue, at what volume, with what URL.
 * `sound.test.ts` proves — with a counting stub in `globalThis` — that no
 * `AudioContext` is constructed on that path at all.
 *
 * ## For the next wave
 *
 * The board's own cues are deliberately NOT wired here: every surface that wants
 * them (`play/Board.tsx`, `play/live/LiveBoard.tsx`, `play/live/gestures/`) is
 * being rewritten by another lane this wave, and two lanes in one file is what
 * the wave protocol exists to prevent. Wiring them is a call to `playCue` at the
 * right moment and nothing else — `drag` when a gesture takes a card, `drop`
 * when it lands, `deny` when the drop was refused. Nothing in this module needs
 * to change to accept them.
 */

import { CUE_SPECS, type Cue } from './cues.ts';
import { cueUrl } from './manifest.ts';
import { CUE_VOLUME, isMuted } from './mute.ts';
import type { CueRequest, CueSink } from './sink.ts';
import { createWebAudioSink } from './webaudio.ts';

/** Set by `setCueSink`. When non-null it is used and nothing else is built. */
let injected: CueSink | null = null;
/** The lazily-built production sink. `null` after a failed attempt; see below. */
let fallback: CueSink | null = null;
/** Whether we have already tried to build the production sink. */
let tried = false;

/**
 * Replace the output device. `null` restores the default.
 *
 * For tests, and for the next thing that wants cues routed somewhere else (a
 * mixer, a recorder, a spec that asserts a game made the right noises). Not a
 * production call path — nothing in the app calls it.
 */
export function setCueSink(sink: CueSink | null): void {
  injected = sink;
}

/**
 * Forget the injected sink AND the memoised production one, so the next
 * `currentCueSink()` probes `globalThis` again.
 *
 * For tests only, and it exists because `currentCueSink` deliberately probes
 * once: without this, a case that stubs `AudioContext` would be answered from a
 * `null` cached by an earlier case and would pass while proving nothing. That
 * failure mode — a control that passes while doing nothing — is the one this
 * repo keeps finding, so the reset is exported rather than worked around.
 */
export function resetCueSinkForTests(): void {
  injected = null;
  fallback = null;
  tried = false;
}

/**
 * The sink a cue would go to, or `null` where there is no way to make a sound.
 *
 * The production sink is built at most ONCE, and a failure is remembered: in an
 * environment without WebAudio (jsdom, a server render) this returns `null`
 * forever after the first call rather than re-probing `globalThis` on every
 * hover.
 */
export function currentCueSink(): CueSink | null {
  if (injected !== null) return injected;
  if (!tried) {
    tried = true;
    fallback = createWebAudioSink();
  }
  return fallback;
}

/**
 * Play a cue.
 *
 * The single entry point. Silent, and cheap, when the player has muted or when
 * the environment cannot make a sound — both are the normal case somewhere, so
 * neither is an error and neither is reported.
 *
 * Never throws: it is called from pointer and click handlers, and a cue that
 * cannot sound must not take the interaction it was decorating down with it.
 * (The sink promises the same for its own internals; this guard is for the
 * lookup path above it.)
 */
export function playCue(cue: Cue): void {
  try {
    if (isMuted()) return;
    const spec = CUE_SPECS[cue];
    // A cue name that is not in the vocabulary. Unreachable through the type,
    // reachable from JS, and worth surviving rather than throwing in a handler.
    if (spec === undefined) return;
    const sink = currentCueSink();
    if (sink === null) return;
    const request: CueRequest = { cue, spec, url: cueUrl(cue), volume: CUE_VOLUME };
    sink.play(request);
  } catch {
    // Sound is decoration. Nothing it does is worth breaking a click over.
  }
}

/** One stable listener per cue, built on first ask. */
const handlers = new Map<Cue, () => void>();

/**
 * A listener that plays `cue`, referentially stable across renders.
 *
 * `onMouseEnter={() => playCue('hover')}` allocates a fresh closure on every
 * render, and `CardTile` is `memo`-ised specifically because a draft screen
 * holds 60 tiles and re-rendering all of them on each pick was the lag. A
 * handler from here is the same function object every time, so it cannot be the
 * thing that defeats a comparison — the same reason `DraftScreen` wraps `onPick`
 * in `useCallback`.
 */
export function cueHandler(cue: Cue): () => void {
  const existing = handlers.get(cue);
  if (existing !== undefined) return existing;
  const fn = (): void => playCue(cue);
  handlers.set(cue, fn);
  return fn;
}

export { CUES, CUE_SPECS, type Cue, type CueSpec } from './cues.ts';
export {
  CUE_MANIFEST,
  cueUrl,
  resolveCueUrl,
  type CueEntry,
  type CueManifest,
  type CueManifestFile,
  type CueSource,
} from './manifest.ts';
export {
  CUE_VOLUME,
  MUTE_KEY,
  isMuted,
  resetMutedForTests,
  setMuted,
  subscribeMuted,
  toggleMuted,
} from './mute.ts';
export type { CueRequest, CueSink } from './sink.ts';
export { hasWebAudio } from './webaudio.ts';

/*
 * `MuteButton` is deliberately NOT re-exported here. This module is logic: a
 * component importing `playCue` should not also pull React's JSX runtime and
 * `sound.css` into its dependency graph. The one place that needs the button
 * imports `./MuteButton.tsx` directly.
 */
