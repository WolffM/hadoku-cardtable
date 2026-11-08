/*
 * Seeds a historical-tournament replay room from a `tournament.json` the
 * tournament import wrote beside its `.dck` files
 * (`packages/deck/src/library/build-tournament-library.ts`).
 *
 * Wired the same off-boot way the testing rooms are (`plugins/rooms.ts`):
 * CARDTABLE_REPLAY_TOURNAMENT names the repo-relative `tournament.json`,
 * CARDTABLE_REPLAY_COLLECTION its library collection id, and
 * CARDTABLE_REPLAY_SEAT (0-7) whose player YOU replay. Absent env: nothing
 * seeds, no cost is paid.
 *
 * Seats the TOP 8 of the event (its own standings, ranks 1-8): the caller in
 * CARDTABLE_REPLAY_SEAT, a Forge AI under every other seat, each AI replaying
 * the deck its real player played (`aiDeckAssignments`). The room is BORN
 * LOCKED (`historical`): classic constructed, the event's era, tournament on
 * with decks locked, and no control the server would refuse offered at all.
 *
 * ## Why a seed hook and not an HTTP route
 *
 * The same doctrine as `testing`/`scenario` (`CreateRoomInput`'s own docs):
 * a replay room is made by the operator's tooling, never by a client body —
 * there is no field a browser can send that sets one. Idempotent by name,
 * exactly as `seedTestingRooms` is: a re-run recreates only what is missing.
 *
 * ## Quarterfinal seat order
 *
 * `round1` pairs seat `i` with seat `i + half` (half = 4 of 8). The event's
 * four quarterfinals (in its own order) are laid onto those four pairs, so
 * the replay's round 1 IS the event's quarterfinals:
 *
 *   seat 0 vs seat 4  =  QF1    seat 1 vs seat 5  =  QF2
 *   seat 2 vs seat 6  =  QF3    seat 3 vs seat 7  =  QF4
 */

import { readFileSync } from 'node:fs';

import { LIBRARY } from '@hadoku/deck/library';

import type { Caller, Lobby } from './lobby.js';

/** The synthetic creator, the same rule as `TESTING_SEED_CALLER`: a `dev:` id no browser can present. */
const REPLAY_SEED_CALLER: Caller = { id: 'dev:replay-seed', name: 'Replay', userId: null };

interface TournamentRecord {
	readonly event: { readonly name: string; readonly date: string; readonly format: string };
	readonly pairings: readonly { readonly RoundName: string; readonly Matches: readonly { readonly Player1: string; readonly Player2: string }[] }[];
	readonly standings: readonly { readonly Rank: number; readonly Player: string }[];
}

/** The format-family prefix of a snapshot name, as `formatIdOf` spells an era id. */
function familyOf(formatName: string): string {
	if (formatName.startsWith('Legacy')) return 'legacy';
	if (formatName.startsWith('Modern')) return 'modern';
	return 'standard';
}

