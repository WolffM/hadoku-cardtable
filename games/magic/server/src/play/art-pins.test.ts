/**
 * A seat's art pins (`art-pins.ts`): the settled order (a tournament-locked drafted deck → its own
 * printing; else a hand pick → "always oldest" → the default), resolved from documents in the real
 * per-person store on a temp dir and a real catalog file `build-catalog` wrote from Scryfall-shaped
 * cards, and what the match's art then draws (`art-ids.ts`), owner by owner.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCardIndex, buildCatalog, normaliseName, type GameplayCard } from '@hadoku/carddata';

import { loadCardCatalog, type CardCatalog } from '../pools/catalog.ts';
import { createMagicUserStore, type MagicUserStore } from '../users/index.ts';
import { artPinKey, createArtIds } from './art-ids.ts';
import { applyArtPins, artRulesOf, pinArtAtStart, resolveArtPins, type ArtPinSeat, type ArtRulesReader } from './art-pins.ts';
import type { HostEvents, MatchHost, MatchHostFactory } from '@hadoku/game-server/play/host';
import { ACTIONS_SUFFIX, PUBLIC_SUFFIX } from '@hadoku/game-server/play/recording/retention';
import type { BridgeCommand, BridgeLine } from './bridge-protocol.ts';
import type { ForgeMatchSpec, ForgeSeatSpec } from './forge-spec.ts';
import { createRecorder } from './recording/recorder.ts';

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'art-pins-test-'));
	dirs.push(dir);
	return dir;
}

let n = 0;
function card(name: string, set: string, collector: string, releasedAt: string, extra: Record<string, unknown> = {}): GameplayCard & { id: string } {
	n += 1;
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		name, lang: 'en', layout: 'normal', set, set_name: set, set_type: 'expansion', collector_number: collector, released_at: releasedAt,
		type_line: 'Instant', oracle_text: '', mana_cost: '{R}', cmc: 1, colors: ['R'], rarity: 'common', games: ['paper'], artist: 'Someone',
		...extra,
	} as GameplayCard & { id: string };
}

const BOLT_M10 = card('Lightning Bolt', 'm10', '146', '2009-07-17');
const BOLT_LEA = card('Lightning Bolt', 'lea', '161', '1993-08-05');
const BOLT_M11 = card('Lightning Bolt', 'm11', '149', '2010-07-16');
const SHOCK_M10 = card('Shock', 'm10', '158', '2009-07-17');
const SHOCK_10E = card('Shock', '10e', '237', '2007-07-13');
const DELVER_ISD = card('Delver of Secrets // Insectile Aberration', 'isd', '51', '2011-09-30', {
	layout: 'transform', type_line: 'Creature — Human Wizard // Creature — Human Insect',
	card_faces: [{ name: 'Delver of Secrets', type_line: 'Creature — Human Wizard', mana_cost: '{U}' }, { name: 'Insectile Aberration', type_line: 'Creature — Human Insect', mana_cost: '' }],
});
const DELVER_MID = card('Delver of Secrets // Insectile Aberration', 'mid', '47', '2021-09-24', { layout: 'transform', type_line: DELVER_ISD.type_line, card_faces: DELVER_ISD.card_faces });

async function catalogOf(cards: readonly GameplayCard[]): Promise<CardCatalog> {
	const path = join(await tempDir(), 'cards.json');
	await writeFile(path, JSON.stringify(buildCatalog(buildCardIndex(cards))));
	return loadCardCatalog(path);
}

const DECK = '[main]\n4 Lightning Bolt|M10\n4 Shock|M10\n4 Delver of Secrets|ISD\n';

async function setup() {
	const catalog = await catalogOf([BOLT_M10, BOLT_LEA, BOLT_M11, SHOCK_M10, SHOCK_10E, DELVER_ISD, DELVER_MID]);
	const store: MagicUserStore = createMagicUserStore(join(await tempDir(), 'users'), () => undefined);
	const read = artRulesOf(store);
	return { catalog, store, read };
}

/** Bolt as the match draws it with no pins at all (the committed table's `Lightning Bolt|M10` row). */
function defaultBolt(catalog: CardCatalog): string {
	const id = createArtIds(catalog, [DECK, DECK]).face({ name: 'Lightning Bolt', set: 'M10' })?.scryfallId;
	expect(id).toBeDefined();
	expect(id).not.toBe(BOLT_LEA.id);
	return id!;
}

const seat = (userId: string | null, locked = false, deck: string | null = DECK): ArtPinSeat => ({ userId, deck, locked });

