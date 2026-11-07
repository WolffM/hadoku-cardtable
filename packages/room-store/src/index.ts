/*
 * @hadoku/room-store — a room snapshot's codec, and where it is stored.
 *
 * `docs/requests/P6_PERSISTENCE.md` is the spec this grew from. It does not
 * exist upstream: `@wolffm/rooms-server@0.38.111` ships `RoomRegistry`,
 * seating, emit, rate limiting and `collectGC`, and no snapshot format and no
 * store. This package is the missing half, built on top of theirs rather than
 * instead of it: it consumes `CoreRoomState` as it ships and writes nothing
 * into `@wolffm/*`.
 *
 * `RoomPersistence` (the debounced load/save layer that applied §4's rules
 * about restore races and flush-on-signal) and `ServiceLifecycle` (the P5
 * service-participant attach/detach/heartbeat state machine) lived here too,
 * through Wave 90. Nothing outside this package ever imported either —
 * `git grep '@hadoku/room-store' apps packages` named only `FileRoomStore`,
 * `STORE_VERSION` and `RoomSnapshot` — so Wave 91 §B deleted both along with
 * their tests, `clock.ts` (which existed only to inject a clock into them)
 * and `sigtermChild.ts`/`sigterm.test.ts` (which proved `RoomPersistence`'s
 * flush-on-SIGTERM). `docs/requests/P5_SERVICE_PARTICIPANT.md` describes code
 * that no longer exists in this package.
 *
 * ## What is left: transport-free, socket-free, in-memory by default
 *
 * Nothing here imports `socket.io` or the filesystem outside of `fileStore.ts`,
 * and only when a host asks for that tier. A room's `MemoryRoomStore` is the
 * default: no filesystem, no network, no behaviour change for a host that has
 * not opted in.
 */

export {
  applySnapshot,
  decodeSnapshot,
  jsonCodec,
  pruneNonDurable,
  snapshotRoom,
  SnapshotUnreadableError,
  STORE_VERSION,
  type AppCodec,
  type DecodedSnapshot,
  type RestoreContext,
  type RestoredMember,
  type RoomCodec,
  type RoomSnapshot,
  type SerializedMember,
  type UnreadableReason,
} from './snapshot.ts';

export { MemoryRoomStore, type RoomStore } from './store.ts';
export { FileRoomStore, type FileRoomStoreOptions } from './fileStore.ts';
