/*
 * The Discord server's Events tab mirrors the front page's calendar (`events.ts`): every upcoming
 * event the game says may be shown there gets a Discord scheduled event, through ArchiveBot's
 * signed `/api/events/create` and `/api/events/update` (contract and source:
 * docs/requests/ARCHIVEBOT_DISCORD_INTEGRATION_REPLY.md, ArchiveBot `lib/eventWebhook.js`).
 * ArchiveBot puts it in the app's own guild and posts its reminder and start in #events.
 *
 * One rule, `sync(id)`, makes Discord match the record, and everything goes through it:
 *
 * - shown and not on Discord → create, keyed `<service>-event-<id>`. ArchiveBot dedupes that key
 *   while its event is live, so a retry, or a reply lost after Discord made it, makes no second one.
 * - shown, on Discord, but sent differently (a new start, the room renamed) → update, keyed by what
 *   it sends, since ArchiveBot drops an update whose key equals the last one it applied. An answer
 *   that the event is gone (someone deleted it in Discord) creates it afresh.
 * - not shown any more (its room closed, or got a password) but on Discord → cancel.
 * - a start already past is left alone: Discord ends it, and cancelling one being played is wrong.
 *
 * The organizer's own cancel (`cancel(event)`) removes the record first, so it cancels from the
 * event it was handed. Calls for one event run one at a time, so a move made while its create is
 * still out waits for the event id. `sweep()` syncs every upcoming event: at boot and every
 * `SWEEP_MS`, it retries what failed and catches what changed without a call (a room renamed,
 * closed or locked in the room itself). A failure is logged, never thrown, and never delays the
 * request that caused it.
 *
 * Without the secret (PPE, local dev) every call is a no-op: only prod has a Discord calendar.
 */
import { createHash } from 'node:crypto';

import { archivebotPost, type ArchivebotTarget } from '@hadoku/service-kernel/lifecycle';

import type { EventRecord, Events } from './events.js';

/** How an event reads on Discord. ArchiveBot caps `name` at 100 and `location` at 100, and cuts `description` at 1000. */
export interface DiscordEventShape {
	name: string;
	description: string;
	location: string;
}

export interface DiscordEventsDeps extends ArchivebotTarget {
	/** Names the idempotency keys and the `source` ArchiveBot logs. */
	service: string;
	events: Events;
	/** How the event reads on Discord, or null when it must not be there (its room is gone, private or a test). */
	shape: (event: EventRecord) => Promise<DiscordEventShape | null>;
	log: (entry: Record<string, unknown>) => void;
	now?: () => number;
}

export interface DiscordEvents {
	/** Make Discord match the event's record now. Resolves when done; never rejects. */
	sync(id: string): Promise<void>;
	/** The organizer cancelled it: take it off Discord. Resolves when done; never rejects. */
	cancel(event: EventRecord): Promise<void>;
	/** `sync` every upcoming event. */
	sweep(): Promise<void>;
}

/** How long the Discord event runs: Discord needs an end, and a pod's three rounds fit in this. */
export const DISCORD_EVENT_LENGTH_MS = 3 * 60 * 60_000;
/** ArchiveBot's reminder in #events, this long before the start. */
export const DISCORD_REMIND_BEFORE_MS = 60 * 60_000;
/** A start closer than this is not sent: ArchiveBot refuses a start already past by the time it arrives. */
const START_MARGIN_MS = 60_000;
/** How often every upcoming event is synced with nobody asking. */
export const SWEEP_MS = 10 * 60_000;

