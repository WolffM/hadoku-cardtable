/**
 * Which permanents' type lines are not the printed ones, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: "phyrexian metamorph makes a creature an artifact when it copies it. i
 * would have expect this to show the card type changed. please make sure that any card that changes
 * a cards type is reflected as a pill". The view carries only the current type (`Type`); the bridge's
 * `printedTypes` names the printed one for every battlefield permanent whose line differs.
 *
 * Seat 0 controls Urborg, Tomb of Yawgmoth (every land is a Swamp in addition), an Adarkar Wastes,
 * Changeling Outcast, Grizzly Bears and four Islands, and casts Phyrexian Metamorph copying the Bears.
 * Seat 1 controls a Glacial Fortress. Both seats must be told: the Metamorph copy's printed line is the
 * Bears' (Creature — Bear) while it is an Artifact Creature — Bear; both nonbasic lands' printed line is
 * a bare Land; and neither the original Bears nor the Outcast (its every creature type is its own
 * Changeling, printed) is named.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/printed-types \
 *   pnpm exec vitest run apps/server/src/play/printed-types.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'printed-types: the frame names each changed permanent’s printed type, against real Forge'
	: `printed-types: the frame names each changed permanent’s printed type, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Phyrexian Metamorph',
	'humanbattlefield=Urborg, Tomb of Yawgmoth;Adarkar Wastes;Changeling Outcast;Grizzly Bears;Island;Island;Island;Island',
	'humanlibrary=Island;Island;Island;Island;Island;Island',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Glacial Fortress',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

interface CardType {
	t: 'cardtype';
	sup: string[];
	core: string[];
	sub: string[];
	all: boolean;
	exc: string[];
}

/** The latest `printedTypes` snapshot `seat` was sent, as a map, or null when none has been. */
function latestPrintedTypes(s: Scenario, seat: number): Map<number, CardType> | null {
	const snapshots = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { printedTypes?: [number, CardType][] } }).payload?.printedTypes)
		.filter((p): p is [number, CardType][] => Array.isArray(p));
	const last = snapshots.at(-1);
	return last === undefined ? null : new Map(last);
}

const line = (t: CardType | undefined): string | undefined => (t === undefined ? undefined : `${[...t.sup, ...t.core].join(' ')}${t.sub.length > 0 ? ` — ${t.sub.join(' ')}` : ''}`);

describe.skipIf(!available.ok)(title, () => {
	it(
		'a Metamorph copy of Grizzly Bears was printed Creature — Bear; Urborg’s Swamps were printed Land, on both sides; Bears and a changeling are not named',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 85, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Phyrexian Metamorph');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				s.select(0, s.zone(0, 'Hand').find((c) => c.name === 'Phyrexian Metamorph')!.id);
				// Its cost is paid by Forge's own Auto (button one on the payment prompt), the copy
				// replacement is Forge's InputConfirm, where button one is yes, and the card to copy is a
				// battlefield selection.
				const pressed = new Set<number>();
				await waitUntil(() => {
					s.answerAsks();
					const at = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
					const msg = at < 0 ? '' : (s.sent[at]!.envelope.frame as unknown as { message: string }).message;
					if (!pressed.has(at) && /Pay Mana Cost|Apply replacement effect/.test(msg) && s.buttons(0)?.enable1 === true) {
						pressed.add(at);
						console.log(`[tl-printed-types.jvm] seat 0 presses OK on ${JSON.stringify(msg.split('\n')[0])}`);
						s.ok(0);
					}
					// What to copy is Forge's card selection on the battlefield ("Choose a card"): the Bears.
					if (!pressed.has(at) && /Choose a card/.test(msg)) {
						pressed.add(at);
						console.log(`[tl-printed-types.jvm] seat 0 chooses the Bears #${bears.id} to copy`);
						s.select(0, bears.id);
					}
					return s.zone(0, 'Battlefield').filter((c) => c.name === 'Grizzly Bears').length === 2;
				}, 'the Metamorph to enter as a copy of the Bears', 30_000, s).catch((e: unknown) => {
					const asks = s.asks.map((a) => `${a.method}${JSON.stringify((a as unknown as { optionList?: unknown }).optionList ?? '')}`);
					console.log(`[tl-printed-types.jvm] no copy: bears #${bears.id}; seat 0 battlefield [${s.zone(0, 'Battlefield').map((c) => `${c.name}#${c.id}`).join(', ')}]; asks [${asks.join(' | ')}]; prompt ${JSON.stringify(s.prompt(0))}`);
					throw e;
				});
				const board = s.zone(0, 'Battlefield');
				const copy = board.find((c) => c.name === 'Grizzly Bears' && c.id !== bears.id)!;
				const wastes = board.find((c) => c.name === 'Adarkar Wastes')!;
				const outcast = board.find((c) => c.name === 'Changeling Outcast')!;
				const fortress = s.zone(1, 'Battlefield').find((c) => c.name === 'Glacial Fortress')!;
				await waitUntil(() => {
					s.answerAsks();
					return [0, 1].every((seat) => latestPrintedTypes(s, seat)?.has(copy.id) === true);
				}, 'both seats to be sent a printedTypes snapshot naming the copy', 10_000, s).catch(() => undefined);
				for (const seat of [0, 1]) {
					const printed = latestPrintedTypes(s, seat);
					const named = [...(printed?.entries() ?? [])].map(([id, t]) => `#${id}=${line(t)}`).join(', ');
					console.log(`[tl-printed-types.jvm] seat ${seat}: printedTypes {${named}}; copy #${copy.id}, bears #${bears.id}, wastes #${wastes.id}, fortress #${fortress.id}, outcast #${outcast.id}`);
					expect(printed, `seat ${seat} was sent a printedTypes snapshot`).not.toBeNull();
					expect(line(printed!.get(copy.id)), `seat ${seat}: the Metamorph copy was printed as the Bears`).toBe('Creature — Bear');
					expect(line(printed!.get(wastes.id)), `seat ${seat}: Urborg made seat 0’s Adarkar Wastes a Swamp`).toBe('Land');
					expect(line(printed!.get(fortress.id)), `seat ${seat}: Urborg made seat 1’s Glacial Fortress a Swamp`).toBe('Land');
					expect(printed!.has(bears.id), `seat ${seat}: the original Bears is unchanged`).toBe(false);
					expect(printed!.has(outcast.id), `seat ${seat}: a changeling’s every creature type is printed`).toBe(false);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
