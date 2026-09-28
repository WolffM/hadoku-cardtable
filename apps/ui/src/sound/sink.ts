/*
 * The seam: what "play this cue" means once the module has decided to play it.
 *
 * A sink is the OUTPUT DEVICE. Everything above it — the vocabulary, the
 * manifest lookup, mute, the master volume — is decided before a request
 * reaches one, and a sink's only job is to make a noise. That split is what
 * makes the module testable at all: jsdom has no WebAudio, so a test injects a
 * recording sink and asserts on the requests, and no test ever needs an
 * `AudioContext` to exist. A test that needs WebAudio is a test that will rot.
 *
 * It is also where a real asset arrives. `request.url` is non-null exactly when
 * `cue-manifest.json` names a file for that cue; `request.spec` is always there
 * as the fallback. A sink that cannot fetch (or whose fetch fails) plays the
 * spec, which is why an unreachable CDN costs a nicer sound rather than silence.
 */

import type { Cue, CueSpec } from './cues.ts';

/** One thing to play, fully resolved. Everything a sink needs and nothing else. */
export interface CueRequest {
  /** Which cue this is. Sinks use it to de-duplicate and tests assert on it. */
  readonly cue: Cue;
  /**
   * The audio file to play, when the manifest names one, else `null`.
   *
   * `null` means *synthesise `spec`* — the state every cue is in today.
   */
  readonly url: string | null;
  /** The envelope to synthesise, and the fallback if `url` will not load. */
  readonly spec: CueSpec;
  /** Master volume, 0..1. Multiply `spec.gain` by it. */
  readonly volume: number;
}

/**
 * Something that can make a noise.
 *
 * One method, deliberately. A sink does not get to know about mute (already
 * applied), about the manifest (already resolved), or about React. The WebAudio
 * sink in `./webaudio.ts` is the only production implementation; the second
 * implementation is three lines in a test.
 *
 * `play` must never throw. It is called from pointer handlers on a hot path —
 * a hover over a 15-card pack — and an exception there would break the
 * interaction the cue was decorating.
 */
export interface CueSink {
  readonly play: (request: CueRequest) => void;
}
