/*
 * A loopback stand-in for ArchiveBot's `/api/events/create` and `/api/events/update`, following
 * ArchiveBot's own `lib/eventWebhook.js`: the signature is checked; a create is deduped on its
 * idempotency key while the event it made is live; an update is dropped when its key equals the
 * last one applied; a cancel retires the event; an event deleted by hand in Discord answers an
 * update `404 event_not_found`, and an id it never made `404 event_not_tracked`.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StandInEvent {
	eventId: string;
	name: string;
	startTime: string;
	endTime: string;
	description: string;
	location: string;
	remindBeforeMs: unknown;
	sourceKey: string;
	lastUpdateKey: string | null;
	/** False once cancelled. */
	active: boolean;
}

export interface StandInArchivebot {
	url: string;
	/** Every event made, cancelled ones too, in the order made. */
	made: StandInEvent[];
	/** The live ones. */
	live(): StandInEvent[];
	/** Every request's path, in order. */
	paths: string[];
	/** Someone deletes it in Discord's own UI. */
	deleteByHand(eventId: string): void;
	/** While set, every request is answered 503, as when the bot is restarting. */
	down: boolean;
	/** Creates wait until the returned function is called. */
	holdCreates(): () => void;
	close(): Promise<void>;
}

export async function standInArchivebot(secret: string, now: () => number): Promise<StandInArchivebot> {
	const made: StandInEvent[] = [];
	const deletedByHand = new Set<string>();
	const paths: string[] = [];
	let hold: Promise<void> | null = null;

	const answer = async (path: string, body: Record<string, unknown>): Promise<[number, Record<string, unknown>]> => {
		if (path === '/api/events/create') {
			if (hold !== null) await hold;
			const start = Date.parse(String(body.startTime));
			if (!(start > now())) return [400, { success: false, error: 'start_in_past' }];
			if (!(Date.parse(String(body.endTime)) > start)) return [400, { success: false, error: 'end_not_after_start' }];
			const existing = made.find((e) => e.sourceKey === body.idempotencyKey && e.active);
			if (existing !== undefined) return [200, { success: true, eventId: existing.eventId, deduped: true }];
			const event: StandInEvent = {
				eventId: `d-${made.length + 1}`,
				name: String(body.name),
				startTime: String(body.startTime),
				endTime: String(body.endTime),
				description: String(body.description),
				location: String(body.location),
				remindBeforeMs: body.remindBeforeMs,
				sourceKey: String(body.idempotencyKey),
				lastUpdateKey: null,
				active: true,
			};
			made.push(event);
			return [200, { success: true, eventId: event.eventId, url: `https://discord.com/events/g/${event.eventId}`, reminderCreated: true }];
		}
		if (path === '/api/events/update') {
			const event = made.find((e) => e.eventId === body.scheduledEventId && e.active);
			if (event === undefined) return [404, { success: false, error: 'event_not_tracked' }];
			if (deletedByHand.has(event.eventId)) {
				event.active = false;
				return [404, { success: false, error: 'event_not_found' }];
			}
			if (event.lastUpdateKey === body.idempotencyKey) return [200, { success: true, eventId: event.eventId, deduped: true }];
			event.lastUpdateKey = String(body.idempotencyKey);
			if (body.cancel === true) {
				event.active = false;
				return [200, { success: true, eventId: event.eventId, cancelled: true }];
			}
			const start = Date.parse(String(body.startTime));
			if (!(start > now())) return [400, { success: false, error: 'start_in_past' }];
			Object.assign(event, { name: String(body.name), startTime: String(body.startTime), endTime: String(body.endTime), description: String(body.description), location: String(body.location), remindBeforeMs: body.remindBeforeMs });
			return [200, { success: true, eventId: event.eventId, reminderActive: true }];
		}
		return [404, { success: false, error: 'not_found' }];
	};

	const self: StandInArchivebot = {
		url: '',
		made,
		paths,
		down: false,
		live: () => made.filter((e) => e.active && !deletedByHand.has(e.eventId)),
		deleteByHand: (eventId) => void deletedByHand.add(eventId),
		holdCreates() {
			let release = (): void => {};
			hold = new Promise<void>((resolve) => (release = resolve));
			return () => {
				hold = null;
				release();
			};
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};

	const server: Server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		req.on('end', () => {
			const path = req.url ?? '';
			paths.push(path);
			const reply = (status: number, body: Record<string, unknown>) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
			if (self.down) return reply(503, { success: false, error: 'discord_rate_limited' });
			const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
			if (req.headers['x-hadoku-signature'] !== expected) return reply(401, { success: false, error: 'invalid_signature' });
			void answer(path, JSON.parse(raw) as Record<string, unknown>).then(([status, body]) => reply(status, body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	self.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return self;
}
