/**
 * Every snapshot file the server keeps (a room, a draft) is written here, OFF the event loop.
 *
 * ## Why
 *
 * A synchronous write on the event loop stops everything the server does until the disk answers:
 * the claws' heartbeats, every socket, every request. On the production host's btrfs root under another
 * workload's writes, `fsyncSync` of a 10 kB room file can force a whole transaction commit and
 * take tens of seconds (2026-11-27 06:07–06:12Z: the process in D state with its CPU idle, a POST
 * that wrote three rooms 28.7 s, and every claw fencing its JVMs because this server said nothing
 * for 10 s). Writing through `fs/promises` moves the wait onto libuv's pool, where it delays only
 * the next snapshot.
 *
 * ## What a write is
 *
 * The same atomic recipe `FileRoomStore` uses: a temp file, `fsync`ed, renamed over the target, so a
 * reader never sees half a snapshot and a crash leaves the previous one.
 *
 * ## Order and memory
 *
 * One file is in flight at a time, across the whole process: a stalled disk ties up one pool thread,
 * never all four (`dns.lookup`, zlib and the rest share them). A file written again before its
 * last write has started keeps only the newest text, so a stall costs one pending snapshot per file,
 * however many mutations it sat through. A remove waits behind the writes queued before it, so a
 * late write can never bring a removed file back.
 *
 * ## Going down
 *
 * A deploy's SIGTERM awaits {@link SnapshotWriter.idle} before the process exits (the kernel's
 * `drain`). An exit that does not wait (a crash, `process.exit`) writes whatever is still queued
 * synchronously in an `exit` handler, without `fsync` (a process exit keeps the page cache); a
 * file whose write was already in flight then lands as whichever rename the kernel takes last.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { jsonLogger, type JsonLog } from '@hadoku/service-kernel/log';

/** A write slower than this is logged (`snapshot-write-slow`): the disk stalled, and nothing else did. */
export const SLOW_WRITE_MS = 1000;

type Job = { kind: 'write'; text: string; waiters: Waiter[] } | { kind: 'remove'; waiters: Waiter[] };
interface Waiter {
	resolve: () => void;
	reject: (err: Error) => void;
}

export class SnapshotWriter {
	/** Not started yet, oldest first; a file's position is its first unstarted job's. */
	readonly #queued = new Map<string, Job>();
	#inFlight: string | null = null;
	#idleWaiters: (() => void)[] = [];
	readonly #log: JsonLog;
	readonly #now: () => number;
	#seq = 0;

	constructor(opts: { log?: JsonLog; now?: () => number } = {}) {
		this.#log = opts.log ?? jsonLogger('cardtable-snapshots');
		this.#now = opts.now ?? Date.now;
	}

	/** Write `text` to `file` atomically, soon. Returns at once. */
	write(file: string, text: string): void {
		const queued = this.#queued.get(file);
		this.#queued.set(file, { kind: 'write', text, waiters: queued?.waiters ?? [] });
		this.#pump();
	}

	/** Remove `file` once every write queued before this has landed. A write queued after it wins. */
	remove(file: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const queued = this.#queued.get(file);
			this.#queued.set(file, { kind: 'remove', waiters: [...(queued?.waiters ?? []), { resolve, reject }] });
			this.#pump();
		});
	}

	/** Resolves once nothing is queued or in flight. */
	idle(): Promise<void> {
		if (this.#inFlight === null && this.#queued.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.#idleWaiters.push(resolve));
	}

	/** How many files have a write or a remove still to land. */
	pending(): number {
		return this.#queued.size + (this.#inFlight === null ? 0 : 1);
	}

	/** The exit path: everything still queued, written now, synchronously. */
	drainSync(): void {
		for (const [file, job] of this.#queued) {
			this.#queued.delete(file);
			try {
				if (job.kind === 'write') {
					mkdirSync(dirname(file), { recursive: true });
					const tmp = this.#tmpOf(file);
					writeFileSync(tmp, job.text);
					renameSync(tmp, file);
				} else {
					rmSync(file, { force: true });
				}
				for (const w of job.waiters) w.resolve();
			} catch (err) {
				this.#log({ evt: 'snapshot-write-failed', level: 'error', file, at: 'exit', error: (err as Error).message });
				for (const w of job.waiters) w.reject(err as Error);
			}
		}
	}

	#tmpOf(file: string): string {
		this.#seq += 1;
		return `${file}.${process.pid}.${this.#now()}.${this.#seq}.tmp`;
	}

	#pump(): void {
		if (this.#inFlight !== null) return;
		const next = this.#queued.entries().next();
		if (next.done === true) {
			const waiters = this.#idleWaiters;
			this.#idleWaiters = [];
			for (const w of waiters) w();
			return;
		}
		const [file, job] = next.value;
		this.#queued.delete(file);
		this.#inFlight = file;
		const started = this.#now();
		const run = job.kind === 'write' ? this.#writeAsync(file, job.text) : rm(file, { force: true });
		run.then(
			() => {
				const ms = this.#now() - started;
				if (ms > SLOW_WRITE_MS) this.#log({ evt: 'snapshot-write-slow', level: 'warn', file, kind: job.kind, ms, queued: this.#queued.size });
				for (const w of job.waiters) w.resolve();
			},
			(err: unknown) => {
				this.#log({ evt: job.kind === 'write' ? 'snapshot-write-failed' : 'snapshot-remove-failed', level: 'error', file, error: (err as Error).message });
				for (const w of job.waiters) w.reject(err as Error);
			},
		).finally(() => {
			this.#inFlight = null;
			this.#pump();
		});
	}

	async #writeAsync(file: string, text: string): Promise<void> {
		await mkdir(dirname(file), { recursive: true });
		const tmp = this.#tmpOf(file);
		const handle = await open(tmp, 'w');
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, file);
	}
}

/** On `globalThis`, not in this module: a second copy of the module (a bundle, a test's fresh import) shares it. */
const SHARED = Symbol.for('hadoku.game-server.snapshotWriter');

/** The process's one writer: every store shares it, so one stalled disk ties up one pool thread. */
export function snapshotWriter(): SnapshotWriter {
	const holder = globalThis as { [SHARED]?: SnapshotWriter };
	let writer = holder[SHARED];
	if (writer === undefined) {
		const made = new SnapshotWriter();
		process.on('exit', () => made.drainSync());
		holder[SHARED] = made;
		writer = made;
	}
	return writer;
}
