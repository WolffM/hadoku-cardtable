/*
 * The cue vocabulary, and the envelope each cue is synthesised from.
 *
 * This file is DATA. It names every sound the app can make and describes each
 * one as a short envelope; it knows nothing about `AudioContext`, about React,
 * or about which component asked. That separation is the whole point of the
 * module — see `index.ts` for why.
 *
 * ## Why synthesised, and why that is not the interesting part
 *
 * The operator has no audio assets yet (*"we need a TON of assets still"*) and
 * will replace every one of these. So the envelopes below are a placeholder in
 * exactly the way card art is a placeholder: the deliverable is the seam, not
 * the sound. Swapping a cue for a real recording is a row in
 * `cue-manifest.json` — see `manifest.ts` — and touches no code.
 *
 * ## Adding a cue
 *
 * Add the name to `Cue`, add its spec to `CUE_SPECS`, done. `CUE_SPECS` is typed
 * as a total `Record<Cue, CueSpec>`, so a new member that nobody described is a
 * type error rather than a cue that silently plays nothing.
 */

/**
 * Every sound this app can make.
 *
 * Five, chosen from the operator's own list — *"lots of ui sounds like
 * hovering, dragging, selecting buttons etc."* — and deliberately no more:
 * a vocabulary is only useful if the next person can hold it in their head.
 *
 * - `hover` — the pointer arrives on something interactive. The quietest cue by
 *   a wide margin, because it is the one that fires hundreds of times a minute.
 * - `select` — a click that took effect: a pick, a button, a card chosen.
 * - `drag` — a drag has begun and the thing is now in hand.
 * - `drop` — the thing landed somewhere it was allowed to land.
 * - `deny` — the action was refused: an illegal drop, a disabled control, a
 *   target Forge would not accept.
 */
export type Cue = 'hover' | 'select' | 'drag' | 'drop' | 'deny';

/** The vocabulary as a list, for tests and for iterating the whole set. */
export const CUES: readonly Cue[] = Object.freeze<Cue[]>(['hover', 'select', 'drag', 'drop', 'deny']);

/**
 * One synthesised cue.
 *
 * A single oscillator gliding from `from` to `to` over `ms`, through a gain
 * envelope that attacks fast and decays to silence. That is enough shape to
 * make five cues distinguishable and little enough to describe in one line
 * each, which is what keeps this file data.
 *
 * `gain` is RELATIVE: the sink multiplies it by the master volume, so lowering
 * the volume lowers every cue and the mix between them is preserved.
 */
export interface CueSpec {
  /** Oscillator shape. `sine` for ticks, `triangle` for body, `square` to bite. */
  readonly wave: 'sine' | 'triangle' | 'square' | 'sawtooth';
  /** Hz at the attack. */
  readonly from: number;
  /** Hz at the release. Equal to `from` for a flat tone. */
  readonly to: number;
  /** Total duration in milliseconds. Short: these are cues, not music. */
  readonly ms: number;
  /** Peak gain relative to the master volume, 0..1. */
  readonly gain: number;
}

/**
 * The envelopes.
 *
 * Tuned by ear against the two surfaces this wave wires (a draft card and the
 * room list), and every one of them is expected to be thrown away when real
 * assets land. Two properties are worth keeping when they are:
 *
 * - **`hover` is much quieter and much shorter than everything else.** It fires
 *   on every pointer move across a 15-card pack. At `select`'s gain it would be
 *   unbearable within ten seconds.
 * - **`drop` falls and `deny` buzzes.** Pitch direction is the only cue-level
 *   signal a player gets without looking, so rising means "it worked" and
 *   falling means "it is over"; `deny` is the only `square` in the set.
 */
export const CUE_SPECS: Readonly<Record<Cue, CueSpec>> = Object.freeze({
  hover: { wave: 'sine', from: 880, to: 990, ms: 26, gain: 0.22 },
  select: { wave: 'triangle', from: 520, to: 880, ms: 70, gain: 0.7 },
  drag: { wave: 'sine', from: 300, to: 380, ms: 45, gain: 0.4 },
  drop: { wave: 'triangle', from: 440, to: 220, ms: 95, gain: 0.7 },
  deny: { wave: 'square', from: 200, to: 155, ms: 130, gain: 0.45 },
});
