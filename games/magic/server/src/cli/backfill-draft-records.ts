/**
 * One-time backfill of the draft record (wave 127): every finished draft the drafts dir still
 * holds becomes a `backfilled: true` record in `<stateDir>/history/drafts.jsonl`, the record the
 * server writes for itself from now on (`history/index.ts`).
 *
 * A pod's file keeps its cards but not, before `roundSources`, what they were dealt from. So each
 * pack round's source is decided, in this order:
 *
 * 1. `roundSources`: the draft says itself.
 * 2. The room's plan, while the room is still in the rooms dir.
 * 3. The card-id prefix: an imported cube's cards are `<cubeId>-<n>` (`cc-2plnt-398#0:0:11`).
 * 4. Name overlap: the round's card names against every cube list (the shortlist and the imports)
 *    and every set's names in the Scryfall corpus. Decided only when exactly one list holds at
 *    least 90% of them. A set's style is read off its rarity mix, since a realistic booster holds
 *    one rare or mythic and a set-cube deals a set's whole list evenly.
 *
 * A round's cards are the ones dealt in it: a dealt card's id ends `#<round>:<seat>:<i>`. A
 * finished pod's pools hold every card its rounds dealt.
 *
 * Anything else is `undecided`, with why, and is not written. A draft still `drafting` is not
 * finished and is never written. Who sat where comes from the draft file; a person's userId is
 * found by matching their seat's participant id against every account this state dir names (its
 * per-person store, its rooms, its tournaments), and is null otherwise. Its `eventId` is the pod
 * tournament `tournaments.json` keeps for the room (`<roomId>-<draftStartedAt>`), as a live record's is. A record's `startedAt` is
 * the pod's deal; its `endedAt` the file's last write, the nearest the file keeps to its last pick.
 *
 * Nothing is written without `--write`; without it the run prints one line per draft file and the
 * totals. `--write` appends the decided records, skipping any draftId the record already holds.
 * The running server reads the record when it starts, so restart it after a write for the counts
 * to show them; an erase or merge it runs meanwhile reads the file again and keeps them.
 *
 *   tsx games/magic/server/src/cli/backfill-draft-records.ts (--site prod|ppe | --state-dir <dir>)
 *       [--shortlist <dir>] [--scryfall <dir>] [--write]
 *
 * `--site` reads `$CARDTABLE_STATE_ROOT` (default `~/srv-data`), the root hadoku_site's PM2 wrapper
 * gives each site.
 */

import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { DraftState } from '@hadoku/draft';
import type { DraftCard, PoolSource } from '@hadoku/shared';
import { corpusDir } from '@hadoku/carddata/corpus-dir';
import { fkOf } from '@hadoku/game-server/erase/index';
import { SHORTLIST_DIR } from '../root.js';
import { podOfDraftId } from '../room/pods.js';
import { createDraftRecordStore, cubeOrigin, draftRecordOf, draftSourceOf, poolSourceOfKey, type DraftRecord, type DraftSource } from '../history/drafts.js';

const SITES = { prod: 'cardtable', ppe: 'cardtable-ppe' } as const;

/** The share of a round's names one list must hold to decide it. */
export const OVERLAP_MIN = 0.9;
/** A round whose rares and mythics are at most this share of its cards is realistic boosters. */
const REALISTIC_RARE_MAX = 0.15;
/** At least this share, a set-cube. Between the two, undecided. */
const SET_CUBE_RARE_MIN = 0.2;

/** A list a round may have been dealt from: a cube, or a set's names. */
export type SourceList = { kind: 'cube'; id: string; name: string; names: ReadonlySet<string> } | { kind: 'set'; code: string; names: ReadonlySet<string> };

/** A draft file as `draftRooms.ts` persists a pod: what this reads of it. */
export interface DraftFile {
	roomId: string;
	createdAt: number;
	updatedAt: number;
	app: { state: DraftState };
}

export type RoundDecision = { source: DraftSource; how: string } | { source: null; why: string };

export interface DraftDecision {
	draftId: string;
	status: string;
	rounds: RoundDecision[];
}

/** A name as two lists compare it: lower case, a double-faced card by its front. */
export function nameKey(name: string): string {
	return name.split(' // ')[0]!.trim().toLowerCase();
}

/** The round a dealt card's id names, or null (a spare pack's card, an id from before dealt ids). */
function roundOf(card: DraftCard): number | null {
	const at = /#(\d+):\d+:\d+$/.exec(card.cardId);
	return at === null ? null : Number(at[1]);
}

