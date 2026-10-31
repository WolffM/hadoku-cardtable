/*
 * Scheduled events and attached Rally forms (`@hadoku/shared`'s `events.ts`): what the front
 * page's calendar and polls list. One JSON file, read at boot and rewritten whole on each change,
 * like `tournaments.ts` — a friend group schedules a handful at a time.
 *
 * An event keeps its room's id and its schedule, nothing else: what the room is called, plays and
 * how are the lobby's (`Lobby.create` with `scheduledFor`), read from it each time. A form keeps
 * only its Rally id and who attached it; its title and status are Rally's.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { z } from 'zod';

const EventRecordSchema = z.object({
	id: z.string(),
	roomId: z.string(),
	startsAt: z.number(),
	organizerId: z.string(),
	organizerName: z.string(),
	createdAt: z.number(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

const FormRecordSchema = z.object({
	formId: z.string(),
	attachedById: z.string(),
	attachedByName: z.string(),
	attachedAt: z.number(),
});
export type FormRecord = z.infer<typeof FormRecordSchema>;

/** An event stays listed this long after it starts: it is still on while people play it. */
export const EVENT_LISTED_AFTER_START_MS = 6 * 60 * 60_000;
/** Forgotten this long after it starts. */
const EVENT_KEPT_AFTER_START_MS = 7 * 24 * 60 * 60_000;

export type NewEvent = Omit<EventRecord, 'id' | 'createdAt'>;
export type NewForm = Omit<FormRecord, 'attachedAt'>;

export type EventChange = { ok: true; event: EventRecord } | { ok: false; reason: 'no-event' | 'not-organizer' };
export type FormChange = { ok: true } | { ok: false; reason: 'no-form' | 'not-attacher' };

export interface Events {
	/** Every event not yet `EVENT_LISTED_AFTER_START_MS` past its start, soonest first. */
	upcoming(now: number): EventRecord[];
	get(id: string): EventRecord | undefined;
	create(event: NewEvent, now: number): EventRecord;
	reschedule(id: string, callerId: string, startsAt: number): EventChange;
	cancel(id: string, callerId: string): EventChange;
	/** Every attached form, oldest first. */
	forms(): FormRecord[];
	/** False when the form was already attached. */
	attachForm(form: NewForm, now: number): boolean;
	detachForm(formId: string, callerId: string): FormChange;
	/** Forget forms Rally says are closed or gone: nobody lists them again. */
	forgetForms(formIds: readonly string[]): void;
}

const mintEventId = (): string => `e-${randomBytes(6).toString('hex')}`;

export async function openEvents(file: string, log: (entry: Record<string, unknown>) => void, now: () => number = Date.now): Promise<Events> {
	let events: EventRecord[] = [];
	let forms: FormRecord[] = [];
	try {
		const parsed = z.object({ events: z.array(z.unknown()), forms: z.array(z.unknown()) }).parse(JSON.parse(await readFile(file, 'utf8')));
		events = parsed.events.flatMap((e) => EventRecordSchema.safeParse(e).data ?? []);
		forms = parsed.forms.flatMap((f) => FormRecordSchema.safeParse(f).data ?? []);
		const dropped = parsed.events.length - events.length + parsed.forms.length - forms.length;
		if (dropped > 0) log({ event: 'events-dropped', dropped });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log({ event: 'events-unreadable', err: String(err) });
	}

	// One write at a time, each of the whole store as it then is.
	let writing: Promise<void> = Promise.resolve();
	const save = (): void => {
		const cutoff = now() - EVENT_KEPT_AFTER_START_MS;
		events = events.filter((e) => e.startsAt > cutoff);
		const body = JSON.stringify({ events, forms });
		writing = writing
			.then(async () => {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(`${file}.tmp`, body);
				await rename(`${file}.tmp`, file);
			})
			.catch((err: unknown) => log({ event: 'events-write-failed', err: String(err) }));
	};

	const owned = (id: string, callerId: string): EventChange => {
		const event = events.find((e) => e.id === id);
		if (event === undefined) return { ok: false, reason: 'no-event' };
		if (event.organizerId !== callerId) return { ok: false, reason: 'not-organizer' };
		return { ok: true, event };
	};

	return {
		upcoming(at) {
			const cutoff = at - EVENT_LISTED_AFTER_START_MS;
			return events.filter((e) => e.startsAt > cutoff).sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1));
		},
		get(id) {
			return events.find((e) => e.id === id);
		},
		create(input, at) {
			let id = mintEventId();
			while (events.some((e) => e.id === id)) id = mintEventId();
			const event: EventRecord = { id, ...input, createdAt: at };
			events = [...events, event];
			log({ event: 'event-created', id, roomId: event.roomId });
			save();
			return event;
		},
		reschedule(id, callerId, startsAt) {
			const found = owned(id, callerId);
			if (!found.ok) return found;
			const event: EventRecord = { ...found.event, startsAt };
			events = events.map((e) => (e.id === id ? event : e));
			log({ event: 'event-updated', id });
			save();
			return { ok: true, event };
		},
		cancel(id, callerId) {
			const found = owned(id, callerId);
			if (!found.ok) return found;
			events = events.filter((e) => e.id !== id);
			log({ event: 'event-cancelled', id });
			save();
			return found;
		},
		forms() {
			return forms;
		},
		attachForm(input, at) {
			if (forms.some((f) => f.formId === input.formId)) return false;
			forms = [...forms, { ...input, attachedAt: at }];
			log({ event: 'event-form-attached', formId: input.formId });
			save();
			return true;
		},
		detachForm(formId, callerId) {
			const form = forms.find((f) => f.formId === formId);
			if (form === undefined) return { ok: false, reason: 'no-form' };
			if (form.attachedById !== callerId) return { ok: false, reason: 'not-attacher' };
			forms = forms.filter((f) => f !== form);
			log({ event: 'event-form-detached', formId });
			save();
			return { ok: true };
		},
		forgetForms(formIds) {
			const gone = new Set(formIds);
			if (!forms.some((f) => gone.has(f.formId))) return;
			forms = forms.filter((f) => !gone.has(f.formId));
			log({ event: 'event-forms-forgotten', formIds });
			save();
		},
	};
}
