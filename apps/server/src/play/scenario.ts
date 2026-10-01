/**
 * A scripted two-seat match against a REAL Forge JVM, for the wave-32 suites that
 * have to see what Forge itself does (`endturn.jvm.test.ts`, `blockers.jvm.test.ts`,
 * `priority.jvm.test.ts`).
 *
 * Not a test, and not a driver of good play: it keeps what each seat was last told,
 * folds each seat's projected state, and exposes the few acts a scenario needs. What
 * a scenario asserts is what FORGE offered and when, never the quality of a move.
 *
 * Every envelope and every bridge line is timestamped on arrival, because the Q5
 * claim is about gaps in milliseconds.
 */

import { ClientFrameSchema, type ServerFrame } from '@hadoku/forge-wire';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type JvmHostConfig } from './host.js';
import { createMatchRegistry, type Match } from './match.js';
import type { StopPolicy } from './auto.js';
import type { ServerEnvelope } from './transport.js';
import { foldFrames, keyOf, TYPE, type StateFrame, type WireObj } from './visibility.js';

export const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_SPARE: '0' });

export function deck(name: string, lines: readonly string[]): string {
	return `[metadata]\nName=${name}\n[main]\n${lines.join('\n')}\n`;
}

export async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

export function idsOf(o: WireObj | undefined, k: string): number[] {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	return (v.v as { t?: string; v?: unknown }[]).filter((x) => x?.t === 'int' && typeof x.v === 'number').map((x) => x.v as number);
}

