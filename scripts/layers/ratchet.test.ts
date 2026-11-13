/**
 * The layer fence. `scripts/layers/layers.json` maps every tracked source file to a
 * layer — `platform` (MIT, imports platform only), `magic` (GPL, imports platform/magic/tangled),
 * `tangled` (GPL, today's generic-mechanism-plus-Magic debt — an explicit list that may only
 * shrink) or `site` (GPL for now, the composition roots, may import anything). This test is the
 * fence: it fails when a NEW import crosses a forbidden direction, when a package's licence field
 * no longer matches what its files are, when a `platform` file carries a GPL header, or when the
 * map itself goes stale (an unclassified file, or a classified one that no longer exists).
 *
 * On a violation it never says "fix the map" — the three ways out are in the printed message:
 * move the Magic part next to its Magic peers, classify the importing file as Magic if that is
 * what it is, or put the generic part in a platform file. A count that FALLS instead of rising
 * passes and prints the one command that writes the new baseline: `node scripts/layers/baseline.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BASELINE_JSON_PATH, buildResolver, loadLayers } from './classify.ts';
import {
	checkCoverage,
	checkLicences,
	checkProvenance,
	checkStalePendingLicence,
	checkTangledDiscipline,
	collectEdges,
	countViolations,
	edgeKey,
	isViolation,
	listSourceFiles,
	moduleSpecifiers,
	packageImportLayer,
	resolvePackageImport,
	type Edge,
} from './scan.ts';

const layers = loadLayers();
const resolver = buildResolver(layers);
const allFiles = listSourceFiles();
const baseline: {
	edgeCounts: Record<string, number>;
	edgeKeys: Record<string, string[]>;
	tangled: string[];
	pendingLicence: string[];
} = JSON.parse(readFileSync(BASELINE_JSON_PATH, 'utf8'));

describe('layer fence — coverage', () => {
	it('every tracked .ts/.tsx source file has a layer, and every mapped file still exists', () => {
		const { uncovered, stale } = checkCoverage(resolver, allFiles);
		if (uncovered.length > 0) {
			throw new Error(
				`${uncovered.length} file(s) have no layer in scripts/layers/layers.json:\n` +
					uncovered.map((f) => `  ${f}`).join('\n') +
					'\nClassify each one: platform, magic, site (a glob in layers.json), or add it to tangled/testSupport.',
			);
		}
		if (stale.length > 0) {
			throw new Error(
				`${stale.length} entry(ies) in layers.json name a file that no longer exists:\n` +
					stale.map((f) => `  ${f}`).join('\n') +
					'\nRemove the stale entry — a map that lists a deleted file fails its own staleness check.',
			);
		}
	});
});

describe('layer fence — imports', () => {
	const edges = collectEdges(resolver, allFiles);
	const violations = edges.filter((e) => isViolation(e.fromLayer, e.toLayer));
	const counts = countViolations(violations);

	it('no (from, to) pair crosses more than the baseline allows', () => {
		const risen: string[] = [];
		for (const [pair, count] of Object.entries(counts)) {
			const allowed = baseline.edgeCounts[pair] ?? 0;
			if (count > allowed) risen.push(`${pair}: ${count} now, ${allowed} in baseline.json`);
		}
		if (risen.length === 0) return;

		const byPair = new Map<string, Edge[]>();
		for (const e of violations) {
			const key = `${e.fromLayer}→${e.toLayer}`;
			if (!byPair.has(key)) byPair.set(key, []);
			byPair.get(key)!.push(e);
		}
		const lines: string[] = [`Layer violations rose:\n  ${risen.join('\n  ')}\n`];
		for (const pair of risen.map((r) => r.split(':')[0])) {
			const known = new Set(baseline.edgeKeys[pair] ?? []);
			const pairEdges = byPair.get(pair) ?? [];
			// One line per NEW edge: the count rose, so at least one key here is not in the baseline.
			// (A duplicate import of an already-accepted spec could raise the count with no new KEY —
			// vanishingly rare; shown in full rather than silently, since that is still a real rise.)
			const newEdges = pairEdges.filter((e) => !known.has(edgeKey(e)));
			const toShow = newEdges.length > 0 ? newEdges : pairEdges;
			lines.push(`${pair}:${newEdges.length === 0 ? ' (no single new key found — showing every edge)' : ''}`);
			for (const e of toShow) lines.push(`  ${e.fromFile}:${e.line} imports '${e.spec}' (${pair})`);
		}
		lines.push(
			'\nThree ways out: move the Magic part next to its Magic peers; classify the importing file as' +
				' Magic in layers.json if that is what it is; or put the generic part in a platform file.',
		);
		throw new Error(lines.join('\n'));
	});

	it('no violating edge is new, whatever the count — slack a deleted edge leaves never admits another', () => {
		const fresh = violations.filter((e) => {
			const pair = `${e.fromLayer}→${e.toLayer}`;
			return !(baseline.edgeKeys[pair] ?? []).includes(edgeKey(e));
		});
		if (fresh.length === 0) return;
		throw new Error(
			[
				`${fresh.length} violating import(s) not in baseline.json (counts now: ${JSON.stringify(counts)}):`,
				...fresh.map((e) => `  ${e.fromFile}:${e.line} imports '${e.spec}' (${e.fromLayer}→${e.toLayer})`),
				'\nThree ways out: move the Magic part next to its Magic peers; classify the importing file as' +
					' Magic in layers.json if that is what it is; or put the generic part in a platform file.' +
					'\nIf the edge is an old one whose file was renamed, run `node scripts/layers/baseline.ts' +
					" --accept-rise` and name the rename in the commit.",
			].join('\n'),
		);
	});

	it('a count that FALLS is a pass, not silence — print the baseline-refresh command', () => {
		const fallen = Object.entries(baseline.edgeCounts).filter(([pair, was]) => (counts[pair] ?? 0) < was);
		if (fallen.length > 0) {
			console.log(
				`layer fence: ${fallen.length} pair(s) improved (${fallen.map(([p]) => p).join(', ')}).` +
					' Run `node scripts/layers/baseline.ts` to write the new baseline.',
			);
		}
		expect(true).toBe(true);
	});
});

describe('layer fence — an @hadoku import lands in the file its package exports there', () => {
	it("a platform file may import a mixed package's platform entry, and not its Magic barrel", () => {
		expect(resolvePackageImport('@hadoku/shared/platform', allFiles)).toBe('packages/shared/src/platform.ts');
		expect(resolvePackageImport('@hadoku/shared', allFiles)).toBe('packages/shared/src/index.ts');
		expect(packageImportLayer('@hadoku/shared/platform', resolver, allFiles)).toBe('platform');
		expect(packageImportLayer('@hadoku/shared', resolver, allFiles)).toBe('magic');
		expect(isViolation('platform', 'platform')).toBe(false);
		expect(isViolation('platform', 'magic')).toBe(true);
	});

	it("follows a `./*` pattern export to the one file it names, in each package's own layer", () => {
		expect(resolvePackageImport('@hadoku/game-server/room/session', allFiles)).toBe('packages/game-server/src/room/session.ts');
		expect(packageImportLayer('@hadoku/game-server/room/session', resolver, allFiles)).toBe('platform');
		expect(resolvePackageImport('@hadoku/magic-server/room/lobby', allFiles)).toBe('games/magic/server/src/room/lobby.ts');
		expect(packageImportLayer('@hadoku/magic-server/room/lobby', resolver, allFiles)).toBe('magic');
	});

	it('reads every form a file names a module in, a namespace re-export included', () => {
		const src = [
			"import a from '@x/default';",
			"import type { B } from '@x/type';",
			"import '@x/side-effect';",
			"export * from '@x/star';",
			"export * as ns from '@x/namespace';",
			"export { c } from '@x/named';",
			"import d = require('@x/equals');",
			"const e = await import('@x/dynamic');",
			"const f = require('@x/require');",
			"type G = typeof import('@x/import-type');",
		].join('\n');
		expect(moduleSpecifiers('x.ts', src).map((m) => m.fileName)).toEqual([
			'@x/default', '@x/type', '@x/side-effect', '@x/star', '@x/namespace', '@x/named', '@x/equals', '@x/dynamic', '@x/require', '@x/import-type',
		]);
	});

	it('a subpath no export names falls back to the whole package, the stricter side', () => {
		expect(resolvePackageImport('@hadoku/shared/room-view', allFiles)).toBeNull();
		expect(packageImportLayer('@hadoku/shared/room-view', resolver, allFiles)).toBe('magic');
	});
});

describe('layer fence — tangled is explicit and shrink-only', () => {
	it('tangled is never a glob, and a file can never become newly tangled', () => {
		const { globEntries, newEntries } = checkTangledDiscipline(layers.tangled, baseline.tangled);
		const lines: string[] = [];
		if (globEntries.length > 0) {
			lines.push(
				`${globEntries.length} glob(s) in layers.json's tangled list (it is an exact file list, never a glob):`,
				...globEntries.map((f) => `  ${f}`),
			);
		}
		if (newEntries.length > 0) {
			lines.push(
				`tangled may only shrink; classify the new file as platform/magic/site — ` +
					`${newEntries.length} file(s) in layers.json's tangled are not in baseline.json's tangled list:`,
				...newEntries.map((f) => `  ${f}`),
			);
		}
		if (lines.length > 0) throw new Error(lines.join('\n'));
	});
});

describe('layer fence — licences', () => {
	it('every package whose files are all platform declares MIT; every other one declares GPL-3.0-or-later', () => {
		const mismatches = checkLicences(resolver, allFiles, baseline.pendingLicence);
		if (mismatches.length === 0) return;
		throw new Error(
			`${mismatches.length} package licence mismatch(es):\n` +
				mismatches
					.map((m) => `  ${m.path}: declares "${m.declared}", layer map says "${m.expected}"`)
					.join('\n') +
				'\nFix the package.json licence field, or add the package to baseline.json\'s pendingLicence' +
				' list (it may only shrink).',
		);
	});

	it('pendingLicence may only shrink — a stale entry (no longer mismatched) must be removed', () => {
		const stale = checkStalePendingLicence(resolver, allFiles, baseline.pendingLicence);
		if (stale.length === 0) return;
		throw new Error(
			`${stale.length} pendingLicence entry(ies) no longer mismatch — the relicense happened, so the` +
				' entry is stale and must be removed from baseline.json (pendingLicence may only shrink):\n' +
				stale.map((s) => `  ${s.pkg} (${s.path}) now declares "${s.declared}", which the map already expects`).join('\n'),
		);
	});
});

describe('layer fence — provenance', () => {
	it('no platform file carries a GPL header', () => {
		const violations = checkProvenance(resolver, allFiles);
		if (violations.length === 0) return;
		throw new Error(
			`${violations.length} platform file(s) carry a GPL header:\n` +
				violations.map((v) => `  ${v.file}:${v.line}`).join('\n') +
				'\nA platform file is MIT — remove the GPL header, or reclassify the file if it is not platform.',
		);
	});
});
