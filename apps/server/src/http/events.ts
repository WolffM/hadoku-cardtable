/*
 * `/api/events` — the front page's calendar and polls (`room/events.ts`). Gated like every `/api`
 * route; everyone sees every event and form, and only an event's organizer moves or cancels it.
 *
 *   GET    /api/events            → 200 { events: EventView[] }, soonest first
 *   POST   /api/events            { title, startsAt, room } → 201 EventView | 400 | 403 | 409 { verdict } | 429
 *   PATCH  /api/events/:id        { startsAt, title? } → 200 EventView | 400 | 403 | 404
 *   DELETE /api/events/:id        → 200 { ok: true } | 403 | 404
 *   GET    /api/events/forms      → 200 { forms: AttachedForm[] }, the open ones, closing soonest first
 *   POST   /api/events/forms      { formId } → 201 AttachedForm | 200 (already attached) | 400 | 404 | 502
 *   DELETE /api/events/forms/:id  → 200 { ok: true } | 403 | 404
 *
 * An event is a tournament room: POST makes it at once with every setting the form chose, the
 * organizer its leader, with `scheduledFor` set so the lobby neither hides nor reaps it before the
 * event. Its view is read from the room each time, so a change made in the room shows here at
 * once; an event whose room has closed is not listed. Cancelling closes the room unless a match or
 * a draft has started in it; moving the start moves the room's `scheduledFor` with it.
 *
 * A form is checked through Rally's summary with this server's service key (signed-in callers
 * only on Rally's side), and only an `event-signup@1` form is attached.
 */

import type { Request, Response, Router } from 'express';
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import {
	AttachFormBodySchema,
	CreateEventBodySchema,
	isEventSignupForm,
	isPodAi,
	RallyFormSummarySchema,
	UpdateEventBodySchema,
	type AttachedForm,
	type DraftPlan,
	type EventKind,
	type EventRoom,
	type EventView,
	type PoolVerdict,
	type RallyFormSummary,
	type RoomView,
} from '@hadoku/shared';

import { userNameOf } from '../edge-auth.js';
import type { Lobby } from '../room/lobby.js';
import type { EventRecord, Events, FormRecord } from '../room/events.js';
import { httpCaller, parseBody, perCallerLimit } from './request.js';

type RallyFetch = (input: string, init?: RequestInit) => Promise<globalThis.Response>;

export interface RallyDeps {
	/** This server's service key (`CONFIG.statsServiceKey`): Rally answers its summary to signed-in callers only. */
	serviceKey: string;
	/** Rally's mount, without `/api`. */
	baseUrl?: string;
	fetch?: RallyFetch;
}

export interface EventsDeps {
	events: Events;
	lobby: Lobby;
	/** A draft tournament's pool verdict (`room/plan.ts`'s `checkPlan`), run before its room is made. */
	checkPlan: (plan: DraftPlan) => Promise<PoolVerdict>;
	rally: RallyDeps;
	/** A room an event's cancel closed, for its matches to be stopped as `/rooms/:id/close` does. */
	closed?: (roomId: string, matches: readonly string[]) => void;
	/** Where a Rally call that failed is told. */
	log: (entry: Record<string, unknown>) => void;
	/** Overrides `EVENT_CREATE_RATE_LIMIT`; `null` is none (`perCallerLimit`). */
	createRateLimit?: RateLimitConfig | null;
	now?: () => number;
}

/**
 * Events organized per caller: a burst of 5, then one every five minutes. An event makes its
 * room at once, so this is the room limit's other door. Attaching a form shares it.
 */
export const EVENT_CREATE_RATE_LIMIT: RateLimitConfig = {
	capacity: 5,
	refillAmount: 1,
	refillIntervalMs: 5 * 60_000,
};

/** A start this far in the past is still accepted: a form filled in a minute late. */
const STARTS_AT_GRACE_MS = 5 * 60_000;

/** How long Rally's answer about a form is trusted: the polls card re-reads every minute. */
const RALLY_SUMMARY_TTL_MS = 5 * 60_000;
const RALLY_TIMEOUT_MS = 5_000;

type Summary = { ok: true; summary: RallyFormSummary } | { ok: false; reason: 'not-found' | 'unreachable' };

