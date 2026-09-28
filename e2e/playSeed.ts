/**
 * The seed every e2e match is played with.
 *
 * Its own module so `play.spec.ts` can name it in a failure without importing
 * `harness.ts`, which is a script: importing it for a constant would spawn a
 * second server.
 *
 * Forge reads this as the seed for its shuffles, the coin toss and the precon
 * pick, so the e2e plays ONE game rather than a new one each run. The chain is
 * short and every link is checked: `play/harness.ts` puts it on the play
 * server's environment, `parseStartBody` reads it into `MatchSpec.seed`
 * (`apps/server/src/play/socket.ts`), `bridgeConfig` spreads the spec to the
 * JVM, and `PlayBridge.startMatch` calls `MyRandom.setRandom(new Random(seed))`
 * before a card is dealt. `apps/server/src/play/seed.jvm.test.ts` measures the
 * end of that chain against a real Forge: two cold matches on one seed, the
 * same library order both times.
 *
 * ## It did nothing at all until 2026-09-27
 *
 * Wave 20 set `CARDTABLE_PLAY_SEED` on `e2e/harness.ts`'s server — the one
 * started deliberately WITHOUT `CARDTABLE_FORGE_JAR`, which therefore cannot
 * start a Forge match. The play stack has its own server
 * (`e2e/play/harness.ts`) and that is the process the variable had to be on. So
 * no e2e match was ever seeded, every run of `play.spec.ts` dealt a fresh
 * shuffle, and the note recorded here — "seed 7 casts Squadron Hawk and
 * resolves it with no button press, verified twice" — was two lucky deals, not
 * a property of this number. Wave 22 then read the bridge and concluded the
 * opposite, that the seed never reaches `MyRandom`; that was wrong too
 * (`PlayBridge.java` has always called it). Both readings came from reading
 * code. The test now measures it.
 *
 * ## Changing this number changes the game
 *
 * And not every game reaches the scenario a spec needs. Seed 7 deals alice six
 * lands and one Preordain, which is a hand `play.spec.ts` can only play out
 * because its drag loop now plays a land EVERY turn rather than once. Seed
 * 20260925 (the first one tried) produced a game where Forge never offered
 * alice a castable spell at all.
 *
 * If a spec goes red after a change here, suspect the seed before the code —
 * and the red will be the same red every run, which is the whole point.
 */
export const PLAY_SEED = 7;
