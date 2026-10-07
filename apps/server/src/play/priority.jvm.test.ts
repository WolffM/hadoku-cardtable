/**
 * Wave 32, Q17 — "holding priority on my own spells is weird" (carried from the first
 * list's item 12), against a REAL Forge match.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/S \
 *   pnpm exec vitest run apps/server/src/play/priority.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import type { ServerFrame } from '@hadoku/forge-wire';

import { onlyAnswer } from './auto.js';
import { available, deck, inOwnMain, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'what the caster is shown after casting, against real Forge'
	: `what the caster is shown after casting, against real Forge — SKIPPED: ${available.reason}`;

function dump(s: Scenario, from: number, seats: number[], t0: number): string[] {
	const out: string[] = [];
	for (const x of s.sent.slice(from)) {
		if (!seats.includes(x.seat)) continue;
		const f = x.envelope.frame as unknown as Record<string, unknown>;
		const m = String(f.method);
		const at = `+${Math.round(x.t - t0)}ms s${x.seat}`;
		if (m === 'showPromptMessage') out.push(`${at} PROMPT ${JSON.stringify(f.message)}`);
		else if (m === 'updateButtons') out.push(`${at} BUTTONS [${String(f.label1)}${f.enable1 === true ? '' : '-'}] [${String(f.label2)}${f.enable2 === true ? '' : '-'}]`);
		else if (m === 'setWeaklySelectable') out.push(`${at} ACTIONABLE ${JSON.stringify((f.cards as { id: number }[]).map((c) => c.id))}`);
		else if (m === 'clearWeaklySelectable') out.push(`${at} ACTIONABLE cleared`);
		else if (f.kind === 'ask') out.push(`${at} ASK ${m}`);
	}
	return out;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'casts a spell and reports who holds priority and which stop fired',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 32,
				decks: [deck('P A', ['30 Mountain', '30 Lightning Bolt']), deck('P B', ['30 Mountain', '30 Lightning Bolt'])],
			});
			try {
				await waitUntil(() => { s.keepHands(); s.answerAsks(); return [0, 1].some((n) => inOwnMain(s, n, 1)); }, 'turn 1 main', 90_000);
				const x = [0, 1].find((n) => inOwnMain(s, n, 1)) as number;
				const y = 1 - x;
				const playLand = async (): Promise<void> => {
					const have = s.zone(x, 'Battlefield').filter((c) => c.land).length;
					const land = s.zone(x, 'Hand').find((c) => c.land);
					if (land === undefined) throw new Error('no land in hand');
					s.select(x, land.id);
					await waitUntil(() => { s.answerAsks(); return s.zone(x, 'Battlefield').filter((c) => c.land).length > have; }, 'the land', 20_000);
				};
				await playLand();
				// Through turn 2 and into this seat's turn 3 main phase.
				await passUntil(s, () => inOwnMain(s, x, 3), `seat ${x}'s turn 3 main`, 90_000);
				await playLand();
				const bolt = s.zone(x, 'Hand').find((c) => c.name === 'Lightning Bolt');
				if (bolt === undefined) throw new Error('no Lightning Bolt in hand');
				const spare = s.zone(x, 'Hand').filter((c) => c.name === 'Lightning Bolt').length;
				const lands = s.zone(x, 'Battlefield').filter((c) => c.land).length;
				const mark = s.sent.length;
				const t0 = performance.now();
				const logsBefore = s.logs.length;
				s.select(x, bolt.id);
				// Target: the other player, once Forge asks for one.
				const oppId = s.match.seats[y]?.playerId as number;
				let targeted = false;
				for (let i = 0; i < 100; i++) {
					s.answerAsks();
					if (!targeted && /target/i.test(s.prompt(x))) {
						targeted = true;
						s.match.fromClient(x, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
					}
					await new Promise((r) => setTimeout(r, 50));
				}
				const lines = dump(s, mark, [x, y], t0);
				lines.push('--- server decisions after the cast');
				for (const l of s.logs.slice(logsBefore)) if (/auto|ask/.test(String(l.evt))) lines.push(JSON.stringify(l));
				lines.push(`--- seat ${x}: ${lands} lands, ${spare} Lightning Bolts in hand when the first was cast; targeted=${targeted}`);
				lines.push(`--- hand now: ${JSON.stringify(s.zone(x, 'Hand').map((c) => c.name))} battlefield: ${JSON.stringify(s.zone(x, 'Battlefield').map((c) => c.name + (c.tapped ? '(T)' : '')))}`);
				console.log(`[q17]\n${lines.join('\n')}`);

				// The precondition, so the claim below is not vacuous: the caster's window with
				// its OWN spell on the stack found Forge naming something else castable.
				const own = s.sent
					.slice(mark)
					.map((e, i) => ({ e, i: i + mark }))
					.filter(({ e }) => e.seat === x && e.envelope.frame.method === 'showPromptMessage' && /Stack: 1 to Resolve/.test((e.envelope.frame as unknown as { message: string }).message));
				expect(own.length, 'the caster was never given priority with its spell on the stack').toBeGreaterThan(0);
				const named = s.sent
					.slice(mark, own[0]!.i)
					.filter((e) => e.seat === x && e.envelope.frame.method === 'setWeaklySelectable')
					.map((e) => (e.envelope.frame as unknown as { cards: unknown[] }).cards.length)
					.at(-1);
				expect(named, 'Forge named nothing castable, so this is not the case Q17 is about').toBeGreaterThan(0);

				// The claim: it was passed anyway, and the spell resolved without a click.
				const passedAtStack = s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === x);
				expect(passedAtStack.length, 'the caster held priority on its own spell').toBeGreaterThan(0);
				expect(/^Stack: Empty$/m.test(s.prompt(x)), 'the spell did not resolve on its own').toBe(true);
				expect(spare).toBeGreaterThan(1);
			} catch (err) {
				for (const seat of [0, 1]) console.log(`[q17-stuck] s${seat} ${JSON.stringify(s.prompt(seat))} ${JSON.stringify(s.buttons(seat))}`);
				console.log(`[q17-stuck] asks ${JSON.stringify(s.asks.map((a) => a.method))}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
	/*
	 * Wave 32 — Q7's server-side question, asked by lane G: `onlyAnswer` answers a one-option
	 * `getChoices`, yet the operator still saw *"select target spell"* with ONE spell on the
	 * stack. A REAL Mana Leak against a real spell says why: the ask is `min: 0, max: 1`.
	 */
	it(
		'Q7: "Select target spell" with one spell on the stack is a getChoices with min 0, which onlyAnswer rightly leaves',
		async () => {
			if (!available.ok) return;
			const cards = ['25 Island', '20 Mana Leak', '15 Memnite'];
			const s = await startScenario(available.config, {
				seed: 7,
				decks: [deck('C A', cards), deck('C B', cards)],
				// The player's own answer to the target question: the one spell.
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string }[];
					return /target/i.test(String(f.message)) && choices[0] !== undefined ? [choices[0].key] : undefined;
				},
			});
			const out: string[] = [];
			try {
				await waitUntil(() => { s.keepHands(); s.answerAsks(); return [0, 1].some((n) => inOwnMain(s, n, 1)); }, 'turn 1 main', 90_000);
				const x = [0, 1].find((n) => inOwnMain(s, n, 1)) as number; // first player: counters on turn 4
				const y = 1 - x;
				const land = async (seat: number): Promise<void> => {
					const have = s.zone(seat, 'Battlefield').filter((c) => c.land).length;
					const l = s.zone(seat, 'Hand').find((c) => c.land);
					if (l === undefined) throw new Error(`seat ${seat} has no land to play`);
					s.select(seat, l.id);
					await waitUntil(() => { s.answerAsks(); return s.zone(seat, 'Battlefield').filter((c) => c.land).length > have; }, 'a land', 20_000);
				};
				await land(x);
				await passUntil(s, () => inOwnMain(s, y, 2), 'turn 2', 60_000);
				await land(y);
				await passUntil(s, () => inOwnMain(s, x, 3), 'turn 3', 60_000);
				await land(x);
				await passUntil(s, () => inOwnMain(s, y, 4), 'turn 4', 60_000);
				const leak = s.zone(x, 'Hand').find((c) => c.name === 'Mana Leak');
				const memnite = s.zone(y, 'Hand').find((c) => c.name === 'Memnite');
				if (leak === undefined || memnite === undefined) throw new Error(`the draw did not give seat ${x} a Mana Leak and seat ${y} a Memnite`);
				out.push(`seat ${x} holds Mana Leak with ${s.zone(x, 'Battlefield').filter((c) => c.land && !c.tapped).length} untapped lands`);

				// y casts a spell; x is given priority with it on the stack and a counterspell castable.
				s.select(y, memnite.id);
				await waitUntil(() => { s.answerAsks(); return /Stack: 1 to Resolve/.test(s.prompt(x)) && s.buttons(x)?.enable1 === true; }, 'priority with the spell on the stack', 20_000);
				out.push(`x's window: ${JSON.stringify(s.prompt(x))}`);
				const askedBefore = s.asks.length;
				s.select(x, leak.id);
				await waitUntil(() => { s.answerAsks(); return s.asks.slice(askedBefore).some((a) => a.method === 'getChoices'); }, 'the target question', 20_000);
				const question = s.asks.slice(askedBefore).find((a) => a.method === 'getChoices') as unknown as {
					message: string; min: number; max: number; choices: { key: string; ref: { kind: string } | null }[];
				};
				out.push(`the ask the seat was shown: ${JSON.stringify(question)}`);
				console.log(`[q7]\n${out.join('\n')}`);

				expect(question.message).toBe('Select target spell');
				expect(question.choices).toHaveLength(1);
				expect(question.choices[0]?.ref?.kind).toBe('stackItem');
				// The whole answer to the manager's question: it is optional, so it is not one-answer.
				expect({ min: question.min, max: question.max }).toEqual({ min: 0, max: 1 });
				expect(onlyAnswer(question as unknown as ServerFrame)).toBeNull();
				// And the boundary: the same ask with the floor at one WOULD be answered.
				expect(onlyAnswer({ ...question, min: 1 } as unknown as ServerFrame)?.result).toEqual(['c0']);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});
