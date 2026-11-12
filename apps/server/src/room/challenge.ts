/*
 * Challenge rooms: a real MTGO Challenge, replayed. A library collection that is a tournament
 * import (`packages/deck/src/library/build-tournament-library.ts`: one `.dck` per player and the
 * event's own `tournament.json`) becomes a room whose field is that event's: an AI in every seat
 * playing the list its real player played, and one seat left open for the person replaying it.
 *
 * Two fields. The top 8 is a pure bracket whose round 1 IS the event's quarterfinals: `round1`
 * pairs seat `i` with seat `i + 4`, so the event's four quarterfinals are laid onto those pairs,
 * in the event's own order. The full field seats every entrant at their final standing and plays
 * the event's shape, Swiss then a top-8 cut.
 *
 * The room is born whole (`CreateRoomInput.historical` and `historicalField`): its era, its mode,
 * its settings and every AI seat are set by `lobby.create` itself, and nothing about the field
 * can be changed afterwards. A member makes one through `POST /api/rooms/challenge` (`http/rooms.ts`);
 * the operator can keep one standing with `CARDTABLE_CHALLENGE_COLLECTION` (`plugins/rooms.ts`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIBRARY, type LibraryCollection } from '@hadoku/deck/library';
import type { ChallengeEvent, ChallengeField } from '@hadoku/shared';

import type { Caller, Lobby, RoomView } from './lobby.js';

/** What `tournament.json` holds that a Challenge room reads. */
interface TournamentRecord {
	readonly event: { readonly name: string; readonly date: string; readonly format: string };
	readonly pairings: readonly { readonly RoundName: string; readonly Matches: readonly { readonly Player1: string; readonly Player2: string }[] }[];
	readonly standings: readonly { readonly Rank: number; readonly Player: string }[];
}

/** The event's top 8 is the bracket a Challenge cuts to. */
const CUT = 8;

/** A tournament import's deck id ends `<date>-<rank>-<player slug>`; the rank is the standings' own. */
const DECK_RANK = /-\d{4}-\d{2}-\d{2}-(\d+)-[^-].*$/;

/** The synthetic creator of a Challenge the operator keeps standing: a `dev:` id no browser can present. */
const STANDING_CREATOR: Caller = { id: 'dev:challenge-seed', name: 'Challenge', userId: null };

export type ChallengeRefusal = 'no-challenge' | 'no-player' | 'not-durable';

export interface Challenges {
	/** Every catalogued Challenge, newest first. */
	list(): ChallengeEvent[];
	/** A new Challenge room for `caller`, who sits in `player`'s seat; the caller leads it. */
	create(caller: Caller, opts: { collection: string; player: string; field: ChallengeField }): { ok: true; room: RoomView } | { ok: false; reason: ChallengeRefusal };
}

interface Loaded {
	readonly collection: LibraryCollection;
	readonly record: TournamentRecord;
	/** Standings rank → that player's library deck id. */
	readonly deckOfRank: ReadonlyMap<number, string>;
}

/** The catalogued Challenges under `repoRoot`, each `tournament.json` read once, on first use. */
export function challenges(lobby: Pick<Lobby, 'create'>, repoRoot: string): Challenges {
	let held: Map<string, Loaded> | null = null;
	const catalogue = (): Map<string, Loaded> => (held ??= load(repoRoot));
	return {
		list: () =>
			[...catalogue().values()]
				.map(({ collection, record, deckOfRank }) => ({
					collection: collection.id,
					name: record.event.name,
					date: record.event.date,
					format: record.event.format,
					standings: [...record.standings].sort((a, b) => a.Rank - b.Rank).map((s) => ({ rank: s.Rank, player: s.Player, deckId: deckOfRank.get(s.Rank)! })),
				}))
				.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name)),
		create(caller, opts) {
			const event = catalogue().get(opts.collection);
			if (event === undefined) return { ok: false, reason: 'no-challenge' };
			const seats = seatOrder(event.record, opts.field);
			const mine = seats.indexOf(opts.player);
			if (mine === -1) return { ok: false, reason: 'no-player' };
			const created = lobby.create(caller, roomInput(event, seats, mine, opts.field));
			return created.ok ? { ok: true, room: created.room } : { ok: false, reason: created.reason };
		},
	};
}

function load(repoRoot: string): Map<string, Loaded> {
	const loaded = new Map<string, Loaded>();
	for (const collection of LIBRARY) {
		if (!collection.id.startsWith('tournament-')) continue;
		const record = JSON.parse(readFileSync(join(repoRoot, collection.directory, 'tournament.json'), 'utf8')) as TournamentRecord;
		const deckOfRank = new Map<number, string>();
		for (const deck of collection.decks) {
			const rank = DECK_RANK.exec(deck.id)?.[1];
			if (rank === undefined) throw new Error(`${collection.id}: ${deck.id} names no standings rank`);
			deckOfRank.set(Number(rank), deck.id);
		}
		for (const row of record.standings) {
			if (!deckOfRank.has(row.Rank)) throw new Error(`${collection.id}: rank ${String(row.Rank)} (${row.Player}) has no deck`);
		}
		loaded.set(collection.id, { collection, record, deckOfRank });
	}
	return loaded;
}

