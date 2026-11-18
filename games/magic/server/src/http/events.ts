/*
 * `/api/events` — the front page's calendar and polls (`room/events.ts`). Gated like every `/api`
 * route; everyone sees every event and form, and only an event's organizer moves or cancels it.
 *
 *   GET    /api/events            → 200 { events: EventView[] }, soonest first
 *   POST   /api/events            { title, startsAt, room, formId? } → 201 EventView | 400 | 403 | 404 | 409 { verdict } | 429 | 502
 *   PATCH  /api/events/:id        { startsAt, title? } → 200 EventView | 400 | 403 | 404
 *   DELETE /api/events/:id        → 200 { ok: true } | 403 | 404
 *   GET    /api/events/forms      → 200 { forms: AttachedForm[] }, closing soonest first: the open ones, and
 *                                    to whoever attached it a closed one no event is made from yet
 *   POST   /api/events/forms      { formId } → 201 AttachedForm | 200 (already attached) | 400 | 404 | 502
 *   DELETE /api/events/forms/:id  → 200 { ok: true } | 403 | 404
 *
 * An event is a tournament room: POST makes it at once with every setting the form chose, the
 * organizer its leader, with `scheduledFor` set so the lobby neither hides nor reaps it before the
 * event. Its view is read from the room each time, so a change made in the room shows here at
 * once; an event whose room has closed is not listed. Cancelling closes the room unless a match or
 * a draft has started in it; moving the start moves the room's `scheduledFor` with it. Making,
 * moving and cancelling an event each update the Discord server's Events tab as they happen
 * (`discord`, never awaited).
 *
 * A form is checked through Rally's summary with this server's service key (signed-in callers
 * only on Rally's side), and only an `event-signup@1` form is attached. Being a service caller,
 * this server also reads the form's availability as counts and who submitted it: an attached
 * form lists its best windows, and an event's `signups` are everyone who submitted the form it
 * was made from (`formId`) and everyone in its room, once each by account, read live, so a later
 * answer or join counts too.
 *
 * A poll closing is when its event gets made, so a closed form stays listed to whoever attached
 * it, with its windows, until an event is made from it or `CLOSED_FORM_KEPT_MS` after it closed;
 * everyone else stops seeing it when it closes.
 */

import type { Request, Response, Router } from 'express';
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import {
	AttachFormBodySchema,
	CreateEventBodySchema,
	isEventSignupForm,
	planDisplayName,
	RallyFormSummarySchema,
	UpdateEventBodySchema,
	type AttachedForm,
	type DraftPlan,
	type EventKind,
	type EventRoom,
	type EventSignup,
	type EventView,
	type PoolVerdict,
	type RallyFormSummary,
} from '@hadoku/shared';

import type { DiscordEvents } from '@hadoku/game-server/room/discord-events';
import type { EventRecord, Events, FormRecord } from '@hadoku/game-server/room/events';
import { callerOf, httpCaller, parseBody, perCallerLimit } from '@hadoku/game-server/http/request';
import { deriveParticipantId } from '@hadoku/game-server/room/identity';
import { faceOfPerson, type People, type Person } from '@hadoku/game-server/people';
import { type Lobby, type MagicRoomView } from '../room/lobby.js';
import { magicView } from '../room/magic-view.js';
import { UNNAMED } from '@hadoku/game-server/room/constants';

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
	/** The Discord server's Events tab, kept to match each change here as it is made; absent, none is. */
	discord?: DiscordEvents;
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

/** A closed form stays creatable this long after it closed (or, closed with no close time, after it was attached). */
export const CLOSED_FORM_KEPT_MS = 14 * 24 * 60 * 60_000;

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
function kindOf(room: MagicRoomView): EventKind {
	if (room.gameType === 'draft') return 'draft-pod';
	return room.settings.tournament ? 'constructed-tournament' : 'room';
}

function roomState(room: MagicRoomView): EventRoom {
	const pod = room.game?.pod ?? null;
	return {
		gameType: room.gameType,
		mode: room.game?.mode ?? null,
		// A draft room still holds a constructed format from its defaults; it plays its plan, not that.
		format: room.gameType === 'draft' ? '' : (room.game?.format ?? ''),
		settings: room.settings,
		pool: pod?.plan == null || pod.roundNames == null ? null : planDisplayName(pod.plan, pod.roundNames),
		locked: room.locked,
		phase: pod?.phase ?? null,
	};
}

/**
 * Who has signed up for an event: everyone who submitted its form (`respondents`, earliest first),
 * then everyone in its room who did not, once each by account. A respondent in the room is drawn
 * as the room draws them; one elsewhere by their account now (`found`), or, with no account, by
 * the name they typed and no face. Exported for its test.
 */
