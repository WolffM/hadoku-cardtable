/*
 * The game-bundle contract watchparty mounts us through (D21).
 *
 * These declarations MOVE to `@wolffm/rooms-protocol`, module `game-bundle`,
 * which watchparty publishes. Until that version is installed they live here,
 * in this one file, and everything else imports them from here — so the swap
 * is this file's body becoming
 *
 *   export type { GameBundleContext, GameBundleIdentity, GameBundleModule, MountedGameBundle } from '@wolffm/rooms-protocol/game-bundle';
 *
 * and nothing else changing.
 *
 * `roomKey` is watchparty's ROOM ID, the same for the leader and every viewer
 * — never the key a person joined by, which for the leader is a credential.
 * Cardtable treats it as opaque: the server hashes it into the table's id
 * (`watchpartyRoomId`, `apps/server/src/room/lobby.ts`), so its shape does not
 * have to fit cardtable's room-id rules.
 */

export interface GameBundleIdentity {
  userId: string;
  userType: string;
  name: string | null;
  sessionId?: string;
}

export interface GameBundleContext {
  roomKey: string;
  identity: GameBundleIdentity;
  theme: string;
  isLeader: boolean;
  close(): void;
}

export interface MountedGameBundle {
  unmount(): void;
  update(ctx: GameBundleContext): void;
}

export interface GameBundleModule {
  mount(el: HTMLElement, ctx: GameBundleContext): MountedGameBundle | Promise<MountedGameBundle>;
}