/** Rally's summary endpoint, each answer kept `RALLY_SUMMARY_TTL_MS`. A failure is not kept. */
function rallySummaries(deps: RallyDeps, now: () => number, log: (entry: Record<string, unknown>) => void) {
	const baseUrl = deps.baseUrl ?? 'https://hadoku.me/rally';
	const fetchImpl: RallyFetch = deps.fetch ?? ((input, init) => fetch(input, init));
	const kept = new Map<string, { at: number; answer: Summary }>();
	return async (formId: string): Promise<Summary> => {
		const hit = kept.get(formId);
		if (hit !== undefined && now() - hit.at < RALLY_SUMMARY_TTL_MS) return hit.answer;
		let answer: Summary;
		try {
			const res = await fetchImpl(`${baseUrl}/api/forms/${encodeURIComponent(formId)}/summary`, {
				headers: { accept: 'application/json', 'x-user-key': deps.serviceKey },
				signal: AbortSignal.timeout(RALLY_TIMEOUT_MS),
			});
			if (res.status === 404) answer = { ok: false, reason: 'not-found' };
			else if (!res.ok) {
				log({ event: 'rally-summary-refused', formId, status: res.status });
				return { ok: false, reason: 'unreachable' };
			} else {
				const body = (await res.json()) as { data?: unknown };
				const summary = RallyFormSummarySchema.safeParse(body.data);
				if (!summary.success) {
					log({ event: 'rally-summary-unreadable', formId });
					return { ok: false, reason: 'unreachable' };
				}
				answer = { ok: true, summary: summary.data };
			}
		} catch (err) {
			log({ event: 'rally-summary-failed', formId, err: String(err) });
			return { ok: false, reason: 'unreachable' };
		}
		kept.set(formId, { at: now(), answer });
		return answer;
	};
}

/** What the room plays now: the event's kind is the room's, never a copy. */
function kindOf(room: RoomView): EventKind {
	if (room.gameType === 'draft') return 'draft-pod';
	return room.settings.tournament ? 'constructed-tournament' : 'room';
}

function roomState(room: RoomView): EventRoom {
	const pod = room.pod;
	const entrants = pod === null ? 0 : pod.phase === 'lobby' ? pod.seats.filter((s) => s !== null && !isPodAi(s.memberId)).length : pod.drafters.length;
	return {
		gameType: room.gameType,
		mode: room.mode,
		format: room.format,
		settings: room.settings,
		pool: pod?.roundNames ?? null,
		locked: room.locked,
		phase: pod?.phase ?? null,
		members: room.members.length,
		entrants,
	};
}