export function signupsOf(
	respondents: NonNullable<RallyFormSummary['respondents']>,
	room: Pick<MagicRoomView, 'members'>,
	users: readonly { memberId: string; userId: string }[],
	found: ReadonlyMap<string, Person>,
): EventSignup[] {
	const memberOf = new Map(users.map((u) => [u.userId, u.memberId]));
	const inRoom = (m: MagicRoomView['members'][number]): EventSignup => ({
		name: m.name,
		...(m.avatarId === undefined ? {} : { avatarId: m.avatarId }),
		...(m.look === undefined ? {} : { look: m.look }),
		inRoom: true,
	});
	const listed = new Set<string>();
	const seen = new Set<string>();
	const out: EventSignup[] = [];
	for (const r of respondents) {
		if (r.userId === null) {
			out.push({ name: r.name, inRoom: false });
			continue;
		}
		if (seen.has(r.userId)) continue;
		seen.add(r.userId);
		const memberId = memberOf.get(r.userId);
		const member = room.members.find((m) => m.id === memberId);
		if (member !== undefined) {
			listed.add(member.id);
			out.push(inRoom(member));
			continue;
		}
		const person = found.get(r.userId);
		out.push({ name: person?.name ?? r.name, ...faceOfPerson(person), inRoom: false });
	}
	for (const m of room.members) if (!listed.has(m.id)) out.push(inRoom(m));
	return out;
}

