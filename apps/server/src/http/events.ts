/*
 * `/api/events` — the front page's calendar (`room/events.ts`). Friend-gated like every `/api`
 * route; every friend sees every event, and only its organizer edits or cancels it.
 *
 *   GET    /api/events       → 200 { events: EventView[] }, soonest first
 *   POST   /api/events       { kind, title, startsAt, room? } → 201 EventView | 400 | 403 | 429
 *   PATCH  /api/events/:id   { title?, startsAt? } → 200 EventView | 400 | 403 | 404
 *   DELETE /api/events/:id   → 200 { ok: true } | 403 | 404
 *
 * A room event makes its room at once, the organizer its leader, with `scheduledFor` set so the
 * lobby neither hides nor reaps it before the event. Cancelling closes that room unless a match or
 * a draft has started in it; moving the start moves the room's `scheduledFor` with it.
 */

import type { Request, Response, Router } from 'express';
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import { CreateEventBodySchema, DEFAULT_CLIENT_MODE, UpdateEventBodySchema, type EventView } from '@hadoku/shared';

import { userNameOf } from '../edge-auth.js';
import type { Lobby } from '../room/lobby.js';
import type { EventRecord, Events } from '../room/events.js';
import { httpCaller, parseBody, perCallerLimit } from './request.js';

export interface EventsDeps {
	events: Events;
	lobby: Lobby;
	/** A room an event's cancel closed, for its matches to be stopped as `/rooms/:id/close` does. */
	closed?: (roomId: string, matches: readonly string[]) => void;
	/** Overrides `EVENT_CREATE_RATE_LIMIT`; `null` is none (`perCallerLimit`). */
	createRateLimit?: RateLimitConfig | null;
	now?: () => number;
}

/**
 * Events organized per caller: a burst of 5, then one every five minutes. A room
 * event makes its room at once, so this is the room limit's other door.
 */
export const EVENT_CREATE_RATE_LIMIT: RateLimitConfig = {
	capacity: 5,
	refillAmount: 1,
	refillIntervalMs: 5 * 60_000,
};

/** A start this far in the past is still accepted: a form filled in a minute late. */
const STARTS_AT_GRACE_MS = 5 * 60_000;

export function attachEvents(api: Router, deps: EventsDeps): void {
	const { events, lobby } = deps;
	const now = deps.now ?? Date.now;

	const view = (e: EventRecord, callerId: string): EventView => ({
		id: e.id,
		kind: e.kind,
		title: e.title,
		startsAt: new Date(e.startsAt).toISOString(),
		organizer: e.organizerName,
		mine: e.organizerId === callerId,
		roomId: e.roomId !== null && lobby.get(e.roomId) !== undefined ? e.roomId : null,
	});

	const refuse = (res: Response, reason: 'no-event' | 'not-organizer'): void => {
		if (reason === 'no-event') res.status(404).json({ error: 'no such event' });
		else res.status(403).json({ error: 'only the organizer can change this event' });
	};

	api.get('/events', (req: Request, res: Response) => {
		const me = httpCaller(req);
		res.json({ events: events.upcoming(now()).map((e) => view(e, me)) });
	});

	const createLimit = perCallerLimit(deps.createRateLimit === undefined ? EVENT_CREATE_RATE_LIMIT : deps.createRateLimit, 'too many new events; wait a little and try again', { now });
	api.post('/events', (req: Request, res: Response) => {
		const body = parseBody(CreateEventBodySchema, req, res);
		if (body === null) return;
		const caller = { id: httpCaller(req), name: userNameOf(req) ?? 'friend' };
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		if (!createLimit(req, res)) return;

		let roomId: string | null = null;
		if (body.kind !== 'casual') {
			// A room event carries the Create room form's own body; the other two are set up in the room.
			const room = body.room ?? { name: body.title, gameType: body.kind === 'draft-pod' ? ('draft' as const) : ('constructed-1v1' as const), clientMode: DEFAULT_CLIENT_MODE };
			const created = lobby.create(caller, { ...room, scheduledFor: startsAt });
			if (!created.ok) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
			roomId = created.room.id;
			if (body.kind === 'constructed-tournament') lobby.setSettings(roomId, caller.id, { tournament: true });
		}
		const event = events.create({ kind: body.kind, title: body.title, startsAt, organizerId: caller.id, organizerName: caller.name, roomId }, now());
		res.status(201).json(view(event, caller.id));
	});

	api.patch('/events/:id', (req: Request, res: Response) => {
		const body = parseBody(UpdateEventBodySchema, req, res);
		if (body === null) return;
		const me = httpCaller(req);
		const startsAt = body.startsAt === undefined ? undefined : Date.parse(body.startsAt);
		if (startsAt !== undefined && startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		const result = events.update(String(req.params.id), me, { ...(body.title === undefined ? {} : { title: body.title }), ...(startsAt === undefined ? {} : { startsAt }) });
		if (!result.ok) return refuse(res, result.reason);
		if (startsAt !== undefined && result.event.roomId !== null) lobby.reschedule(result.event.roomId, startsAt);
		res.json(view(result.event, me));
	});

	api.delete('/events/:id', (req: Request, res: Response) => {
		const me = httpCaller(req);
		const result = events.cancel(String(req.params.id), me);
		if (!result.ok) return refuse(res, result.reason);
		const room = result.event.roomId === null ? undefined : lobby.get(result.event.roomId);
		// A room people have started playing in outlives its event; one still waiting goes with it.
		if (room !== undefined && room.draftStartedAt === null && room.tables.every((t) => t.matchId === null)) {
			const closed = lobby.close(room.id, me);
			if (closed.ok) deps.closed?.(room.id, closed.matches);
		}
		res.json({ ok: true });
	});
}
