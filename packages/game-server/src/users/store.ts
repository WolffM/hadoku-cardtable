/**
 * The per-person store: one JSON document per account, `<dir>/<userId>.json`, owned by this
 * server and kept on its own disk (operator, 2026-11-23: "i would prefer if all the data was
 * self-hosted so we don't rely on cloudflare for this").
 *
 * The store knows nothing of what a document holds. The game hands it the shape: an empty
 * document, a parse of what is on disk, and a merge for an account merge. So Magic's favourites,
 * last-played stamps, built decks and art picks live in Magic's own file, and this one stays MIT.
 *
 * Every write is a temp file renamed over the target, as `draftRooms.ts` writes a pod, so a
 * reader never sees half a document and the nightly state backup (which carries the state dir
 * whole) never copies one. Updates to one person are serialised in this process, so two requests
 * that land together both keep their change.
 *
 * `get` and `update` are the whole interface the rest of the server uses, so moving the documents
 * into dataplatform's store later (`docs/planning/telemetry-and-state-inventory.md` §4) replaces
 * this file and nothing that reads it.
 *
 * A file that is not a document (truncated by a full disk, edited by hand) is moved aside to
 * `<userId>.json.unreadable-<ms>`, logged, and the person starts from an empty document: their
 * bytes are kept for the operator, and nothing they do afterwards is refused for it.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A registry userId: what the edge sends as `X-User-Id`. Anything else never becomes a file name. */
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isStorableUserId(userId: string): boolean {
	return USER_ID.test(userId);
}

export interface UserDocShape<D> {
	/** A person with no document yet. */
	empty(): D;
	/** What is on disk, as a document; throws when it is not one. */
	parse(raw: unknown): D;
	/** An account merge: `from`'s document folded into `into`'s, `into` winning every conflict. */
	merge(from: D, into: D): D;
}

export interface UserStore<D> {
	/** The person's document, or an empty one. */
	get(userId: string): Promise<D>;
	/** Change the person's document and write it. `fn` edits the document in place or returns a new one. Answers what was written. */
	update(userId: string, fn: (doc: D) => D | void): Promise<D>;
	/** Account erase: the person's document is deleted. Answers 1 when there was one. */
	remove(userId: string): Promise<number>;
	/** Account merge: `fromUserId`'s document folds into `intoUserId`'s and is deleted. Answers 1 when there was one to move. */
	move(fromUserId: string, intoUserId: string): Promise<number>;
}

export interface UserStoreOptions<D> {
	dir: string;
	shape: UserDocShape<D>;
	log?: (entry: Record<string, unknown>) => void;
	now?: () => number;
}

export function createUserStore<D>(opts: UserStoreOptions<D>): UserStore<D> {
	const { dir, shape } = opts;
	const log = opts.log ?? (() => undefined);
	const now = opts.now ?? Date.now;
	/** The tail of each person's queue of reads-then-writes. */
	const queues = new Map<string, Promise<unknown>>();

	const pathOf = (userId: string): string => {
		if (!isStorableUserId(userId)) throw new Error(`not a userId: ${JSON.stringify(userId)}`);
		return join(dir, `${userId}.json`);
	};

	/** Run `job` after every earlier job for these people. */
	function serial<T>(userIds: readonly string[], job: () => Promise<T>): Promise<T> {
		const before = Promise.all(userIds.map((id) => queues.get(id)));
		const run = before.then(job, job);
		const tail = run.catch(() => undefined);
		for (const id of userIds) queues.set(id, tail);
		void tail.then(() => {
			for (const id of userIds) if (queues.get(id) === tail) queues.delete(id);
		});
		return run;
	}

	async function read(userId: string): Promise<D | null> {
		const path = pathOf(userId);
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
		try {
			return shape.parse(JSON.parse(text));
		} catch (err) {
			const aside = `${path}.unreadable-${now()}`;
			await rename(path, aside);
			log({ evt: 'user-doc-unreadable', userId, movedTo: aside, error: (err as Error).message });
			return null;
		}
	}

	async function write(userId: string, doc: D): Promise<void> {
		const path = pathOf(userId);
		await mkdir(dir, { recursive: true });
		const tmp = `${path}.${process.pid}.${now()}.tmp`;
		await writeFile(tmp, JSON.stringify(doc));
		await rename(tmp, path);
	}

	async function drop(userId: string): Promise<number> {
		try {
			await rm(pathOf(userId));
			return 1;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
			throw err;
		}
	}

	return {
		get: (userId) => serial([userId], async () => (await read(userId)) ?? shape.empty()),
		update: (userId, fn) =>
			serial([userId], async () => {
				const doc = (await read(userId)) ?? shape.empty();
				const next = fn(doc) ?? doc;
				await write(userId, next);
				return next;
			}),
		// An id that cannot be a file name names no document: nothing to erase or move.
		remove: (userId) => (isStorableUserId(userId) ? serial([userId], () => drop(userId)) : Promise.resolve(0)),
		move: (fromUserId, intoUserId) =>
			serial([fromUserId, intoUserId], async () => {
				if (fromUserId === intoUserId || !isStorableUserId(fromUserId)) return 0;
				const from = await read(fromUserId);
				if (from === null) return 0;
				await write(intoUserId, shape.merge(from, (await read(intoUserId)) ?? shape.empty()));
				await drop(fromUserId);
				return 1;
			}),
	};
}