export function attachEvents(api: Router, deps: EventsDeps): void {
	const { events, lobby } = deps;
	const now = deps.now ?? Date.now;
	const summary = rallySummaries(deps.rally, now, deps.log);

	/** Each person as they are now, by userId (R4: a name is looked up, never kept). */
	const peopleOf = async (userIds: readonly (string | null | undefined)[]): Promise<Map<string, Person>> => {
		const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string'))];
		return deps.people === undefined || ids.length === 0 ? new Map<string, Person>() : deps.people.resolve(ids);
	};

	/**
	 * Each person's name from `found`. A record from before userIds were kept shows the name it
	 * stored; one with neither, the word an unnamed caller gets.
	 */
	const nameIn = (found: Map<string, Person>) => (userId: string | null | undefined, kept: string | undefined): string => (userId == null ? undefined : found.get(userId)?.name) ?? kept ?? UNNAMED;
	const namesOf = async (userIds: readonly (string | null | undefined)[]) => nameIn(await peopleOf(userIds));

	/** Who submitted the event's form; none without a form, or while Rally cannot say (an expired answer is used while the next is read). */
	const respondentsOf = async (e: EventRecord): Promise<NonNullable<RallyFormSummary['respondents']>> => {
		if (e.formId === undefined) return [];
		const found = await summary(e.formId, true);
		return (found.ok ? found.summary.respondents : undefined) ?? [];
	};

	const views = async (shown: readonly { e: EventRecord; room: MagicRoomView }[], callerId: string, kept: (e: EventRecord) => string | undefined = (e) => e.organizerName): Promise<EventView[]> => {
		const respondents = await Promise.all(shown.map(({ e }) => respondentsOf(e)));
		const found = await peopleOf([...shown.map(({ e }) => e.organizerUserId), ...respondents.flat().map((r) => r.userId)]);
		const nameOf = nameIn(found);
		return shown.map(({ e, room }, i) => ({
			id: e.id,
			kind: kindOf(room),
			title: room.name,
			startsAt: new Date(e.startsAt).toISOString(),
			organizer: nameOf(e.organizerUserId, kept(e)),
			mine: e.organizerId === callerId,
			joined: lobby.isMember(room.id, callerId),
			roomId: room.id,
			room: roomState(room),
			signups: signupsOf(respondents[i]!, room, lobby.usersOf(room.id), found),
		}));
	};

	const formView = (f: FormRecord, { availability, respondents: _respondents, ...s }: RallyFormSummary, callerId: string, nameOf: (userId: string | null | undefined, kept: string | undefined) => string): AttachedForm => ({
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
		const madeFrom = new Set(events.upcoming(now()).flatMap((e) => (e.formId === undefined ? [] : [e.formId])));
		const [answers, nameOf] = await Promise.all([Promise.all(attached.map((f) => summary(f.formId, true))), namesOf(attached.map((f) => f.attachedByUserId))]);
		const gone: string[] = [];
		const open: { form: AttachedForm; attachedAt: number }[] = [];
		attached.forEach((f, i) => {
			const a = answers[i]!;
			if (!a.ok) {
				if (a.reason === 'not-found') gone.push(f.formId);
				return;
			}
			if (a.summary.status === 'closed') {
				const closedAt = a.summary.closesAt === null ? f.attachedAt : Date.parse(a.summary.closesAt);
				if (madeFrom.has(f.formId) || now() >= closedAt + CLOSED_FORM_KEPT_MS) return void gone.push(f.formId);
				if (f.attachedById !== me) return;
			}
			open.push({ form: formView(f, a.summary, me, nameOf), attachedAt: f.attachedAt });
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
			// An event's room is one Magic's lobby made (`POST /events`).
			const room = magicView(lobby.get(e.roomId));
			return room === undefined ? [] : [{ e, room }];
		});
		res.json({ events: await views(upcoming, me) });
	});

	api.post('/events', async (req: Request, res: Response) => {
		const body = parseBody(CreateEventBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		// The form is checked before the room exists too: only a sign-up form Rally knows is linked.
		let formClosed = false;
		// An event made from a form is its creator's, whoever sends the request (the service key, a friend).
		let organizer = { id: caller.id, userId: caller.userId };
		if (body.formId !== undefined) {
			const found = await summary(body.formId);
			if (!found.ok || !isEventSignupForm(found.summary)) {
				deps.log({ event: 'event-form-refused', formId: body.formId, reason: found.ok ? 'schema' : found.reason });
				if (found.ok) return res.status(400).json({ error: 'only an event sign-up form can be linked' });
				if (found.reason === 'not-found') return res.status(404).json({ error: 'Rally has no such form' });
				return res.status(502).json({ error: 'Rally did not answer; try again in a moment' });
			}
			formClosed = found.summary.status === 'closed';
			const creator = found.summary.createdById;
			if (creator !== undefined) organizer = { id: deriveParticipantId({ accountId: creator, socketId: '' }), userId: creator };
		}
		if (!createLimit(req, res)) return;

		// The pool is checked before the room exists, so a refused one leaves nothing behind.
		const verdict = body.plan === undefined ? null : await deps.checkPlan(body.plan);
		if (verdict !== null && !verdict.ok) return res.status(409).json({ verdict });

		// The room is the organizer's too: a service caller making it for a form's creator never sits in it.
		// Their name comes from their account once the room is made (`attachPeople`).
		const host = organizer.id === caller.id ? caller : { ...caller, ...organizer, name: UNNAMED };
		const created = lobby.create(host, { ...body.room, scheduledFor: startsAt });
		if (!created.ok) return res.status(403).json({ error: 'the edge did not name you, so you cannot organize an event' });
		const roomId = created.room.id;
		const constructed = body.room.gameType === 'constructed-1v1';
		if (body.format !== undefined) lobby.setFormat(roomId, organizer.id, body.format);
		const settings = constructed ? { ...body.settings, tournament: true } : body.settings;
		if (Object.keys(settings).length > 0) lobby.setSettings(roomId, organizer.id, settings);
		if (body.plan !== undefined && verdict !== null) lobby.setPodPlan(roomId, organizer.id, body.plan, verdict);

		const event = events.create({ roomId, startsAt, organizerId: organizer.id, organizerUserId: organizer.userId, ...(body.formId === undefined ? {} : { formId: body.formId }) }, now());
		// A closed poll was kept only so its event could be made: made, it goes.
		if (formClosed && body.formId !== undefined) events.forgetForms([body.formId]);
		void deps.discord?.sync(event.id);
		// The create body takes only Magic's game types (`CreateRoomBodySchema`).
		const [made] = await views([{ e: event, room: magicView(lobby.get(roomId))! }], caller.id, (e) => e.organizerName ?? (organizer.id === caller.id ? caller.name : undefined));
		res.status(201).json(made);
	});

	api.patch('/events/:id', async (req: Request, res: Response) => {
		const body = parseBody(UpdateEventBodySchema, req, res);
		if (body === null) return;
		const me = httpCaller(req);
		const existing = events.get(String(req.params.id));
		if (existing === undefined) return refuse(res, 'no-event');
		if (existing.organizerId !== me) return refuse(res, 'not-organizer');
		const room = magicView(lobby.get(existing.roomId));
		if (room === undefined) return res.status(404).json({ error: 'this event’s room has closed' });
		if (body.title !== undefined && body.title !== room.name) return res.status(400).json({ error: 'an event is named after its room' });
		const startsAt = Date.parse(body.startsAt);
		if (startsAt < now() - STARTS_AT_GRACE_MS) return res.status(400).json({ error: 'startsAt must not be in the past' });
		const result = events.reschedule(existing.id, me, startsAt);
		if (!result.ok) return refuse(res, result.reason);
		lobby.reschedule(room.id, startsAt);
		void deps.discord?.sync(existing.id);
		const [moved] = await views([{ e: result.event, room: magicView(lobby.get(room.id)) ?? room }], me);
		res.json(moved);
	});

	api.delete('/events/:id', (req: Request, res: Response) => {
		const me = httpCaller(req);
		const result = events.cancel(String(req.params.id), me);
		if (!result.ok) return refuse(res, result.reason);
		void deps.discord?.cancel(result.event);
		const room = magicView(lobby.get(result.event.roomId));
		// A room people have started playing in outlives its event; one still waiting goes with it.
		if (room !== undefined && (room.game?.draftStartedAt ?? null) === null && room.tables.every((t) => t.matchId === null)) {
			const closed = lobby.close(room.id, me);
			if (closed.ok) deps.closed?.(room.id, closed.matches);
		}
		res.json({ ok: true });
	});
}
