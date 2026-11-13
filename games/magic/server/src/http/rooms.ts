/**
 * `/api/rooms`'s MAGIC surface: Challenge rooms (the catalogued real events),
 * a draft pod's own lobby (`/pod/*`), starting a draft (`/start`), and the
 * `format`/`settings`/`mode` arms of `PATCH /:id` — everything about `/api/rooms`
 * that is Magic's own, never another game's. The generic routes (list, create,
 * join, ready, leave, close, reset, watchparty, of-match, and `PATCH { gameType
 * }`) are `http/room-core.ts`'s, mounted first by `attachRooms` below, on the
 * SAME router this file then adds its own routes to — same "mount order is
 * load-bearing" pattern `http/routes.ts`'s header documents for `attachTables`
 * before `attachPlay`.
 *
 *   GET   /api/rooms/challenges            → 200 { challenges: Challenge[] }
 *   POST  /api/rooms/challenge             { collection, player } → 201 RoomBody | 400 | 403
 *   POST  /api/rooms/:id/start             {} or no body         → 200 RoomBody | 404 | 409
 *   POST  /api/rooms/:id/pod/split         {} or no body         → 200 RoomBody | 404 | 409
 *   POST  /api/rooms/:id/pod/sit           {} or { seat }        → 200 RoomBody | 404 | 409
 *   POST  /api/rooms/:id/pod/stand         {} or no body         → 200 RoomBody | 404 | 409
 *   POST  /api/rooms/:id/pod/ai            { seat, on }          → 200 RoomBody | 404 | 409
 *   POST  /api/rooms/:id/pod/close         { seat, closed }      → 200 RoomBody | 403 | 404 | 409
 *   POST  /api/rooms/:id/pod/play          {} or no body         → 200 RoomBody | 403 | 404 | 409
 *   PUT   /api/rooms/:id/pod/plan          { plan }               → 200 RoomBody | 400 | 403 | 404 | 409 { verdict }
 *   PATCH /api/rooms/:id { format } | { settings } | { mode, modeOptions? } → 200 RoomBody | 403 | 404 | 409
 *
 * `format` is a frozen era's id or Free pick — never `draft:<podId>`. A drafted
 * deck is played on Free pick ("My decks"); a pod's own tables play its pool by
 * being a `draft` room (`http/routes.ts`'s `effectivePoolOf`), not by a format.
 *
 * ## `ready` and `start` are the room's own, not the table's
 *
 * `/api/tables/rooms/:id/ready` (`http/routes.ts`) is the CONSTRUCTED table's
 * ready: it means "my deck is loaded and legal" and is refused without a deck.
 * `room-core.ts`'s `/:id/ready` is the ROOM's, it needs no deck, and it is what
 * a draft starts on. A draft room never touches the tables API at all.
 *
 * `start` (below) may be called by any member, not only the leader — like
 * constructed, where either browser asks and the server answers one start to
 * both — and it is idempotent, so two browsers racing is one draft. A PATCH of
 * the game type is refused with 409 once a draft is running: the pod is dealt
 * against this room's id and is already being played.
 *
 * ## Ephemeral callers can look but not create or join
 *
 * A caller the edge did not name gets an `eph:` identity minted per request, so
 * they could never be recognised as the same member twice. `create` (challenge
 * among them) and `join` answer 403 for them. Behind the edge every friend has
 * a friend key, so this is a dev/direct-hit case, not a production one.
 */

import { Router, type Request, type Response } from 'express';
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import { callerOf, parseBody } from '@hadoku/game-server/http/request';
import {
	ChallengeCreateBodySchema,
	CreateRoomBodySchema,
	EmptyBodySchema,
	JoinRoomBodySchema,
	PatchRoomBodySchema,
	PodAiBodySchema,
	PodCloseBodySchema,
	POD_SEATS,
	ReadyBodySchema,
	ROOM_ID_RE,
	SetDraftPlanBodySchema,
	SitBodySchema,
	WatchpartyBindBodySchema,
	type CreateRoomBody,
	type DraftCard,
	type DraftPlan,
	type PatchRoomBody,
	type PoolVerdict,
	type TableGame,
} from '@hadoku/shared';
import { POD_MIN_OPEN, SEATS_SHUT } from '../room/pods.js';
import type { Challenges } from '../room/challenge.js';
import type { DraftRooms } from '../room/draftRooms.js';
import type { Lobby, RoomView } from '../room/lobby.js';
import {
	attachRoomCore,
	badRequest,
	bodyErrors,
	noMatch,
	notDurable,
	JOIN_RATE_LIMIT,
	ROOM_CREATE_RATE_LIMIT,
	NO_MATCH,
	type RoomCoreDeps,
	type RoomBody,
} from '@hadoku/game-server/http/room-core';

