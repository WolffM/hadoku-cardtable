/**
 * One seed, one deal — against a real Forge, twice.
 *
 * `MatchSpec.seed` is the only thing standing between `e2e/play.spec.ts` and a
 * new game every run, and for two waves it was believed to work on the
 * strength of two lucky runs. It was also, separately, claimed NOT to work
 * (wave 22's close: "our bridge never applies the seed"). Both readings came
 * from reading code. This measures it.
 *
 * What it proves: two cold matches on one seed put both libraries in the same
 * order. The library a seat is told about is a list of card IDS, and Forge
 * mints those ids in the deck's own order as it fills the zone
 * (`Match.preparePlayerZone` → `Card.fromPaperCard`) — so the id list IS the
 * shuffle's permutation, and comparing it compares the deal itself rather than
 * a summary of it. A seed that did not reach `MyRandom` would show two
 * different permutations here; the pre-shuffle order cannot hide a difference,
 * because it is the same both times by construction.
 *
 * Mutation-tested (2026-09-27): with `MyRandom.setRandom` skipped in
 * `PlayBridge.startMatch` — `if (seed != null && false)` — the two runs come
 * back with different permutations for both seats and this fails; restored, it
 * passes. So it is measuring the seed, not the fact that two runs of the same
 * program agree.
 *
 * SKIPS without a Forge build, like every `*.jvm.test.ts`. To run it:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   pnpm exec vitest run apps/server/src/play/seed.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import { keyOf, TYPE, type WireObj } from './visibility.js';
import { rawStatesOf } from './fixtures/transcript.js';

const available = jvmHostConfig();
const title = available.ok ? 'one seed, one deal' : `one seed, one deal — SKIPPED: ${available.reason}`;

const SEED = 20260918;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

/** A zone list on a PlayerView, as the wire codec shapes it: `{ v: [{ v: id }] }`. */
function zoneIds(player: WireObj | undefined, zone: string): number[] {
	const v = player?.[zone] as { v?: { v: number }[] } | undefined;
	return Array.isArray(v?.v) ? v.v.map((x) => x.v) : [];
}

/** Both libraries and both hands, in order, as seat 0 is told them. */
function deal(raw: readonly BridgeLine[]): string {
	const states = rawStatesOf(raw, 0);
	const last = states[states.length - 1];
	if (last === undefined) throw new Error('seat 0 was never sent a state');
	return [0, 1]
		.map((p) => {
			const player = last.get(keyOf(TYPE.player, p));
			return `p${p} hand=${zoneIds(player, 'Hand').join(',')} library=${zoneIds(player, 'Library').join(',')}`;
		})
		.join('\n');
}

const spec = (): MatchSpec => ({
	seed: SEED,
	seats: [
		{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
		{ name: 'Seat 2', ai: false, deck: precon('Decay') },
	],
});

/** One cold match, far enough to have been dealt, then gone. */
async function dealtOnce(): Promise<string> {
	if (!available.ok) throw new Error('unreachable');
	const raw: BridgeLine[] = [];
	const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
	try {
		const registry = createMatchRegistry({
			host: (id, s, events) =>
				jvm(id, s, {
					...events,
					line: (l) => {
						raw.push(l);
						events.line(l);
					},
				}),
			log: () => {},
			overGraceMs: 60_000,
			emit: () => {},
		});
		const match: Match = registry.create(spec());
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });
		// Forge opens with the coin toss, which it cannot ask before the libraries
		// exist — so a prompt is the signal that there is a deal to read.
		await waitUntil(
			() => raw.some((l) => l.t === 'frame' && (l.frame as { method?: string }).method === 'updateButtons'),
			'the first prompt',
			60_000,
		);
		const dealt = deal(raw);
		match.stop();
		return dealt;
	} finally {
		jvm.reapOnExit();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
	}
}

describe.skipIf(!available.ok)(title, () => {
	it('deals the same library order twice', async () => {
		if (!available.ok) return;
		const first = await dealtOnce();
		const second = await dealtOnce();
		console.log(`[seed] ${SEED} run 1:\n${first}\n[seed] ${SEED} run 2:\n${second}`);
		// Non-vacuity: a comparison of two empty libraries would pass and prove
		// nothing. A 40-card precon is the smallest deck Forge ships.
		expect(first).toMatch(/library=(\d+,){39}/);
		expect(second).toBe(first);
	}, 400_000);
});
