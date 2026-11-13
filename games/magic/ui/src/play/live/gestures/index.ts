/*
 * The pointer layer: attack, block, target (wave 24 §B).
 *
 * **THE SEAM.** Lane C's `LiveBoard` calls `installGestures` from one
 * `useEffect` and otherwise knows nothing about what happens in here. This
 * module is framework-free on purpose — no React, no JSX, no portal: it takes
 * the canvas element, delegates its pointer handlers from it, and creates its
 * own DOM inside lane A's overlay root.
 *
 * Wave 20 put the drag gesture and the targeter arrow in `LiveBoard.tsx`.
 * Wave 24 re-homed them here unchanged in behaviour, because the contract lane
 * A, B and C share says *"B draws into that root and attaches pointer handlers
 * by delegation"* and a React component is neither.
 *
 * ## What is in here
 *
 *  - `./targets.ts`   — what the pointer is over, and whether Forge offered it.
 *  - `./commit.ts`    — what a release MEANS, in `selectCard` / `selectPlayer`.
 *  - `./arrow.ts`     — the targeter arrow, drawn as DOM into the overlay.
 *  - `./marquee.ts`   — the box-draw rectangle, same overlay.
 *  - `./intent.ts`    — the attack-intent mark on a card's `<li>`.
 *  - `./install.ts`   — the one entry point, and the gesture state machine.
 *
 * Everything drawn is `pointer-events: none` (`./gestures.css`), so nothing in
 * here can ever become the element under the pointer.
 */
export type { GestureOptions, GestureHandle } from './types.ts';
export { installGestures } from './install.ts';