/** An imported cube's id off one of its card ids (`<cubeId>-<n>#…`), or null for anyone else's. */
function importedCubeOf(card: DraftCard): string | null {
	const id = card.cardId.split('#')[0]!;
	if (!id.startsWith('cc-') && !id.startsWith('list-')) return null;
	const at = /^(.+)-\d+$/.exec(id);
	return at === null ? null : at[1]!;
}

function percent(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function cubeSource(id: string, lists: readonly SourceList[]): Extract<DraftSource, { kind: 'cube' }> {
	const list = lists.find((l) => l.kind === 'cube' && l.id === id);
	return { kind: 'cube', cubeId: id, name: list?.kind === 'cube' ? list.name : id, origin: cubeOrigin(id) };
}

/** One round's source from its cards: the imported cube its card ids name, else the one list holding ≥ 90% of its names. */
export function decideRoundFromCards(cards: readonly DraftCard[], lists: readonly SourceList[]): RoundDecision {
	if (cards.length === 0) return { source: null, why: 'no card dealt in this round is left' };
	const imported = new Set(cards.map(importedCubeOf));
	if (imported.size === 1 && !imported.has(null)) {
		const id = [...imported][0]!;
		return { source: cubeSource(id, lists), how: 'card-id prefix' };
	}
	const names = new Set(cards.map((c) => nameKey(c.name)));
	const scored = lists
		.map((list) => {
			let held = 0;
			for (const n of names) if (list.names.has(n)) held++;
			return { list, share: held / names.size };
		})
		.sort((a, b) => b.share - a.share);
	const over = scored.filter((s) => s.share >= OVERLAP_MIN);
	const label = (l: SourceList): string => (l.kind === 'cube' ? `cube ${l.id}` : `set ${l.code}`);
	if (over.length === 0) {
		const best = scored[0];
		return { source: null, why: best === undefined ? 'no list to match against' : `no list holds ${percent(OVERLAP_MIN)} of its ${names.size} names (best: ${label(best.list)} at ${percent(best.share)})` };
	}
	if (over.length > 1) return { source: null, why: `${over.length} lists hold ${percent(OVERLAP_MIN)} of its names: ${over.map((s) => `${label(s.list)} ${percent(s.share)}`).join(', ')}` };
	const { list, share } = over[0]!;
	if (list.kind === 'cube') return { source: cubeSource(list.id, lists), how: `name overlap ${percent(share)}` };
	const rare = cards.filter((c) => c.rarity === 'rare' || c.rarity === 'mythic').length / cards.length;
	if (rare <= REALISTIC_RARE_MAX) return { source: { kind: 'set', code: list.code, style: 'realistic' }, how: `name overlap ${percent(share)}, ${percent(rare)} rare: realistic` };
	if (rare >= SET_CUBE_RARE_MIN) return { source: { kind: 'set', code: list.code, style: 'set-cube' }, how: `name overlap ${percent(share)}, ${percent(rare)} rare: set-cube` };
	return { source: null, why: `set ${list.code} at ${percent(share)}, but ${percent(rare)} rare says neither realistic nor set-cube` };
}

/** Every round of a draft file, decided by the rules in the header, in that order. */
export function decideDraft(file: DraftFile, lists: readonly SourceList[], planOf: (roomId: string) => readonly PoolSource[] | null): DraftDecision {
	const state = file.app.state;
	const plan = planOf(podOfDraftId(file.roomId).roomId);
	const nameOf = (src: PoolSource): string => (src.kind === 'cube' ? cubeSource(src.cubeId, lists).name : src.code);
	const dealt = [...state.pools.flat(), ...state.queues.flat(2), ...state.rounds.flat(2)];
	const rounds = Array.from({ length: state.packCount }, (_, round): RoundDecision => {
		const fromKey = poolSourceOfKey(state.roundSources?.[round] ?? null);
		if (fromKey !== null) return { source: draftSourceOf(fromKey, nameOf), how: 'roundSources' };
		const fromPlan = plan?.[round];
		if (fromPlan !== undefined) return { source: draftSourceOf(fromPlan, nameOf), how: 'room plan' };
		return decideRoundFromCards(
			dealt.filter((c) => roundOf(c) === round),
			lists,
		);
	});
	return { draftId: state.draftId, status: state.status, rounds };
}

/** A decided round as one line's words. */
function sourceLabel(source: DraftSource): string {
	return source.kind === 'cube' ? `cube ${source.cubeId} (${source.name})` : `set ${source.code} ${source.style}`;
}

/** The draft's one line: its source and how it was decided, or `undecided` and why. */
export function decisionLine(d: DraftDecision): string {
	const head = `${d.draftId.padEnd(18)} ${d.status.padEnd(9)}`;
	const undecided = d.rounds.flatMap((r, i) => (r.source === null ? [`round ${i + 1}: ${r.why}`] : []));
	if (undecided.length > 0) return `${head} undecided — ${undecided.join('; ')}`;
	const decided = d.rounds as { source: DraftSource; how: string }[];
	const labels = [...new Set(decided.map((r) => sourceLabel(r.source)))];
	const hows = [...new Set(decided.map((r) => r.how))];
	return `${head} ${labels.join(' / ')} — ${hows.join('; ')}`;
}

/** The record a decided, finished draft becomes. */
export function backfilledRecord(file: DraftFile, decision: DraftDecision, pod: number | null, eventId: string | null, userIdOf: (participantId: string) => string | null): DraftRecord | null {
	if (file.app.state.status !== 'complete' || decision.rounds.some((r) => r.source === null)) return null;
	return {
		...draftRecordOf({
			state: file.app.state,
			roomId: podOfDraftId(file.roomId).roomId,
			pod,
			eventId,
			rounds: decision.rounds.map((r) => r.source!),
			userIdOf,
			startedAt: file.createdAt,
			endedAt: file.updatedAt,
			outcome: 'complete',
		}),
		backfilled: true,
	};
}

/* ── reading a state dir ─────────────────────────────────────────────── */

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonFiles(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp')).map((f) => join(dir, f)) : [];
}

/** The shortlist (`{ cube, cards }`, id = file stem) and the imports (`{ id, name, cards }`). */
function cubeLists(shortlistDir: string, cubesDir: string): SourceList[] {
	const lists: SourceList[] = [];
	for (const path of jsonFiles(shortlistDir)) {
		const raw = readJson(path) as { cube?: string; cards?: { name: string }[] };
		if (raw.cube === undefined || raw.cards === undefined) continue;
		lists.push({ kind: 'cube', id: basename(path, '.json'), name: raw.cube, names: new Set(raw.cards.map((c) => nameKey(c.name))) });
	}
	for (const path of jsonFiles(cubesDir)) {
		const raw = readJson(path) as { id?: string; name?: string; cards?: { name: string }[] };
		if (raw.id === undefined || raw.cards === undefined) continue;
		lists.push({ kind: 'cube', id: raw.id, name: raw.name ?? raw.id, names: new Set(raw.cards.map((c) => nameKey(c.name))) });
	}
	return lists;
}

/**
 * A set a draft may be dealt from: one Scryfall marks a card of as a booster card, or a draftable
 * kind of set. Scryfall marks no card of a set not yet released as a booster card (The Hobbit,
 * HOB, on 2026-11-24), and Forge already drafts some of them.
 */
const DRAFTABLE_SET_TYPES = new Set(['expansion', 'core', 'masters', 'draft_innovation']);

/** Every set a draft may be dealt from in the Scryfall corpus, by its upper-case code (Forge's), with its names. */
async function setLists(scryfallDir: string): Promise<SourceList[]> {
	const file = join(scryfallDir, 'cards.jsonl');
	if (!existsSync(file)) throw new Error(`no Scryfall corpus at ${file}`);
	const bySet = new Map<string, Set<string>>();
	for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
		if (line === '') continue;
		const card = JSON.parse(line) as { name: string; set: string; set_type?: string; booster?: boolean; lang?: string };
		if (card.lang !== undefined && card.lang !== 'en') continue;
		if (card.booster !== true && !DRAFTABLE_SET_TYPES.has(card.set_type ?? '')) continue;
		const code = card.set.toUpperCase();
		let names = bySet.get(code);
		if (names === undefined) bySet.set(code, (names = new Set()));
		names.add(nameKey(card.name));
	}
	return [...bySet].map(([code, names]) => ({ kind: 'set', code, names }));
}

