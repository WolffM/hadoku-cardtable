/**
 * The container namespace and port range the e2e harness owns.
 *
 * Its own module, not an export of `harness.ts`, because `harness.ts` is a
 * script: importing it from a spec would spawn a second server as a side
 * effect of reading a constant.
 *
 * ## Why a separate namespace exists at all
 *
 * Every cardtable boot runs `stream/alloc.ts`'s `sweepOrphans()`, which removes
 * every container matching its name prefix that its own `live` map does not
 * own. For one server that is exactly right — it reclaims what a restart left
 * behind. Across two servers it is destructive, and this harness runs on the
 * machine that also runs PRODUCTION cardtable and the friend-demo bench:
 *
 *   - sharing the default prefix, this server's boot sweep deletes a real
 *     player's streamed room mid-match;
 *   - and production's next restart deletes this one's containers mid-test.
 *
 * Observed, not theorised: a container named `cardtable-room-probe-0` created
 * by hand on 2026-09-24 was gone within two minutes, reclaimed by production's
 * boot sweep after an unrelated key-swap restart.
 *
 * `scripts/stream/container.sh` reads `CARDTABLE_STREAM_NAME_PREFIX` too, so
 * the script and the server cannot disagree about which containers are ours.
 */

/** Never `cardtable-room*`: that prefix is production's claim on this host. */
export const STREAM_NAME_PREFIX = 'cardtable-e2e-room';

/** Clear of the bench (6080-6081) and of production's pool (6100-6199). */
export const STREAM_BASE_PORT = 6300;

/**
 * The window `container.sh` will accept for OUR ports.
 *
 * The script guards the range itself (default 6100-6199) as a second refusal
 * behind the server's own constant, so moving the base without moving the
 * window means every provision is refused with `refusing port 6300: above
 * 6199` — which is exactly what the first run of `streamed-live.spec.ts` got.
 * The guard was right; the harness was half-configured.
 */
export const STREAM_PORT_MAX = STREAM_BASE_PORT + 99;