/** ArchiveBot's answers that the event it was asked to update no longer exists on Discord. */
const GONE = new Set(['event_not_tracked', 'event_not_found']);

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function discordEvents(deps: DiscordEventsDeps): DiscordEvents {
	const now = deps.now ?? Date.now;
	const enabled = deps.secret !== '';
	const queues = new Map<string, Promise<void>>();

	/** Run `task` after every earlier one for the same event; never rejects. */
	const queued = (id: string, task: () => Promise<void>): Promise<void> => {
		const run = (queues.get(id) ?? Promise.resolve()).then(task).catch((err: unknown) => {
			deps.log({ event: 'discord-event', outcome: 'failed', id, error: err instanceof Error ? err.message : String(err) });
		});
		queues.set(id, run);
		void run.then(() => {
			if (queues.get(id) === run) queues.delete(id);
		});
		return run;
	};

	const post = (path: string, payload: Record<string, unknown>) => archivebotPost(deps, path, JSON.stringify({ ...payload, timestamp: now(), source: deps.service }));

	const fields = (event: EventRecord, shape: DiscordEventShape) => ({
		name: shape.name.slice(0, 100),
		startTime: new Date(event.startsAt).toISOString(),
		endTime: new Date(event.startsAt + DISCORD_EVENT_LENGTH_MS).toISOString(),
		description: shape.description.slice(0, 1000),
		location: shape.location.slice(0, 100),
		remindBeforeMs: DISCORD_REMIND_BEFORE_MS,
	});

	const cancelOnDiscord = async (event: EventRecord, discord: NonNullable<EventRecord['discord']>): Promise<boolean> => {
		const res = await post('/api/events/update', { idempotencyKey: `${deps.service}-event-${event.id}-cancel-${discord.eventId}`, scheduledEventId: discord.eventId, cancel: true });
		const gone = typeof res.answer.error === 'string' && GONE.has(res.answer.error);
		if (!res.ok && !gone) {
			deps.log({ event: 'discord-event', outcome: 'failed', act: 'cancel', id: event.id, eventId: discord.eventId, status: res.status, reply: res.raw.slice(0, 500) });
			return false;
		}
		deps.log({ event: 'discord-event', outcome: gone ? 'already-gone' : 'cancelled', id: event.id, eventId: discord.eventId });
		return true;
	};

	const create = async (event: EventRecord, sent: string, body: ReturnType<typeof fields>): Promise<void> => {
		const res = await post('/api/events/create', { idempotencyKey: `${deps.service}-event-${event.id}`, ...body });
		const eventId = res.answer.eventId;
		if (!res.ok || typeof eventId !== 'string') {
			deps.log({ event: 'discord-event', outcome: 'failed', act: 'create', id: event.id, status: res.status, reply: res.raw.slice(0, 500) });
			return;
		}
		deps.log({ event: 'discord-event', outcome: res.answer.deduped === true ? 'already-created' : 'created', id: event.id, eventId });
		// Cancelled while the create was out: nothing will hold this id, so take it straight back off.
		if (deps.events.get(event.id) === undefined) await cancelOnDiscord(event, { eventId, sent });
		else deps.events.setDiscord(event.id, { eventId, sent });
	};

	const syncNow = async (id: string): Promise<void> => {
		const event = deps.events.get(id);
		if (event === undefined || event.startsAt <= now() + START_MARGIN_MS) return;
		const shape = await deps.shape(event);
		if (shape === null) {
			if (event.discord !== undefined && (await cancelOnDiscord(event, event.discord))) deps.events.setDiscord(id, undefined);
			return;
		}
		const body = fields(event, shape);
		const sent = JSON.stringify(body);
		if (event.discord === undefined) return create(event, sent, body);
		if (event.discord.sent === sent) return;
		const res = await post('/api/events/update', { idempotencyKey: `${deps.service}-event-${id}-${short(sent)}`, scheduledEventId: event.discord.eventId, ...body });
		if (typeof res.answer.error === 'string' && GONE.has(res.answer.error)) {
			deps.log({ event: 'discord-event', outcome: 'recreating', id, eventId: event.discord.eventId });
			return create(event, sent, body);
		}
		if (!res.ok) {
			deps.log({ event: 'discord-event', outcome: 'failed', act: 'update', id, eventId: event.discord.eventId, status: res.status, reply: res.raw.slice(0, 500) });
			return;
		}
		deps.events.setDiscord(id, { eventId: event.discord.eventId, sent });
		deps.log({ event: 'discord-event', outcome: 'updated', id, eventId: event.discord.eventId });
	};

	return {
		sync: (id) => (enabled ? queued(id, () => syncNow(id)) : Promise.resolve()),
		// Queued even with no Discord id yet, so it runs after a create still out, which then sees the record gone.
		cancel: (event) =>
			enabled && event.startsAt > now()
				? queued(event.id, async () => {
						if (event.discord !== undefined) await cancelOnDiscord(event, event.discord);
					})
				: Promise.resolve(),
		sweep: async () => {
			if (!enabled) return;
			await Promise.all(deps.events.upcoming(now()).map((e) => queued(e.id, () => syncNow(e.id))));
		},
	};
}
