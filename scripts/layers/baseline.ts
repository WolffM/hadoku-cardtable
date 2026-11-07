#!/usr/bin/env node
/**
 * Writes `scripts/layers/baseline.json` from the current tree: today's violating-edge counts per
 * (from, to) layer pair, the stable key of each one (`edgeKeys`, no line numbers — a line shifting
 * elsewhere in the file must never look like a new edge), the `tangled` snapshot, and
 * `pendingLicence`.
 *
 * **This is a ratchet, not a snapshot tool.** If any pair's count would RISE, or any edge key is
 * not in the baseline already on disk, this refuses: it prints those edges (file:line, the same
 * shape the test's own failure message uses) and exits 1 WITHOUT WRITING anything — so a session
 * that meets a red cannot "fix" it by running this command. `--accept-rise` overrides the refusal
 * and writes the risen state as the new baseline; it exists for the tracker reclassifying a file
 * (moving an edge from `tangled`/`magic` debt to a deliberately-accepted baseline entry), never for
 * a session that just added a new import and wants the red to go away.
 *
 * Both `tangled` and `pendingLicence` only ever SHRINK here, independently of the ratchet above —
 * a fall in either is always written, never refused:
 * - `tangled`: the new value is the intersection of the PREVIOUS baseline's tangled list and
 *   `layers.json`'s current one. An entry `layers.json` dropped (untangled) drops here too; an
 *   entry `layers.json` ADDED is never written — the ratchet fails on it instead, because a file
 *   can never become newly tangled. The very first run (no `tangled` field on disk yet) seeds the
 *   snapshot from `layers.json` as it stands, since there is nothing yet to intersect against.
 * - `pendingLicence`: the new value is the previous list filtered down to entries that STILL
 *   mismatch. This script never adds an entry — only a lane that hits the licence check's failure
 *   adds one, by hand, to this file directly, which is the one place that can grow it, and only in
 *   the same commit that explains why.
 *
 * The one command the ratchet's failure message names when a count FALLS and the map is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { BASELINE_JSON_PATH, buildResolver, loadLayers } from './classify.ts';
import {
	checkCoverage,
	checkStalePendingLicence,
	checkTangledDiscipline,
	collectEdges,
	countViolations,
	edgeKey,
	groupEdgeKeysByPair,
	isViolation,
	listSourceFiles,
	type Edge,
} from './scan.ts';

function main(): void {
	const acceptRise = process.argv.includes('--accept-rise');

	const layers = loadLayers();
	const resolver = buildResolver(layers);
	const allFiles = listSourceFiles();

	const coverage = checkCoverage(resolver, allFiles);
	if (coverage.uncovered.length > 0) {
		console.error(`baseline: ${coverage.uncovered.length} file(s) have no layer. Fix layers.json first:`);
		for (const f of coverage.uncovered) console.error(`  ${f}`);
		process.exit(1);
	}
	if (coverage.stale.length > 0) {
		console.error(`baseline: ${coverage.stale.length} map entry(ies) name a file that no longer exists:`);
		for (const f of coverage.stale) console.error(`  ${f}`);
		process.exit(1);
	}
	const globTangled = checkTangledDiscipline(layers.tangled, layers.tangled).globEntries;
	if (globTangled.length > 0) {
		console.error(`baseline: tangled is an explicit file list, never a glob:`);
		for (const f of globTangled) console.error(`  ${f}`);
		process.exit(1);
	}

	const edges = collectEdges(resolver, allFiles);
	const violations = edges.filter((e) => isViolation(e.fromLayer, e.toLayer));
	const edgeCounts = countViolations(violations);
	const edgeKeys = groupEdgeKeysByPair(violations);

	let prevRaw: {
		edgeCounts?: Record<string, number>;
		edgeKeys?: Record<string, string[]>;
		tangled?: string[];
		pendingLicence?: string[];
	} = {};
	try {
		prevRaw = JSON.parse(readFileSync(BASELINE_JSON_PATH, 'utf8'));
	} catch {
		// no existing baseline — first run
	}
	const prevEdgeCounts = prevRaw.edgeCounts ?? {};
	const prevEdgeKeys = prevRaw.edgeKeys ?? {};

	// The ratchet: a pair whose count rose, OR whose edge-key set gained a key not seen before
	// (possible with the count unchanged, if one known edge dropped while a new one appeared) —
	// either way, something here was never reviewed, and `--accept-rise` is the only way past it.
	const risenPairs = new Set<string>();
	for (const [pair, count] of Object.entries(edgeCounts)) {
		if (count > (prevEdgeCounts[pair] ?? 0)) risenPairs.add(pair);
	}
	for (const [pair, keys] of Object.entries(edgeKeys)) {
		const known = new Set(prevEdgeKeys[pair] ?? []);
		if (keys.some((k) => !known.has(k))) risenPairs.add(pair);
	}

	if (risenPairs.size > 0 && !acceptRise) {
		const byPair = new Map<string, Edge[]>();
		for (const e of violations) {
			const pair = `${e.fromLayer}→${e.toLayer}`;
			if (!byPair.has(pair)) byPair.set(pair, []);
			byPair.get(pair)!.push(e);
		}
		console.error(
			`baseline: refused — ${risenPairs.size} pair(s) rose, and this would accept a NEW violation:`,
		);
		for (const pair of [...risenPairs].sort()) {
			const now = edgeCounts[pair] ?? 0;
			const was = prevEdgeCounts[pair] ?? 0;
			console.error(`  ${pair}: ${now} now, ${was} in baseline.json`);
			const known = new Set(prevEdgeKeys[pair] ?? []);
			const pairEdges = byPair.get(pair) ?? [];
			const newEdges = pairEdges.filter((e) => !known.has(edgeKey(e)));
			for (const e of newEdges.length > 0 ? newEdges : pairEdges) {
				console.error(`    ${e.fromFile}:${e.line} imports '${e.spec}' (${pair})`);
			}
		}
		console.error(
			'\nFix the import (move the Magic part next to its Magic peers, classify the importing file as' +
				' Magic, or put the generic part in a platform file) and re-run with no flag. `--accept-rise`' +
				" is for the tracker deliberately reclassifying a file's debt, never for a session's new import.",
		);
		process.exit(1);
	}

	// tangled: intersect with the previous snapshot (shrink-only); seed from layers.json only the
	// very first time this file gets a `tangled` field at all.
	const hadTangledField = Object.prototype.hasOwnProperty.call(prevRaw, 'tangled');
	const prevTangled = prevRaw.tangled ?? [];
	const tangled = hadTangledField ? layers.tangled.filter((f) => prevTangled.includes(f)) : [...layers.tangled];
	const droppedFromTangled = prevTangled.filter((f) => !tangled.includes(f));
	const refusedNewTangled = hadTangledField ? checkTangledDiscipline(layers.tangled, prevTangled).newEntries : [];

	// pendingLicence: filter the previous list down to entries that still mismatch. Never adds.
	const prevPendingLicence = prevRaw.pendingLicence ?? [];
	const stale = new Set(checkStalePendingLicence(resolver, allFiles, prevPendingLicence).map((s) => s.pkg));
	const pendingLicence = prevPendingLicence.filter((p) => !stale.has(p));

	const out = { edgeCounts, edgeKeys, tangled, pendingLicence };
	writeFileSync(BASELINE_JSON_PATH, JSON.stringify(out, null, '\t') + '\n');

	const total = Object.values(edgeCounts).reduce((a, b) => a + b, 0);
	console.log(`baseline.json written: ${total} violating edge(s) across ${Object.keys(edgeCounts).length} pair(s).`);
	for (const [k, v] of Object.entries(edgeCounts).sort()) console.log(`  ${k}: ${v}`);
	if (acceptRise && risenPairs.size > 0) console.log(`  (--accept-rise: wrote ${risenPairs.size} risen pair(s))`);
	console.log(`tangled: ${tangled.length} file(s)${hadTangledField ? '' : ' (seeded from layers.json)'}`);
	if (droppedFromTangled.length > 0) console.log(`  dropped (untangled): ${droppedFromTangled.join(', ')}`);
	if (refusedNewTangled.length > 0) {
		console.log(
			`  REFUSED to add (not in the previous baseline — classify as platform/magic/site instead): ${refusedNewTangled.join(', ')}`,
		);
	}
	console.log(`pendingLicence: ${pendingLicence.length ? pendingLicence.join(', ') : '(none)'}`);
	if (stale.size > 0) console.log(`  dropped (no longer mismatched): ${[...stale].join(', ')}`);
}

main();
