/**
 * The draft record: one line per finished or abandoned draft, `<stateDir>/history/drafts.jsonl`
 * (wave 127, the operator: *"we need better data for when games and drafts are completed"*).
 * Before it, nothing kept a finished draft: `podDraftDone` only dealt the room's round 1.
 *
 * A record names what each pack round was drafted from (`rounds`), who sat where and how many
 * cards each seat took, and when the draft was dealt and ended. It is written from the room's
 * own plan, or the draft's `roundSources`, never guessed from the cards: a cube's cards carry
 * whatever printing the list named, so their set codes say nothing about the source.
 *
 * ## The file
 *
 * Append-only: each record is one line, appended and fsynced before the append resolves. The
 * file is never rewritten, except by an account erase or merge, which reads it again (so a line
 * the backfill CLI appended meanwhile is kept), writes the whole file aside and renames it over the
 * old one. It is read when the store opens, into the counts (`countBySource`) and the set of drafts
 * already recorded; a line this build cannot read is logged, counts nothing, and is kept on disk.
 *
 * Until the history programme's room history lands, this file is the record. Then it becomes a
 * room-history event, and this file is migrated and retired.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { DraftState } from '@hadoku/draft';
import type { PoolSource } from '@hadoku/shared';
import { UNNAMED } from '@hadoku/game-server/room/constants';

export const DRAFT_RECORDS_FILE = 'drafts.jsonl';

const DraftSourceSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('cube'), cubeId: z.string().min(1), name: z.string(), origin: z.enum(['shortlist', 'cubecobra', 'list']) }),
	z.strictObject({ kind: z.literal('set'), code: z.string().min(1), style: z.enum(['realistic', 'set-cube']) }),
]);
export type DraftSource = z.infer<typeof DraftSourceSchema>;

const DraftSeatSchema = z.strictObject({
	kind: z.enum(['user', 'bot']),
	userId: z.string().nullable(),
	displayName: z.string(),
	picks: z.number().int().nonnegative(),
});
export type DraftSeat = z.infer<typeof DraftSeatSchema>;

export const DraftRecordSchema = z.strictObject({
	v: z.literal(1),
	draftId: z.string().min(1),
	roomId: z.string().min(1),
	pod: z.number().int().nonnegative().nullable(),
	eventId: z.string().nullable(),
	/** One per pack round; a Cube or Set room repeats one source three times. */
	rounds: z.array(DraftSourceSchema),
	seats: z.array(DraftSeatSchema),
	startedAt: z.number(),
	endedAt: z.number(),
	durationMs: z.number(),
	outcome: z.enum(['complete', 'abandoned']),
	backfilled: z.literal(true).optional(),
});
export type DraftRecord = z.infer<typeof DraftRecordSchema>;

export interface SourceCount {
	drafts: number;
	lastAt: number;
}

export interface DraftRecordStore {
	append(r: DraftRecord): Promise<void>;
	/** `cube:<id>` | `set:<code>` → drafts COMPLETED from it (a round counts its source once per draft) and the latest endedAt. */
	countBySource(): ReadonlyMap<string, SourceCount>;
	/** Every seat naming one of `userIds` loses it, and its name becomes the room's word for an unnamed member. Answers the seats changed. */
	anonymise(userIds: ReadonlySet<string>): Promise<number>;
	/** An account merge: every seat naming a key of `renames` names its value instead. Answers the seats changed. */
	move(renames: ReadonlyMap<string, string>): Promise<number>;
	/** A record for this draft is already kept: for `startedAt`'s deal of it, or for any deal when `startedAt` is absent. */
	has(draftId: string, startedAt?: number): boolean;
}

/** The key `countBySource` counts a source under: a set's two styles are one set. */
export function sourceKeyOf(source: DraftSource): string {
	return source.kind === 'cube' ? `cube:${source.cubeId}` : `set:${source.code}`;
}

/** Where a cube came from, read off its id (`CubeSummarySchema.id`: a shortlist file stem, `cc-<id>` or `list-<random>`). */
export function cubeOrigin(cubeId: string): 'shortlist' | 'cubecobra' | 'list' {
	if (cubeId.startsWith('cc-')) return 'cubecobra';
	if (cubeId.startsWith('list-')) return 'list';
	return 'shortlist';
}

