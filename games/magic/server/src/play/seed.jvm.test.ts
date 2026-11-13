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
 *   pnpm exec vitest run games/magic/server/src/play/seed.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory as jvmHostFactoryGeneric, liveJvmCount, type MatchSpec } from '@hadoku/game-server/play/host';
import type { BridgeCommand, BridgeLine } from './bridge-protocol.js';
const jvmHostFactory = (config: Parameters<typeof jvmHostFactoryGeneric>[0], options?: Parameters<typeof jvmHostFactoryGeneric>[1]) => jvmHostFactoryGeneric<BridgeLine, BridgeCommand>(config, options);
import { createMatchRegistry, type Match } from './match.js';
import { type WireObj } from './visibility.js';
import { rawStatesOf } from './fixtures/transcript.js';
import { BRIDGE_SOURCE } from '../root.js';

const available = jvmHostConfig(BRIDGE_SOURCE);
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

/** Whether `line` is Forge's prompt bar for `seat`. */
function isPrompt(line: BridgeLine, seat: number): boolean {
	return line.t === 'frame' && line.seat === seat && (line.frame as { method?: string }).method === 'updateButtons';
}

/** Every frame up to `end`, as `s<seat>:<method>`: what a red prints, so it shows where the read fell. */
function frameTrace(raw: readonly BridgeLine[], end: number): string {
	return raw
		.slice(0, end)
		.flatMap((l) => (l.t === 'frame' ? [`s${l.seat}:${(l.frame as { method?: string }).method}`] : []))
		.join(' ');
}

/** Both libraries and both hands, in order, as seat 0 is told them. */
function deal(raw: readonly BridgeLine[]): string {
	const states = rawStatesOf(raw, 0);
	const last = states[states.length - 1];
	if (last === undefined) throw new Error('seat 0 was never sent a state');
	return [0, 1]
		.map((p) => {
			const player = last.get(deltaKey(DELTA_TYPE.player, p));
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

/** One cold match, far enough to have been dealt, then gone: the deal, and the frames up to where it was read. */
async function dealtOnce(): Promise<{ dealt: string; trace: string }> {
	if (!available.ok) throw new Error('unreachable');
	const raw: BridgeLine[] = [];
	const jvm = jvmHostFactory(available.config, { warm: false, log: () => {} });
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
		// exist — so seat 0's first prompt is the signal that seat 0 has been told
		// the deal. Seat 0's own: each seat's frames arrive on that seat's client
		// thread, so the other seat's prompt says nothing of what seat 0 has heard.
		// And read as of that frame, not as of the poll: one fixed point in one
		// seat's stream, the same in both runs.
		await waitUntil(() => raw.some((l) => isPrompt(l, 0)), "seat 0's first prompt", 60_000);
		const at = raw.findIndex((l) => isPrompt(l, 0));
		const dealt = deal(raw.slice(0, at + 1));
		match.stop();
		return { dealt, trace: frameTrace(raw, at + 1) };
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
		console.log(`[seed] ${SEED} run 1:\n${first.dealt}\n[seed] ${SEED} run 2:\n${second.dealt}`);
		// Non-vacuity: a comparison of two empty libraries would pass and prove
		// nothing. A 40-card precon is the smallest deck Forge ships.
		for (const run of [first, second]) expect(run.dealt, `read after: ${run.trace}`).toMatch(/library=(\d+,){39}/);
		expect(second.dealt).toBe(first.dealt);
	}, 400_000);
});
