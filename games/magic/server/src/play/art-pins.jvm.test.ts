/**
 * Art pins against real Forge (wave 125 §B, "Done when"): seat 0's player pins Lightning Bolt to
 * Alpha (LEA); both players own Bolts. Both screens, and the watcher, draw seat 0's Bolt as LEA's
 * printing and seat 1's Bolt as its default. Then the match's recording carries the pins in its
 * header, and the replay rebuilt from that recording alone draws exactly the same ids.
 *
 * The pins are resolved the way a start resolves them (`pinArtAtStart`, from the per-person store
 * on a temp dir, while the JVM boots), and the test prints how long that took against the window
 * it has: from the match's start to the first face stamped with art.
 *
 * A Bolt each board can see whole: both are in a graveyard, on a puzzle board (`scenario`), so no
 * play is needed. The catalog is one `build-catalog` wrote from Scryfall-shaped cards carrying the
 * real ids, never the host's.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCardIndex, buildCatalog, type GameplayCard } from '@hadoku/carddata';
import { cardIdOfState, deltaKey, DELTA_TYPE, intOf, strOf } from '@hadoku/forge-wire';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import type { ServerEnvelope } from '@hadoku/shared';

import { jvmHostFactory as jvmHostFactoryGeneric, liveJvmCount } from '@hadoku/game-server/play/host';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '@hadoku/game-server/play/recording/retention';
import { loadCardCatalog } from '../pools/catalog.js';
import { createMagicUserStore } from '../users/index.js';
import { createArtIds } from './art-ids.js';
import { artRulesOf, pinArtAtStart } from './art-pins.js';
import type { BridgeCommand, BridgeLine } from './bridge-protocol.js';
import type { ForgeMatchSpec } from './forge-spec.js';
import { createMatchRegistry } from './match.js';
import { WATCHER_SEAT } from './match/forge-session.js';
import { normalisedBoard } from './recording/position.js';
import { bridgeDigest, createRecorder, forgePin } from './recording/recorder.js';
import { publicStreamPath, rebuild } from './recording/rebuild.js';
import { available, deck } from './scenario.js';
import { foldFrames, type StateFrame } from './visibility.js';

const jvmHostFactory = (config: Parameters<typeof jvmHostFactoryGeneric>[0], options?: Parameters<typeof jvmHostFactoryGeneric>[1]) => jvmHostFactoryGeneric<BridgeLine, BridgeCommand>(config, options);

const title = available.ok
	? "art pins: each seat's Bolt is drawn by its owner's pin on every screen, and the replay draws the same, against real Forge"
	: `art pins against real Forge — SKIPPED: ${available.reason}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(50);
	}
}

/** Scryfall's own ids: Alpha's Bolt (LEA 161) and Magic 2010's (M10 146). */
const BOLT_LEA = 'd573ef03-4730-45aa-93dd-e45ac1dbaf4a';
const BOLT_M10 = 'e768c957-3a1f-42f5-853a-96942f645df5';

const scry = (id: string, set: string, collector: string, releasedAt: string, name = 'Lightning Bolt', typeLine = 'Instant'): GameplayCard =>
	({ id, name, lang: 'en', layout: 'normal', set, set_name: set, set_type: 'core', collector_number: collector, released_at: releasedAt, type_line: typeLine, oracle_text: '', mana_cost: '{R}', cmc: 1, colors: ['R'], rarity: 'common', games: ['paper'], artist: 'Someone' }) as GameplayCard;

const DECK = deck('Bolts', ['36 Mountain|M10', '4 Lightning Bolt|M10']);
/** Seat 0 ("human") has one Bolt in its graveyard, seat 1 ("ai", a human seat here) two: both boards see all three whole. */
const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Mountain|Set:M10',
	'humanlibrary=Mountain|Set:M10;Mountain|Set:M10;Mountain|Set:M10;Mountain|Set:M10',
	'humangraveyard=Lightning Bolt|Set:M10',
	'aihand=',
	'aibattlefield=Mountain|Set:M10',
	'ailibrary=Mountain|Set:M10;Mountain|Set:M10;Mountain|Set:M10;Mountain|Set:M10',
	'aigraveyard=Lightning Bolt|Set:M10;Lightning Bolt|Set:M10',
].join('\n');

const STATE_METHODS = new Set(['setGameView', 'applyDelta']);
const stateFrames = (envelopes: readonly unknown[]): StateFrame[] =>
	envelopes
		.map((env) => (env as ServerEnvelope).frame as unknown as { kind?: string; method?: string })
		.filter((f) => f.kind === 'notify' && STATE_METHODS.has(f.method ?? '')) as unknown as StateFrame[];

