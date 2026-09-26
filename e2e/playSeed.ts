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
 * **Changing this number changes the game**, and not every game reaches the
 * scenario a spec needs: seed 20260925 (the first one tried) produced a game
 * where Forge never offered alice a castable spell at all, so `play.spec.ts`'s
 * unattended-resolve check had nothing to exercise — deterministically, which
 * is how it was found. Seed 7 casts Squadron Hawk and resolves it with no
 * button press, verified twice.
 *
 * If a spec goes red after a change here, suspect the seed before the code.
 */
export const PLAY_SEED = 7;
