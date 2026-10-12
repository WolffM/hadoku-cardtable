/**
 * The accepted drafted deck, played by a real Forge in a child JVM: the text
 * the gate checked (`gate-fixture.ts`'s browser-written deck) is the text
 * Forge plays. `gate.test.ts` pins the gate's rules on the same deck.
 *
 * SKIPS, and says so in its name, unless the Forge build is configured.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostFactory } from '../play/host.js';
import { createMatchRegistry, type Match } from '../play/match.js';
import { POWER_2012, UW_DELVER, ctx, drafted, draftedDeckText } from './gate-fixture.js';
import { checkSeat, type SeatVerdict } from './gate.js';

/**
 * Every `Library` collection in a frame, as sizes. Forge sends a player's zones
 * as a trackable collection — `{ v: [...] }` under the `Library` property — so
 * the opening library size is a fact read out of Forge's own view rather than
 * inferred from a status code.
 */
function librarySizes(node: unknown, key = ''): number[] {
	if (Array.isArray(node)) {
		return [...(key === 'Library' ? [node.length] : []), ...node.flatMap((n) => librarySizes(n))];
	}
	if (typeof node === 'object' && node !== null) {
		const entries = Object.entries(node as Record<string, unknown>);
		const inner = entries.flatMap(([k, v]) => librarySizes(v, key === 'Library' && k === 'v' ? key : k));
		return inner;
	}
	return [];
}

const available = jvmHostConfig();
const title = available.ok
	? 'the accepted drafted deck starts a real Forge match'
	: `the accepted drafted deck starts a real Forge match — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title, () => {
	const matches: Match[] = [];
	const pools: JvmHostFactory[] = [];

	afterAll(async () => {
		for (const m of matches) m.stop();
		for (const p of pools) p.close();
		const deadline = Date.now() + 15_000;
		while (liveJvmCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		expect(liveJvmCount()).toBe(0);
	});

	it('hands Forge the checked text and the match runs', async () => {
		if (!available.ok) return;
		const mine = checkSeat(drafted(draftedDeckText()), ctx) as SeatVerdict;
		const theirs = checkSeat({ deck: { library: UW_DELVER }, rules: { kind: 'standard', format: POWER_2012 } }, ctx) as SeatVerdict;
		expect([mine.legal, theirs.legal]).toEqual([true, true]);

		const raw: BridgeLine[] = [];
		const jvm = jvmHostFactory(available.config, { spare: false, log: () => {} });
		pools.push(jvm);
		const registry = createMatchRegistry({
			host: (id, spec, events) =>
				jvm(id, spec, {
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
		const match = registry.create({
			seed: 20260919,
			seats: [
				{ name: 'Seat 1', ai: false, deck: mine.text },
				{ name: 'Forge AI', ai: true, deck: theirs.text },
			],
		});
		matches.push(match);
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });
		const ready = raw.find((l) => l.t === 'ready') as Extract<BridgeLine, { t: 'ready' }>;
		expect(ready.seats.map((s) => s.deck)).toEqual([mine.deckName, theirs.deckName]);
		// The proof that Forge plays the deck the gate checked: Forge's own view
		// of the opening libraries is 40 cards (23 drafted + 17 Islands) and 60.
		//
		// Wait for BOTH, not for the first one to arrive: the two players' zones
		// reach us in separate frames and in no guaranteed order, so a loop that
		// stops at 40 asserts 60 on whatever has landed by then. Under a full
		// `pnpm check` — three JVM suites at once — that raced and failed
		// ("expected [ 40 ] to include 60"). The deadline is generous for the
		// same reason: it is a wait for a frame, not a measurement of anything.
		const wanted = [40, 60];
		const deadline = Date.now() + 120_000;
		const sizes = (): number[] => raw.flatMap((l) => (l.t === 'frame' ? librarySizes(l.frame) : []));
		while (!wanted.every((n) => sizes().includes(n)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		for (const n of wanted) expect(sizes()).toContain(n);
		match.stop();
		jvm.close();
	}, 300_000);
});
