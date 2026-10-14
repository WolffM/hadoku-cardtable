/**
 * A modal spell's targets, on the wire, against real Forge.
 *
 * A charm or a Command is one `SpellAbility` (`CharmEffect`) whose chosen modes are chained under
 * it as sub-abilities (`CharmEffect.chainAbilities`). The stack item Forge publishes is the root's:
 * its own `TargetCards`/`TargetPlayers` and `TargetChoices` are the root's, which targets nothing.
 * Each chosen mode's targets live one `SubInstance` down (`SpellAbilityStackInstance.getSubInstance`,
 * `StackItemView.updateSubInstance`) — Forge's own desktop arrows walk that chain
 * (`TargetingOverlay.java`). The operator, 2026-10-11: "izzet charm should have produced an arrow
 * here targeting muddle the mixture, but it didn't."
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/modal-targets.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, inOwnMain, landPayer, scenarioText, startScenario, strOf, waitUntil, type Scenario } from './scenario.js';
import { TYPE, type WireObj } from './visibility.js';

const title = available.ok ? 'a modal spell’s targets reach the wire, against real Forge' : `a modal spell’s targets, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/** The stack item `id` and every sub-instance under it, in chain order. */
function chainOf(state: Map<string, WireObj>, id: number): WireObj[] {
	const byId = new Map([...state.values()].filter((o) => o._type === TYPE.stackItem).map((o) => [o._id, o]));
	const out: WireObj[] = [];
	for (let at = byId.get(id); at !== undefined && !out.includes(at); ) {
		out.push(at);
		const sub = (at['SubInstance'] as { v?: unknown } | undefined)?.v;
		at = typeof sub === 'number' ? byId.get(sub) : undefined;
	}
	return out;
}

function stackOf(s: Scenario, seat: number): number[] {
	const game = [...s.state(seat).values()].find((o) => o._type === TYPE.game);
	return idsOf(game, 'Stack');
}

function describeChain(chain: WireObj[]): string {
	return chain.map((o) => `#${o._id} "${strOf(o, 'Description') ?? ''}" cards=[${idsOf(o, 'TargetCards')}] players=[${idsOf(o, 'TargetPlayers')}]`).join(' → ');
}

/** The latest `stackTargetSpells` snapshot `seat` was sent. */
function latestStackTargets(s: Scenario, seat: number): [number, number][] {
	const frames = s.sent
		.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
		.map((x) => (x.envelope.frame as unknown as { payload?: { stackTargetSpells?: [number, number][] } }).payload?.stackTargetSpells)
		.filter((p): p is [number, number][] => Array.isArray(p));
	return frames.at(-1) ?? [];
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Izzet Charm’s counter mode pairs the charm with the spell it targets, for both seats',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 7,
				decks: DECKS,
				scenario: scenarioText('modal-charm'),
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string; label?: string }[];
					// The mode by its words; the counter's target ask is optional on the wire ("up to 1"), so the plain answer would be none.
					const counter = choices.find((c) => /counter target noncreature/i.test(c.label ?? ''));
					if (counter !== undefined) return [counter.key];
					return /target/i.test(String(f.message)) && choices[0] !== undefined ? [choices[0].key] : undefined;
				},
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1);
				}, 'seat 0 to hold priority in its own main', 30_000, s);
				const ponder = s.zone(0, 'Hand').find((c) => c.name === 'Ponder');
				if (ponder === undefined) throw new Error('no Ponder in hand');
				s.select(0, ponder.id);
				const pay0 = landPayer(s, 0);
				await waitUntil(() => {
					s.answerAsks();
					pay0();
					return /Stack: 1 to Resolve/.test(s.prompt(1)) && s.buttons(1)?.enable1 === true;
				}, 'seat 1 to be given priority with Ponder on the stack', 30_000, s);

				expect(s.match.setFullControl(1, true).ok).toBe(true);
				const charm = s.zone(1, 'Hand').find((c) => c.name === 'Izzet Charm');
				if (charm === undefined) throw new Error('no Izzet Charm in hand');
				s.select(1, charm.id);
				const pay1 = landPayer(s, 1);
				await waitUntil(() => {
					s.answerAsks();
					pay1();
					return /Stack: 2 to Resolve/.test(s.prompt(1));
				}, 'Izzet Charm to reach the stack', 30_000, s);

				for (const seat of [0, 1]) {
					const [top, under] = stackOf(s, seat);
					const chain = chainOf(s.state(seat), top!);
					const pairs = latestStackTargets(s, seat);
					console.log(`[modal-charm] seat ${seat} stack=[${stackOf(s, seat)}] chain: ${describeChain(chain)} stackTargetSpells=${JSON.stringify(pairs)}`);
					expect(strOf(chain[0], 'Description') ?? '', 'the top item is the charm').toMatch(/Izzet Charm/);
					expect(pairs, `seat ${seat}: stackTargetSpells pairs Izzet Charm (${top}) with Ponder (${under})`).toContainEqual([top, under]);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Kolaghan’s Command’s two modes carry a creature and a player target, for both seats',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 8, decks: DECKS, scenario: scenarioText('modal-command') });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1);
				}, 'seat 0 to hold priority in its own main', 30_000, s);
				const bears = s.zone(1, 'Battlefield').find((c) => c.name === 'Grizzly Bears');
				const command = s.zone(0, 'Hand').find((c) => c.name === "Kolaghan's Command");
				if (bears === undefined || command === undefined) throw new Error('the scenario did not apply');
				const oppId = s.match.seats[1]?.playerId as number;

				expect(s.match.setFullControl(0, true).ok).toBe(true);
				const since = s.sent.length;
				s.select(0, command.id);
				const pay = landPayer(s, 0);
				let handled = since;
				await waitUntil(() => {
					s.answerAsks();
					pay();
					// One answer per target selection Forge opens: the creature when it is offered, else the opponent.
					const at = s.sent.findIndex((x, i) => i >= handled && x.seat === 0 && (x.envelope.frame as { method?: string }).method === 'setSelectables');
					if (at >= 0) {
						handled = at + 1;
						const frame = s.sent[at]!.envelope.frame as unknown as { cards: { id: number }[] };
						if (frame.cards.some((c) => c.id === bears.id)) s.select(0, bears.id);
						else s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
					}
					return /Stack: 1 to Resolve/.test(s.prompt(0));
				}, "Kolaghan's Command to reach the stack", 30_000, s);

				for (const seat of [0, 1]) {
					const [top] = stackOf(s, seat);
					const chain = chainOf(s.state(seat), top!);
					console.log(`[modal-command] seat ${seat} chain: ${describeChain(chain)}`);
					expect(idsOf(chain[0], 'TargetCards'), 'the root item targets nothing itself').toEqual([]);
					expect(chain.flatMap((o) => idsOf(o, 'TargetCards')), `seat ${seat}: the chain targets Grizzly Bears (${bears.id})`).toContain(bears.id);
					expect(chain.flatMap((o) => idsOf(o, 'TargetPlayers')), `seat ${seat}: the chain targets the opponent (${oppId})`).toContain(oppId);
				}
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});
