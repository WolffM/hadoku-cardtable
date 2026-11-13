/*
 * `/api/events` — the front page's calendar and polls (`room/events.ts`). Gated like every `/api`
 * route; everyone sees every event and form, and only an event's organizer moves or cancels it.
 *
 *   GET    /api/events            → 200 { events: EventView[] }, soonest first
 *   POST   /api/events            { title, startsAt, room, formId? } → 201 EventView | 400 | 403 | 404 | 409 { verdict } | 429 | 502
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
 * only on Rally's side), and only an `event-signup@1` form is attached. Being a service caller,
 * this server also reads the form's availability as counts: an attached form lists its best
 * windows, and an event made from a form (`formId`) shows how many can make its start
 * (`signedUp`), live, so a later answer counts too.
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
} from '@hadoku/shared';

import type { EventRecord, Events, FormRecord } from '../room/events.js';
import { callerOf, httpCaller, parseBody, perCallerLimit } from './request.js';
import type { People, Person } from '../people.js';
import { type Lobby, type RoomView } from '../room/lobby.js';
import { UNNAMED } from '../room/constants.js';

type RallyFetch = (input: string, init?: RequestInit) => Promise<globalThis.Response>;

export interface RallyDeps {
	/** This server's service key (`CONFIG.serviceKey`): Rally answers its summary to signed-in callers only. */
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
	/** Organizers' and attachers' names, looked up when shown (`people.ts`). Absent: a record shows the name it kept, if any. */
	people?: People;
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

/** How long Rally's answer about a form is trusted before the next caller reads behind it: the polls card re-reads every minute. */
const RALLY_SUMMARY_TTL_MS = 5 * 60_000;
/** How long a read Rally did not answer is trusted: an outage costs one wait per form this often, not one per poll per player. */
const RALLY_FAILURE_TTL_MS = 30_000;
const RALLY_TIMEOUT_MS = 5_000;

type Summary = { ok: true; summary: RallyFormSummary } | { ok: false; reason: 'not-found' | 'unreachable' };

/**
 * Rally's summary endpoint, one read per form at a time, each answer kept `RALLY_SUMMARY_TTL_MS`.
 * A read Rally did not answer keeps the last answer it gave, or `unreachable`, for
 * `RALLY_FAILURE_TTL_MS`. `stale`: answer an expired one at once and read behind it (the polls
 * card, which would otherwise wait on Rally every fifth poll); without it the caller waits for the
 * read (attaching a form).
 */
function rallySummaries(deps: RallyDeps, now: () => number, log: (entry: Record<string, unknown>) => void) {
	const baseUrl = deps.baseUrl ?? 'https://hadoku.me/rally';
	const fetchImpl: RallyFetch = deps.fetch ?? ((input, init) => fetch(input, init));
	const kept = new Map<string, { until: number; answer: Summary }>();
	const reading = new Map<string, Promise<Summary>>();

	const read = async (formId: string): Promise<Summary> => {
		try {
			const res = await fetchImpl(`${baseUrl}/api/forms/${encodeURIComponent(formId)}/summary`, {
				headers: { accept: 'application/json', 'x-user-key': deps.serviceKey },
				signal: AbortSignal.timeout(RALLY_TIMEOUT_MS),
			});
			if (res.status === 404) return { ok: false, reason: 'not-found' };
			if (!res.ok) {
				log({ event: 'rally-summary-refused', formId, status: res.status });
				return { ok: false, reason: 'unreachable' };
			}
			const body = (await res.json()) as { data?: unknown };
			const summary = RallyFormSummarySchema.safeParse(body.data);
			if (!summary.success) {
				log({ event: 'rally-summary-unreadable', formId });
				return { ok: false, reason: 'unreachable' };
			}
			return { ok: true, summary: summary.data };
		} catch (err) {
			log({ event: 'rally-summary-failed', formId, err: String(err) });
			return { ok: false, reason: 'unreachable' };
		}
	};

	const refresh = (formId: string): Promise<Summary> => {
		const out = reading.get(formId);
		if (out !== undefined) return out;
		const task = read(formId).then((answer) => {
			reading.delete(formId);
			const unanswered = !answer.ok && answer.reason === 'unreachable';
			const keep = unanswered ? (kept.get(formId)?.answer ?? answer) : answer;
			kept.set(formId, { until: now() + (unanswered ? RALLY_FAILURE_TTL_MS : RALLY_SUMMARY_TTL_MS), answer: keep });
			return keep;
		});
		reading.set(formId, task);
		return task;
	};

	return async (formId: string, stale = false): Promise<Summary> => {
		const hit = kept.get(formId);
		if (hit === undefined) return refresh(formId);
		if (now() < hit.until) return hit.answer;
		if (!stale) return refresh(formId);
		void refresh(formId);
		return hit.answer;
	};
}

