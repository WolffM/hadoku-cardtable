/*
 * @hadoku/room-store — room persistence (P6) and the service participant (P5).
 *
 * Both specs live in this repo: `docs/requests/P6_PERSISTENCE.md` and
 * `docs/requests/P5_SERVICE_PARTICIPANT.md`. Neither exists upstream —
 * `@wolffm/rooms-server@0.38.111` ships `RoomRegistry`, seating, emit, rate
 * limiting and `collectGC`, and no store, no snapshot and no service role. This
 * package is the missing half, built on top of theirs rather than instead of it:
 * it consumes `CoreRoomState` and `RoomRegistry` as they ship, and writes
 * nothing into `@wolffm/*`.
 *
 * ## Transport-free and socket-free, like `@hadoku/draft`
 *
 * Nothing here imports `socket.io`. `ServicePeer` is an interface with `send`
 * and `close`; the host brings the socket. The clock is injected, so `holdMs`
 * being ten minutes costs a test nothing. The filesystem appears in exactly one
 * file (`fileStore.ts`) and only when a host asks for that tier.
 *
 * ## In-memory by default
 *
 * `RoomPersistence` with no `store` gets a `MemoryRoomStore`: no filesystem, no
 * network, no behaviour change for a host that has not opted in. Same for the
 * service — `createServiceLifecycle(room, undefined)` is `null`, and a null
 * lifecycle means no heartbeat clock, no GC exemption and no notices.
 */

export { ManualClock, systemClock, type Clock, type TimerHandle } from './clock.ts';

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

export {
  DEFAULT_PERSIST,
  RoomPersistence,
  SaveBeforeLoadError,
  type PersistenceLog,
  type PersistOptions,
  type RoomLoadState,
  type RoomPersistenceConfig,
} from './persistence.ts';

export {
  createServiceLifecycle,
  DEFAULT_SERVICE_CONFIG,
  evaluateRoomWithService,
  ServiceLifecycle,
  ServiceRejection,
  SKIP,
  type DetachReason,
  type ServiceConfig,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceLifecycleOptions,
  type ServiceNotice,
  type ServicePeer,
  type ServiceResult,
  type ServiceSession,
  type ServiceStatus,
} from './service.ts';