export { JOIN_RATE_LIMIT, ROOM_CREATE_RATE_LIMIT, NO_MATCH };
export type { RoomBody };

/**
 * The public deps `plugins/routes.ts` passes — `wire` (the schemas `room-core.ts`
 * needs but may not import) is NOT part of it: `attachRooms` builds that itself,
 * below, from the real `@hadoku/shared` schemas, so the one real call site needs
 * no edit for this wave's split. `lobby` is re-declared at its real, fuller type
 * (`room-core.ts`'s own `LobbyCore<RoomView, CreateRoomBody>` is the narrower
 * structural slice `attachRoomCore` itself calls through).
 */
export interface RoomsDeps extends Omit<RoomCoreDeps<RoomView, CreateRoomBody, PatchRoomBody, TableGame>, 'wire' | 'lobby'> {
	lobby: Lobby;
	/** The catalogued Challenges (`room/challenge.ts`). Absent (a unit suite) offers none. */
	challenges?: Challenges;
	/**
	 * The verdict for a plan (`room/plan.ts`'s `checkPlan`, bound to the
	 * server's cube lookup and Forge checker) — `PUT …/pod/plan` runs this
	 * BEFORE calling `lobby.setPodPlan`, since computing it is the one thing in
	 * this request that needs async I/O. `index.ts` wires the real deps (the
	 * interim shortlist `CubeLookup` and a `null` `ForgeChecker` for steps 1-5;
	 * C's `createCubeStore` and D's `createForgePools` at step 6).
	 */
	checkPlan: (plan: DraftPlan) => Promise<PoolVerdict>;
	/**
	 * Wave 74 §E step 2: a realistic round's boosters are fetched HERE, before
	 * `lobby.startDraft` — never inside `draftRooms.open()`, which stays
	 * synchronous ("realistic boosters are fetched before `deal` and passed
	 * in"). `forge: null` (no jar) refuses `/start` for a plan with any
	 * realistic round, named, the same "never a pass by default" rule
	 * `room/plan.ts`'s verdict already holds — everything else about `/start`
	 * is unchanged. Every test that never plans a realistic round (everything
	 * before this wave) can omit this whole block; `attachRooms` then refuses
	 * `/start` for one instead of silently mis-dealing it.
	 */
	realistic?: {
		forge: RealisticBoosterSource | null;
		catalog: RealisticCatalog;
		draftRooms: Pick<DraftRooms, 'cacheRealisticRound'>;
	};
}

/** The slice of D's `ForgePools` this file needs for one round's boosters — structural, like `room/plan.ts`'s own `ForgeChecker`. */
export interface RealisticBoosterSource {
	boosters(code: string, count: number, seed: string): Promise<{ name: string; set: string; collectorNumber: string; foil?: boolean }[][]>;
}

/** The slice of G's `CardCatalog` this file needs — both always present (`pools/catalog.ts`'s own `CardCatalog`), `byPrinting` tried first. */
export interface RealisticCatalog {
	byName(name: string): DraftCard | null;
	byPrinting(set: string, collectorNumber: string): DraftCard | null;
}

/**
 * One booster card, mapped to a `DraftCard` through the catalog — the set's
 * own printing when `byPrinting` knows it (it misses until the catalog's
 * first rebuild with a `printings` section — `pools/catalog.ts`'s own doc),
 * `byName` otherwise. A name neither resolves is the honest `missingText`
 * stand-in: `checkSource` should have refused this source before a leader
 * ever reached `/start` with it, so this is a defensive fallback, not the
 * expected path.
 *
 * `card.foil` rides along onto the result (never onto the catalog's own cached
 * object — a fresh copy, since the same catalog card backs every non-foil
 * copy dealt across the whole pod). Absent/false stays absent on the
 * `DraftCard`, matching `DraftCardSchema.foil`'s "absent means not foil".
 */