describe('resolving a seat\'s pins: the settled order', () => {
	it('a hand pick beats "always oldest"; oldest covers every card the player did not pick', async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: true, picks: { 'lightning bolt': BOLT_M11.id } };
		});
		const [pins] = await resolveArtPins([seat('alice')], { read, catalog });
		expect(pins).toEqual({
			'lightning bolt': BOLT_M11.id,
			shock: SHOCK_10E.id,
			'delver of secrets // insectile aberration': DELVER_ISD.id,
		});
	});

	it('a pick alone, with oldest off: only the picked card is pinned', async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: false, picks: { 'lightning bolt': BOLT_LEA.id } };
		});
		expect(await resolveArtPins([seat('alice')], { read, catalog })).toEqual([{ 'lightning bolt': BOLT_LEA.id }]);
	});

	it('a drafted deck still in its tournament ignores both the pick and oldest', async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: true, picks: { 'lightning bolt': BOLT_LEA.id } };
		});
		expect(await resolveArtPins([seat('alice', true)], { read, catalog })).toEqual([undefined]);
	});

	it("a pick that is not a printing of the card is never honoured: another card's picture cannot stand in", async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: false, picks: { 'lightning bolt': SHOCK_M10.id, shock: 'not-an-id' } };
		});
		expect(await resolveArtPins([seat('alice')], { read, catalog })).toEqual([undefined]);
	});

	it("a two-faced card picked by its front's name is pinned under its whole name, which the board's faces look up", async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: false, picks: { 'delver of secrets': DELVER_MID.id } };
		});
		const [pins] = await resolveArtPins([seat('alice')], { read, catalog });
		expect(pins).toEqual({ 'delver of secrets // insectile aberration': DELVER_MID.id });
		const art = createArtIds(catalog, [DECK], [{ artPins: pins! }]);
		expect(art.face({ name: 'Delver of Secrets', set: 'ISD', seat: 0 })?.scryfallId).toBe(DELVER_MID.id);
		expect(art.face({ name: 'Insectile Aberration', set: 'ISD', front: 'Delver of Secrets', seat: 0 })?.scryfallId).toBe(`${DELVER_MID.id}#back`);
	});

	it('the AI, an unheld seat, a precon and a player with no rules have no pins', async () => {
		const { catalog, read } = await setup();
		expect(await resolveArtPins([seat(null), seat('nobody-yet'), seat('alice', false, null)], { read, catalog })).toEqual([undefined, undefined, undefined]);
	});

	it('a document that cannot be read is default art for that seat, logged once; the other seat keeps its pins', async () => {
		const { catalog, store } = await setup();
		await store.update('bob', (doc) => {
			doc.art = { oldest: true, picks: {} };
		});
		const logs: Record<string, unknown>[] = [];
		const read: ArtRulesReader = async (userId) => {
			if (userId === 'alice') throw new Error('EIO');
			return (await store.get(userId)).art;
		};
		const pins = await resolveArtPins([seat('alice'), seat('bob')], { read, catalog, log: (e) => logs.push(e) });
		expect(pins[0]).toBeUndefined();
		expect(pins[1]?.['lightning bolt']).toBe(BOLT_LEA.id);
		expect(logs).toEqual([{ evt: 'art-pins-default', seat: 0, reason: 'unreadable', detail: 'EIO' }]);
	});

	it('a document not read within the budget is default art for that seat, logged once', async () => {
		const { catalog, store } = await setup();
		await store.update('bob', (doc) => {
			doc.art = { oldest: true, picks: {} };
		});
		const logs: Record<string, unknown>[] = [];
		const read: ArtRulesReader = (userId) => (userId === 'alice' ? new Promise(() => undefined) : store.get(userId).then((d) => d.art));
		const pins = await resolveArtPins([seat('alice'), seat('bob')], { read, catalog, budgetMs: 50, log: (e) => logs.push(e) });
		expect(pins[0]).toBeUndefined();
		expect(pins[1]?.shock).toBe(SHOCK_10E.id);
		expect(logs).toEqual([{ evt: 'art-pins-default', seat: 0, reason: 'timeout', budgetMs: 50 }]);
	});
});

