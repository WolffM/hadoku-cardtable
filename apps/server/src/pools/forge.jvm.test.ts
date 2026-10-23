/**
 * The pool service against a real jar: `check`, `sets`, `setCards` and
 * `boosters`, per `docs/planning/wave73-2026-10-21.md` §D.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   CI=1 pnpm exec vitest run apps/server/src/pools/forge.jvm.test.ts
 *
 * `check` is run over the 8 shortlisted cubes (`docs/planning/draft-pools-plan.md`,
 * ruling 7). **Any unplayable name is a FINDING for the operator, not a test
 * failure** (the ruling itself refuses a cube with one; this suite's job is to
 * surface the list, not to assert it is empty) — every `console.log` line below
 * tagged `unplayable` is collected into the report.
 *
 * Shortlist source: lane A generates `apps/server/pools/cubes/<stem>.json` in
 * parallel (not landed on origin/main as of this file). Until it lands, or for
 * a cube it does not (yet) cover, this reads the shortlisted cube's own `.dck`
 * straight from `CARDTABLE_FORGE_RES`'s `cube/` directory — the exact res tree
 * this test's own JVM boots against, so the cube's name list can never disagree
 * with the jar being checked. `loadShortlistNames` prefers a generated file
 * (matched by its `cube` field, not by filename, so it does not need to guess
 * lane A's stem convention) and falls back to the `.dck` otherwise.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDck } from '@hadoku/carddata/dck';
import { afterAll, describe, expect, it } from 'vitest';

import { jvmHostConfig } from '../play/host.js';
import { createForgePools, type ForgePools } from './forge.js';

const available = jvmHostConfig();
const title = available.ok
	? 'the pool service answers check, sets, setCards and boosters'
	: `the pool service answers check, sets, setCards and boosters — SKIPPED: ${available.reason}`;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Lane A's generated cubes, if they have landed (`apps/server/pools/cubes/*.json`). */
const GENERATED_CUBES_DIR = resolve(HERE, '..', '..', 'pools', 'cubes');

/** The 8 shortlisted cubes (`draft-pools-plan.md` ruling 7) — the filename is the name verbatim plus `.dck`. */
const SHORTLIST = [
	'MTGO Vintage Cube 2025-04',
	'MTGO Legacy Cube 2021-08',
	'The Pauper Cube 2026-02',
	"Ryan Overturf's Grixis Cube (MTGO)",
	"Timothee Simonot's Twisted Color Pie Cube",
	"Guillaume Matignon's Jenny's-Johnny's Cube",
	'Old School 93-94 Magic Powered 360 Card Cube',
	'Hypercube (383 cards)',
] as const;

/** A generated `{cube,size,cards}` file (the `pool.json` shape) matching `name`'s `cube` field, if one exists. */
function findGenerated(name: string): { name: string }[] | null {
	if (!existsSync(GENERATED_CUBES_DIR)) return null;
	for (const entry of readdirSync(GENERATED_CUBES_DIR)) {
		if (!entry.endsWith('.json')) continue;
		let data: unknown;
		try {
			data = JSON.parse(readFileSync(join(GENERATED_CUBES_DIR, entry), 'utf8'));
		} catch {
			continue;
		}
		const cube = data as { cube?: unknown; cards?: unknown };
		if (cube.cube === name && Array.isArray(cube.cards)) return cube.cards as { name: string }[];
	}
	return null;
}

/** Every unique card name the cube holds: lane A's generated file when present, else the shortlisted `.dck` itself. */
function loadShortlistNames(name: string, cubeDir: string): string[] {
	const generated = findGenerated(name);
	if (generated !== null) return [...new Set(generated.map((c) => c.name))];
	const text = readFileSync(join(cubeDir, `${name}.dck`), 'utf8');
	const deck = parseDck(text);
	const main = deck.sections.get('main') ?? [];
	return [...new Set(main.map((e) => e.card.name))];
}

/**
 * Innistrad's 20 transform cards, by front face — the name Forge's card DB
 * files each under (`AlternateMode:DoubleFaced` in its cardsfolder script; the
 * back face is never a card of its own). Derived, not guessed, by:
 *
 *   awk '/^\[cards\]/{f=1;next}/^\[/{f=0}f' "forge/forge-gui/res/editions/Innistrad.txt" \
 *     | sed -E 's|^[0-9]+ [A-Z] (.+) @.*|\1|' \
 *     | while read -r n; do grep -rlF "Name:$n" forge/forge-gui/res/cardsfolder \
 *         | xargs -r grep -l AlternateMode:DoubleFaced >/dev/null 2>&1 && echo "$n"; done
 *
 * ISD's `Booster=` (`9 Common:!dfc, 3 Uncommon:!dfc, 1 RareMythic:!dfc, 1 dfc, 1 BasicLand`)
 * guarantees exactly one card from this set in every draft booster — not a
 * seed-dependent chance, so this holds for any seed.
 */
