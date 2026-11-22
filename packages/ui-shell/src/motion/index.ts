/*
 * How much the page moves, the player's say over it (operator, 2026-11-21, after a player said moving
 * elements were bad for their ADHD: "let's just make sure that each of them can be individually toggled").
 *
 * Three switches, each its own:
 *   - **Card motion** — what travels, rams, cracks and pops. Off is the board's reduced-motion path:
 *     every `prefersReducedMotion()` reader, and every `@media (prefers-reduced-motion: …)` block,
 *     which `motionCss` (`./css.ts`) makes answer to the switch.
 *   - **Screen shake** — the table jolting under a heavy blow (`screenShakeAllowed()`).
 *   - **Ambient motion** — the endless loops: pulses, glows, shimmers, bobbing. Off pauses each, its
 *     first frame left standing (`motionCss`).
 *
 * A switch nobody has set follows the system's `prefers-reduced-motion`: asked for less, all three
 * start off. What the player sets wins either way, so a player can also turn motion ON over the OS.
 * A switch the player set is written on the root the sheets resolve on, as `data-motion` (`full`/`reduce`)
 * or `data-ambient` (`on`/`off`); one left to the system is not, so the sheets' own media query answers in
 * the frame the system changes (an attribute written from a `change` event lags it by a frame or more:
 * af70's flyer swayed on under reduced motion). `data-shake` is always written: script reads it.
 */

/** One player's choices; a switch left `undefined` follows the system. */
export interface MotionChoices {
  cardMotion?: boolean;
  screenShake?: boolean;
  ambientMotion?: boolean;
}

/** Every switch resolved: what the page does now. */
export type MotionState = Required<MotionChoices>;

export const MOTION_ATTR = { motion: 'data-motion', shake: 'data-shake', ambient: 'data-ambient' } as const;

let chosen: MotionChoices = {};

/** Whether the system asks for less motion: the default for every switch nobody has set. */
export function systemReducesMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The switches as the page applies them: each the player's, else the system's. */
export function motionState(choices: MotionChoices = chosen): MotionState {
  const system = !systemReducesMotion();
  return {
    cardMotion: choices.cardMotion ?? system,
    screenShake: choices.screenShake ?? system,
    ambientMotion: choices.ambientMotion ?? system,
  };
}

/** The player's choices, as the page applies them from now on (`applyMotion` writes them on a root). */
export function setMotionChoices(choices: MotionChoices): void {
  chosen = { ...choices };
}

/**
 * Whether the board draws its reduced-motion path: card motion off. Any game's board reads this without
 * caring where the question lives; cardtable's own `play/motion.ts` re-exports it.
 */
export function prefersReducedMotion(): boolean {
  return !motionState().cardMotion;
}

/** Whether the table may shake. */
export function screenShakeAllowed(): boolean {
  return motionState().screenShake;
}

/** Writes the player's switches on `root`, where the sheets' rewritten selectors (`./css.ts`) look for them, and the effective shake. */
export function applyMotion(root: Element, choices: MotionChoices = chosen): void {
  const set = (attr: string, on: boolean | undefined, yes: string, no: string): void => (on === undefined ? root.removeAttribute(attr) : root.setAttribute(attr, on ? yes : no));
  set(MOTION_ATTR.motion, choices.cardMotion, 'full', 'reduce');
  set(MOTION_ATTR.ambient, choices.ambientMotion, 'on', 'off');
  root.setAttribute(MOTION_ATTR.shake, motionState(choices).screenShake ? 'on' : 'off');
}

export function clearMotion(root: Element): void {
  for (const attr of Object.values(MOTION_ATTR)) root.removeAttribute(attr);
}

/** Per game (`<key>`, handed in): the choices last applied in this browser, so the first frame is drawn with them. */
export function rememberedMotion(key: string): MotionChoices | null {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? null;
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const out: MotionChoices = {};
    for (const name of ['cardMotion', 'screenShake', 'ambientMotion'] as const) {
      const v = (parsed as Record<string, unknown>)[name];
      if (typeof v === 'boolean') out[name] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function rememberMotion(key: string, choices: MotionChoices): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(choices));
  } catch {
    // Not remembered: the next page follows the system until prefs answer.
  }
}

export { ambientPlayState, gateSelector, motionCss } from './css.ts';
export { animate, animationsOf, at, hold, homeEase, markTempo, moment, quicken, runningOf, STILL, TEMPO_PROPERTY, timerSet, together, weightEase, writeDurations, type AnimateContext, type Clip, type MotionContext, type Running, type Timed } from './animate.ts';
export { everyFrame, nextFrame, resetFrames, type FrameStep } from './frame.ts';
export { claimParticles, PARTICLE_BUDGET, particlePool, particleShare, shared, type ParticlePool } from './particles.ts';
export { animationName, Stage, type StageHold, type StageOptions, type TrackOptions } from './stage.ts';
export { afterGlide, rel, standIn, type Box, type StandInOptions } from './stand-in.ts';