export function attachEvents(api: Router, deps: EventsDeps): void {
	const { events, lobby } = deps;
	const now = deps.now ?? Date.now;
	const summary = rallySummaries(deps.rally, now, deps.log);

	const view = (e: EventRecord, room: RoomView, callerId: string): EventView => ({
		id: e.id,
		kind: kindOf(room),
		title: room.name,
		startsAt: new Date(e.startsAt).toISOString(),
		organizer: e.organizerName,
		mine: e.organizerId === callerId,
		roomId: room.id,
		room: roomState(room),
	});

	const formView = (f: FormRecord, s: RallyFormSummary, callerId: string): AttachedForm => ({ ...s, attachedBy: f.attachedByName, mine: f.attachedById === callerId });

	const refuse = (res: Response, reason: 'no-event' | 'not-organizer'): void => {
		if (reason === 'no-event') res.status(404).json({ error: 'no such event' });
		else res.status(403).json({ error: 'only the organizer can change this event' });
	};

	const createLimit = perCallerLimit(deps.createRateLimit === undefined ? EVENT_CREATE_RATE_LIMIT : deps.createRateLimit, 'too many new events; wait a little and try again', { now });

	api.get('/events/forms', async (req: Request, res: Response) => {
		const me = httpCaller(req);
		const attached = events.forms();
		const answers = await Promise.all(attached.map((f) => summary(f.formId)));
		const gone: string[] = [];
		const open: { form: AttachedForm; attachedAt: number }[] = [];
		attached.forEach((f, i) => {
			const a = answers[i]!;
			if (!a.ok) {
				if (a.reason === 'not-found') gone.push(f.formId);
			} else if (a.summary.status === 'closed') gone.push(f.formId);
			else open.push({ form: formView(f, a.summary, me), attachedAt: f.attachedAt });
		});
		events.forgetForms(gone);
		const closes = (f: AttachedForm): number => (f.closesAt === null ? Infinity : Date.parse(f.closesAt));
		open.sort((a, b) => closes(a.form) - closes(b.form) || a.attachedAt - b.attachedAt);
		res.json({ forms: open.map((o) => o.form) });
	});

	api.post('/events/forms', async (req: Request, res: Response) => {
		const body = parseBody(AttachFormBodySchema, req, res);
		if (body === null) return;
		const caller = { id: httpCaller(req), name: userNameOf(req) ?? 'friend' };
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot attach a form' });
		const found = await summary(body.formId);
		if (!found.ok || !isEventSignupForm(found.summary)) {
			deps.log({ event: 'event-form-refused', formId: body.formId, reason: found.ok ? 'schema' : found.reason });
			if (found.ok) return res.status(400).json({ error: 'only an event sign-up form can be attached' });
			if (found.reason === 'not-found') return res.status(404).json({ error: 'Rally has no such form' });
			return res.status(502).json({ error: 'Rally did not answer; try again in a moment' });
		}
		const existing = events.forms().find((f) => f.formId === body.formId);
		if (existing !== undefined) return res.status(200).json(formView(existing, found.summary, caller.id));
		if (!createLimit(req, res)) return;
		events.attachForm({ formId: body.formId, attachedById: caller.id, attachedByName: caller.name }, now());
		const attached = events.forms().find((f) => f.formId === body.formId)!;
		res.status(201).json(formView(attached, found.summary, caller.id));
	});

	api.delete('/events/forms/:id', (req: Request, res: Response) => {
		const result = events.detachForm(String(req.params.id), httpCaller(req));
		if (!result.ok) {
			if (result.reason === 'no-form') return res.status(404).json({ error: 'no such form' });
			return res.status(403).json({ error: 'only whoever attached this form can take it off' });
		}
		res.json({ ok: true });
	});

	api.get('/events', (req: Request, res: Response) => {
		const me = httpCaller(req);
		res.json({
			events: events.upcoming(now()).flatMap((e) => {
				const room = lobby.get(e.roomId);
				return room === undefined ? [] : [view(e, room, me)];
			}),
		});
	});

	api.post('/events', async (req: Request, res: Response) => {
		const body = parseBody(CreateEventBodySchema, req, res);
		if (body === null) return;
		const caller = { id: httpCaller(req), name: userNameOf(req) ?? 'friend' };
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		if (!createLimit(req, res)) return;

		// The pool is checked before the room exists, so a refused one leaves nothing behind.
		const verdict = body.plan === undefined ? null : await deps.checkPlan(body.plan);
		if (verdict !== null && !verdict.ok) return res.status(409).json({ verdict });

		const created = lobby.create(caller, { ...body.room, scheduledFor: startsAt });
		if (!created.ok) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const roomId = created.room.id;
		const constructed = body.room.gameType === 'constructed-1v1';
		if (body.format !== undefined) lobby.setFormat(roomId, caller.id, body.format);
		const settings = constructed ? { ...body.settings, tournament: true } : body.settings;
		if (Object.keys(settings).length > 0) lobby.setSettings(roomId, caller.id, settings);
		if (body.plan !== undefined && verdict !== null) lobby.setPodPlan(roomId, caller.id, body.plan, verdict);

		const event = events.create({ roomId, startsAt, organizerId: caller.id, organizerName: caller.name }, now());
		res.status(201).json(view(event, lobby.get(roomId)!, caller.id));
	});

	api.patch('/events/:id', (req: Request, res: Response) => {
		const body = parseBody(UpdateEventBodySchema, req, res);
		if (body === null) return;
		const me = httpCaller(req);
		const existing = events.get(String(req.params.id));
		if (existing === undefined) return refuse(res, 'no-event');
		if (existing.organizerId !== me) return refuse(res, 'not-organizer');
		const room = lobby.get(existing.roomId);
		if (room === undefined) return res.status(404).json({ error: 'this event’s room has closed' });
		if (body.title !== undefined && body.title !== room.name) return res.status(400).json({ error: 'an event is named after its room' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		const result = events.reschedule(existing.id, me, startsAt);
		if (!result.ok) return refuse(res, result.reason);
		lobby.reschedule(room.id, startsAt);
		res.json(view(result.event, lobby.get(room.id) ?? room, me));
	});

	api.delete('/events/:id', (req: Request, res: Response) => {
		const me = httpCaller(req);
		const result = events.cancel(String(req.params.id), me);
		if (!result.ok) return refuse(res, result.reason);
		const room = lobby.get(result.event.roomId);
		// A room people have started playing in outlives its event; one still waiting goes with it.
		if (room !== undefined && room.draftStartedAt === null && room.tables.every((t) => t.matchId === null)) {
			const closed = lobby.close(room.id, me);
			if (closed.ok) deps.closed?.(room.id, closed.matches);
		}
		res.json({ ok: true });
	});
}
