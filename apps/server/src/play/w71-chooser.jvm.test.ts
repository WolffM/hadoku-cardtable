/**
 * Wave 71 §E — the play/draw chooser on a fresh match, against a real Forge.
 *
 * MEASUREMENT (step 1 of the brief, recorded here rather than as a separate
 * commit since this lane lands as one): every game we host is a fresh Forge
 * `Match`, so `GameAction.determineFirstTurnPlayer`
 * (`forge/forge-game/src/main/java/forge/game/GameAction.java:2364-2416`) always
 * takes the `isFirstGame` branch — `goesFirst = Aggregates.random(game.getPlayers())`
 * — rather than the "loser of the last game" branch, because `lastGameOutcome`
 * is always null for us (`docs/planning/wave71-2026-10-17.md` §"Settled": each
 * game of a series is a fresh Forge match). `goesFirst` is then asked
 * `goesFirst.getController().chooseStartingPlayer(isFirstGame)`.
 *
 * On the wire, that ask is Forge's `IGuiGame.updateButtons` with
 * `label1:'Play', label2:'Draw', enable1:true, enable2:true`
 * (`packages/forge-wire/src/tier-b.ts:301-311`), sent to ONE seat only — the one
 * `goesFirst` resolved to. `apps/server/src/play/match.ts`'s `noteCoinToss`
 * (:1952-1965) watches every seat's frames for exactly that shape and records
 * `this.coinToss = { winner: s.seat, at }` the first time it sees one, which
 * `seatIdentities()` (:1449) publishes on `forge:seats` as `coinToss`.
 * `apps/ui/src/play/live/match.ts:1412-1413` reads `coinToss` off `forge:seats`
 * and `apps/ui/src/play/live/LiveBoard.tsx` draws `CoinToss` from it — so the
 * ask reaches the browser as data the client already trusts, not as a frame it
 * parses itself. Since 2026-10-19 a match that names its chooser reports no
 * coin at all — nothing was tossed (the operator: "it should ask the opponent
 * if they want to go first not flip a coin") — and the other seat reads the
 * named seat's open question as an ordinary wait. This file reads the raw
 * frames, so it proves which seat Forge asks either way.
 *
 * `MatchSpec.chooser` (`host.ts`) flows to `config.json` unchanged, like every
 * other spec field (`bridgeConfig` just spreads the spec). `PlayBridge.java`'s
 * `configFrom` reads it into the static `chooser` field, and `startMatch` — when
 * it is set — wraps the shared `MyRandom` in `RiggedCoinToss`, whose doc comment
 * has the full case for why forcing exactly one `nextInt(2)` call, gated on the
 * caller being `forge.util.Aggregates.random`, is enough: `forge/` is untouched
 * and no fork pin changes.
 *
 * SKIPS without a Forge build, like every `*.jvm.test.ts`. To run it (serially,
 * under the heavy lock — fifteen-plus cold matches):
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/w71-chooser.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from './host.js';
import { createMatchRegistry } from './match.js';

const available = jvmHostConfig();
const title = available.ok
	? 'wave 71 chooser: who Forge asks play-or-draw'
	: `wave 71 chooser: who Forge asks play-or-draw — SKIPPED: ${available.reason}`;

/** Five fixed seeds. The first is `seed.jvm.test.ts`'s own, for continuity with its evidence. */
const SEEDS = [20260918, 20261011, 20261012, 20261013, 20261014];

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

/** Forge's own `IGuiGame.updateButtons` for the play/draw ask — see this file's header. */
function isPlayOrDraw(frame: unknown): boolean {
	const f = frame as { method?: string; label1?: string; label2?: string; enable1?: boolean; enable2?: boolean } | null;
	return f?.method === 'updateButtons' && f.label1 === 'Play' && f.label2 === 'Draw' && f.enable1 === true && f.enable2 === true;
}

function spec(seed: number, chooser: 0 | 1 | undefined): MatchSpec {
	return {
		seed,
		...(chooser === undefined ? {} : { chooser }),
		seats: [
			{ name: 'Seat 1', ai: false, deck: precon('Spirit Flames') },
			{ name: 'Seat 2', ai: false, deck: precon('Decay') },
		],
	};
}

/** One cold match, run to the play-or-draw ask: which seat Forge asked. */
async function askedSeat(seed: number, chooser: 0 | 1 | undefined): Promise<number> {
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
		const match = registry.create(spec(seed, chooser));
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });
		await waitUntil(
			() => raw.some((l) => l.t === 'frame' && isPlayOrDraw(l.frame)),
			'the play-or-draw ask',
			60_000,
		);
		const asked = raw.find((l): l is BridgeLine & { t: 'frame'; seat: number } => l.t === 'frame' && isPlayOrDraw(l.frame));
		if (asked === undefined) throw new Error('unreachable: waitUntil just confirmed this exists');
		match.stop();
		return asked.seat;
	} finally {
		jvm.reapOnExit();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
	}
}

describe.skipIf(!available.ok)(title, () => {
	for (const seed of SEEDS) {
		it(`chooser 0, seed ${seed} — Forge asks seat 0`, async () => {
			if (!available.ok) return;
			await expect(askedSeat(seed, 0)).resolves.toBe(0);
		}, 180_000);

		it(`chooser 1, seed ${seed} — Forge asks seat 1`, async () => {
			if (!available.ok) return;
			await expect(askedSeat(seed, 1)).resolves.toBe(1);
		}, 180_000);

		it(`absent, seed ${seed} — still a real ask, no crash, byte-identical code path`, async () => {
			if (!available.ok) return;
			const winner = await askedSeat(seed, undefined);
			expect([0, 1]).toContain(winner);
		}, 180_000);
	}

	// Belt and suspenders on top of the per-seed loop above: `chooser` absent never
	// enters `startMatch`'s `if (chooser != null)` branch at all (plain `git diff`
	// shows that branch untouched by any other read), so the toss is exactly the
	// pre-wave-71 seeded one — which a fixed seed must reproduce run over run.
	it('absent is deterministic run over run, for one fixed seed (the untouched path)', async () => {
		if (!available.ok) return;
		const first = await askedSeat(SEEDS[0], undefined);
		const second = await askedSeat(SEEDS[0], undefined);
		expect(second).toBe(first);
	}, 300_000);
});