/** Every Bolt face a channel's frames drew, as `owner seat → the ids drawn`, sorted. */
function boltsByOwner(envelopes: readonly unknown[]): Record<number, string[]> {
	const state = foldFrames(stateFrames(envelopes));
	const out: Record<number, string[]> = {};
	for (const obj of state.values()) {
		if (obj._type !== DELTA_TYPE.cardState || strOf(obj, 'Name') !== 'Lightning Bolt') continue;
		const owner = intOf(state.get(deltaKey(DELTA_TYPE.card, cardIdOfState(obj._id))), 'Owner');
		const id = strOf(obj, 'ScryfallId');
		if (owner === null || id === null) continue;
		(out[owner] ??= []).push(id);
	}
	for (const ids of Object.values(out)) ids.sort();
	return out;
}

const hasArt = (env: ServerEnvelope): boolean => JSON.stringify(env.frame).includes('"ScryfallId"');

/** What differs between two `normalisedBoard`s: each object only one side has, and each property whose value differs. */
function boardDiff(live: string, rebuilt: string): string {
	const objects = (board: string) => new Map(JSON.parse(board) as [string, Record<string, unknown>][]);
	const a = objects(live);
	const b = objects(rebuilt);
	const out: string[] = [];
	for (const key of new Set([...a.keys(), ...b.keys()])) {
		const x = a.get(key);
		const y = b.get(key);
		if (x === undefined || y === undefined) {
			out.push(`${key} only ${x === undefined ? 'rebuilt' : 'live'}`);
			continue;
		}
		for (const prop of new Set([...Object.keys(x), ...Object.keys(y)])) {
			if (JSON.stringify(x[prop]) !== JSON.stringify(y[prop])) out.push(`${key}.${prop}: live ${JSON.stringify(x[prop])} rebuilt ${JSON.stringify(y[prop])}`);
		}
	}
	return out.length === 0 ? 'same' : out.slice(0, 20).join('; ') + (out.length > 20 ? `; …${out.length - 20} more` : '');
}

function linesOf(path: string): { t: string; [k: string]: unknown }[] {
	return gunzipSync(readFileSync(path))
		.toString('utf8')
		.split('\n')
		.filter((l) => l !== '')
		.map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
}

