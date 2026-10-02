/**
 * The draft arm of the deck gate, with basic lands in the deck.
 *
 * A drafted pool is not a deck until you add lands, and the lands come from
 * the table, not the pool. Before Wave 13 D the gate read a drafted deck's
 * `.dck` back with its basics in `main` and counted them against the drafted
 * pool, so every drafted deck with lands was refused — "plays 17x Island but
 * drafted 0". These tests pin the exemption and its edges: basics are exempt
 * from the POOL check and from nothing else, and the Standard arm is untouched.
 *
 * The pool is real: 45 cards of the committed cube, read by the server's own
 * loader. The deck is the one the BROWSER writes — the UI's own `deckFromPool`,
 * `setBasicLand` and `.dck` writer — so this is the file a player would submit.
 *
 * The last suite hands the accepted text to a real Forge in a child JVM. It
 * SKIPS, and says so in its name, unless the Forge build is configured.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDck, type CardRequest } from '@hadoku/carddata/dck';
import { BASIC_LAND_NAMES, basicLand, deckFromDeckFile, deckIssues, isBasicLand, moveToMain, setBasicLand } from '@hadoku/deck';
import type { DraftCard } from '@hadoku/shared';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';
import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostFactory } from '../play/host.js';
import { createMatchRegistry, type Match } from '../play/match.js';
import { loadPool } from '../room/pool.js';
import { draftPoolEntries } from './draftPool.js';
import { checkSeat, refusalLine, splitBasicLands, type DraftPoolLookup, type GateContext, type SeatVerdict } from './gate.js';
import { loadTablesLibrary } from './library.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const DRAFT = 'amber-lantern-k7q4';
/** A real library deck, legal in its own era (`Standard (M13)`, 2012) and from before Return to Ravnica (October 2012), which is what makes adding a Hallowed Fountain below an illegal card rather than a legal reprint. */
const UW_DELVER = 'power-2012-1-todd-anderson-uw-delver';
const POWER_2012 = '2012-07-13';

const cube = loadPool(resolve(REPO_ROOT, 'apps/ui/src/draft/pool.json'));
if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);

/**
 * The first 45 cube cards that are neither lands nor double-faced: 23 to play,
 * 22 to sideboard.
 *
 * The lands are left out so the only lands in the deck are the 17 the table
 * supplies. The `//` names are left out for a reason that is NOT this lane's
 * to fix and is written down rather than hidden: the cube stores a modal
 * double-faced card under its combined name (`Ajani, Nacatl Pariah // Ajani,
 * Nacatl Avenger`), `cardRequestOf` writes that name into the `.dck`, and
 * Forge's `CardDb` knows only the front face — so a real Forge silently DROPS
 * the line and plays 39 cards where the gate checked 40. Seen in this suite's
 * live run on 2026-09-19, reported to the tracker.
 */
const POOL: DraftCard[] = cube.pool.cards
	.filter((c) => !/\bLand\b/.test(c.typeLine) && !c.name.includes(' // '))
	.slice(0, 45);

/** The caller's own pool, as the route builds it from `DraftRooms`. */
const draftPool: DraftPoolLookup = (draftId) =>
	draftId === DRAFT ? { ok: true, pool: POOL } : { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };

const library = loadTablesLibrary(REPO_ROOT);
const ctx: GateContext = { library, draftPool };

/** The deck the browser writes: 23 drafted cards promoted, then 17 Islands from the basics buttons. */
function draftedDeckText(): string {
	let deck = deckFromPool(DRAFT, POOL);
	for (const entry of deck.sideboard.slice(0, 23)) deck = moveToMain(deck, entry.card, entry.count);
	deck = setBasicLand(deck, basicLand('Island'), 17);
	return dckTextOf(deck);
}

/** Put `line` at the top of the main section, as a hand-edited file would. */
function withMain(text: string, line: string): string {
	const at = text.search(/^\[main\]$/im);
	const end = text.indexOf('\n', at) + 1;
	return `${text.slice(0, end)}${line}\n${text.slice(end)}`;
}

const drafted = (dck: string) => ({ deck: { dck }, rules: { kind: 'draft' as const, draftId: DRAFT } });