/** A plan's round, as the record keeps it: a cube with its name as the server knows it now, a set by code and style. */
export function draftSourceOf(src: PoolSource, nameOf: (src: PoolSource) => string): DraftSource {
	if (src.kind === 'set') return { kind: 'set', code: src.code, style: src.style };
	return { kind: 'cube', cubeId: src.cubeId, name: nameOf(src), origin: cubeOrigin(src.cubeId) };
}

/**
 * A draft's `roundSources` key (`@hadoku/draft`'s `sourceKey`: `cube:<id>` or `set:<code>:<style>`)
 * as the plan's source it was dealt from. Null for anything else, and for a realistic round, which
 * the deal keys as null.
 */
export function poolSourceOfKey(key: string | null): PoolSource | null {
	if (key === null) return null;
	if (key.startsWith('cube:') && key.length > 'cube:'.length) return { kind: 'cube', cubeId: key.slice('cube:'.length) };
	const set = /^set:(.+):(realistic|set-cube)$/.exec(key);
	return set === null ? null : { kind: 'set', code: set[1]!, style: set[2] as 'realistic' | 'set-cube' };
}

/** Each seat of a draft as the record keeps it: bot or person, their userId when `userIdOf` knows it, their name, the cards they took. */
export function draftSeatsOf(state: DraftState, userIdOf: (participantId: string) => string | null): DraftSeat[] {
	const byReservation = new Map(Object.entries(state.table.reservations).map(([seat, r]) => [Number(seat), r.participantId]));
	const byRemembered = new Map(Object.entries(state.table.remembered).map(([pid, seat]) => [seat, pid]));
	const seats: DraftSeat[] = [];
	for (let seat = 0; seat < state.seatCount; seat++) {
		const occupant = state.table.seats[seat]?.occupant ?? null;
		const picks = state.pools[seat]?.length ?? 0;
		const displayName = state.displayNames[seat] ?? `Seat ${seat + 1}`;
		if (occupant?.kind === 'bot') {
			seats.push({ kind: 'bot', userId: null, displayName, picks });
			continue;
		}
		// A person who stepped away keeps their seat by reservation, then by the table's memory of it.
		const participantId = occupant?.participantId ?? byReservation.get(seat) ?? byRemembered.get(seat) ?? null;
		seats.push({ kind: 'user', userId: participantId === null ? null : userIdOf(participantId), displayName, picks });
	}
	return seats;
}

export interface DraftRecordInput {
	state: DraftState;
	roomId: string;
	pod: number | null;
	eventId: string | null;
	rounds: DraftSource[];
	userIdOf: (participantId: string) => string | null;
	startedAt: number;
	endedAt: number;
	outcome: DraftRecord['outcome'];
}

export function draftRecordOf(input: DraftRecordInput): DraftRecord {
	return {
		v: 1,
		draftId: input.state.draftId,
		roomId: input.roomId,
		pod: input.pod,
		eventId: input.eventId,
		rounds: input.rounds,
		seats: draftSeatsOf(input.state, input.userIdOf),
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationMs: input.endedAt - input.startedAt,
		outcome: input.outcome,
	};
}

type Log = (entry: Record<string, unknown>) => void;

const dealKey = (draftId: string, startedAt: number): string => `${draftId}\0${startedAt}`;

/** Parse the file's lines. A line that is not a record is logged by its line number and handed back as it is, to be kept. */
function readRecords(file: string, log: Log): { records: DraftRecord[]; unreadable: string[] } {
	const records: DraftRecord[] = [];
	const unreadable: string[] = [];
	if (!existsSync(file)) return { records, unreadable };
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			if (line.trim() === '') return;
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch (err) {
				log({ event: 'draft-record-unreadable', file, line: i + 1, detail: (err as Error).message });
				unreadable.push(line);
				return;
			}
			const parsed = DraftRecordSchema.safeParse(raw);
			if (parsed.success) {
				records.push(parsed.data);
				return;
			}
			log({ event: 'draft-record-unreadable', file, line: i + 1, detail: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
			unreadable.push(line);
		});
	return { records, unreadable };
}

