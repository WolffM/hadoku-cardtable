/**
 * Playtest 15, AE13 — the operator, 2026-10-08: *"bug with selesnya sanctuary.
 * if played as the only land, the shortcut returns it immediately. but on the
 * opponent screen it still shows 'Waiting for Bella to decide…' as if i
 * needed to make a choice there."*
 *
 * The sentence is the OTHER seat's `waitingOn` fact (`match.ts`'s
 * `waitingOnFor`, re-published by `checkWaitingOn` on the `forge:seats`
 * roster). This file plays the land against the real jar with
 * `scenarios/w62-bounce.state` (the Sanctuary as alice's only land, so the
 * bounce has one legal reply) and RECORDS, stamped: every roster the match
 * told (`Scenario.seats`), every ask Forge opened for seat 0 and how it was
 * answered (`ask-auto-answered` / `ask-answered`), and every window decision
 * (`prompt-forwarded` / `prompt-withheld`). The assertion is the operator's
 * sentence: once the land is back in her hand and her own next window has
 * been decided, the LAST roster told carries no `waitingOn` for seat 0.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/w62-bounce.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a bounceland played as the only land: the shortcut returns it and the other seat is NOT told to wait, against real Forge'
	: `a bounceland played as the only land: the shortcut returns it and the other seat is NOT told to wait, against real Forge — SKIPPED: ${available.reason}`;

function story(s: Scenario, from: number): string {
	const t0 = s.seats[0]?.t ?? 0;
	const rows: { t: number; text: string }[] = [];
	for (const r of s.seats) rows.push({ t: r.t, text: `seats   ${JSON.stringify(r.seats.map((x) => x.waitingOn ?? null))}` });
	for (const x of s.sent.slice(from)) {
		const f = x.envelope.frame as unknown as { kind?: string; method?: string; callId?: string };
		if (f.kind === 'ask') rows.push({ t: x.t, text: `wire s${x.seat} ASK ${String(f.method)} ${String(f.callId)}` });
	}
	rows.sort((a, b) => a.t - b.t);
	// The server's log rows carry no clock: listed after, in their own order.
	const decisions = s.logs
		.filter((l) => /^(ask-|prompt-|auto-)/.test(String(l.evt)))
		.map((l) => `log ${JSON.stringify({ ...l, matchId: undefined })}`);
	return [...rows.map((r) => `+${Math.round(r.t - t0)}ms ${r.text}`), '--- decisions, in order', ...decisions].join('\n');
}

describe.skipIf(!available.ok)(title, () => {
	it('records the roster, the asks and the window decisions; after the play the other seat is never told alice has a decision — only that she holds priority', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 7,
			decks: [deck('bounce-a', ['20 Forest']), deck('bounce-b', ['20 Forest'])],
			names: ['Bella', 'Eisen'],
			scenario: scenarioText('w62-bounce'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => inOwnMain(s, 0, 1), 'alice to hold priority in her first main', 30_000, s);
			const sentFrom = s.sent.length;
			const linesFrom = s.lines.length;
			const land = s.zone(0, 'Hand').find((c) => c.name === 'Selesnya Sanctuary');
			if (land === undefined) throw new Error('no Sanctuary in hand');
			s.select(0, land.id);
			// First the land LEAVES her hand (the play; any lone-ability sheet on the way is answered as a
			// browser would), then the trigger resolves and the Sanctuary is back: both read off the
			// folded state, never a live prompt (the bounce can happen between two polls).
			await waitUntil(
				() => {
					s.answerAsks();
					return !s.zone(0, 'Hand').some((c) => c.id === land.id);
				},
				'the Sanctuary to leave her hand',
				30_000,
				s,
			);
			await waitUntil(
				() => {
					s.answerAsks();
					return s.zone(0, 'Hand').some((c) => c.name === 'Selesnya Sanctuary') && s.zone(0, 'Battlefield').length === 0 && /^Stack: Empty$/m.test(s.prompt(0));
				},
				'the Sanctuary to bounce itself back to hand',
				30_000,
				s,
			);
			// Let the server decide alice's next window (it may auto-pass or keep it) before reading.
			await new Promise((r) => setTimeout(r, 1500));
			const tale = `${story(s, sentFrom)}\n--- seat 0's windows (forge vs wire)\n${timeline(s, 0, linesFrom, sentFrom)}`;
			console.log(`[w62-bounce]\n${tale}`);
			// What the other seat is told about alice from the moment the land left her hand: she held
			// priority (`priority` — plain "Waiting for Bella…"), never a decision. Measured before the
			// fix: the post-bounce window's live bar read as `confirm` ("Waiting for Bella to decide…").
			const afterPlay = s.seats.filter((r) => r.t >= (s.sent[sentFrom]?.t ?? 0));
			const facts = afterPlay.map((r) => r.seats.find((x) => x.seat === 0)?.waitingOn?.method ?? null);
			expect(facts, `alice's facts after the play:\n${tale}`).not.toContain('confirm');
			const last = s.seats.at(-1)?.seats.find((x) => x.seat === 0)?.waitingOn ?? null;
			expect(last, `the last roster: alice merely holds priority, or nothing:\n${tale}`).toSatisfy((f: { method: string } | null) => f === null || f.method === 'priority');
		} finally {
			await s.stop();
		}
	}, 180_000);
});
