/**
 * The operator, 2026-10-19, on Bone Shards: *"'Destroy target creature or planeswalker. (Additional
 * cost: Sacrifice a creature) Select creature to sacrifice (1 left)' … ideally the text here is just
 * for the decision that has to be made."*
 *
 * Forge writes an ability's text into every prompt it asks for that ability (with
 * `UI_DETAILED_SPELLDESC_IN_PROMPT`, its default). The bridge hands each such prompt over split
 * (`PlayBridge.java`'s `promptParts`): `question` the decision, `context` the ability's text. This
 * casts Bone Shards (its sacrifice) and Thrill of Possibility (its discard) against the real jar and
 * reads every prompt the casts showed: the target, the sacrifice, the discard and any mana payment.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/qt-prompt-parts.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a prompt Forge writes an ability into reaches the seat split into its decision and the ability, against real Forge'
	: `a prompt Forge writes an ability into reaches the seat split into its decision and the ability, against real Forge — SKIPPED: ${available.reason}`;

interface Parts {
	question: string;
	context: string;
	input: string;
}

/** Every prompt seat 0 was shown from line `from`, with the bridge's split of it. */
const prompts = (s: Scenario, from: number): { message: string; parts: Parts | null }[] =>
	forgeFrames(s, 0, from)
		.filter((f) => f.method === 'showPromptMessage')
		.map((f) => ({ message: f.message ?? '', parts: (f as { parts?: Parts }).parts ?? null }));

/** Cast `spell` (at `target`, if it targets) and pay its additional cost with `cost`; every mana cost by tapping a land. */
async function cast(s: Scenario, spell: string, cost: number, target: number | null): Promise<void> {
	const card = s.zone(0, 'Hand').find((c) => c.name === spell);
	if (card === undefined) throw new Error(`no ${spell} in hand`);
	const graveyard = () => s.zone(0, 'Graveyard').filter((c) => c.name === spell).length;
	const before = graveyard();
	s.select(0, card.id);
	let targeted = target === null;
	let paid = false;
	let last = '';
	await waitUntil(
		() => {
			s.answerAsks();
			const said = s.prompt(0);
			if (said !== last) console.log(`[qt] ${spell}: prompt ${JSON.stringify((last = said))}`);
			if (!targeted && /Select target/.test(said)) {
				targeted = true;
				s.select(0, target!);
			} else if (!paid && /to (sacrifice|discard)/.test(said)) {
				paid = true;
				s.select(0, cost);
			} else if (/Pay Mana Cost/.test(said)) {
				const land = s.zone(0, 'Battlefield').find((c) => c.land && !c.tapped);
				if (land !== undefined) s.select(0, land.id);
			}
			return graveyard() === before + 1 && /^Stack: Empty$/m.test(s.prompt(0));
		},
		`${spell} to resolve`,
		45_000,
		s,
	);
}

describe.skipIf(!available.ok)(title, () => {
	it('the target, the sacrifice, the discard and the payment each carry their own question, and the ability apart', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 7,
			decks: [deck('qt-a', ['20 Swamp']), deck('qt-b', ['20 Island'])],
			names: ['Alice', 'Bob'],
			scenario: scenarioText('qt-costs'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => inOwnMain(s, 0, 1), 'alice to hold priority in her first main', 30_000, s);
			const from = s.lines.length;
			const theirs = (name: string) => s.zone(1, 'Battlefield').find((c) => c.name === name)!.id;
			const mine = (name: string) => [...s.zone(0, 'Battlefield'), ...s.zone(0, 'Hand')].find((c) => c.name === name)!.id;
			await cast(s, 'Bone Shards', mine('Llanowar Elves'), theirs('Hill Giant'));
			await cast(s, 'Thrill of Possibility', mine('Island'), null);
			const seen = prompts(s, from).filter((p) => p.parts !== null || !/^(Priority|Waiting)/.test(p.message));
			for (const p of seen) console.log(`[qt] ${JSON.stringify(p)}`);
			const split = (re: RegExp) => seen.filter((p) => re.test(p.message)).map((p) => p.parts);

			expect(split(/Select target creature or planeswalker/), 'the target prompt: the target, and the spell under it').toEqual([
				{ input: 'target', question: 'Select target creature or planeswalker', context: 'Destroy target creature or planeswalker. (Additional cost: Sacrifice a creature)' },
			]);
			const sacrifice = split(/to sacrifice/);
			expect(sacrifice.length, 'the sacrifice was asked').toBeGreaterThan(0);
			for (const p of sacrifice) {
				expect(p?.input).toBe('select');
				expect(p?.question, 'the sacrifice prompt asks the sacrifice').toMatch(/^Select .+ to sacrifice \(1 left\)$/);
				expect(p?.context).toMatch(/^Destroy target creature or planeswalker\. \(Additional cost: Sacrifice a creature\)$/);
			}
			const discard = split(/to discard/);
			expect(discard.length, 'the discard was asked').toBeGreaterThan(0);
			for (const p of discard) {
				expect(p?.input).toBe('select');
				expect(p?.question, 'the discard prompt asks the discard').toMatch(/to discard/);
				expect(p?.question).not.toMatch(/Draw two/);
				expect(p?.context).toMatch(/Draw two cards/);
			}
			const pay = split(/Pay Mana Cost/);
			for (const p of pay) {
				expect(p?.input).toBe('pay');
				expect(p?.question, 'the payment asks the mana').toMatch(/^Pay Mana Cost/);
				expect(p?.context).toMatch(/Bone Shards|Thrill of Possibility/);
			}
			expect(
				seen.filter((p) => p.parts === null && /Destroy target|Draw two/.test(p.message)).map((p) => p.message),
				'no prompt with the spell in it goes unsplit',
			).toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});
