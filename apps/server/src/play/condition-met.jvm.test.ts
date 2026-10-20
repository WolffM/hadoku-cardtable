/**
 * Which cards' conditions are on, on the wire, against real Forge.
 *
 * The operator, 2026-10-15: "i would like it if the game told you when things like 'metalcraft' are
 * active. other things like threshold, delirium, etc. anything that has some count and matters for
 * the card should somehow indicate as being active." The two seats hold the same conditional cards
 * on opposite sides of each count — seat 0 controls three artifacts and has seven cards of five types
 * in its graveyard and cards in hand; seat 1 controls two artifacts, has six lands in its graveyard
 * and an empty hand — so each kind is asked once met and once not:
 *
 *   metalcraft  Carapace Forger (static `Condition$`), Galvanic Blast in hand (`Count$Metalcraft.4.2`)
 *   threshold   Anurid Barkripper (static `Condition$`)
 *   delirium    Angel of Deliverance (trigger `Delirium$ True`)
 *   hellbent    Gathan Raiders (static `Condition$`) — on for seat 1, off for seat 0
 *   spell mastery  Calculated Dismissal in hand (sub-ability `ConditionPresent$`), Fiery Impulse in hand
 *                  (sub-ability `ConditionCheckSVar$ … GE2` beside its default branch's `LT2`)
 *
 * and never: Grizzly Bears and Lightning Bolt (no condition), Tarmogoyf (a count, not a condition),
 * Arrow Storm with no attack (its "otherwise" branch is always met, and must not light it), Voice
 * of Victory on seat 0's own turn ("during your turn" is timing, not a count) and Starting Town
 * (its "enters tapped unless" count is a drawback, not a bonus).
 * Pulse of the Forge's "if that player has more life than you" names its target, which a card in
 * hand has none of, and Forge's check throws there: that card stays dark and every other card is
 * still read.
 * Seat 1 must not be told about a card in seat 0's hand.
 *
 * The operator, 2026-10-16: "why is the spell mastery condition highlighted here? there are no cards
 * in my gy" — Fiery Impulse in an opening hand. A second game holds it, with Arrow Storm, at turn 1
 * with both graveyards empty: an "instead"'s default branch ("LT2", "EQ0") is met there, and must not
 * light the card; nor must Curious Obsession's "if you didn't attack" (a trigger's `SVarCompare$ EQ0`,
 * which Forge reads from the trigger's own parameters rather than the map it is handed), nor Jeweled
 * Amulet's "activate only if there are no charge counters" (an activation's `SVarCompare$ EQ0`), nor
 * Mythos of Illuna's plain copy (`ConditionManaNotSpent$`, beside its "if {R}{G} was spent"). A lone
 * comparison met at 0 is no default: Bloodghast's haste with the opponent at 10 life (`LE10`) lights.
 *
 * The operator, 2026-10-20: "why is 'Kappa Cannoneer' highlighted in orange? what conditional effect
 * is relevant here that would make it highlight?" — none. Its trigger carries `IsPresent$ Card.Self`,
 * Forge's "only while this card is here", which the card's own presence always meets. A third game
 * holds the cards whose only presence check is the card itself — a trigger's (Kappa Cannoneer,
 * Steelfin Whale), a sub-ability's (Oubliette's `ConditionPresent$ Card.Self`), an activation's
 * (Durkwood Tracker), and Edgar Markov's `Card.StrictlySelf` ("this object, not a new one") — beside a metalcraft card with three artifacts and Guardian Beast, whose
 * "as long as it is untapped" (`Card.Self+untapped`) is a condition the card itself can turn off.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/condition-met \
 *   pnpm exec vitest run apps/server/src/play/condition-met.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Card, type Scenario } from './scenario.js';

const title = available.ok
	? 'condition-met: the frame names the cards whose condition is on, against real Forge'
	: `condition-met: the frame names the cards whose condition is on, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Swamps', ['40 Swamp']), deck('Plains', ['40 Plains'])];

const CONDITIONAL = 'Carapace Forger;Anurid Barkripper;Angel of Deliverance;Gathan Raiders';

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=Galvanic Blast;Calculated Dismissal;Fiery Impulse;Pulse of the Forge;Arrow Storm;Lightning Bolt;Voice of Victory;Starting Town',
	`humanbattlefield=Ornithopter;Ornithopter;Ornithopter;${CONDITIONAL};Grizzly Bears;Tarmogoyf;Swamp`,
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=Swamp;Grizzly Bears;Lightning Bolt;Divination;Ornithopter;Swamp;Swamp',
	'aihand=',
	`aibattlefield=Ornithopter;Ornithopter;${CONDITIONAL};Plains`,
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=Plains;Plains;Plains;Plains;Plains;Plains',
].join('\n');

const EMPTY_GRAVEYARDS = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=10',
	'humanhand=Fiery Impulse;Arrow Storm;Curious Obsession;Jeweled Amulet;Mythos of Illuna;Bloodghast;Mountain',
	'humanbattlefield=',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

const SELF_PRESENCE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Ornithopter;Ornithopter;Kappa Cannoneer;Carapace Forger;Steelfin Whale;Oubliette;Durkwood Tracker;Edgar Markov;Guardian Beast;Swamp',
	'humanlibrary=Swamp;Swamp;Swamp;Swamp;Swamp;Swamp',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

/** The latest `conditionMet` snapshot `seat` was sent, or null when none has been. */
function latestConditionMet(s: Scenario, seat: number): number[] | null {
	const snapshots = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { conditionMet?: number[] } }).payload?.conditionMet)
		.filter((p): p is number[] => Array.isArray(p));
	return snapshots.at(-1) ?? null;
}

