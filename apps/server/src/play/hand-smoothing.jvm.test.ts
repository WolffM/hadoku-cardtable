/**
 * Hand smoothing (`MatchSpec.handSmoothing`), against a real Forge.
 *
 * The bridge turns the room's setting into Forge's filtered hands, and our fork's
 * `forge.game.mulligan.HandSmoothing` does the rest: before the opening seven is
 * drawn a second candidate is shuffled up and the one whose land count is closer
 * to the library's ratio is kept outright; before each mulligan's redraw the same
 * two candidates are weighed, each kept with odds `1 / (1 + distance)`.
 *
 * Both decks are 20 Forest and 20 Grizzly Bears, so the ratio is exactly one
 * half and a land is a card named Forest.
 *
 * **The opening hand is measured exactly.** Smoothing runs after the libraries
 * are shuffled, so on one seed the smoothed run's first candidate IS the hand the
 * unsmoothed run deals. Keeping the closer of it and another can only hold or
 * improve the distance — for every seat on every seed — and the seeds below
 * include deals where it strictly improves.
 *
 * **The mulligan is measured as engaged, not as a distribution.** A weighted pick
 * may keep either candidate, so no single deal says it worked. What one seed does
 * say: from an identical opening, an unsmoothed run redraws the same hands every
 * time, and a smoothed run (which shuffles a second candidate and draws a weight
 * each time) redraws different ones. The weighting itself is arithmetic — for
 * this deck the expected distance of a redraw is 0.92 lands unsmoothed and 0.77
 * weighted (0.51 strict) — and would take hundreds of real redraws to see.
 *
 * SKIPS without a Forge build, like every `*.jvm.test.ts`:
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/hand-smoothing.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema, deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';
import { createMatchRegistry } from './match.js';
import { foldFrames, type StateFrame, type WireObj } from './visibility.js';
import type { ServerEnvelope } from '@hadoku/shared';

const available = jvmHostConfig();
const title = available.ok ? 'hand smoothing, against real Forge' : `hand smoothing, against real Forge — SKIPPED: ${available.reason}`;

const DECK = '[metadata]\nName=Half lands\n[main]\n20 Forest\n20 Grizzly Bears\n';
const EXPECTED_LANDS = 3.5;
/** Seat 0's mulligans in the mulligan runs; each is one more redraw to compare. */
const MULLIGANS = 3;

interface Hand {
	ids: number[];
	lands: number;
}

const distance = (h: Hand): number => Math.abs(h.lands - EXPECTED_LANDS);

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/**
 * Every hand each seat is asked to keep, in order: the opening seven first, then
 * one per mulligan. Seat 0 mulligans `mulligans` times; everyone else keeps.
 */
