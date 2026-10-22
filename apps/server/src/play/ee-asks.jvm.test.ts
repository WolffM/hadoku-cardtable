/**
 * Two production softlocks of one family (2026-10-10): a Forge question that never reaches the
 * browser leaves Forge's game thread parked, and every later click queues behind it.
 *
 *  1. m-24f69e2e0b7e — Fire-Lit Thicket's "{R/G}, {T}: Add {R}{R}, {R}{G}, or {G}{G}" asks its
 *     combination through `assignGenericAmount`, keyed by `MagicColor.Color`. The bridge sent those
 *     keys as entities with a null ref; the server refused the frame and dropped it.
 *  2. m-70cba9014f79 — an ask frame lost between the bridge and the server.
 *
 * Against the real jar, `scenarios/ee-thicket.state`, Full control on, the operator's steps: click the
 * Thicket, pick the filter ability, press OK (Auto) on the {R/G} payment.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/ee-asks.jvm.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@hadoku/forge-wire';

import { DELTA_TYPE, deltaKey } from '@hadoku/forge-wire';

import type { BridgeLine } from './host.js';
import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario, type ScenarioOptions } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

type Frame = ServerFrame & Record<string, unknown>;
type Offered = { id: number; label?: string };

/** The Thicket's filter ability over its {C} one; for a land with a choice of colours, its {G}. */
function reply(f: Frame): unknown {
	if (f.method === 'getAbilityToPlay') {
		const abilities = f.abilities as Offered[];
		return abilities.find((a) => /\{R\}\{G\}/.test(a.label ?? '')) ?? abilities.find((a) => /\{G\}/.test(a.label ?? '')) ?? abilities[0];
	}
	if (f.method === 'assignGenericAmount') {
		// {R}{G}: one of each colour.
		return (f.target as { key: unknown }[]).map((t) => ({ key: t.key, amount: 1 }));
	}
	return undefined;
}

/** Seat 0's floating mana, `ManaAtom` byte → count, off its own projected `PlayerView.Mana`. */
function pool(s: Scenario): Record<number, number> {
	const player = s.state(0).get(deltaKey(DELTA_TYPE.player, s.match.seats[0]?.playerId ?? -1));
	const mana = player?.Mana as { t?: string; v?: unknown } | undefined;
	const out: Record<number, number> = {};
	if (mana?.t !== 'map' || !Array.isArray(mana.v)) return out;
	for (const [k, v] of mana.v as [{ v: number }, { v: number }][]) if (v.v > 0) out[k.v] = v.v;
	return out;
}

const askLines = (s: Scenario, method: string) =>
	s.lines.filter((l): l is Extract<BridgeLine, { t: 'frame' }> & { hostT: number } => l.t === 'frame' && (l.frame as { method?: string }).method === method);

async function start(options: Partial<ScenarioOptions>): Promise<Scenario> {
	const s = await startScenario(available.ok ? available.config : (undefined as never), {
		seed: 11,
		decks: [deck('thicket-a', ['20 Forest']), deck('thicket-b', ['20 Mountain'])],
		names: ['Alice', 'Bob'],
		scenario: scenarioText('ee-thicket'),
		reply,
		...options,
	});
	await finishMulligan(s);
	await waitUntil(() => inOwnMain(s, 0, 1), 'alice to hold priority in her first main', 30_000, s);
	expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
	return s;
}

/** Click the Thicket, answer whatever reaches the browser, press Auto on the payment, until `done`. */
async function activate(s: Scenario, done: () => boolean, label: string): Promise<void> {
	const thicket = s.zone(0, 'Battlefield').find((c) => c.name === 'Fire-Lit Thicket');
	if (thicket === undefined) throw new Error('no Fire-Lit Thicket');
	s.select(0, thicket.id);
	let paidAt: string | null = null;
	await waitUntil(
		() => {
			s.answerAsks();
			const prompt = s.prompt(0);
			if (/Pay Mana Cost/.test(prompt) && prompt !== paidAt && s.buttons(0)?.enable1 === true) {
				paidAt = prompt;
				s.ok(0);
			}
			return done();
		},
		label,
		60_000,
		s,
	);
}