/**
 * The room the operator keeps standing (`CARDTABLE_CHALLENGE_COLLECTION`): made by a synthetic
 * creator who leaves it at once, so the open seat waits for whoever comes in. Idempotent by name,
 * as the testing rooms are: a warm hook that runs twice makes nothing new.
 */
export function seedStandingChallenge(
	lobby: Pick<Lobby, 'create' | 'list' | 'standPod' | 'leave'>,
	list: Challenges,
	opts: { collection: string; player: string; field: ChallengeField },
	log: (entry: Record<string, unknown>) => void = () => {},
): void {
	const event = list.list().find((e) => e.collection === opts.collection);
	if (event === undefined) throw new Error(`no Challenge ${opts.collection}`);
	const name = challengeRoomName(event, opts.field);
	if (lobby.list().some((r) => r.name === name)) return;
	const made = list.create(STANDING_CREATOR, opts);
	if (!made.ok) throw new Error(`Challenge ${opts.collection} refused: ${made.reason}`);
	// Stand first: a member who leaves keeps their seat for their return, and this one never returns.
	lobby.standPod(made.room.id, STANDING_CREATOR.id);
	lobby.leave(made.room.id, STANDING_CREATOR.id);
	log({ event: 'challenge-room-seeded', roomId: made.room.id, name, player: opts.player });
}

export function challengeRoomName(event: Pick<ChallengeEvent, 'name' | 'date'>, field: ChallengeField): string {
	return `${event.name}${field === 'top8' ? ' Top 8' : ''}, ${event.date}`;
}

/** Who sits where, by player name: the top 8 laid out so round 1 is the event's quarterfinals; the full field by final standing. */
function seatOrder(record: TournamentRecord, field: ChallengeField): string[] {
	const standings = [...record.standings].sort((a, b) => a.Rank - b.Rank);
	if (field === 'full') return standings.map((s) => s.Player);
	const top = standings.slice(0, CUT);
	const quarters = record.pairings.find((r) => r.RoundName.toLowerCase().startsWith('quarter'))?.Matches;
	const pairs = quarters?.length === CUT / 2 ? quarters.map((m) => [m.Player1, m.Player2] as const) : top.slice(0, CUT / 2).map((a, i) => [a.Player, top[CUT - 1 - i]!.Player] as const);
	const seats = new Array<string>(CUT);
	for (const [k, [a, b]] of pairs.entries()) {
		seats[k] = a;
		seats[k + CUT / 2] = b;
	}
	return seats;
}

function roomInput(event: Loaded, seats: readonly string[], mine: number, field: ChallengeField): Parameters<Lobby['create']>[1] {
	const rankOf = new Map(event.record.standings.map((s) => [s.Player, s.Rank]));
	const deckOf = (player: string): string => event.deckOfRank.get(rankOf.get(player)!)!;
	const aiDeckAssignments: Record<string, string> = {};
	for (const [seat, player] of seats.entries()) {
		if (seat !== mine) aiDeckAssignments[`ai:${String(seat)}`] = deckOf(player);
	}
	return {
		name: challengeRoomName(event.record.event, field),
		gameType: 'constructed-1v1',
		clientMode: 'builtin',
		historical: true,
		// Standard-family era ids are the BARE date (`formatIdOf`); only Modern and
		// Legacy prefix. A block format (ALICE) freezes under Standard's date-keyed
		// fixture name, so its era id is the unprefixed date too.
		historicalFormat: familyOf(event.record.event.format) === 'standard' ? event.record.event.date : `${familyOf(event.record.event.format)}-${event.record.event.date}`,
		historicalField: seats.length,
		// A Challenge plays the Swiss rounds its field needs to find one undefeated player, then cuts.
		historicalStructure: field === 'full' ? { swiss: Math.ceil(Math.log2(seats.length)), cut: CUT } : { swiss: 0, cut: CUT },
		aiDeckAssignments,
		// The person in the open seat plays as its player, list and all.
		seatDecks: { [String(mine)]: deckOf(seats[mine]!) },
	};
}

/** The era family of a format name, as an era id spells it (`legacy-2026-02-07`). */
function familyOf(format: string): string {
	if (format.startsWith('Legacy')) return 'legacy';
	if (format.startsWith('Modern')) return 'modern';
	// A block format (ALICE — Ice Age + Alliances) freezes under the Standard
	// family's date-keyed fixture name (`standard-<date>`), the pool its own
	// collection carries. It is not a Standard snapshot; the era id is just
	// where the fixture lives.
	if (format.startsWith('ALICE')) return 'standard';
	throw new Error(`a Challenge in ${format} has no era family`);
}
