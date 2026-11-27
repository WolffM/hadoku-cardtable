/**
 * `FileRoomStore` with its writes off the event loop: the same files, the same format, the same
 * atomic temp-file-fsync-rename, through the process's {@link snapshotWriter} instead of
 * `fsyncSync` on the loop (`persist/snapshot-writer.ts` has the measured why). Reads (`load`,
 * `list`, `quarantine`) happen at boot and stay the base class's.
 *
 * `saveSync` keeps its name because the lobby calls it from every mutation and must not await; it
 * returns once the snapshot is queued. A save then a remove of one room land in that order.
 */

import { join } from 'node:path';

import { FileRoomStore, type RoomSnapshot } from '@wolffm/rooms-server/store';

import { snapshotWriter, type SnapshotWriter } from '../persist/snapshot-writer.js';

const SUFFIX = '.json';

export class OffLoopRoomStore extends FileRoomStore {
	readonly #writer: SnapshotWriter;

	constructor(dir: string, opts: { writer?: SnapshotWriter; now?: () => number } = {}) {
		super(dir, opts.now === undefined ? {} : { now: opts.now });
		this.#writer = opts.writer ?? snapshotWriter();
	}

	/** `FileRoomStore`'s own file for a room: base64url of the id, so a join payload never names a path. */
	fileOf(roomId: string): string {
		return join(this.dir, `${Buffer.from(roomId, 'utf8').toString('base64url')}${SUFFIX}`);
	}

	override saveSync(snapshot: RoomSnapshot): void {
		this.#writer.write(this.fileOf(snapshot.roomId), JSON.stringify(snapshot));
	}

	override save(snapshot: RoomSnapshot): Promise<void> {
		this.saveSync(snapshot);
		return Promise.resolve();
	}

	override remove(roomId: string): Promise<void> {
		return this.#writer.remove(this.fileOf(roomId));
	}

	override removeSync(roomId: string): void {
		void this.#writer.remove(this.fileOf(roomId)).catch(() => {
			// The writer has logged it (`snapshot-remove-failed`); a sync caller has nobody to tell.
		});
	}

	/** Resolves once every save and remove asked of this process's writer so far has landed. */
	flushed(): Promise<void> {
		return this.#writer.idle();
	}
}
