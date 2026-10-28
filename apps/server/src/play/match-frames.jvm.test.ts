/**
 * The `match-frames` ring against a real 20-turn match: how many decided
 * windows one ordinary game produces, and how many bytes the one log line
 * that carries them weighs.
 *
 * Two creature decks, a driver that plays a land and a creature each main
 * phase and presses OK on every other window it is shown. Nothing attacks, so
 * the game reaches turn 20 by itself. The numbers go to stdout on a
 * `[match-frames]` line, which a green CI runner run keeps in its job log.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/match-frames \
 *   pnpm exec vitest run apps/server/src/play/match-frames.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'the match-frames ring over a real 20-turn match'
	: `the match-frames ring over a real 20-turn match — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [
	deck('Bears', ['20 Forest', '20 Grizzly Bears']),
	deck('Giants', ['20 Mountain', '20 Hill Giant']),
];
const TURNS = 20;

interface Ring {
	evt: 'match-frames';
	frames: { decision: string; seat: number }[];
}

/** One act per forwarded window: a land, then a creature, in the seat's own main phase; OK everywhere else. `acted` holds the windows answered with a card. */
function drive(s: Scenario, acted: Set<number>): void {
	s.answerAsks();
	for (const seat of [0, 1]) {
		const at = s.sent.findLastIndex((x) => x.seat === seat && x.envelope.frame.method === 'showPromptMessage');
		if (at < 0 || acted.has(at) || s.pressed.has(at) || s.buttons(seat)?.enable1 !== true) continue;
		const msg = s.prompt(seat);
		if (/^Cleanup Phase\nSelect \d+ card\(s\) to discard/.test(msg)) {
			acted.add(at);
			const card = s.zone(seat, 'Hand')[0];
			if (card !== undefined) s.select(seat, card.id);
			continue;
		}
		const ownMain = msg.startsWith(`Priority: ${s.names[seat]}`) && /^Phase: Main phase/m.test(msg) && /^Stack: Empty$/m.test(msg);
		if (ownMain) {
			const offer = s.sent.findLast((x) => x.seat === seat && x.envelope.frame.method === 'setWeaklySelectable')?.envelope.frame as
				| { cards: { id: number }[] }
				| undefined;
			const offered = new Set(offer?.cards.map((c) => c.id) ?? []);
			const hand = s.zone(seat, 'Hand').filter((c) => offered.has(c.id));
			const play = hand.find((c) => c.land) ?? hand.find((c) => c.creature);
			if (play !== undefined) {
				acted.add(at);
				s.select(seat, play.id);
				continue;
			}
		}
		s.ok(seat);
	}
}

describe.skipIf(!available.ok)(title, () => {
	it(
		`a ${TURNS}-turn match logs one ring, bounded, both decisions present`,
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 57, decks: DECKS });
			let turn = 0;
			try {
				await finishMulligan(s);
				const acted = new Set<number>();
				await waitUntil(
					() => {
						drive(s, acted);
						turn = Math.max(turn, s.turn(0)?.n ?? 0, s.turn(1)?.n ?? 0);
						return turn >= TURNS || s.match.status !== 'running';
					},
					`turn ${TURNS}`,
					480_000,
					s,
				);
			} finally {
				await s.stop();
			}
			const rings = s.logs.filter((l) => l.evt === 'match-frames') as unknown as Ring[];
			expect(rings).toHaveLength(1);
			const frames = rings[0]?.frames ?? [];
			const bytes = Buffer.byteLength(JSON.stringify(rings[0]));
			const withheld = frames.filter((f) => f.decision === 'withheld').length;
			console.log(
				`[match-frames] turns=${turn} rows=${frames.length} withheld=${withheld} forwarded=${frames.length - withheld} ` +
					`bytes=${bytes} bytesPerRow=${frames.length === 0 ? 0 : Math.round(bytes / frames.length)}`,
			);
			expect(turn).toBeGreaterThanOrEqual(TURNS);
			expect(frames.length).toBeGreaterThan(0);
			expect(frames.length).toBeLessThanOrEqual(500);
			expect(withheld).toBeGreaterThan(0);
			expect(frames.length - withheld).toBeGreaterThan(0);
		},
		600_000,
	);
});