const ISD_DFC_FRONTS = new Set([
	'Cloistered Youth',
	'Thraben Sentry',
	'Civilized Scholar',
	'Delver of Secrets',
	"Ludevic's Test Subject",
	'Bloodline Keeper',
	'Screeching Bat',
	'Hanweir Watchkeep',
	'Instigator Gang',
	'Kruin Outlaw',
	'Reckless Waif',
	'Tormented Pariah',
	'Village Ironsmith',
	'Daybreak Ranger',
	'Garruk Relentless',
	'Gatstaf Shepherd',
	'Grizzled Outcasts',
	'Mayor of Avabruck',
	'Ulvenwald Mystics',
	'Villagers of Estwald',
]);

describe.skipIf(!available.ok)(title, () => {
	let pools: ForgePools | null = null;
	/** Every `pool-stderr` text the service wrote, for what reaches the server's log. */
	const stderr: string[] = [];

	afterAll(async () => {
		if (pools !== null) await pools.close();
	});

	/** Thrown only if a test body somehow runs without the `available.ok` guard below — never in practice. */
	function service(): ForgePools {
		if (!available.ok) throw new Error(available.reason);
		pools ??= createForgePools(available.config, (entry) => {
			if (entry.evt === 'pool-stderr') stderr.push(String(entry.text));
			console.log(`[forge.jvm] ${JSON.stringify(entry)}`);
		});
		return pools;
	}

	it(
		'check reports every unplayable name, per shortlisted cube — a finding for the operator, not a test failure',
		{ timeout: 120_000 },
		async () => {
			if (!available.ok) return;
			const cubeDir = join(available.config.res, 'cube');
			const findings: Record<string, string[]> = {};
			for (const name of SHORTLIST) {
				const names = loadShortlistNames(name, cubeDir);
				expect(names.length, `${name} parsed to 0 cards`).toBeGreaterThan(0);
				const unplayable = await service().check(names);
				findings[name] = unplayable;
				console.log(`[forge.jvm] unplayable in "${name}" (${unplayable.length} of ${names.length}): ${JSON.stringify(unplayable)}`);
			}
			// The suite is green regardless of what it found: per ruling 6, an
			// unplayable name refuses that cube's selection, which is the room's
			// job (A's verdict), not this test's.
			expect(Object.keys(findings)).toHaveLength(SHORTLIST.length);
		},
	);

	it('check(["Not A Real Card"]) returns it', async () => {
		if (!available.ok) return;
		const unplayable = await service().check(['Not A Real Card']);
		expect(unplayable).toEqual(['Not A Real Card']);
	});

	/**
	 * A real integration bug (lane A booting the wired server against a real
	 * jar): the verdict sends a cube's `DraftCard` names, which are Scryfall's
	 * `Front // Back` for every two-faced card — the shape `check`'s own
	 * callers actually feed it, not the `.dck`-derived names the shortlist test
	 * above happened to use. Forge never indexes a transform/MDFC/adventure
	 * card under that joined form (`PlayBridge.forgeCardName`'s own doc), so
	 * every real cube with one DFC was refused wholesale — including the
	 * default plan (MTGO Legacy Cube 2021-08 came back with 23 "unplayable"
	 * names, all DFCs). `check` must resolve the Scryfall-style name to Forge's
	 * own filing name first, exactly as a drafted deck's own lines do.
	 */
	it("check resolves a two-faced card's Scryfall name to Forge's own, and still refuses a wrong pairing", async () => {
		if (!available.ok) return;
		const realDfcs = await service().check([
			"Jace, Vryn's Prodigy // Jace, Telepath Unbound", // transform
			'Fire // Ice', // split — already Forge's own joined name
			'Delver of Secrets // Insectile Aberration', // transform
		]);
		expect(realDfcs).toEqual([]);
		const wrongBack = await service().check(["Jace, Vryn's Prodigy // Not His Back"]);
		expect(wrongBack).toEqual(["Jace, Vryn's Prodigy // Not His Back"]);
	});

	it('names each set by the code Scryfall prints it as too, on the set and on every booster card (Conflux: CFX, CON)', { timeout: 60_000 }, async () => {
		if (!available.ok) return;
		expect((await service().sets()).find((s) => s.code === 'CFX')?.scryfallCode).toBe('CON');
		const [pack] = await service().boosters('CFX', 1, 'scryfall-code');
		expect(pack!.every((c) => c.set === 'CON'), JSON.stringify(pack!.map((c) => c.set))).toBe(true);
	});

	it('sets() includes ISD and ARB', async () => {
		if (!available.ok) return;
		const sets = await service().sets();
		const codes = sets.map((s) => s.code);
		expect(codes).toContain('ISD');
		expect(codes).toContain('ARB');
	});

	// Claw run 39856808361: the top-up added a common Delver of Secrets beside the pack's own DFC.
	it('every ISD pack holds exactly one DFC across 200 seeds — the top-up commons are never double-faced', { timeout: 120_000 }, async () => {
		if (!available.ok) return;
		for (let i = 0; i < 200; i++) {
			const [pack] = await service().boosters('ISD', 1, `one-dfc-${i}`);
			const dfcs = pack!.filter((c) => ISD_DFC_FRONTS.has(c.name)).map((c) => c.name);
			expect(dfcs, `one-dfc-${i}: ${JSON.stringify(pack!.map((c) => c.name))}`).toHaveLength(1);
		}
	});

	it(
		'two ISD booster calls with one seed are identical, and every ISD booster holds a DFC',
		{ timeout: 60_000 },
		async () => {
			if (!available.ok) return;
			const seed = 'wave73-lane-d-isd';
			const first = await service().boosters('ISD', 3, seed);
			const second = await service().boosters('ISD', 3, seed);
			expect(second).toEqual(first);
			expect(first).toHaveLength(3);
			for (const pack of first) {
				expect(pack.length).toBeGreaterThan(0);
				const dfcCount = pack.filter((c) => ISD_DFC_FRONTS.has(c.name)).length;
				expect(dfcCount, `booster holds no DFC: ${JSON.stringify(pack.map((c) => c.name))}`).toBeGreaterThanOrEqual(1);
			}
		},
	);

	// The operator, 2026-10-22: "i dont like the land/foil being in the packs. lets make sure all packs are 15 cards".
	it(
		'every pack is 15 cards with no basic land — a play booster (BLB, 14 with a land and a foil) and a land-slot draft booster (DMU) alike',
		{ timeout: 60_000 },
		async () => {
			if (!available.ok) return;
			const basics = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
			for (const code of ['BLB', 'DMU', 'ISD']) {
				const packs = await service().boosters(code, 4, `packs-15-${code}`);
				for (const pack of packs) {
					const names = pack.map((c) => c.name);
					expect(names, code).toHaveLength(15);
					expect(names.filter((n) => basics.test(n)), code).toEqual([]);
				}
			}
		},
	);

	// Forge's own booster may add a foil of any rarity (ISD: ~21% a pack, `e2e/draft-sets.collation.ts`); a draft
	// pack leaves it out — the operator, 2026-10-22: "i dont like the land/foil being in the packs".
	it(
		'no ISD pack carries a foil across 200 seeds, and every card says foil:false',
		{ timeout: 120_000 },
		async () => {
			if (!available.ok) return;
			for (let i = 0; i < 200; i++) {
				const [pack] = await service().boosters('ISD', 1, `wave-foil-search-${i}`);
				expect(pack!.every((c) => c.foil === false), `wave-foil-search-${i}: ${JSON.stringify(pack)}`).toBe(true);
			}
		},
	);

	// Forge prints a line per booster slot to System.out (`BoosterGenerator`, `BoosterSlot`): two-thirds of the
	// server's log. The service counts them instead, one summary line a phase; Forge's warnings still pass.
	it('logs one summary line for a phase of Forge’s own output, never the lines themselves', { timeout: 60_000 }, async () => {
		if (!available.ok) return;
		stderr.length = 0;
		await service().boosters('ISD', 3, 'quiet-log');
		const lines = stderr.flatMap((t) => t.split('\n')).filter((l) => l.trim() !== '');
		expect(lines.filter((l) => /^\d+ of type |^Attempting to lookup: |^Parsing from main code: |^Replaced a base slot! /.test(l)), 'Forge’s per-slot chatter').toEqual([]);
		expect(lines.some((l) => /^\[PoolService\] boosters: \d+ lines of Forge output in \d+ ms$/.test(l)), `one summary for the draw: ${JSON.stringify(lines)}`).toBe(true);
	});
});