export function strOf(o: WireObj | undefined, k: string): string | null {
	const v = o?.[k] as { t?: string; v?: unknown } | undefined;
	return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

export interface Stamped {
	seat: number;
	envelope: ServerEnvelope;
	/** `performance.now()` when the server handed it to a socket. */
	t: number;
}

export interface Buttons {
	label1: string;
	label2: string;
	enable1: boolean;
	enable2: boolean;
}

export interface Card {
	id: number;
	name: string;
	tapped: boolean;
	land: boolean;
	creature: boolean;
	sick: boolean;
}

export interface Scenario {
	match: Match;
	sent: Stamped[];
	lines: (BridgeLine & { t: string; hostT: number })[];
	logs: Record<string, unknown>[];
	names: [string, string];
	prompt(seat: number): string;
	buttons(seat: number): Buttons | null;
	state(seat: number): Map<string, WireObj>;
	zone(seat: number, name: 'Hand' | 'Battlefield' | 'Graveyard'): Card[];
	/** `Turn: N (Owner)` off this seat's last prompt. */
	turn(seat: number): { n: number; owner: string } | null;
	phase(seat: number): string | null;
	ok(seat: number): void;
	cancel(seat: number): void;
	select(seat: number, id: number): void;
	/** Answer every ask that reached a browser, plainly. Returns the asks answered this call. */
	answerAsks(): ServerFrame[];
	/**
	 * Keep every hand: press OK once on each prompt that is not a priority window
	 * (the keep-or-mulligan question). Call it in the scenario's loop.
	 */
	keepHands(): void;
	asks: ServerFrame[];
	stop(): Promise<void>;
}

export interface ScenarioOptions {
	seed: number;
	decks: [string, string];
	names?: [string, string];
	policy?: StopPolicy;
	/** Answers by method for asks `answerAsks` would otherwise answer plainly. */
	reply?: (frame: ServerFrame & Record<string, unknown>) => unknown;
}

export async function startScenario(config: JvmHostConfig, options: ScenarioOptions): Promise<Scenario> {
	const names = options.names ?? ['A', 'B'];
	const sent: Stamped[] = [];
	const lines: Scenario['lines'] = [];
	const logs: Record<string, unknown>[] = [];
	const jvm = jvmHostFactory(config, { spare: false, log: (e) => logs.push(e) });
	const registry = createMatchRegistry({
		host: (id, spec, events) =>
			jvm(id, spec, {
				...events,
				line: (l) => {
					lines.push({ ...(l as BridgeLine & { t: string }), hostT: performance.now() });
					events.line(l);
				},
			}),
		log: (e) => logs.push(e),
		askTimeoutMs: 120_000,
		overGraceMs: 60_000,
		...(options.policy === undefined ? {} : { stopPolicy: options.policy }),
		emit: (_m, seat, envelope) => sent.push({ seat, envelope, t: performance.now() }),
	});
	const match = registry.create({
		seed: options.seed,
		seats: [
			{ name: names[0], ai: false, deck: options.decks[0] },
			{ name: names[1], ai: false, deck: options.decks[1] },
		],
	});
	const started = await match.whenRunning(120_000);
	if (!started.ok) throw new Error(`match did not start: ${started.error}`);

	const answered = new Set<string>();
	const handled = new Set<number>();
	const asks: ServerFrame[] = [];

	const last = <T>(seat: number, method: string): T | null =>
		([...sent].reverse().find((s) => s.seat === seat && s.envelope.frame.method === method)?.envelope.frame as T | undefined) ?? null;

	const self: Scenario = {
		match,
		sent,
		lines,
		logs,
		names,
		asks,
		prompt: (seat) => last<{ message: string }>(seat, 'showPromptMessage')?.message ?? '',
		buttons: (seat) => last<Buttons>(seat, 'updateButtons'),
		state: (seat) =>
			foldFrames(
				sent
					.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as StateFrame)
					.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
			),
		zone(seat, name) {
			const state = self.state(seat);
			const player = state.get(keyOf(TYPE.player, match.seats[seat]?.playerId ?? -1));
			return idsOf(player, name).map((id) => {
				const view = state.get(keyOf(TYPE.card, id));
				const current = view?.CurrentState as { v?: number } | undefined;
				const face = state.get(keyOf(TYPE.cardState, id * 16 + (current?.v ?? 0)));
				const type = face?.Type as { core?: string[] } | undefined;
				return {
					id,
					name: strOf(face, 'Name') ?? strOf(view, 'Name') ?? `#${id}`,
					tapped: (view?.Tapped as { v?: boolean } | undefined)?.v === true,
					land: type?.core?.includes('Land') === true,
					creature: type?.core?.includes('Creature') === true,
					sick: (view?.Sickness as { v?: boolean } | undefined)?.v === true,
				};
			});
		},
		turn(seat) {
			const m = /Turn: (\d+) \(([^)]*)\)/.exec(self.prompt(seat));
			return m === null ? null : { n: Number(m[1]), owner: m[2] as string };
		},
		phase: (seat) => /^Phase: (.+)$/m.exec(self.prompt(seat))?.[1] ?? null,
		ok: (seat) => void match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonOk' })),
		cancel: (seat) => void match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', method: 'selectButtonCancel' })),
		select: (seat, id) =>
			void match.fromClient(
				seat,
				ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null }),
			),
		answerAsks() {
			const now: ServerFrame[] = [];
			for (const { seat, envelope } of sent) {
				const f = envelope.frame as ServerFrame & Record<string, unknown>;
				if (f.kind !== 'ask' || answered.has(f.callId as string)) continue;
				const callId = f.callId as string;
				answered.add(callId);
				asks.push(f);
				now.push(f);
				let result: unknown = options.reply?.(f);
				if (result === undefined) {
					switch (f.method) {
						case 'confirm':
						case 'showConfirmDialog':
						case 'openZones':
							result = true;
							break;
						case 'showOptionDialog':
							result = 0;
							break;
						case 'showInputDialog':
							result = '0';
							break;
						case 'getChoices': {
							const keys = (f.choices as { key: string }[]).map((c) => c.key);
							result = (f.min as number) > 0 && keys[0] !== undefined ? [keys[0]] : [];
							break;
						}
						case 'getAbilityToPlay':
							result = (f.abilities as unknown[])[0] ?? null;
							break;
						case 'chooseSingleEntityForEffect':
							result = (f.optionList as unknown[])[0] ?? null;
							break;
						case 'chooseEntitiesForEffect':
							result = (f.min as number) > 0 ? [(f.optionList as unknown[])[0]] : [];
							break;
						case 'manipulateCardList':
							result = f.cards;
							break;
						case 'order':
							result = { ordered: (f.sourceChoices as { key: string }[]).map((c) => c.key), rememberDecision: false };
							break;
						case 'assignCombatDamage':
						case 'assignGenericAmount':
							result = [];
							break;
						default:
							result = null;
					}
				}
				const reply = ClientFrameSchema.parse({ kind: 'reply', callId, method: f.method, result });
				match.fromClient(seat, reply);
			}
			return now;
		},
		keepHands() {
			for (const seat of [0, 1]) {
				const at = sent
					.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
					.filter((i) => i >= 0)
					.pop();
				if (at === undefined || handled.has(at)) continue;
				handled.add(at);
				const msg = (sent[at]?.envelope.frame as unknown as { message: string }).message;
				if (msg.startsWith('Priority:') || self.buttons(seat)?.enable1 !== true) continue;
				self.ok(seat);
			}
		},
		async stop() {
			match.stop();
			await waitUntil(() => liveJvmCount() === 0, "this match's JVM to exit", 30_000);
		},
	};
	return self;
}

