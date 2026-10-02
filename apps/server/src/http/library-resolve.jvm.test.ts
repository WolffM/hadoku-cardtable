/**
 * Wave 34 §D, item 3 (the second half): every card in every library deck
 * resolves in FORGE'S OWN card database, at the pinned jar — not merely in the
 * real corpus `validate-library.ts` checks against.
 *
 * Those are different questions. The corpus is Scryfall data and says whether
 * a NAME is legal in a format; it says nothing about whether the exact `Name|
 * SET` pair a `.dck` line writes is a printing Forge itself knows, under the
 * edition code Forge itself uses. `build-library.ts`'s `CARD_SET_FIXUPS` is a
 * fix this exact check found: six Time Spiral "timeshifted" reprints mtgtop8
 * exports as plain `[TSP]`, which the real corpus is indifferent to (the NAME
 * is legal either way) but which Forge's card database refuses under that
 * edition code, because Forge has no Time Spiral printing of them at all — only
 * a Time Spiral Timeshifted (`TSB`) one.
 *
 * `./jvm/ResolveCheck.java`'s own header is the detailed case for why this is
 * checked with `CardDb.getCardFromSet` and not the friendlier `getCard(name,
 * set)`, which silently accepts a wrong set code by falling back to a
 * name-only lookup.
 *
 * One process for the whole library — not one per deck, not one per card —
 * because loading Forge's ~33,700 cardscripts is the cost and it is paid once:
 * every `(name, set)` pair the library's 96 decks use, 1151 of them, is sent
 * down one child's stdin and answered on its stdout.
 *
 * SKIPS without a Forge build, like every `*.jvm.test.ts`. To run it:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm exec vitest run apps/server/src/http/library-resolve.jvm.test.ts
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseDck } from '@hadoku/carddata/dck';
import { LIBRARY, deckPath } from '@hadoku/deck/library';

import { jvmHostConfig } from '../play/host.js';

const available = jvmHostConfig();
const title = available.ok
	? 'every library card resolves in Forge’s own card database'
	: `every library card resolves in Forge’s own card database — SKIPPED: ${available.reason}`;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RESOLVE_CHECK = join(dirname(fileURLToPath(import.meta.url)), 'jvm', 'ResolveCheck.java');

/** Every distinct `(name, set)` pair any library deck plays, main or sideboard. */
function libraryCardSetPairs(): Set<string> {
	const pairs = new Set<string>();
	for (const collection of LIBRARY) {
		for (const entry of collection.decks) {
			const text = readFileSync(join(REPO_ROOT, deckPath(collection, entry)), 'utf8');
			const deck = parseDck(text);
			for (const section of deck.sections.values()) {
				for (const line of section) {
					if (line.card.set === null) continue;
					pairs.add(`${line.card.name}\t${line.card.set}`);
				}
			}
		}
	}
	return pairs;
}

interface ResolveResult {
	kind: 'OK' | 'UNKNOWN_SET' | 'NO_SET' | 'UNKNOWN';
	name: string;
	set: string;
}

function parseResolveOutput(stdout: string): ResolveResult[] {
	const results: ResolveResult[] = [];
	for (const line of stdout.split('\n')) {
		if (line.trim().length === 0) continue;
		const [kind, name, set] = line.split('\t');
		if (kind === undefined || name === undefined || set === undefined) continue;
		if (kind !== 'OK' && kind !== 'UNKNOWN_SET' && kind !== 'NO_SET' && kind !== 'UNKNOWN') continue;
		results.push({ kind, name, set });
	}
	return results;
}

describe.skipIf(!available.ok)(title, () => {
	it('every (name, set) pair the library plays is a printing Forge itself knows', () => {
		if (!available.ok) return;
		const pairs = [...libraryCardSetPairs()].sort();
		expect(pairs.length).toBeGreaterThan(1000); // 1151 at the time this was written — a sanity floor, not a pin.

		const input = pairs.map((p) => `${p}\n`).join('');
		const result = spawnSync(available.config.java, ['-cp', available.config.jar, RESOLVE_CHECK, available.config.res], {
			input,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			timeout: 180_000,
		});
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);

		const results = parseResolveOutput(result.stdout);
		expect(results.length).toBe(pairs.length);

		const bad = results.filter((r) => r.kind !== 'OK');
		expect(bad.map((r) => `${r.kind}\t${r.name}\t${r.set}`)).toEqual([]);
	});
});