/** Tournament entry ids are `tourney-<date>-<rank>-<slug>` (`build-tournament-library.ts`). */
function slugifyForReplay(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Seed the replay room. `lobby` is the live lobby (the plugin holds it); the
 * human caller is a synthetic `dev:` id the seeded room's joiner replaces by
 * sitting — they arrive through the front door like anyone else, and the seed
 * leaves NO member in the room.
 */
export async function seedReplay(
	lobby: Pick<Lobby, 'create' | 'list' | 'join' | 'standPod' | 'aiPod' | 'leave'>,
	opts: { readonly tournament: string; readonly collection: string; readonly seat: number; readonly full?: boolean },
	log: (entry: Record<string, unknown>) => void = () => {},
): Promise<void> {
	const record = JSON.parse(readFileSync(opts.tournament, 'utf8')) as TournamentRecord;
	const standings = [...record.standings].sort((a, b) => a.Rank - b.Rank);
	const top8 = standings.filter((s) => s.Rank <= 8);
	const field = opts.full === true ? standings : top8;
	if (field.length < 2) throw new Error(`field holds ${String(field.length)} entrants`);
	if (top8.length !== 8) throw new Error(`top 8 holds ${String(top8.length)} entrants, not 8`);
	if (!Number.isInteger(opts.seat) || opts.seat < 0 || opts.seat >= field.length) throw new Error(`seat is 0-${String(field.length - 1)}`);

	// Idempotent by name, the same rule as the testing rooms: a warm hook that
	// runs twice recreates nothing.
	const name = `${record.event.name} — Top 8 Replay`;
	if (lobby.list().some((r) => r.name === name)) {
		log({ event: 'replay-room-present', name });
		return;
	}

	// Whose deck each seat replays. The top-8 replay lays the event's own
	// quarterfinals onto round 1's across-the-table pairs; a full field seats
	// every entrant at their final standing's rank, and the structure — Swiss
	// then cut — decides who meets whom.
	const seatPlayers: string[] =
		opts.full === true
			? field.map((s) => s.Player)
			: (() => {
					const qf = record.pairings.find((r) => r.RoundName.toLowerCase().includes('quarter'));
					const qfPairs: readonly (readonly [string, string])[] =
						qf === undefined
							? top8.slice(0, 4).map((a, i): [string, string] => [a.Player, top8[i + 4]!.Player])
							: qf.Matches.map((m): [string, string] => [m.Player1, m.Player2]);
					if (qfPairs.length !== 4) throw new Error(`quarterfinals hold ${String(qfPairs.length)} matches, not 4`);
					const seats = new Array<string>(8).fill('');
					for (const [k, [a, b]] of qfPairs.entries()) {
						seats[k] = a;
						seats[k + 4] = b;
					}
					return seats;
				})();

	// Each AI seat's deck: the library deck of the player it replays. The join
	// is the player's OWN SLUG — never the id's whole shape, which the importer
	// has already spelled two ways (`tourney-<date>-…` for the Modern import,
	// `tourney-leg-…` for the Legacy one). An entry id is
	// `<prefix>-<rank>-<slug>`: the rank a pure integer, the slug everything
	// after it — and a slug may itself contain hyphens and digits
	// (Magic_Dads71522 → magic-dads71522), so the regex matches structurally
	// rather than by counting segments.
	const collection = LIBRARY.find((c) => c.id === opts.collection);
	if (collection === undefined) throw new Error(`no library collection ${opts.collection}`);
	const ENTRY_ID = /^(?:[a-z0-9]+-)+(\d+)-(.+)$/;
	const bySlug = new Map(collection.decks.map((d) => [ENTRY_ID.exec(d.id)?.[2] ?? '', d]));
	if (bySlug.size !== collection.decks.length) throw new Error(`${opts.collection}: entry id slugs collide`);
	const assignments: Record<string, string> = {};
	for (const [s, player] of seatPlayers.entries()) {
		if (s === opts.seat) continue;
		const deck = bySlug.get(slugifyForReplay(player));
		if (deck === undefined) throw new Error(`${player} has no library deck in ${opts.collection}`);
		assignments[`ai:${String(s)}`] = deck.id;
	}

	const created = lobby.create(REPLAY_SEED_CALLER, {
		name,
		gameType: 'constructed-1v1',
		clientMode: 'builtin',
		historical: true,
		historicalFormat: `${familyOf(record.event.format)}-${record.event.date}`,
		aiDeckAssignments: assignments,
		// The top-8 replay is a pure bracket (no Swiss inside it — the seats ARE
		// the bracket); a full field plays the event's own Swiss rounds and
		// cuts to its top 8, the shape a Challenge is actually run in.
		historicalStructure: opts.full === true ? { swiss: 5, cut: 8 } : { swiss: 0, cut: 8 },
	});
	if (!created.ok) throw new Error(`create refused: ${created.reason}`);
	// Seat every AI entrant now, through the same `aiPod` the AI button drives,
	// so the room arrives with its field complete: the joiner takes their own
	// seat, readies, and the tournament locks with the real eight. The seed
	// caller joins for this (aiPod is member-gated) and leaves again — a room
	// nobody is in, holding seven AIs and one open seat.
	lobby.join(created.room.id, REPLAY_SEED_CALLER);
	// `join` auto-seats the creator into the first open pod seat (`seat-auto`),
	// which may be the seat an AI needs: give it back before seating the field.
	lobby.standPod(created.room.id, REPLAY_SEED_CALLER.id);
	for (const s of seatPlayers.keys()) {
		if (s === opts.seat) continue;
		const ai = lobby.aiPod(created.room.id, REPLAY_SEED_CALLER.id, s, true);
		if (!ai.ok) throw new Error(`ai seat ${String(s)} refused: ${ai.reason}`);
	}
	lobby.leave(created.room.id, REPLAY_SEED_CALLER.id);
	log({ event: 'replay-room-seeded', roomId: created.room.id, name, seat: opts.seat, human: seatPlayers[opts.seat] });
}