/** What the room plays now: the event's kind is the room's, never a copy. */
function kindOf(room: RoomView): EventKind {
	if (room.gameType === 'draft') return 'draft-pod';
	return room.settings.tournament ? 'constructed-tournament' : 'room';
}

function roomState(room: RoomView): EventRoom {
	const pod = room.game.pod;
	const entrants = pod === null ? 0 : pod.phase === 'lobby' ? pod.seats.filter((s) => s !== null && !isPodAi(s.memberId)).length : pod.drafters.length;
	return {
		gameType: room.gameType,
		mode: room.game.mode,
		format: room.game.format,
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

	/**
	 * Each person's name now, by userId (R4: a name is looked up, never kept). A record from before
	 * userIds were kept shows the name it stored; one with neither, the word an unnamed caller gets.
	 */
	const namesOf = async (userIds: readonly (string | null | undefined)[]): Promise<(userId: string | null | undefined, kept: string | undefined) => string> => {
		const ids = userIds.filter((id): id is string => typeof id === 'string');
		const found = deps.people === undefined || ids.length === 0 ? new Map<string, Person>() : await deps.people.resolve(ids);
		return (userId, kept) => (userId == null ? undefined : found.get(userId)?.name) ?? kept ?? UNNAMED;
	};

	/**
	 * How many said on the event's form that they can make it: Rally's count of respondents free for
	 * the form's whole length from the event's start (0 at a start nobody can make). Null without a
	 * form, or while Rally cannot say; an expired answer is shown while the next is read.
	 */
	const signedUpOf = async (e: EventRecord): Promise<number | null> => {
		if (e.formId === undefined) return null;
		const found = await summary(e.formId, true);
		const availability = found.ok ? found.summary.availability : undefined;
		if (availability === undefined) return null;
		return availability.starts.find((s) => Date.parse(s.at) === e.startsAt)?.free ?? 0;
	};

	const view = (e: EventRecord, room: RoomView, callerId: string, nameOf: (userId: string | null | undefined, kept: string | undefined) => string, signedUp: number | null): EventView => ({
		id: e.id,
		kind: kindOf(room),
		title: room.name,
		startsAt: new Date(e.startsAt).toISOString(),
		organizer: nameOf(e.organizerUserId, e.organizerName),
		mine: e.organizerId === callerId,
		roomId: room.id,
		room: roomState(room),
		signedUp,
	});

	const formView = (f: FormRecord, { availability, ...s }: RallyFormSummary, callerId: string, nameOf: (userId: string | null | undefined, kept: string | undefined) => string): AttachedForm => ({
		...s,
		attachedBy: nameOf(f.attachedByUserId, f.attachedByName),
		mine: f.attachedById === callerId,
		windows: availability?.best ?? [],
	});

	const refuse = (res: Response, reason: 'no-event' | 'not-organizer'): void => {
		if (reason === 'no-event') res.status(404).json({ error: 'no such event' });
		else res.status(403).json({ error: 'only the organizer can change this event' });
	};

	const createLimit = perCallerLimit(deps.createRateLimit === undefined ? EVENT_CREATE_RATE_LIMIT : deps.createRateLimit, 'too many new events; wait a little and try again', { act: 'event-create', now });

	api.get('/events/forms', async (req: Request, res: Response) => {
		const me = httpCaller(req);
		const attached = events.forms();
		const [answers, nameOf] = await Promise.all([Promise.all(attached.map((f) => summary(f.formId, true))), namesOf(attached.map((f) => f.attachedByUserId))]);
		const gone: string[] = [];
		const open: { form: AttachedForm; attachedAt: number }[] = [];
		attached.forEach((f, i) => {
			const a = answers[i]!;
			if (!a.ok) {
				if (a.reason === 'not-found') gone.push(f.formId);
			} else if (a.summary.status === 'closed') gone.push(f.formId);
			else open.push({ form: formView(f, a.summary, me, nameOf), attachedAt: f.attachedAt });
		});
		events.forgetForms(gone);
		const closes = (f: AttachedForm): number => (f.closesAt === null ? Infinity : Date.parse(f.closesAt));
		open.sort((a, b) => closes(a.form) - closes(b.form) || a.attachedAt - b.attachedAt);
		res.json({ forms: open.map((o) => o.form) });
	});

	api.post('/events/forms', async (req: Request, res: Response) => {
		const body = parseBody(AttachFormBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot attach a form' });
		const found = await summary(body.formId);
		if (!found.ok || !isEventSignupForm(found.summary)) {
			deps.log({ event: 'event-form-refused', formId: body.formId, reason: found.ok ? 'schema' : found.reason });
			if (found.ok) return res.status(400).json({ error: 'only an event sign-up form can be attached' });
			if (found.reason === 'not-found') return res.status(404).json({ error: 'Rally has no such form' });
			return res.status(502).json({ error: 'Rally did not answer; try again in a moment' });
		}
		const existing = events.forms().find((f) => f.formId === body.formId);
		if (existing !== undefined) return res.status(200).json(formView(existing, found.summary, caller.id, await namesOf([existing.attachedByUserId])));
		if (!createLimit(req, res)) return;
		events.attachForm({ formId: body.formId, attachedById: caller.id, attachedByUserId: caller.userId }, now());
		const attached = events.forms().find((f) => f.formId === body.formId)!;
		res.status(201).json(formView(attached, found.summary, caller.id, () => caller.name));
	});

	api.delete('/events/forms/:id', (req: Request, res: Response) => {
		const result = events.detachForm(String(req.params.id), httpCaller(req));
		if (!result.ok) {
			if (result.reason === 'no-form') return res.status(404).json({ error: 'no such form' });
			return res.status(403).json({ error: 'only whoever attached this form can take it off' });
		}
		res.json({ ok: true });
	});

	api.get('/events', async (req: Request, res: Response) => {
		const me = httpCaller(req);
		const upcoming = events.upcoming(now()).flatMap((e) => {
			const room = lobby.get(e.roomId);
			return room === undefined ? [] : [{ e, room }];
		});
		const [nameOf, signedUp] = await Promise.all([namesOf(upcoming.map(({ e }) => e.organizerUserId)), Promise.all(upcoming.map(({ e }) => signedUpOf(e)))]);
		res.json({ events: upcoming.map(({ e, room }, i) => view(e, room, me, nameOf, signedUp[i]!)) });
	});

	api.post('/events', async (req: Request, res: Response) => {
		const body = parseBody(CreateEventBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		// The form is checked before the room exists too: only a sign-up form Rally knows is linked.
		if (body.formId !== undefined) {
			const found = await summary(body.formId);
			if (!found.ok || !isEventSignupForm(found.summary)) {
				deps.log({ event: 'event-form-refused', formId: body.formId, reason: found.ok ? 'schema' : found.reason });
				if (found.ok) return res.status(400).json({ error: 'only an event sign-up form can be linked' });
				if (found.reason === 'not-found') return res.status(404).json({ error: 'Rally has no such form' });
				return res.status(502).json({ error: 'Rally did not answer; try again in a moment' });
			}
		}
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

		const event = events.create({ roomId, startsAt, organizerId: caller.id, organizerUserId: caller.userId, ...(body.formId === undefined ? {} : { formId: body.formId }) }, now());
		res.status(201).json(view(event, lobby.get(roomId)!, caller.id, () => caller.name, await signedUpOf(event)));
	});

	api.patch('/events/:id', async (req: Request, res: Response) => {
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
		const [nameOf, signedUp] = await Promise.all([namesOf([result.event.organizerUserId]), signedUpOf(result.event)]);
		res.json(view(result.event, lobby.get(room.id) ?? room, me, nameOf, signedUp));
	});

	api.delete('/events/:id', (req: Request, res: Response) => {
		const me = httpCaller(req);
		const result = events.cancel(String(req.params.id), me);
		if (!result.ok) return refuse(res, result.reason);
		const room = lobby.get(result.event.roomId);
		// A room people have started playing in outlives its event; one still waiting goes with it.
		if (room !== undefined && room.game.draftStartedAt === null && room.tables.every((t) => t.matchId === null)) {
			const closed = lobby.close(room.id, me);
			if (closed.ok) deps.closed?.(room.id, closed.matches);
		}
		res.json({ ok: true });
	});
}
