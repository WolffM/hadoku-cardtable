/**
 * P8 — Gitaxian Probe with no untapped land, against a REAL Forge match.
 *
 * The operator, second 2026-09-30 play test: "gitaxian probe is not playable
 * with zero mana". `{U/P}` is payable with two life, and the payment path for
 * that exists (`LIFE_INSTEAD` in `auto.ts`). What decides whether a card can be
 * clicked at all is Forge's actionable set (`setWeaklySelectable`), which is
 * `forge-ai`'s `AvailableActions.collectActionable`; its `canAfford` asked the
 * AI payer whether the cost was payable, and the AI payer refuses Phyrexian
 * life for any spell script carrying `AIPhyrexianPayment$ Never` — Gitaxian
 * Probe's does (`cardsfolder/g/gitaxian_probe.txt`). That is an AI strategy
 * hint, not a rule: a human may always pay 2 life.
 *
 * The deck is sixty Probes, so the opening hand has no land in it and the
 * board can never have one. The test prints what the browser is offered at
 * seat 0's first main phase, then casts Probe by clicking it and its target
 * and paying by clicking the life total, and asserts 20 -> 18, the spell on
 * the graveyard side of the ledger, and a card drawn.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/phyrexian.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema, type ServerFrame } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount } from './host.js';
import { createMatchRegistry } from './match.js';
import { foldFrames, keyOf, TYPE, type StateFrame, type WireObj } from './visibility.js';
import type { ServerEnvelope } from './transport.js';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });
const title = available.ok
	? 'a Phyrexian spell with no untapped land, against real Forge'
	: `a Phyrexian spell with no untapped land, against real Forge — SKIPPED: ${available.reason}`;

function deck(name: string, lines: readonly string[]): string {
	return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function ids(o: WireObj | undefined, k: string): number[] {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	return (v.v as { t?: string; v?: unknown }[]).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'offers Gitaxian Probe at {U/P} with no land, and casting it pays 2 life and draws',
		async () => {
			if (!available.ok) return;
			const sent: { seat: number; envelope: ServerEnvelope }[] = [];
			const logs: Record<string, unknown>[] = [];
			const jvm = jvmHostFactory(available.config, { spare: false, log: (e) => logs.push(e) });

			const notes = [0, 1].map(() => ({ prompt: '', ok: false, actionable: null as number[] | null }));
			const registry = createMatchRegistry({
				host: (id, spec, events) => jvm(id, spec, events),
				log: (e) => logs.push(e),
				askTimeoutMs: 120_000,
				overGraceMs: 60_000,
				emit: (_m, seat, envelope) => {
					sent.push({ seat, envelope });
					const f = envelope.frame;
					if (f.method === 'setWeaklySelectable') notes[seat]!.actionable = f.cards.map((c) => c.id);
					else if (f.method === 'clearWeaklySelectable') notes[seat]!.actionable = null;
					else if (f.method === 'showPromptMessage') notes[seat]!.prompt = f.message;
					else if (f.method === 'updateButtons') notes[seat]!.ok = f.enable1;
				},
			});

			const match = registry.create({
				seed: 20260930,
				seats: [
					{ name: 'A', ai: false, deck: deck('P8 A', ['60 Gitaxian Probe']) },
					{ name: 'B', ai: false, deck: deck('P8 B', ['60 Gitaxian Probe']) },
				],
			});
			expect(await match.whenRunning(120_000)).toEqual({ ok: true });

			function stateOf(seat: number): Map<string, WireObj> {
				return foldFrames(
					sent
						.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
						.map((x) => x.envelope.frame as unknown as StateFrame)
						.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
				);
			}
			const playerOf = (seat: number, state = stateOf(seat)): WireObj | undefined => state.get(keyOf(TYPE.player, match.seats[seat]!.playerId ?? -1));
			const handOf = (seat: number): number[] => ids(playerOf(seat), 'Hand');
			const lifeOf = (seat: number): number => ((playerOf(seat)?.Life as { v?: number } | undefined)?.v) ?? -1;
			const gravesOf = (seat: number): number => ids(playerOf(seat), 'Graveyard').length;

			const answered = new Set<string>();
			function answerAsks(): void {
				for (const { seat, envelope } of sent) {
					const f = envelope.frame as ServerFrame & Record<string, unknown>;
					if (f.kind !== 'ask' || answered.has(f.callId as string)) continue;
					const callId = f.callId as string;
					answered.add(callId);
					let result: unknown = null;
					if (f.method === 'confirm' || f.method === 'showConfirmDialog' || f.method === 'openZones') result = true;
					else if (f.method === 'showOptionDialog') result = 0;
					else if (f.method === 'getAbilityToPlay') result = (f.abilities as unknown[])[0] ?? null;
					else if (f.method === 'manipulateCardList') result = f.cards;
					expect(match.fromClient(seat, ClientFrameSchema.parse({ kind: 'reply', callId, method: f.method, result })), `${String(f.method)} ${callId}`).toEqual({ ok: true });
				}
			}

			const OK = ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' });
			const select = (id: number) =>
				ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null });
			const clickPlayer = (id: number) =>
				ClientFrameSchema.parse({ kind: 'act', method: 'selectPlayer', player: { kind: 'player', id }, triggerEvent: null });

			// Drive to seat 0's first main phase and stop there: keep, play first.
			const isMyMain = (prompt: string): boolean =>
				prompt.startsWith('Priority: A') && /^Turn: \d+ \(A\)/m.test(prompt) && /Stack: Empty/.test(prompt) && /Phase: Main/.test(prompt);
			const toMain = Date.now() + 60_000;
			while (!isMyMain(notes[0]!.prompt) && Date.now() < toMain) {
				answerAsks();
				for (const seat of [0, 1]) if (notes[seat]!.ok && !isMyMain(notes[seat]!.prompt)) match.fromClient(seat, OK);
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(isMyMain(notes[0]!.prompt), `never reached seat 0's main phase; last prompt: ${notes[0]!.prompt}`).toBe(true);
			await new Promise((r) => setTimeout(r, 500));

			const hand = handOf(0);
			const offered = notes[0]!.actionable;
			console.log(`[phyrexian] main phase: hand=${JSON.stringify(hand)} life=${String(lifeOf(0))} actionable=${JSON.stringify(offered)}`);
			expect(hand.length).toBeGreaterThanOrEqual(7);
			const probe = hand.find((id) => offered?.includes(id) === true);
			expect(probe, `Gitaxian Probe is not in the set the browser is offered: ${JSON.stringify(offered)}`).toBeDefined();

			// Click it, click its target (the opponent), and pay by clicking our own life total.
			const opponent = match.seats[1]!.playerId ?? -1;
			const me = match.seats[0]!.playerId ?? -1;
			const before = { life: lifeOf(0), graves: gravesOf(0) };
			match.fromClient(0, select(probe!));
			let targeted = false;
			let paid = false;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline && !(paid && lifeOf(0) < before.life)) {
				answerAsks();
				const p = notes[0]!.prompt;
				if (!targeted && p !== '' && !p.startsWith('Priority: ') && !/^Pay Mana Cost: /m.test(p)) {
					targeted = true;
					match.fromClient(0, clickPlayer(opponent));
				} else if (!paid && /^Pay Mana Cost: /m.test(p)) {
					paid = true;
					console.log(`[phyrexian] payment prompt: ${JSON.stringify(p)}`);
					expect(p).toMatch(/Click on your life total to pay life for/);
					match.fromClient(0, clickPlayer(me));
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			await new Promise((r) => setTimeout(r, 1500));
			answerAsks();
			await new Promise((r) => setTimeout(r, 500));

			console.log(`[phyrexian] after: life=${String(lifeOf(0))} graveyard=${String(gravesOf(0))} hand=${String(handOf(0).length)}`);
			expect(lifeOf(0)).toBe(18);
			expect(gravesOf(0)).toBe(before.graves + 1);
			// One card left the hand to be cast and Probe's own draw put one back.
			expect(handOf(0)).toHaveLength(hand.length);

			match.stop();
			jvm.close();
			await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 15_000);
		},
		240_000,
	);
});
