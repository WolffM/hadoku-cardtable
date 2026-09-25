/**
 * The seed every e2e match is played with.
 *
 * Its own module so `play.spec.ts` can name it in a failure without importing
 * `harness.ts`, which is a script: importing it for a constant would spawn a
 * second server.
 *
 * Forge reads this as the seed for its shuffles, the coin toss and the precon
 * pick (`apps/server/src/play/README.md`), so the e2e plays ONE game rather
 * than a new one each run. That matters for more than tidiness:
 * `play.spec.ts` proves a spell resolves with nobody pressing a button, which
 * it can only do if the game ever offers it a castable spell — and on
 * 2026-09-25 CI drew a hand where Forge offered nothing but lands, so the
 * proof failed on the shuffle rather than on the product.
 *
 * Changing this number changes the game. If a spec goes red after a change
 * here, suspect the seed before the code.
 */
export const PLAY_SEED = 20260925;
