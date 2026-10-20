/**
 * Improvise and convoke offer the cards they can tap, and tapping them pays for the spell, against real
 * Forge.
 *
 * The operator, 2026-10-20 (match m-e6863c7810f1): *"i just tried to play an improvise creature and it
 * showed 'select artifacts to reduce cost' and none of my artifacts were selectable"*. Forge asks the
 * reduction through `InputSelectCardsForConvokeOrImprovise`, which never calls
 * `IGuiGame.setSelectables` — only `InputSelectTargets` and `InputSelectEntitiesFromList` do — so the
 * seat was asked a question with nothing to answer it with. The bridge now publishes the input's
 * `availableCards` itself (`PlayBridge.java`'s `syncConvokeSelectables`).
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'improvise and convoke offer what they can tap, against real Forge'
	: `improvise and convoke offer what they can tap, against real Forge — SKIPPED: ${available.reason}`;

interface Selectables {
	cards: number[];
	min: number;
	max: number;
	players: number[] | null;
}

/** The seat's latest `setSelectables` since `from`, unless a `clearSelectables` came after it. */
function openSelectables(s: Scenario, seat: number, from: number): Selectables | null {
	let open: Selectables | null = null;
	for (const x of s.sent.slice(from)) {
		if (x.seat !== seat) continue;
		const f = x.envelope.frame as { method?: string; cards?: { id: number }[]; min?: number; max?: number; players?: { id: number }[] };
		if (f.method === 'clearSelectables') open = null;
		if (f.method === 'setSelectables') open = { cards: (f.cards ?? []).map((c) => c.id), min: f.min ?? -1, max: f.max ?? -1, players: f.players === undefined ? null : f.players.map((p) => p.id) };
	}
	return open;
}

/** The card ids the seat was told are marked, folded from every `setHighlighted` since `from`. */
function highlighted(s: Scenario, seat: number, from: number): Set<number> {
	const on = new Set<number>();
	for (const x of s.sent.slice(from)) {
		if (x.seat !== seat) continue;
		const f = x.envelope.frame as { method?: string; entities?: { kind: string; id: number }[]; on?: boolean };
		if (f.method !== 'setHighlighted') continue;
		for (const e of f.entities ?? []) {
			if (e.kind !== 'card') continue;
			if (f.on === true) on.add(e.id);
			else on.delete(e.id);
		}
	}
	return on;
}

async function atOwnMain(scenario: string): Promise<Scenario> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, {
		seed: 7301,
		decks: [deck('Islands', ['40 Island']), deck('Mountains', ['40 Mountain'])],
		scenario: scenarioText(scenario),
	});
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0's main phase with the scripted board", 60_000, s);
	return s;
}

for (const { scenario, spell, tapper, land, keyword } of [
	{ scenario: 'ip-improvise', spell: 'Kappa Cannoneer', tapper: "Mishra's Bauble", land: 'Island', keyword: 'Improvise' },
	{ scenario: 'ip-convoke', spell: 'Siege Wurm', tapper: 'Grizzly Bears', land: 'Forest', keyword: 'Convoke' },
] as const) {
	describe.skipIf(!available.ok)(`${title} (${keyword})`, () => {
		it(`${keyword} offers every untapped ${tapper}, waits for the seat, and each one tapped pays for one`, async () => {
			const s = await atOwnMain(scenario);
			try {
				const card = s.zone(0, 'Hand').find((c) => c.name === spell)!;
				const tappers = s.zone(0, 'Battlefield').filter((c) => c.name === tapper).map((c) => c.id);
				const lands = s.zone(0, 'Battlefield').filter((c) => c.name === land).length;
				const cmc = spell === 'Kappa Cannoneer' ? 6 : 7;
				const from = s.sent.length;
				const lineFrom = s.lines.length;
				s.select(0, card.id);

				await waitUntil(() => { s.answerAsks(); return new RegExp(`for ${keyword}`).test(s.prompt(0)); }, `Forge's ${keyword} question`, 20_000, s);
				await waitUntil(() => openSelectables(s, 0, from) !== null, `the ${keyword} pick offered to seat 0 — ${timeline(s, 0, lineFrom, from)}`, 5_000, s);
				expect(openSelectables(s, 0, from), `the ${keyword} pick is every untapped ${tapper}, any number of them`).toEqual({
					cards: [...tappers].sort((a, b) => a - b),
					min: 0,
					max: tappers.length,
					players: [],
				});
				// Nothing answers it for the seat: it is the seat's own choice how much to tap.
				await new Promise((r) => setTimeout(r, 3_000));
				expect(s.prompt(0), `the ${keyword} question still waits — ${timeline(s, 0, lineFrom, from)}`).toMatch(new RegExp(`for ${keyword}`));

				for (const id of tappers) {
					const before = s.prompt(0);
					s.select(0, id);
					await waitUntil(() => highlighted(s, 0, from).has(id) && s.prompt(0) !== before, `${tapper} ${id} marked for ${keyword}`, 10_000, s);
				}
				s.ok(0);

				await waitUntil(
					() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.id === card.id) && /^Stack: Empty$/m.test(s.prompt(0)); },
					`${spell} resolved — ${timeline(s, 0, lineFrom, from)}`,
					30_000,
					s,
				);
				expect(openSelectables(s, 0, from), `the ${keyword} pick is withdrawn once it is answered`).toBeNull();
				const board = s.zone(0, 'Battlefield');
				expect(board.filter((c) => c.name === tapper && c.tapped).map((c) => c.id), `every ${tapper} tapped for ${keyword}`).toEqual(expect.arrayContaining(tappers));
				expect(board.filter((c) => c.name === land && c.tapped), `${land}s paid only what ${keyword} left`).toHaveLength(cmc - tappers.length);
				expect(board.filter((c) => c.name === land && !c.tapped), `the rest of the ${land}s untapped`).toHaveLength(lands - (cmc - tappers.length));
			} finally {
				await s.stop();
			}
		}, 180_000);
	});
}