const MAIN1 = /^Phase: Main phase, precombat$/m;

/** The seat's own first-main priority window for turn `n`, with the button live. */
export function inOwnMain(s: Scenario, seat: number, n: number): boolean {
	const turn = s.turn(seat);
	return (
		turn !== null &&
		turn.n === n &&
		turn.owner === s.names[seat] &&
		s.prompt(seat).startsWith(`Priority: ${s.names[seat]}`) &&
		MAIN1.test(s.prompt(seat)) &&
		/^Stack: Empty$/m.test(s.prompt(seat)) &&
		s.buttons(seat)?.enable1 === true
	);
}

/**
 * Whether the default policy STOPS the seat at this window — the only windows a
 * driver may press OK in, because every other one is passed by the server itself
 * and a second press would skip the stop after it.
 */
export function isStop(msg: string, seat: number, s: Scenario): boolean {
	if (!msg.startsWith('Priority:') || !/^Stack: Empty$/m.test(msg)) return false;
	const owner = /Turn: \d+ \(([^)]*)\)/.exec(msg)?.[1];
	const mine = owner === s.names[seat];
	const phase = /^Phase: (.+)$/m.exec(msg)?.[1] ?? '';
	if (mine) return ['Main phase, precombat', 'Main phase, postcombat', 'Declare Attackers Step'].includes(phase);
	return phase === 'Declare Blockers Step';
}

/** Press OK once on every NEW stop of either seat, until `done`. */
export async function passUntil(s: Scenario, done: () => boolean, label: string, ms = 60_000): Promise<void> {
	const pressed = new Set<number>();
	await waitUntil(() => {
		s.keepHands();
		s.answerAsks();
		if (done()) return true;
		for (const seat of [0, 1]) {
			const at = s.sent
				.map((x, i) => (x.seat === seat && x.envelope.frame.method === 'showPromptMessage' ? i : -1))
				.filter((i) => i >= 0)
				.pop();
			if (at === undefined || pressed.has(at)) continue;
			const msg = (s.sent[at]?.envelope.frame as unknown as { message: string }).message;
			// The cleanup discard: a hand of eight is one over the maximum.
			if (/^Cleanup Phase\nSelect \d+ card\(s\) to discard/.test(msg)) {
				pressed.add(at);
				const card = s.zone(seat, 'Hand')[0];
				if (card !== undefined) {
					s.select(seat, card.id);
					setTimeout(() => s.ok(seat), 300);
				}
				continue;
			}
			if (!isStop(msg, seat, s) || s.buttons(seat)?.enable1 !== true) continue;
			pressed.add(at);
			s.ok(seat);
		}
		return false;
	}, label, ms);
}

/** Click `name` in the seat's hand and wait until it is on the battlefield with the stack empty again. */
export async function castNamed(s: Scenario, seat: number, name: string): Promise<void> {
	await waitUntil(() => {
		s.answerAsks();
		return s.zone(seat, 'Hand').some((c) => c.name === name);
	}, `seat ${seat} to hold a ${name}`, 20_000);
	const card = s.zone(seat, 'Hand').find((c) => c.name === name);
	if (card === undefined) throw new Error(`no ${name}`);
	s.select(seat, card.id);
	await waitUntil(() => {
		s.answerAsks();
		return !s.zone(seat, 'Hand').some((c) => c.id === card.id) && /^Stack: Empty$/m.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true;
	}, `seat ${seat}'s ${name} to resolve`, 30_000);
}