/** Each room's plan, by room id, from the rooms dir's snapshots. */
function roomPlans(roomsDir: string): Map<string, PoolSource[]> {
	const plans = new Map<string, PoolSource[]>();
	for (const path of jsonFiles(roomsDir)) {
		const raw = readJson(path) as { roomId?: string; app?: { game?: { plan?: { rounds?: PoolSource[] } } } };
		const rounds = raw.app?.game?.plan?.rounds;
		if (raw.roomId !== undefined && rounds !== undefined) plans.set(raw.roomId, rounds);
	}
	return plans;
}

/** The state dir's tournaments (`tournaments.json`), as their ids and when each started. */
function tournamentsOf(stateDir: string): { id: string; startedAt: number; users?: Record<string, string> }[] {
	const file = join(stateDir, 'tournaments.json');
	if (!existsSync(file)) return [];
	const raw = readJson(file) as unknown;
	return (Array.isArray(raw) ? raw : []) as { id: string; startedAt: number; users?: Record<string, string> }[];
}

/**
 * The pod tournament a draft fed (`room/pods.ts`'s `tournamentId`, `<roomId>-<draftStartedAt>`): the
 * room's tournament that started last at or before the pod was dealt. Null when it played none.
 */
export function eventOf(roomId: string, dealtAt: number, tournaments: readonly { id: string; startedAt: number }[]): string | null {
	let best: { id: string; startedAt: number } | null = null;
	for (const t of tournaments) {
		if (t.id !== `${roomId}-${t.startedAt}` || t.startedAt > dealtAt) continue;
		if (best === null || t.startedAt > best.startedAt) best = t;
	}
	return best?.id ?? null;
}