async function handsDealt(seed: number, handSmoothing: boolean, mulligans: number): Promise<[Hand[], Hand[]]> {
	if (!available.ok) throw new Error('unreachable');
	const sent: { seat: number; envelope: ServerEnvelope }[] = [];
	const jvm = jvmHostFactory(available.config, { warm: false, log: () => {} });
	try {
		const registry = createMatchRegistry({
			host: (id, spec, events) => jvm(id, spec, events),
			log: () => {},
			overGraceMs: 60_000,
			emit: (_m, seat, envelope) => sent.push({ seat, envelope }),
		});
		const match = registry.create({
			seed,
			handSmoothing,
			seats: [
				{ name: 'A', ai: false, deck: DECK },
				{ name: 'B', ai: false, deck: DECK },
			],
		});
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });

		/** The seat's own hand as it stood when frame `upTo` was sent. */
		const handAt = (seat: number, upTo: number): Hand => {
			const state = foldFrames(
				sent
					.slice(0, upTo + 1)
					.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as StateFrame)
					.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
			);
			const player = state.get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1)) as unknown as
				| Record<string, { v?: { v: number }[] }>
				| undefined;
			const ids = (player?.['Hand']?.v ?? []).map((x) => x.v);
			const lands = ids.filter((id) => {
				const view = state.get(deltaKey(DELTA_TYPE.card, id));
				const current = (view?.CurrentState as { v?: number } | undefined)?.v ?? 0;
				const face: WireObj | undefined = state.get(deltaKey(DELTA_TYPE.cardState, id * 16 + current));
				return (face?.Name as { v?: string } | undefined)?.v === 'Forest';
			}).length;
			return { ids, lands };
		};

		const hands: [Hand[], Hand[]] = [[], []];
		const prompts: string[] = [];
		const press = (seat: number, method: 'selectButtonOk' | 'selectButtonCancel'): void => {
			expect(match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method }))).toEqual({ ok: true });
		};
		const handled = new Set<number>();
		const done = (): boolean => hands[0].length > mulligans && hands[1].length > 0;
		const deadline = Date.now() + 90_000;
		while (!done() && Date.now() < deadline) {
			// Each seat's LATEST prompt only, and once: an earlier one has been answered or replaced.
			for (const seat of [0, 1]) {
				const at = sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
				if (at < 0 || handled.has(at)) continue;
				const buttons = sent.slice(0, at + 1).findLast((x) => x.seat === seat && x.envelope.frame.method === 'updateButtons')
					?.envelope.frame as unknown as { enable1?: boolean } | undefined;
				const message = (sent[at]!.envelope.frame as unknown as { message: string }).message;
				if (/keep your hand/i.test(message)) {
					handled.add(at);
					prompts.push(`${seat}: ${message}`);
					const hand = handAt(seat, at);
					expect(hand.ids, `seat ${seat}'s hand at a keep prompt`).toHaveLength(7);
					hands[seat]!.push(hand);
					press(seat, seat === 0 && hands[0].length <= mulligans ? 'selectButtonCancel' : 'selectButtonOk');
				} else if (buttons?.enable1 === true) {
					// Play or draw, and whatever else stands before the keep: take the default.
					handled.add(at);
					prompts.push(`${seat}: ${message}`);
					press(seat, 'selectButtonOk');
				}
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(done(), `hands seen before the deadline: ${JSON.stringify(hands)}; prompts answered: ${JSON.stringify(prompts)}`).toBe(true);
		match.stop();
		return hands;
	} finally {
		jvm.reapOnExit();
		await waitUntil(() => liveJvmCount() === 0, 'the JVM to exit', 20_000);
	}
}

describe.skipIf(!available.ok)(title, () => {
	it('keeps an opening hand at least as close to the land ratio as the deal it replaces, for every seat', async () => {
		const SEEDS = [7, 11, 20260918];
		let improved = 0;
		for (const seed of SEEDS) {
			const [off, on] = [await handsDealt(seed, false, 0), await handsDealt(seed, true, 0)];
			for (const seat of [0, 1]) {
				const [plain, smoothed] = [off[seat]![0]!, on[seat]![0]!];
				console.log(`[smoothing] seed ${seed} seat ${seat}: ${plain.lands} lands unsmoothed, ${smoothed.lands} smoothed`);
				expect(distance(smoothed), `seed ${seed} seat ${seat}`).toBeLessThanOrEqual(distance(plain));
				if (distance(smoothed) < distance(plain)) improved++;
			}
		}
		// Non-vacuity: on none of these deals did smoothing just hand back the same hand.
		expect(improved).toBeGreaterThan(0);
	}, 600_000);

	it("draws a mulligan's redraw differently with smoothing on, from the same opening hand", async () => {
		// Seed 11 keeps seat 0's first candidate under smoothing, so both runs
		// mulligan from one and the same library: only the redraws can differ.
		const SEED = 11;
		const plain = await handsDealt(SEED, false, MULLIGANS);
		const again = await handsDealt(SEED, false, MULLIGANS);
		const smoothed = await handsDealt(SEED, true, MULLIGANS);
		const redraws = (hands: Hand[]): number[][] => hands.slice(1).map((h) => h.ids);
		console.log(
			`[smoothing] seed ${SEED} seat 0 lands per hand: unsmoothed ${plain[0].map((h) => h.lands).join(',')}, smoothed ${smoothed[0].map((h) => h.lands).join(',')}`,
		);
		expect(smoothed[0][0]!.ids, 'both runs open on the same hand').toEqual(plain[0][0]!.ids);
		// The control: without smoothing, one seed is one sequence of redraws.
		expect(redraws(again[0])).toEqual(redraws(plain[0]));
		expect(redraws(smoothed[0])).not.toEqual(redraws(plain[0]));
	}, 600_000);
});