function named(cards: readonly Card[], name: string): Card {
	const c = cards.find((x) => x.name === name);
	if (c === undefined) throw new Error(`no ${name} among ${cards.map((x) => x.name).join(', ')}`);
	return c;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'metalcraft, threshold, delirium, hellbent and spell mastery light where they are met and nowhere else; an unconditional card never does',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 82, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Carapace Forger') && s.zone(1, 'Battlefield').some((c) => c.name === 'Gathan Raiders');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const mine = [...s.zone(0, 'Battlefield'), ...s.zone(0, 'Hand')];
				const theirs = s.zone(1, 'Battlefield');
				const on = [
					named(mine, 'Carapace Forger'),
					named(mine, 'Galvanic Blast'),
					named(mine, 'Anurid Barkripper'),
					named(mine, 'Angel of Deliverance'),
					named(mine, 'Calculated Dismissal'),
					named(mine, 'Fiery Impulse'),
					named(theirs, 'Gathan Raiders'),
				];
				const off = [
					named(theirs, 'Carapace Forger'),
					named(theirs, 'Anurid Barkripper'),
					named(theirs, 'Angel of Deliverance'),
					named(mine, 'Gathan Raiders'),
					named(mine, 'Grizzly Bears'),
					named(mine, 'Tarmogoyf'),
					named(mine, 'Lightning Bolt'),
					named(mine, 'Arrow Storm'),
					named(mine, 'Voice of Victory'),
					named(mine, 'Starting Town'),
					named(mine, 'Pulse of the Forge'),
					named(mine, 'Ornithopter'),
				];
				const stderr = join(s.workDir, s.match.id, 'bridge.stderr.txt');
				const failures = existsSync(stderr) ? readFileSync(stderr, 'utf8').split('\n').filter((l) => l.includes('conditionMet')) : [];
				console.log(`[ca-condition-met.jvm] bridge conditionMet failures: ${failures.length} ${JSON.stringify(failures.slice(0, 3))}`);
				expect(failures, 'the bridge read every frame’s cards').toEqual([]);
				const seat0 = latestConditionMet(s, 0);
				const lit = [...mine, ...theirs].filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[ca-condition-met.jvm] seat 0: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const c of on) expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
				for (const c of off) expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);

				const seat1 = latestConditionMet(s, 1);
				console.log(`[ca-condition-met.jvm] seat 1: conditionMet=${JSON.stringify(seat1)}`);
				expect(seat1, 'seat 1 was sent a conditionMet snapshot').not.toBeNull();
				for (const c of on.filter((x) => !s.zone(0, 'Hand').some((h) => h.id === x.id))) expect(seat1, `seat 1 sees ${c.name}#${c.id} on`).toContain(c.id);
				for (const c of s.zone(0, 'Hand')) expect(seat1, `seat 1 is told nothing of ${c.name}#${c.id} in seat 0's hand`).not.toContain(c.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'an "instead" whose bonus is off does not light from its default branch: Fiery Impulse with an empty graveyard',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 84, decks: DECKS, scenario: EMPTY_GRAVEYARDS });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Fiery Impulse');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const hand = s.zone(0, 'Hand');
				const seat0 = latestConditionMet(s, 0);
				const lit = hand.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[cf-condition-met.jvm] empty graveyards: graveyard=${s.zone(0, 'Graveyard').length} conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(s.zone(0, 'Graveyard'), 'seat 0’s graveyard is empty').toEqual([]);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const name of ['Fiery Impulse', 'Arrow Storm', 'Curious Obsession', 'Jeweled Amulet', 'Mythos of Illuna']) {
					const c = named(hand, name);
					expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);
				}
				const bloodghast = named(hand, 'Bloodghast');
				expect(seat0, `Bloodghast#${bloodghast.id} is on with the opponent at 10 life`).toContain(bloodghast.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'a presence check whose only subject is the card itself is not a condition: Kappa Cannoneer on the battlefield stays dark',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 85, decks: DECKS, scenario: SELF_PRESENCE });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Kappa Cannoneer');
				}, 'seat 0 to hold priority in its own main with the scenario applied', 30_000, s);
				const board = s.zone(0, 'Battlefield');
				const seat0 = latestConditionMet(s, 0);
				const lit = board.filter((c) => seat0?.includes(c.id)).map((c) => `${c.name}#${c.id}`);
				console.log(`[cm-condition-met.jvm] self presence: conditionMet=${JSON.stringify(seat0)} → [${lit.join(', ')}]`);
				expect(seat0, 'seat 0 was sent a conditionMet snapshot').not.toBeNull();
				for (const name of ['Kappa Cannoneer', 'Steelfin Whale', 'Oubliette', 'Durkwood Tracker', 'Edgar Markov']) {
					const c = named(board, name);
					expect(seat0, `${c.name}#${c.id} is off`).not.toContain(c.id);
				}
				for (const name of ['Carapace Forger', 'Guardian Beast']) {
					const c = named(board, name);
					expect(seat0, `${c.name}#${c.id} is on`).toContain(c.id);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