/** Every userId this state dir names, by the participant id each one drafts under. */
function knownPeople(stateDir: string): Map<string, string> {
	const userIds = new Set<string>();
	for (const path of jsonFiles(join(stateDir, 'users'))) userIds.add(basename(path, '.json'));
	for (const path of jsonFiles(join(stateDir, 'rooms'))) {
		const raw = readJson(path) as { members?: { accountId?: string }[] };
		for (const m of raw.members ?? []) if (typeof m.accountId === 'string') userIds.add(m.accountId);
	}
	for (const t of tournamentsOf(stateDir)) for (const id of Object.values(t.users ?? {})) userIds.add(id);
	return new Map([...userIds].map((id) => [fkOf(id), id]));
}

function fail(message: string): never {
	console.error(`backfill-draft-records: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			site: { type: 'string' },
			'state-dir': { type: 'string' },
			shortlist: { type: 'string', default: SHORTLIST_DIR },
			scryfall: { type: 'string', default: corpusDir() },
			write: { type: 'boolean', default: false },
		},
	});
	const site = values.site;
	const stateDir =
		values['state-dir'] ??
		(site !== undefined && site in SITES ? join(process.env.CARDTABLE_STATE_ROOT ?? join(homedir(), 'srv-data'), SITES[site as keyof typeof SITES]) : fail('say which state dir: --site prod|ppe, or --state-dir <dir>'));

	const lists = [...cubeLists(values.shortlist, join(stateDir, 'cubes')), ...(await setLists(values.scryfall))];
	const plans = roomPlans(join(stateDir, 'rooms'));
	const people = knownPeople(stateDir);
	const tournaments = tournamentsOf(stateDir);
	const files = jsonFiles(join(stateDir, 'drafts')).map((path) => readJson(path) as DraftFile);
	const multiPod = new Set(files.map((f) => podOfDraftId(f.roomId)).filter((p) => p.pod > 0).map((p) => p.roomId));

	const store = createDraftRecordStore(join(stateDir, 'history'), (e) => console.error('history:', JSON.stringify(e)));
	const records: DraftRecord[] = [];
	let finished = 0;
	let undecided = 0;
	for (const file of files.sort((a, b) => a.createdAt - b.createdAt)) {
		const decision = decideDraft(file, lists, (roomId) => plans.get(roomId) ?? null);
		console.log(decisionLine(decision));
		if (decision.status !== 'complete') continue;
		finished++;
		const { roomId, pod } = podOfDraftId(file.roomId);
		const record = backfilledRecord(file, decision, multiPod.has(roomId) ? pod : null, eventOf(roomId, file.createdAt, tournaments), (pid) => people.get(pid) ?? null);
		if (record === null) undecided++;
		else if (!store.has(record.draftId)) records.push(record);
	}
	console.log(`finished drafts: ${finished}; decided ${finished - undecided} of ${finished}, undecided ${undecided}; ${records.length} not yet in ${join(stateDir, 'history')}`);
	if (!values.write) {
		console.log('dry run: nothing written (--write to write)');
		return;
	}
	for (const record of records) await store.append(record);
	console.log(`written: ${records.length} backfilled records`);
}

if (import.meta.main) await main();
