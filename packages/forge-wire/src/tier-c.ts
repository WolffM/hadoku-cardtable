/*
 * Tier C — the state channel. 3 methods, all of the actual work, and NOT
 * MODELLED HERE.
 *
 *     setGameView · openView · applyDelta
 *
 * ## Read this before you "finish" this file
 *
 * Wave 6 lane F mapped the 38 required `ProtocolMethod`s into three tiers and
 * then said, in as many words, that this tier is the one nobody has exercised:
 *
 *   > **Tier C is entirely unexercised.** If a real match's delta stream turns
 *   > out not to survive a JSON round trip, the week becomes a month and the
 *   > month becomes a quarter.
 *
 * `setGameView`, `openView` and `applyDelta` never fired in that spike. The
 * experiment that settles them is Wave 7 lane A, and its answer lands in
 * **`docs/spikes/tier-c.md`** — the reproduction, a non-zero delta count from a
 * real match, and a round-trip verdict naming what fails. Until that document
 * exists and says what survives, any schema here would be a guess dressed as a
 * contract, and the next session would inherit it as fact.
 *
 * What IS known, and is not enough:
 *
 * - `applyDelta`'s payload is already an id-keyed property diff, not an object
 *   graph — `Map<Integer, Map<TrackableProperty, Object>> objectDeltas` and the
 *   same for `newObjects` (`DeltaPacket.java:28-29`). The *shape* is JSON-shaped.
 * - The unsolved half is the VALUE encoding for `TrackableProperty`'s 214
 *   constants. 121 are already JSON scalars, 54 are entity refs (`refs.ts`
 *   covers those), 19 are scalar collections, 7 are enum names — and **13 over
 *   9 types need a hand-written encoder each**, with `ObjectType` untyped by
 *   construction and `CombatViewType` the nastiest. `docs/spikes/itoclient.md`,
 *   "Sizing Tier C", has the table.
 * - `setGameView(GameView, long sequenceNumber)` (ProtocolMethod.java:35) and
 *   `openView(TrackableCollection<PlayerView>)` (:36) are the baseline half of
 *   the same channel and have the same unknown in them.
 *
 * ## So what is in this file
 *
 * An arm per method that is REACHABLE and REFUSING. The three methods are named
 * in the envelope's union, so a Tier C frame is recognised rather than falling
 * through as "unknown method" — and its payload is `z.never()` with a message
 * that points here and at lane A, so parsing one fails with a sentence a human
 * can act on.
 *
 * The alternative — `z.unknown()`, or an open `z.record` — was rejected
 * deliberately. It would accept every malformed delta silently, look finished
 * in a diff, and turn the first real `applyDelta` into a debugging session
 * about why the browser rendered nothing. A schema that cannot fail is not a
 * schema; this repo has now found five green gates that guarded nothing, and
 * this would have been the sixth.
 *
 * `tierCFrames` therefore parses NOTHING, by construction, and
 * `tier-c.test.ts` asserts exactly that — including against a hand-built,
 * plausible-looking delta, which is the frame a future session would reach for.
 */

import { z } from 'zod';

/** The three Tier C method names (ProtocolMethod.java:35-36,79). */
export const TIER_C_METHODS = ['setGameView', 'openView', 'applyDelta'] as const;

export type TierCMethod = (typeof TIER_C_METHODS)[number];

/** Where the answer will be, and who is producing it. Quoted in every refusal. */
export const TIER_C_SPIKE = 'docs/spikes/tier-c.md';

/**
 * The sentence a consumer sees when it tries to send or parse a Tier C frame.
 *
 * Exported because a bridge should be able to surface it verbatim rather than
 * inventing its own wording for the same gap, and because a test can assert the
 * refusal actually names the spike.
 */
export function tierCRefusal(method: TierCMethod): string {
  return (
    `${method} is Tier C — the Forge state channel, and it is UNRESOLVED. ` +
    `No schema is shipped for it because no session has yet seen a real delta ` +
    `stream: Wave 7 lane A is running that experiment and writes its verdict to ` +
    `${TIER_C_SPIKE}. Model this arm from that document's round-trip result, not ` +
    `from a guess. Background: docs/spikes/itoclient.md, "Sizing Tier C".`
  );
}

/**
 * `true` while Tier C is unmodelled. A consumer branches on this instead of
 * discovering the gap from a parse failure at runtime.
 *
 * Flipping it is not what completes this tier — deleting the `z.never()` arms
 * below and replacing them with real payloads is. It exists so a UI can say
 * "spectating only" rather than crash.
 */
export const TIER_C_UNRESOLVED = true;

function unresolvedPayload(method: TierCMethod) {
  return z.never({ error: () => tierCRefusal(method) });
}

/**
 * `void setGameView(GameView gameView, long sequenceNumber)` —
 * ProtocolMethod.java:35, IGuiGame.java:57. The full-state baseline.
 */
export const SetGameViewSchema = z.strictObject({
  kind: z.literal('unresolved'),
  method: z.literal('setGameView'),
  payload: unresolvedPayload('setGameView'),
});

/**
 * `void openView(TrackableCollection<PlayerView> myPlayers)` —
 * ProtocolMethod.java:36, IGuiGame.java:68. Which seats this client controls.
 */
export const OpenViewSchema = z.strictObject({
  kind: z.literal('unresolved'),
  method: z.literal('openView'),
  payload: unresolvedPayload('openView'),
});

/**
 * `void applyDelta(DeltaPacket packet)` — ProtocolMethod.java:79,
 * IGuiGame.java:304. The entire incremental state channel.
 */
export const ApplyDeltaSchema = z.strictObject({
  kind: z.literal('unresolved'),
  method: z.literal('applyDelta'),
  payload: unresolvedPayload('applyDelta'),
});

/** The three Tier C frames. Present in the envelope, parseable by nothing. */
export const TIER_C_SERVER_FRAMES = [
  SetGameViewSchema,
  OpenViewSchema,
  ApplyDeltaSchema,
] as const;

/**
 * Tier C has no client→server half. All three methods are `Mode.SERVER` and
 * none blocks, so there are no replies either — `TIER_C_REPLIES` is empty on
 * purpose rather than missing.
 */
export const TIER_C_REPLIES = {} as const;