const priorityBack = (s: Scenario): boolean => s.prompt(0).startsWith('Priority: Alice') && s.buttons(0)?.enable1 === true && s.match.seats[0]!.asks.size === 0;

describe.skipIf(!available.ok)(title('the mana combination ask, against real Forge'), () => {
	it('Fire-Lit Thicket under Full control: the {R}{R}/{R}{G}/{G}{G} question reaches the seat as colours, is answered, and {R}{G} floats', async () => {
		const s = await start({});
		try {
			await activate(s, () => pool(s)[8] === 1 && pool(s)[16] === 1, '{R}{G} to float');
			const asked = s.asks.filter((a) => a.method === 'assignGenericAmount') as Frame[];
			console.log(`[ee-asks] thicket asked: ${JSON.stringify(asked.map((a) => a.target))} pool ${JSON.stringify(pool(s))}`);
			expect(asked).toHaveLength(1);
			expect((asked[0]!.target as { key: unknown }[]).map((t) => t.key)).toEqual([
				{ target: 'manaColor', color: 8 },
				{ target: 'manaColor', color: 16 },
			]);
			expect(s.logs.filter((l) => l.evt === 'frame-invalid' || l.evt === 'ask-aborted-invalid')).toEqual([]);
			expect(s.logs.find((l) => l.evt === 'ask-answered' && l.method === 'assignGenericAmount')).toBeDefined();
			await waitUntil(() => priorityBack(s), 'alice to hold priority again', 15_000, s);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('an ask the server cannot parse is shown as a pick of its whole answers, never dropped or aborted, and the pick reaches Forge', async () => {
		let broken = 0;
		const s = await start({
			// One field forge-wire refuses (a number where Forge's label goes); the keys stay real.
			mapLine: (l) => {
				if (l.t !== 'frame' || (l.frame as { method?: string }).method !== 'assignGenericAmount' || broken > 0) return l;
				broken += 1;
				return { ...l, frame: { ...(l.frame as object), amountLabel: 42 } };
			},
		});
		try {
			await activate(s, () => pool(s)[8] === 2, '{R}{R}, the fallback\'s first answer, to float');
			const unparsed = s.logs.find((l) => l.evt === 'ask-unparsed')!;
			const shown = s.asks.find((a) => a.method === 'getChoices' && a.callId === unparsed.callId) as (Frame & { choices: { label: string }[] }) | undefined;
			console.log(`[ee-asks] unparsed: ${JSON.stringify(unparsed)}; shown ${JSON.stringify(shown?.choices.map((c) => c.label))}; pool ${JSON.stringify(pool(s))}`);
			expect(unparsed).toMatchObject({ method: 'assignGenericAmount', fallback: true });
			expect(shown?.choices.map((c) => c.label)).toEqual(['2 red', '1 red, 1 green', '2 green']);
			expect(s.logs.filter((l) => l.evt === 'ask-aborted')).toEqual([]);
			await waitUntil(() => priorityBack(s), 'alice to hold priority again', 30_000, s);
			s.ok(0);
			await waitUntil(() => {
				s.answerAsks();
				return s.phase(0) !== null && !/Main phase, precombat/.test(s.phase(0)!);
			}, 'the game to move on past her main phase', 30_000, s);
			console.log(`[ee-asks] game went on: phase ${String(s.phase(0))}`);
			expect(s.match.status).toBe('running');
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('an ask frame lost on the way is re-asked after the act gets nothing back, and the game goes on', async () => {
		let dropped = 0;
		const s = await start({
			actSilenceMs: 3000,
			// The first getAbilityToPlay (the Thicket's two abilities) is lost between the bridge and the server.
			mapLine: (l) => {
				if (l.t !== 'frame' || (l.frame as { method?: string }).method !== 'getAbilityToPlay' || dropped > 0) return l;
				dropped += 1;
				return null;
			},
		});
		try {
			await activate(s, () => pool(s)[8] === 1 && pool(s)[16] === 1, '{R}{G} to float after the lost ask is re-asked');
			const offers = askLines(s, 'getAbilityToPlay');
			const first = (offers[0]!.frame as { callId: string }).callId;
			const resent = s.logs.find((l) => l.evt === 'asks-resent');
			console.log(`[ee-asks] lost: ${first}; act-unanswered ${JSON.stringify(s.logs.find((l) => l.evt === 'act-unanswered'))}; resent ${JSON.stringify(resent)}`);
			expect(s.logs.some((l) => l.evt === 'act-unanswered' && l.seat === 0)).toBe(true);
			expect(resent?.callIds).toContain(first);
			expect(offers.filter((l) => (l.frame as { callId: string }).callId === first)).toHaveLength(2);
			expect(s.logs.find((l) => l.evt === 'ask-answered' && l.callId === first)).toBeDefined();
			await waitUntil(() => priorityBack(s), 'alice to hold priority again', 15_000, s);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it("a card-name ask outlives its seat's departure: re-shown on return, answered, and Cabal Therapy resolves (prod m-dd37bda1c441)", async () => {
		if (!available.ok) return;
		const isNameAsk = (f: Frame): boolean => f.method === 'getChoices' && Array.isArray(f.names);
		const s = await startScenario(available.config, {
			seed: 17,
			decks: [deck('therapy-a', ['20 Swamp']), deck('therapy-b', ['20 Mountain'])],
			names: ['Alice', 'Bob'],
			scenario: scenarioText('ee-therapy'),
			hold: isNameAsk,
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'alice to hold priority in her first main', 30_000, s);
			const therapy = s.zone(0, 'Hand').find((c) => c.name === 'Cabal Therapy');
			if (therapy === undefined) throw new Error('no Cabal Therapy in hand');
			const oppId = s.match.seats[1]?.playerId as number;
			s.select(0, therapy.id);
			let targeted = false;
			let paid = false;
			const nameAsk = (): Frame | undefined => s.sent.map((x) => x.envelope.frame as Frame).find((f) => f.kind === 'ask' && isNameAsk(f));
			await waitUntil(
				() => {
					s.answerAsks();
					if (!targeted && /target/i.test(s.prompt(0))) {
						targeted = true;
						s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
					}
					if (!paid && s.buttons(0)?.label1 === 'Auto' && s.buttons(0)?.enable1 === true) {
						paid = true;
						s.ok(0);
					}
					return nameAsk() !== undefined;
				},
				'the card-name question',
				60_000,
				s,
			);
			const ask = nameAsk()!;
			const callId = ask.callId as string;

			// The tab freezes and drops; the seat stays gone past the disconnect grace.
			s.match.seatDisconnected(0);
			await new Promise((r) => setTimeout(r, 3000));
			expect(s.logs.filter((l) => l.evt === 'ask-aborted')).toEqual([]);

			s.match.seatConnected(0);
			s.match.snapshot(0);
			const mark = s.sent.length;
			s.match.resendAfterSnapshot(0);
			const again = s.sent.slice(mark).map((x) => x.envelope.frame as Frame).find((f) => f.kind === 'ask' && f.callId === callId);
			console.log(`[ee-asks] therapy: ${callId} re-sent after the return: ${again !== undefined}; ${(ask.names as unknown[]).length} names`);
			expect(again, 'the open card-name ask is re-sent to the returning seat').toBeDefined();

			expect(ask.names as string[], 'Elvish Mystic is among the names').toContain('Elvish Mystic');
			expect(s.match.fromClient(0, { kind: 'reply', callId, method: 'getChoices', result: ['Elvish Mystic'] } as never)).toEqual({ ok: true });
			await waitUntil(
				() => {
					s.answerAsks();
					return s.zone(0, 'Graveyard').some((c) => c.name === 'Cabal Therapy') && s.zone(1, 'Graveyard').some((c) => c.name === 'Elvish Mystic');
				},
				'Cabal Therapy to resolve: named Elvish Mystic discarded',
				30_000,
				s,
			);
			const stderr = readFileSync(join(s.workDir, s.match.id, 'bridge.stderr.txt'), 'utf8');
			console.log(`[ee-asks] therapy resolved; status ${s.match.status}; NPE in bridge stderr: ${/NullPointerException/.test(stderr)}`);
			expect(stderr).not.toMatch(/NullPointerException/);
			expect(s.match.status).toBe('running');
		} finally {
			await s.stop();
		}
	}, 240_000);
});