describe('what the match draws with the pins', () => {
	it("a pin's key is the catalog's own normaliseName, which art-ids.ts writes out rather than import", () => {
		for (const name of ['  Lightning Bolt ', 'Lim-Dûl the Necromancer', 'DELVER OF SECRETS // Insectile Aberration']) expect(artPinKey(null, name)).toBe(normaliseName(name));
	});

	it("an opponent's pins never touch your cards: each seat's Bolt is drawn by its own owner's pin", async () => {
		const { catalog } = await setup();
		const seats: ForgeSeatSpec[] = [
			{ name: 'A', ai: false, deck: DECK, artPins: { 'lightning bolt': BOLT_LEA.id } },
			{ name: 'B', ai: false, deck: DECK },
		];
		const plain = defaultBolt(catalog);
		const art = createArtIds(catalog, seats.map((s) => s.deck), seats);
		expect(art.face({ name: 'Lightning Bolt', set: 'M10', seat: 0 })?.scryfallId).toBe(BOLT_LEA.id);
		expect(art.face({ name: 'Lightning Bolt', set: 'M10', seat: 1 })?.scryfallId).toBe(plain);
		expect(art.face({ name: 'Lightning Bolt', set: 'M10' })?.scryfallId, 'a face nobody owns reads no pin').toBe(plain);
		expect(art.card('Lightning Bolt', 'M10')?.scryfallId, 'a lookup by name alone reads no pin').toBe(plain);
		expect(art.images('Lightning Bolt', 'M10'), 'the preload warms both').toEqual([plain, BOLT_LEA.id]);
	});

	it('pins written while the JVM boots are drawn; pins that arrive after the first face are dropped, never half-applied', async () => {
		const { catalog, store, read } = await setup();
		await store.update('alice', (doc) => {
			doc.art = { oldest: false, picks: { 'lightning bolt': BOLT_LEA.id } };
		});
		const early: { seats: ForgeSeatSpec[] } = { seats: [{ name: 'A', ai: false, deck: DECK }, { name: 'B', ai: true, deck: DECK }] };
		const earlyArt = createArtIds(catalog, [DECK, DECK], early.seats);
		const logs: Record<string, unknown>[] = [];
		await pinArtAtStart('m-early', early, [seat('alice'), seat(null)], { read, catalog, log: (e) => logs.push(e) });
		expect(early.seats[0]!.artPins).toEqual({ 'lightning bolt': BOLT_LEA.id });
		expect(earlyArt.face({ name: 'Lightning Bolt', set: 'M10', seat: 0 })?.scryfallId).toBe(BOLT_LEA.id);
		expect(logs).toMatchObject([{ evt: 'art-pins', matchId: 'm-early', pinned: [1, 0] }]);

		const late: { seats: ForgeSeatSpec[] } = { seats: [{ name: 'A', ai: false, deck: DECK }, { name: 'B', ai: true, deck: DECK }] };
		const lateArt = createArtIds(catalog, [DECK, DECK], late.seats);
		expect(lateArt.face({ name: 'Lightning Bolt', set: 'M10', seat: 0 })?.scryfallId).toBe(defaultBolt(catalog));
		logs.length = 0;
		await pinArtAtStart('m-late', late, [seat('alice'), seat(null)], { read, catalog, log: (e) => logs.push(e) });
		expect(late.seats[0]!.artPins, 'nothing written into a spec whose faces are drawn').toBeUndefined();
		expect(lateArt.face({ name: 'Lightning Bolt', set: 'M10', seat: 0 })?.scryfallId).toBe(defaultBolt(catalog));
		expect(logs).toMatchObject([{ evt: 'art-pins-late', matchId: 'm-late' }]);
		expect(applyArtPins(late.seats, [{ 'lightning bolt': BOLT_LEA.id }])).toBe(false);
	});
});

describe('the recording carries the pins', () => {
	it("pins written after the JVM was asked for land in the action log's header and the public header's preload", async () => {
		const { catalog } = await setup();
		const dir = await tempDir();
		let events: HostEvents<BridgeLine, BridgeCommand> | null = null;
		const inner = ((_id, _spec, e) => {
			events = e;
			return { send: () => undefined, stop: () => undefined } satisfies MatchHost<BridgeCommand>;
		}) as MatchHostFactory<BridgeLine, BridgeCommand>;
		inner.close = () => undefined;
		inner.room = () => 'none';
		const recorder = createRecorder({ dir, identity: { pin: null, bridge: 'b', server: 's' }, roomOf: () => 'r', deckCosts: () => ({}), catalog, log: () => undefined });
		const spec: ForgeMatchSpec = { seed: 1, seats: [{ name: 'A', ai: false, deck: DECK }, { name: 'B', ai: false, deck: DECK }] };
		recorder.host(inner)('m-pins', spec, { line: () => undefined, exit: () => undefined } as unknown as HostEvents<BridgeLine, BridgeCommand>);
		// As `pinArtAtStart` does, while the JVM boots: on the spec's own seats.
		expect(applyArtPins(spec.seats, [{ 'lightning bolt': BOLT_LEA.id }, undefined])).toBe(true);
		events!.exit('stopped');
		const actions = join(dir, `m-pins${ACTIONS_SUFFIX}`);
		const pub = join(dir, `m-pins${PUBLIC_SUFFIX}`);
		await new Promise<void>((done) => {
			const poll = (): void => (existsSync(actions) && existsSync(pub) ? done() : void setTimeout(poll, 10));
			poll();
		});
		const first = (path: string) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8').split('\n')[0]!) as { spec: ForgeMatchSpec; art: string[] };
		expect(first(actions).spec.seats.map((s) => s.artPins)).toEqual([{ 'lightning bolt': BOLT_LEA.id }, undefined]);
		expect(first(actions).spec.seats.map((s) => s.name), 'still anonymous').toEqual(['Player 1', 'Player 2']);
		expect(first(pub).art).toContain(BOLT_LEA.id);
	});
});