export function resolveBoosterCard(catalog: RealisticCatalog, card: { name: string; set: string; collectorNumber: string; foil?: boolean }): DraftCard {
	const resolved =
		catalog.byPrinting(card.set, card.collectorNumber) ??
		catalog.byName(card.name) ??
		({
			cardId: `${card.set}-${card.collectorNumber}-${card.name}`,
			name: card.name,
			manaCost: [],
			manaValue: 0,
			colors: [],
			typeLine: '',
			oracleText: '',
			setCode: card.set,
			collectorNumber: card.collectorNumber,
			rarity: 'special',
		} satisfies DraftCard);
	return card.foil === true ? { ...resolved, foil: true } : resolved;
}

/** `PatchRoomBody` minus the `{ gameType }` arm `room-core.ts` already answers itself — `onPatch`'s own body. */
type MagicRoomPatch = Exclude<PatchRoomBody, { gameType: unknown }>;

export function attachRooms(api: Router, deps: RoomsDeps): void {
	const { lobby } = deps;
	// The real schemas, injected into `room-core.ts`'s generic `wire` — it may not
	// import `@hadoku/shared` itself (the ratchet resolves the whole package, even
	// through `/platform`, as one — this file is Magic and imports it freely).
	const wire = {
		roomIdRe: ROOM_ID_RE,
		createRoomBody: CreateRoomBodySchema,
		joinRoomBody: JoinRoomBodySchema,
		readyBody: ReadyBodySchema,
		emptyBody: EmptyBodySchema,
		watchpartyBindBody: WatchpartyBindBodySchema,
		patchRoomBody: PatchRoomBodySchema,
	};

	/**
	 * `{ format }`/`{ settings }`/`{ mode }` — the one PATCH registration's
	 * Magic arm, called by `room-core.ts`'s own `PATCH /:id` (never a second
	 * route: `route-table.json`, the frozen-route guard, admits each
	 * method+path once). `core.roomBody` is referenced before `core` exists
	 * below — safe, since `onPatch` only ever runs on a later request, by
	 * which time `attachRoomCore` has returned.
	 */
	function onPatch(req: Request, res: Response, body: MagicRoomPatch, caller: ReturnType<typeof callerOf>, id: string): void {
		const me = caller.id;
		const what = 'format' in body ? 'format' : 'settings' in body ? 'settings' : 'mode';
		const result = 'format' in body ? lobby.setFormat(id, me, body.format) : 'settings' in body ? lobby.setSettings(id, me, body.settings) : lobby.setMode(id, me, body.mode);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			if (result.reason === 'draft-started') {
				res.status(409).json({ error: `this room is drafting; the ${what} cannot change now` });
				return;
			}
			if (result.reason === 'not-constructed') {
				res.status(409).json({ error: 'only a constructed room has a mode', reason: result.reason });
				return;
			}
			if (result.reason === 'mode-locked') {
				res.status(409).json({ error: `a game is under way or a seated player is ready; the ${what} cannot change now`, reason: result.reason });
				return;
			}
			res.status(403).json({ error: `only the room leader can change the ${what}` });
			return;
		}
		res.json(core.roomBody(result.room, me));
	}

	// `/challenges` registers through `beforeWildcard`, BEFORE `room-core.ts`'s own
	// `GET /:id` — a bare `:id` would otherwise swallow it (see that file's header).
	// This is the SAME router `room-core.ts` built (and already ran its own
	// `.param('id', …)` guard on), not a second one at the same prefix.
	const core = attachRoomCore(api, { ...deps, wire }, {
		beforeWildcard: (router) => {
			// Challenge rooms (`room/challenge.ts`): the catalogued real events, and a room
			// replaying one with the caller in the seat of the player they chose.
			router.get('/challenges', (_req: Request, res: Response) => {
				res.json({ challenges: deps.challenges?.list() ?? [] });
			});
		},
		onPatch,
	});
	const { router: rooms, roomBody, createLimit } = core;

	// A new room each time, counted as any room made is (`createLimit` — the SAME
	// limiter `POST /` spends from, not a second budget). Order-safe after `GET
	// /:id`: a POST with no second path segment never collides with it.
	rooms.post('/challenge', (req: Request, res: Response) => {
		const body = parseBody(ChallengeCreateBodySchema, req, res);
		if (body === null) return;
		if (deps.challenges === undefined) return res.status(404).json({ error: 'this server has no Challenges' });
		if (!createLimit(req, res)) return;
		const caller = callerOf(req);
		const made = deps.challenges.create(caller, body);
		if (made.ok) {
			deps.arrived?.(made.room.id, caller);
			return res.status(201).json(roomBody(made.room, caller.id));
		}
		if (made.reason === 'not-durable') return notDurable(res);
		res.status(400).json({ error: made.reason === 'no-challenge' ? `no Challenge ${body.collection}` : `${body.player} did not play in that field` });
	});

	rooms.post('/:id/start', async (req: Request, res: Response) => {
		if (parseBody(EmptyBodySchema, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);

		// Wave 74 §E step 2: a realistic round's boosters are fetched and
		// cached BEFORE `lobby.startDraft` ever runs — `draftRooms.open()` (the
		// FIRST socket `join`'s own call, not this route's) reads them back
		// synchronously. Only while the pod is still in its lobby: a second
		// `/start` from the other browser (idempotent, by design — see this
		// file's header) must not re-fetch, and a room that is already
		// drafting or done has nothing left to pre-fetch for anyway.
		const room = lobby.get(id);
		// A constructed tournament's pod also reaches `lobby`, but drafts no
		// pool (`PodView.plan` is `null` there) — nothing here is its business.
		const plan = room?.gameType === 'draft' ? (room.game?.pod?.plan ?? null) : null;
		if (room?.game?.pod?.phase === 'lobby' && plan !== null) {
			const realisticRounds: number[] = [];
			plan.rounds.forEach((src, round) => {
				if (src.kind === 'set' && src.style === 'realistic') realisticRounds.push(round);
			});
			if (realisticRounds.length > 0) {
				if (deps.realistic === undefined || deps.realistic.forge === null) {
					return res.status(409).json({ error: 'the pool service is not available to deal a realistic round — try again once it is up' });
				}
				const { forge, catalog, draftRooms } = deps.realistic;
				const pod = lobby.podDraft(id);
				const seatCount = pod?.seats ?? POD_SEATS;
				try {
					for (const round of realisticRounds) {
						const src = plan.rounds[round];
						if (src === undefined || src.kind !== 'set') continue;
						const boosters = await forge.boosters(src.code, seatCount, `${id}:${round}`);
						const packs = boosters.map((pack) => pack.map((c) => resolveBoosterCard(catalog, c)));
						draftRooms.cacheRealisticRound(id, round, packs);
					}
				} catch (err) {
					return res.status(409).json({ error: `could not deal the realistic round(s): ${(err as Error).message}` });
				}
			}
		}

		const result = lobby.startDraft(id, caller.id);
		if (!result.ok) {
			// `not-member` is deliberately the same answer as `no-room`.
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			// A sentence, because the room screen shows it to whoever clicked.
			return res.status(409).json({
				error:
					result.reason === 'not-draft'
						? 'this room is not playing a draft'
						: result.reason === 'plan-not-ready'
							? 'the draft pool is still being checked, or was refused — pick a different one, or wait'
							: result.reason === 'not-split'
								? 'a room of more than 8 drafts once the leader has split it into pods'
								: result.reason === 'not-leader'
									? 'only the room owner starts the draft of a split room'
									: result.reason === 'not-open'
										? SEATS_SHUT
										: 'every seat needs a player or the AI, and every player ready, before the draft starts',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * Split & randomize (`lobby.splitPod`): the leader of a ready draft room of more than 8 splits its drafters
	 * into random pods, which fixes every seat until the leader's own `/start`. No body. Idempotent while the
	 * split stands.
	 */
	rooms.post('/:id/pod/split', (req: Request, res: Response) => {
		if (parseBody(EmptyBodySchema, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.splitPod(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			const error =
				result.reason === 'not-leader'
					? 'only the room owner splits the pods'
					: result.reason === 'not-draft'
						? 'this room is not drafting from its lobby'
						: result.reason === 'one-pod'
							? 'a room of 8 or fewer drafts as one pod'
							: result.reason === 'plan-not-ready'
								? 'the draft pool is still being checked, or was refused — pick a different one, or wait'
								: 'every seat needs a player or the AI, and every player ready, before the split';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * Take a pod seat (wave 72 §P), lobby phase only. `seat` absent takes the
	 * first free one. Leader and non-leader alike — the pod lobby reuses the
	 * 1v1 table's own seat UI, and sitting is not a leader act there either.
	 */
	rooms.post('/:id/pod/sit', (req: Request, res: Response) => {
		const body = parseBody(SitBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.sitSeat(id, caller.id, body.seat);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'seats are fixed once the room is split or its draft has started'
						: result.reason === 'not-open'
							? SEATS_SHUT
							: result.reason === 'bad-seat'
								? 'that seat is past the last one'
								: result.reason === 'seat-taken'
									? 'that seat is already taken'
									: 'the pod is full';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/** Give up a pod seat, lobby phase only. Idempotent: not seated answers `ok` and changes nothing. */
	rooms.post('/:id/pod/stand', (req: Request, res: Response) => {
		if (parseBody(EmptyBodySchema, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.standSeat(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			return res.status(409).json({
				error: result.reason === 'not-draft' ? 'this room does not have a pod' : 'seats are fixed once the room is split or its draft has started',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * The AI button on an open pod seat (`{ seat, on: true }`), or taking it
	 * back out (`on: false`), lobby phase only, any member. The draft deals
	 * only once no seat is open (`room/lobby.ts`'s `startDraft`).
	 */
	rooms.post('/:id/pod/ai', (req: Request, res: Response) => {
		const body = parseBody(PodAiBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.aiSeat(id, caller.id, body.seat, body.on);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'seats are fixed once the room is split or its draft has started'
						: result.reason === 'not-open'
							? SEATS_SHUT
							: 'that seat is already taken';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/** Close an empty pod seat, or open a closed one: the owner's, before the draft (`Lobby.closeSeat`). */
	rooms.post('/:id/pod/close', (req: Request, res: Response) => {
		const body = parseBody(PodCloseBodySchema, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.closeSeat(id, caller.id, body.seat, body.closed);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			if (result.reason === 'not-leader') return res.status(403).json({ error: 'only the room owner closes seats' });
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'seats are fixed once the room is split or its draft has started'
						: result.reason === 'too-few'
							? `a pod keeps at least ${POD_MIN_OPEN} seats`
							: 'that seat is taken';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * Done building — the deck editor's Play. Refused until the caller's deck
	 * is saved and legal; the last drafter's press deals round 1
	 * (`room/lobby.ts`'s `playPod`).
	 */
	rooms.post('/:id/pod/play', (req: Request, res: Response) => {
		if (parseBody(EmptyBodySchema, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.playPod(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			if (result.reason === 'not-drafter') return res.status(403).json({ error: 'you did not draft in this pod' });
			return res.status(409).json({ error: 'your deck is not saved and legal yet' });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * The leader's pool choice (wave 73 §A; wave 74 §E adds `kind: 'set'`),
	 * lobby phase only — the wire contract's own words: "it runs the verdict
	 * first. Refused: 409 { verdict }, and the plan is unchanged. Accepted:
	 * 200, and the plan is broadcast on the room like any pod change." Every
	 * source — cube or set, either style — goes to `checkPlan` BEFORE
	 * `lobby.setPodPlan` ever sees it, since that is this request's one piece
	 * of async I/O (`room/plan.ts`'s `checkSource`/`checkPlan`).
	 */
	rooms.put('/:id/pod/plan', async (req: Request, res: Response) => {
		const parsed = SetDraftPlanBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, 'body is { plan: { rounds: [source, source, source] } }');
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);

		const verdict = await deps.checkPlan(parsed.data.plan);
		const result = lobby.setPodPlan(id, caller.id, parsed.data.plan, verdict);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			if (result.reason === 'not-leader') return res.status(403).json({ error: 'only the room owner sets the draft pool' });
			if (result.reason === 'refused') return res.status(409).json({ verdict: result.verdict });
			return res.status(409).json({
				error: result.reason === 'not-draft' ? 'this room does not have a pod' : 'the pod has already started — the pool is fixed',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	api.use('/rooms', bodyErrors((name) => (deps.log ?? (() => {}))({ event: 'rooms-error', name })));
}