describe.skipIf(!available.ok)(title, () => {
	afterAll(async () => {
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 50_000);
	}, 60_000);

	it(
		"seat 0's pin draws its own Bolt as LEA on both screens; seat 1's Bolt keeps its default; the replay draws the same",
		async () => {
			if (!available.ok) return;
			const dir = mkdtempSync(join(tmpdir(), 'cardtable-art-pins-jvm-'));
			try {
				const catalogPath = join(dir, 'cards.json');
				writeFileSync(
					catalogPath,
					JSON.stringify(buildCatalog(buildCardIndex([scry(BOLT_LEA, 'lea', '161', '1993-08-05'), scry(BOLT_M10, 'm10', '146', '2009-07-17'), scry('0b3c7c5d-0000-4000-8000-000000000001', 'm10', '242', '2009-07-17', 'Mountain', 'Basic Land — Mountain')]))),
				);
				const catalog = loadCardCatalog(catalogPath);
				const store = createMagicUserStore(join(dir, 'users'), () => undefined);
				await store.update('player-zero', (doc) => {
					doc.art = { oldest: false, picks: { 'lightning bolt': BOLT_LEA } };
				});
				// The other player pinned nothing: an opponent's rules never reach your cards, nor yours theirs.
				await store.update('player-one', (doc) => {
					doc.art = { oldest: false, picks: {} };
				});
				const unpinned = createArtIds(catalog, [DECK, DECK]).face({ name: 'Lightning Bolt', set: 'M10' })?.scryfallId;
				expect(unpinned, "seat 1's default must differ from the pin, or this proves nothing").not.toBe(BOLT_LEA);

				const recordingsDir = join(dir, 'recordings');
				const identity = { pin: forgePin(available.config.jar), bridge: bridgeDigest(available.config.bridgeSource), server: 'art-pins-jvm' };
				const recorder = createRecorder({ dir: recordingsDir, identity, roomOf: () => 'r-art-pins', deckCosts: () => LIBRARY_CARD_COSTS, catalog, log: () => {} });
				const jvm = jvmHostFactory(available.config, { warm: false, log: () => {} });
				const seen = new Map<number, unknown[]>([[0, []], [1, []], [WATCHER_SEAT, []]]);
				let firstArtAt: number | null = null;
				// The live run's raw lines, so a refused rebuild can be diffed against what the match itself folded.
				const raw: BridgeLine[] = [];
				const hosted = recorder.host(jvm);
				const registry = createMatchRegistry({
					host: (id, s, events) =>
						hosted(id, s, {
							...events,
							line: (l) => {
								raw.push(l);
								events.line(l);
							},
						}),
					catalog,
					log: () => {},
					overGraceMs: 60_000,
					emit: (match, seat, envelope) => {
						recorder.onEnvelope(match.id, seat, envelope);
						seen.get(seat)?.push(envelope);
						if (firstArtAt === null && hasArt(envelope)) firstArtAt = performance.now();
					},
				});

				const spec: ForgeMatchSpec = {
					seed: 20261123,
					seats: [
						{ name: 'A', ai: false, deck: DECK },
						{ name: 'B', ai: false, deck: DECK },
					],
					scenario: STATE,
					skipOpening: true,
				};
				const startedAt = performance.now();
				const match = registry.create(spec);
				const pinLog: Record<string, unknown>[] = [];
				const pinned = pinArtAtStart(match.id, spec, [{ userId: 'player-zero', deck: DECK, locked: false }, { userId: 'player-one', deck: DECK, locked: false }], { read: artRulesOf(store), catalog, log: (e) => pinLog.push(e) });
				await pinned;
				const resolvedAt = performance.now();
				expect(await match.whenRunning(120_000)).toEqual({ ok: true });
				expect(pinLog).toMatchObject([{ evt: 'art-pins', pinned: [1, 0] }]);

				const threeBolts = (seat: number) => Object.values(boltsByOwner(seen.get(seat)!)).flat().length === 3;
				await waitUntil(() => [0, 1, WATCHER_SEAT].every(threeBolts), 'every screen to draw all three Bolts', 60_000);
				console.log(
					`[art-pins] resolve ${(resolvedAt - startedAt).toFixed(2)} ms; window (start → first face stamped) ${firstArtAt === null ? 'n/a' : (firstArtAt - startedAt).toFixed(0)} ms`,
				);
				expect(firstArtAt).not.toBeNull();
				expect(resolvedAt, 'the pins were in before the first face was drawn').toBeLessThan(firstArtAt!);

				// Forge numbers the players from 0 in seat order: the owner a face carries IS its seat.
				expect(match.seats.map((s) => s.playerId)).toEqual([0, 1]);
				const live = boltsByOwner(seen.get(WATCHER_SEAT)!);
				expect(live).toEqual({ 0: [BOLT_LEA], 1: [unpinned, unpinned] });
				expect(boltsByOwner(seen.get(0)!), "seat 0's screen").toEqual(live);
				expect(boltsByOwner(seen.get(1)!), "seat 1's screen").toEqual(live);

				match.stop();
				await waitUntil(() => liveJvmCount() === 0, 'the match JVM to exit', 20_000);
				const actionsPath = join(recordingsDir, `${match.id}${ACTIONS_SUFFIX}`);
				const publicPath = join(recordingsDir, `${match.id}${PUBLIC_SUFFIX}`);
				await waitUntil(() => existsSync(actionsPath) && existsSync(publicPath), 'the recording to flush', 10_000);

				const header = linesOf(actionsPath)[0] as unknown as { spec: ForgeMatchSpec };
				console.log(`[art-pins] action log: ${JSON.stringify(linesOf(actionsPath).filter((l) => l.t === 'cmd').map((l) => (l.cmd as { t?: string; frame?: { method?: string } }).frame?.method ?? (l.cmd as { t?: string }).t))}`);
				expect(header.spec.seats.map((s) => s.artPins)).toEqual([{ 'lightning bolt': BOLT_LEA }, undefined]);
				expect((linesOf(publicPath)[0] as unknown as { art: string[] }).art, 'the replay preloads the pinned art').toContain(BOLT_LEA);

				// The public stream expires: the replay is rebuilt from the action log alone, on its own JVM.
				rmSync(publicStreamPath(recordingsDir, match.id));
				const rebuildJvm = jvmHostFactory(available.config, { warm: false, log: () => {} });
				const rebuildLog: Record<string, unknown>[] = [];
				const rebuilt = await rebuild(match.id, { recordingsDir, host: rebuildJvm, log: (e) => rebuildLog.push(e), deckCosts: () => LIBRARY_CARD_COSTS, catalog, positionBudgetMs: 180_000, running: { pin: identity.pin, bridge: identity.bridge } });
				rebuildJvm.close();
				jvm.close();
				const refusal = rebuilt.ok
					? ''
					: [rebuilt.reason, ...(rebuilt.rebuiltBoards ?? []).map((board, seat) => `seat ${seat}: ${boardDiff(normalisedBoard(raw, seat), board)}`), `rebuild log: ${JSON.stringify(rebuildLog)}`].join('\n');
				expect(rebuilt.ok, refusal).toBe(true);
				if (!rebuilt.ok) return;
				const replayed = rebuilt.lines.filter((l): l is { t: 'env'; at: number; env: ServerEnvelope } => l.t === 'env').map((l) => l.env);
				expect(boltsByOwner(replayed), 'the replay draws what the match drew').toEqual(live);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