describe('a drafted deck with basic lands', () => {
	it('the pool really is 45 drafted cards and no basics', () => {
		expect(POOL).toHaveLength(45);
		expect(POOL.some((c) => BASIC_LAND_NAMES.includes(c.name))).toBe(false);
	});

	it('is legal with 17 Islands, and the text checked is the text sent', () => {
		const text = draftedDeckText();
		expect(text).toMatch(/^17 Island$/m);
		const v = checkSeat(drafted(text), ctx) as SeatVerdict;
		expect(v).toMatchObject({
			deckName: `Cube draft ${DRAFT}`,
			rulesName: `your pool from ${DRAFT}`,
			legal: true,
			issues: [],
			note: null,
		});
		expect(v.text).toBe(text);
	});

	it('still refuses a non-basic the caller did not draft, by name', () => {
		const v = checkSeat(drafted(withMain(draftedDeckText(), '1 Black Lotus|LEA')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues).toEqual([
			{ kind: 'more-copies-than-drafted', message: 'plays 1x Black Lotus but drafted 0', cardName: 'Black Lotus', count: 1, limit: 0 },
		]);
		expect(refusalLine(0, v)).toBe(
			`Seat 1's deck "Cube draft ${DRAFT}" is not legal in your pool from ${DRAFT}: plays 1x Black Lotus but drafted 0`,
		);
	});

	it('exempts only Forge\'s five: an undrafted land outside them is pool-checked', () => {
		const v = checkSeat(drafted(withMain(draftedDeckText(), '1 Wastes')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues.map((i) => [i.kind, i.cardName])).toEqual([['more-copies-than-drafted', 'Wastes']]);
	});

	it('does not let the lands count twice or vanish: a 23-card deck plus 17 Islands is 40', () => {
		const deck = splitBasicLands(deckFromDeckFile(parseDck(draftedDeckText())));
		expect(deck.basics.map((e) => [e.count, e.card.name])).toEqual([[17, 'Island']]);
		expect(deck.main.some((e) => isBasicLand(e.card))).toBe(false);
		expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(23);
		// And one Island short is under the floor, so the lands are counted as maindeck.
		const short = checkSeat(drafted(draftedDeckText().replace(/^17 Island$/m, '16 Island')), ctx) as SeatVerdict;
		expect(short.issues.map((i) => i.message)).toEqual(['maindeck has 39 cards, needs at least 40']);
	});

	it('still refuses a non-basic in the basics pile', () => {
		const deck = splitBasicLands(deckFromDeckFile(parseDck(draftedDeckText())));
		const notABasic: CardRequest = { ...basicLand('Island'), name: 'Tolarian Academy' };
		const issues = deckIssues({ ...deck, basics: [...deck.basics, { count: 1, card: notABasic }] }, draftPoolEntries(POOL));
		expect(issues.map((i) => [i.kind, i.message])).toEqual([
			['not-a-basic-land', 'Tolarian Academy is in the basics pile but is not a basic land'],
		]);
	});
});

describe('the Standard arm is unchanged', () => {
	it('still refuses a land that is not in the format pool', () => {
		const base = library.deck(UW_DELVER)?.text ?? '';
		const standard = (dck: string) => ({ deck: { dck }, rules: { kind: 'standard' as const, format: POWER_2012 } });
		expect((checkSeat(standard(base), ctx) as SeatVerdict).legal).toBe(true);
		const v = checkSeat(standard(withMain(base, '4 Hallowed Fountain|RTR')), ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues.map((i) => [i.kind, i.cardName])).toContainEqual(['not-in-pool', 'Hallowed Fountain']);
	});
});

/* ── the accepted deck, played by a real Forge ───────────────────────── */

/**
 * Every `Library` collection in a frame, as sizes. Forge sends a player's zones
 * as a trackable collection — `{ v: [...] }` under the `Library` property — so
 * the opening library size is a fact read out of Forge's own view rather than
 * inferred from a status code.
 */
function librarySizes(node: unknown, key = ''): number[] {
	if (Array.isArray(node)) {
		return [...(key === 'Library' ? [node.length] : []), ...node.flatMap((n) => librarySizes(n))];
	}
	if (typeof node === 'object' && node !== null) {
		const entries = Object.entries(node as Record<string, unknown>);
		const inner = entries.flatMap(([k, v]) => librarySizes(v, key === 'Library' && k === 'v' ? key : k));
		return inner;
	}
	return [];
}

const available = jvmHostConfig();
const title = available.ok
	? 'the accepted drafted deck starts a real Forge match'
	: `the accepted drafted deck starts a real Forge match — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title, () => {
	const matches: Match[] = [];
	const pools: JvmHostFactory[] = [];

	afterAll(async () => {
		for (const m of matches) m.stop();
		for (const p of pools) p.close();
		const deadline = Date.now() + 15_000;
		while (liveJvmCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		expect(liveJvmCount()).toBe(0);
	});

	it('hands Forge the checked text and the match runs', async () => {
		if (!available.ok) return;
		const mine = checkSeat(drafted(draftedDeckText()), ctx) as SeatVerdict;
		const theirs = checkSeat({ deck: { library: UW_DELVER }, rules: { kind: 'standard', format: POWER_2012 } }, ctx) as SeatVerdict;
		expect([mine.legal, theirs.legal]).toEqual([true, true]);

		const raw: BridgeLine[] = [];
		const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
		pools.push(jvm);
		const registry = createMatchRegistry({
			host: (id, spec, events) =>
				jvm(id, spec, {
					...events,
					line: (l) => {
						raw.push(l);
						events.line(l);
					},
				}),
			log: () => {},
			askTimeoutMs: 60_000,
			overGraceMs: 60_000,
			emit: () => {},
		});
		const match = registry.create({
			seed: 20260919,
			seats: [
				{ name: 'Seat 1', ai: false, deck: mine.text },
				{ name: 'Forge AI', ai: true, deck: theirs.text },
			],
		});
		matches.push(match);
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });
		const ready = raw.find((l) => l.t === 'ready') as Extract<BridgeLine, { t: 'ready' }>;
		expect(ready.seats.map((s) => s.deck)).toEqual([mine.deckName, theirs.deckName]);
		// The proof that Forge plays the deck the gate checked: Forge's own view
		// of the opening libraries is 40 cards (23 drafted + 17 Islands) and 60.
		//
		// Wait for BOTH, not for the first one to arrive: the two players' zones
		// reach us in separate frames and in no guaranteed order, so a loop that
		// stops at 40 asserts 60 on whatever has landed by then. Under a full
		// `pnpm check` — three JVM suites at once — that raced and failed
		// ("expected [ 40 ] to include 60"). The deadline is generous for the
		// same reason: it is a wait for a frame, not a measurement of anything.
		const wanted = [40, 60];
		const deadline = Date.now() + 120_000;
		const sizes = (): number[] => raw.flatMap((l) => (l.t === 'frame' ? librarySizes(l.frame) : []));
		while (!wanted.every((n) => sizes().includes(n)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		for (const n of wanted) expect(sizes()).toContain(n);
		match.stop();
		jvm.close();
	}, 300_000);
});