/**
 * The store over `<dir>/drafts.jsonl`. Opening it reads the file once, synchronously, so the
 * counts are there before anyone asks. Writes go one at a time, in the order they were asked for.
 */
export function createDraftRecordStore(dir: string, log: Log): DraftRecordStore {
	const file = join(dir, DRAFT_RECORDS_FILE);
	/** Every record on disk, in file order. Changed only inside `serial`, after the file has. */
	let records: DraftRecord[] = [];
	const deals = new Set<string>();
	const drafts = new Set<string>();
	/** Appends asked for and not yet written: `has` answers for them already, so a draft reported twice is kept once. */
	const pending = new Set<string>();
	/** Lines on disk this build cannot read: counted by nothing, and written back as they were by a rewrite. */
	let unreadable: string[] = [];
	let counts: Map<string, SourceCount> | null = null;
	const known = (r: DraftRecord): void => {
		records.push(r);
		deals.add(dealKey(r.draftId, r.startedAt));
		drafts.add(r.draftId);
		counts = null;
	};
	const load = (): void => {
		records = [];
		deals.clear();
		drafts.clear();
		const read = readRecords(file, log);
		for (const r of read.records) known(r);
		unreadable = read.unreadable;
	};
	load();
	let queue: Promise<unknown> = Promise.resolve();

	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work);
		queue = next.catch(() => undefined);
		return next;
	};

	const tally = (): Map<string, SourceCount> => {
		const out = new Map<string, SourceCount>();
		for (const r of records) {
			if (r.outcome !== 'complete') continue;
			for (const key of new Set(r.rounds.map(sourceKeyOf))) {
				const was = out.get(key);
				out.set(key, { drafts: (was?.drafts ?? 0) + 1, lastAt: Math.max(was?.lastAt ?? 0, r.endedAt) });
			}
		}
		return out;
	};

	/** The whole file again, from `records` and the lines nothing could read: written aside, fsynced, renamed over. */
	const rewrite = async (): Promise<void> => {
		await mkdir(dir, { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const handle = await open(tmp, 'w');
		try {
			await handle.writeFile([...records.map((r) => JSON.stringify(r)), ...unreadable].map((line) => `${line}\n`).join(''));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, file);
	};

	/**
	 * Rewrite every seat `to(seat)` answers a change for; answers how many seats changed. The file is
	 * read again first, so a line appended by another writer (the backfill CLI) is kept, not dropped.
	 */
	const reseat = (to: (seat: DraftSeat) => DraftSeat | null): Promise<number> =>
		serial(async () => {
			load();
			let changed = 0;
			for (const r of records) {
				r.seats = r.seats.map((seat) => {
					const next = to(seat);
					if (next === null) return seat;
					changed++;
					return next;
				});
			}
			if (changed > 0) {
				counts = null;
				await rewrite();
			}
			return changed;
		});

	return {
		append(r) {
			const record = DraftRecordSchema.parse(r);
			const key = dealKey(record.draftId, record.startedAt);
			pending.add(key);
			return serial(async () => {
				try {
					await mkdir(dir, { recursive: true });
					const handle = await open(file, 'a');
					try {
						await handle.write(`${JSON.stringify(record)}\n`);
						await handle.sync();
					} finally {
						await handle.close();
					}
					known(record);
				} finally {
					pending.delete(key);
				}
			});
		},
		countBySource() {
			counts ??= tally();
			return counts;
		},
		anonymise(userIds) {
			return reseat((seat) => (seat.userId !== null && userIds.has(seat.userId) ? { ...seat, userId: null, displayName: UNNAMED } : null));
		},
		move(renames) {
			return reseat((seat) => {
				const to = seat.userId === null ? undefined : renames.get(seat.userId);
				return to === undefined ? null : { ...seat, userId: to };
			});
		},
		has(draftId, startedAt) {
			if (startedAt !== undefined) return deals.has(dealKey(draftId, startedAt)) || pending.has(dealKey(draftId, startedAt));
			return drafts.has(draftId) || [...pending].some((key) => key.startsWith(`${draftId}\0`));
		},
	};
}
