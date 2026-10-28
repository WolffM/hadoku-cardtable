/*
 * Scheduled events (`@hadoku/shared`'s `events.ts`): what the front page's Upcoming card and its
 * calendar list. One JSON file, read at boot and rewritten whole on each change, like
 * `tournaments.ts` — a friend group schedules a handful at a time.
 *
 * The room an event makes is the lobby's (`Lobby.create` with `scheduledFor`), not this store's:
 * this keeps only its id, and a room since closed reads back as none.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { z } from 'zod';
import { EventKindSchema, type EventKind } from '@hadoku/shared';

const EventRecordSchema = z.object({
	id: z.string(),
	kind: EventKindSchema,
	title: z.string(),
	startsAt: z.number(),
	organizerId: z.string(),
	organizerName: z.string(),
	roomId: z.string().nullable(),
	createdAt: z.number(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

/** An event stays listed this long after it starts: it is still on while people play it. */
export const EVENT_LISTED_AFTER_START_MS = 6 * 60 * 60_000;
/** Forgotten this long after it starts. */
const EVENT_KEPT_AFTER_START_MS = 7 * 24 * 60 * 60_000;

export interface NewEvent {
	kind: EventKind;
	title: string;
	startsAt: number;
	organizerId: string;
	organizerName: string;
	roomId: string | null;
}

export type EventChange = { ok: true; event: EventRecord } | { ok: false; reason: 'no-event' | 'not-organizer' };

export interface Events {
	/** Every event not yet `EVENT_LISTED_AFTER_START_MS` past its start, soonest first. */
	upcoming(now: number): EventRecord[];
	get(id: string): EventRecord | undefined;
	create(event: NewEvent, now: number): EventRecord;
	update(id: string, callerId: string, change: { title?: string; startsAt?: number }): EventChange;
	cancel(id: string, callerId: string): EventChange;
}

const mintEventId = (): string => `e-${randomBytes(6).toString('hex')}`;

export async function openEvents(file: string, log: (entry: Record<string, unknown>) => void, now: () => number = Date.now): Promise<Events> {
	let all: EventRecord[] = [];
	try {
		const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
		if (!Array.isArray(parsed)) throw new Error('not an array');
		all = parsed.flatMap((e) => EventRecordSchema.safeParse(e).data ?? []);
		if (all.length !== parsed.length) log({ event: 'events-dropped', dropped: parsed.length - all.length });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ event: 'events-unreadable', err: String(err) });
	}

	// One write at a time, each of the whole list as it then is.
	let writing: Promise<void> = Promise.resolve();
	const save = (): void => {
		const cutoff = now() - EVENT_KEPT_AFTER_START_MS;
		all = all.filter((e) => e.startsAt > cutoff);
		const body = JSON.stringify(all);
		writing = writing
			.then(async () => {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(`${file}.tmp`, body);
				await rename(`${file}.tmp`, file);
			})
			.catch((err: unknown) => log({ event: 'events-write-failed', err: String(err) }));
	};

	const owned = (id: string, callerId: string): EventChange => {
		const event = all.find((e) => e.id === id);
		if (event === undefined) return { ok: false, reason: 'no-event' };
		if (event.organizerId !== callerId) return { ok: false, reason: 'not-organizer' };
		return { ok: true, event };
	};

	return {
		upcoming(at) {
			const cutoff = at - EVENT_LISTED_AFTER_START_MS;
			return all.filter((e) => e.startsAt > cutoff).sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1));
		},
		get(id) {
			return all.find((e) => e.id === id);
		},
		create(input, at) {
			let id = mintEventId();
			while (all.some((e) => e.id === id)) id = mintEventId();
			const event: EventRecord = { id, ...input, createdAt: at };
			all = [...all, event];
			log({ event: 'event-created', id, kind: event.kind, roomId: event.roomId });
			save();
			return event;
		},
		update(id, callerId, change) {
			const found = owned(id, callerId);
			if (!found.ok) return found;
			const event: EventRecord = { ...found.event, ...(change.title === undefined ? {} : { title: change.title }), ...(change.startsAt === undefined ? {} : { startsAt: change.startsAt }) };
			all = all.map((e) => (e.id === id ? event : e));
			log({ event: 'event-updated', id });
			save();
			return { ok: true, event };
		},
		cancel(id, callerId) {
			const found = owned(id, callerId);
			if (!found.ok) return found;
			all = all.filter((e) => e.id !== id);
			log({ event: 'event-cancelled', id });
			save();
			return found;
		},
	};
}
