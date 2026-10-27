/**
 * Can a match be rebuilt from its action log (docs/planning/front-page-and-replay-plan.md)? Run A
 * plays a real two-human match through the registry with a crude driver, recording every command
 * sent to Forge with the seat's board and prompt at that moment. Run B starts the same spec on a
 * bare host and sends each command once its seat reaches that same position, with nobody deciding
 * anything. Every position must be reached, and both seats' final boards must match.
 *
 * What is compared is the folded board, not the frames: Forge batches state into packets on its
 * own clock, sends a property at its default or leaves it out depending on that batching, and
 * interleaves the two seats' prompts by thread timing. None of that is the game.
 *
 * Measured 2026-10-27 on pin 5eff8436: Spirit Flames v Decay to turn 8 (170 commands), Abzan Siege
 * v Aerodoom to turn 11 (269), Adaptive Enchantment v Spirit Flames to turn 5 (100) — 8 replays,
 * every one identical. Not yet measured: a replay under load, or any match with an AI seat (its
 * decisions are not commands, so they are not in the log).
 *
 * `[nightly]`: a played match plus its replays is minutes of JVM. `CARDTABLE_REPLAY_RUNS` replays
 * (default 2), `CARDTABLE_PLAY_SEED`, `CARDTABLE_REPLAY_DECK_A`/`_B` (precon names),
 * `CARDTABLE_REPLAY_TURNS`; `CARDTABLE_REPLAY_DUMP=<dir>` keeps both logs.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientFrameSchema, deltaKey, DELTA_TYPE, type ServerFrame } from '@hadoku/forge-wire';
import type { ServerEnvelope } from '@hadoku/shared';

import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeCommand, type BridgeLine, type MatchSpec } from './host.js';
import { createMatchRegistry } from './match.js';
import { nightly } from './scenario.js';
import { foldFrames, type StateFrame, type WireObj } from './visibility.js';

const available = jvmHostConfig();
const title = !available.ok
	? `replay from the action log [nightly] — SKIPPED: ${available.reason}`
	: !nightly
		? 'replay from the action log [nightly] — SKIPPED: CARDTABLE_JVM_NIGHTLY is not 1'
		: 'replay from the action log [nightly]';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(p: () => boolean, label: string, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!p()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(20);
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

interface Logged {
	/** The seat's board and its last prompt when A sent this: where B must be before it is sent again. */
	board: string;
	prompt: string;
	command: BridgeCommand;
}

const commandSeat = (c: BridgeCommand): number | null => ('seat' in c ? c.seat : null);

const STATE_METHODS = new Set(['setGameView', 'applyDelta', 'openView']);
const isState = (l: BridgeLine): boolean => l.t === 'frame' && STATE_METHODS.has((l.frame as { method?: string }).method ?? '');

/**
 * What a player is shown that is not board state: prompts, buttons, asks. Forge batches state into
 * packets on its own clock, so the packets are compared by what they fold to, and commands are
 * placed by these.
 */
const controlCount = (lines: readonly BridgeLine[]): number => lines.filter((l) => l.t === 'frame' && !isState(l)).length;

function controlFrames(lines: readonly BridgeLine[], seat: number): string[] {
	return lines
		.filter((l) => l.t === 'frame' && l.seat === seat && !isState(l))
		.map((l) => JSON.stringify((l as { frame: unknown }).frame).replace(/"callId":"[^"]*"/g, '"callId":_'));
}

function lastPrompt(lines: readonly BridgeLine[], seat: number): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!;
		if (l.t === 'frame' && l.seat === seat && (l.frame as { method?: string }).method === 'showPromptMessage') return (l.frame as { message: string }).message;
	}
	return '';
}

/** The first object two boards disagree on, both sides. */
function boardDiff(a: string, b: string): string {
	const ma = new Map(JSON.parse(a) as [string, unknown][]);
	const mb = new Map(JSON.parse(b) as [string, unknown][]);
	for (const k of new Set([...ma.keys(), ...mb.keys()])) {
		const x = JSON.stringify(ma.get(k) ?? null);
		const y = JSON.stringify(mb.get(k) ?? null);
		if (x !== y) return `${k}:\n    A ${x.slice(0, 600)}\n    B ${y.slice(0, 600)}`;
	}
	return 'none';
}

/** The board a seat ends up with, packet boundaries and sequence numbers aside. */
function boardOf(lines: readonly BridgeLine[], seat: number): string {
	const state = foldFrames(lines.filter((l) => isState(l) && l.t === 'frame' && l.seat === seat).map((l) => (l as { frame: unknown }).frame as StateFrame));
	// A property at its default may be absent or sent empty, depending on how Forge batched it.
	const isDefault = (x: unknown): boolean => {
		if (typeof x !== 'object' || x === null || !('t' in x)) return false;
		const v = (x as { v?: unknown }).v;
		return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && v.length === 0);
	};
	const normal = [...state.entries()].map(([k, o]) => [k, Object.fromEntries(Object.entries(o).filter(([, x]) => !isDefault(x)).sort(([a], [b]) => a.localeCompare(b)))] as const);
	return JSON.stringify(normal.sort(([a], [b]) => a.localeCompare(b)));
}

/** The ask callIds each seat was sent, in order — a reply names one, and B's may be spelled differently. */
function askIds(lines: readonly BridgeLine[]): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const l of lines) {
		if (l.t !== 'frame') continue;
		const f = l.frame as { kind?: string; callId?: string };
		if (f.kind !== 'ask' || f.callId === undefined) continue;
		out.set(l.seat, [...(out.get(l.seat) ?? []), f.callId]);
	}
	return out;
}

describe.skipIf(!available.ok || !nightly)(title, () => {
	afterAll(async () => {
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
	});

	it('rebuilds the same game from the commands alone', async () => {
		if (!available.ok) return;
		const spec: MatchSpec = {
			seed: Number(process.env.CARDTABLE_PLAY_SEED ?? 20261026),
			seats: [
				{ name: 'A', ai: false, deck: precon(process.env.CARDTABLE_REPLAY_DECK_A ?? 'Spirit Flames') },
				{ name: 'B', ai: false, deck: precon(process.env.CARDTABLE_REPLAY_DECK_B ?? 'Decay') },
			],
		};

		// ---- Run A: a played match. ----
		const raw: BridgeLine[] = [];
		const log: Logged[] = [];
		let hostSpec: MatchSpec | null = null;
		let lastLineAt = Date.now();
		const sent: { seat: number; envelope: ServerEnvelope }[] = [];
		const notes = [0, 1].map(() => ({ prompt: '', ok: false, actionable: null as number[] | null }));
		const jvmA = jvmHostFactory(available.config, { spare: false, log: () => {} });
		const registry = createMatchRegistry({
			host: (id, s, events) => {
				hostSpec = s;
				const host = jvmA(id, s, {
					...events,
					line: (l) => {
						raw.push(l);
						lastLineAt = Date.now();
						events.line(l);
					},
				});
				return {
					...host,
					send: (command) => {
						const seat = commandSeat(command);
						log.push({ board: seat === null ? '' : boardOf(raw, seat), prompt: seat === null ? '' : lastPrompt(raw, seat), command });
						host.send(command);
					},
				};
			},
			log: () => {},
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
		const t0 = Date.now();
		const match = registry.create(spec);
		expect(await match.whenRunning(120_000)).toEqual({ ok: true });

		const answered = new Set<string>();
		const tried = new Set<string>();
		const handOf = (seat: number): number[] => {
			const state = foldFrames(
				sent
					.filter((x) => x.seat === seat && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as StateFrame)
					.filter((f) => f.method === 'setGameView' || f.method === 'applyDelta' || f.method === 'openView'),
			);
			const player = state.get(deltaKey(DELTA_TYPE.player, match.seats[seat]!.playerId ?? -1)) as WireObj | undefined;
			const hand = player?.Hand as { v?: unknown[] } | undefined;
			return (hand?.v ?? []).map((x) => (typeof x === 'object' && x !== null ? (x as { v: number }).v : (x as number)));
		};
		const answerAsks = (): void => {
			for (const { seat, envelope } of sent) {
				const f = envelope.frame as ServerFrame & Record<string, unknown>;
				if (f.kind !== 'ask' || answered.has(f.callId as string)) continue;
				answered.add(f.callId as string);
				let result: unknown = null;
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
						result = { ordered: (f.destChoices as { key: string }[]).map((c) => c.key), rememberDecision: false };
						break;
					case 'assignCombatDamage':
					case 'assignGenericAmount':
						result = [];
						break;
				}
				match.fromClient(seat, ClientFrameSchema.parse({ kind: 'reply', callId: f.callId, method: f.method, result }));
			}
		};
		const act = (seat: number, frame: Record<string, unknown>) => match.fromClient(seat, ClientFrameSchema.parse({ kind: 'act', ...frame }));
		const select = (id: number) => ({ method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null });

		const maxTurn = Number(process.env.CARDTABLE_REPLAY_TURNS ?? 12);
		const deadline = Date.now() + Number(process.env.CARDTABLE_REPLAY_PLAY_MS ?? 240_000);
		let turn = 0;
		let samePrompt = { text: '', since: Date.now() };
		while (Date.now() < deadline && turn < maxTurn && match.status === 'running') {
			// A human acts on a settled screen; so does this driver.
			if (Date.now() - lastLineAt < 150) {
				await sleep(50);
				continue;
			}
			answerAsks();
			for (const seat of [0, 1]) {
				const n = notes[seat]!;
				const me = seat === 0 ? 'A' : 'B';
				const t = /Turn: (\d+) \(([^)]*)\)/.exec(n.prompt);
				if (t !== null) turn = Math.max(turn, Number(t[1]));
				const key = `${seat}:${n.prompt}`;
				if (n.prompt !== samePrompt.text) samePrompt = { text: n.prompt, since: Date.now() };
				const offered = n.actionable ?? [];
				const myPriority = n.prompt.startsWith(`Priority: ${me}`);
				const myMain = myPriority && /Stack: Empty/.test(n.prompt) && /Phase: Main/.test(n.prompt) && t?.[2] === me;
				if (myMain) {
					const card = handOf(seat).find((id) => offered.includes(id) && !tried.has(`${key}:${id}`));
					if (card !== undefined) {
						tried.add(`${key}:${card}`);
						act(seat, select(card));
						continue;
					}
				}
				// Attackers, targets and any other "pick one of these": the first offered thing, once.
				if (!myMain && offered.length > 0 && !n.prompt.startsWith('Priority:')) {
					const pick = offered.find((id) => !tried.has(`${key}:${id}`));
					if (pick !== undefined) {
						tried.add(`${key}:${pick}`);
						act(seat, select(pick));
						continue;
					}
				}
				// A discard or other "select N cards" from hand that offers no highlight.
				if (/^Cleanup|discard/i.test(n.prompt) && !n.ok) {
					const card = handOf(seat).find((id) => !tried.has(`${key}:${id}`));
					if (card !== undefined) {
						tried.add(`${key}:${card}`);
						act(seat, select(card));
						continue;
					}
				}
				if (n.ok) act(seat, { method: 'selectButtonOk' });
				else if (n.prompt !== '' && Date.now() - samePrompt.since > 800) act(seat, { method: 'selectButtonCancel' });
			}
			await sleep(100);
		}
		await waitUntil(() => Date.now() - lastLineAt > 1500, 'run A to settle', 30_000);
		const playedMs = Date.now() - t0;
		match.stop();
		jvmA.close();
		await waitUntil(() => liveJvmCount() === 0, 'run A to exit', 20_000);
		console.log(`[replay] A: turn ${turn}, ${raw.length} lines, ${controlCount(raw)} control frames, ${log.length} commands, ${playedMs} ms`);
		const asksA = askIds(raw);

		// ---- Run B: the same spec and the log, nobody deciding. ----
		const replays = Number(process.env.CARDTABLE_REPLAY_RUNS ?? 2);
		const differed: number[] = [];
		for (let r = 0; r < replays; r++) {
			const rawB: BridgeLine[] = [];
			let lastB = Date.now();
			let exited: string | null = null;
			const jvmB = jvmHostFactory(available.config, { spare: false, log: () => {} });
			const tB = Date.now();
			const hostB = jvmB(`replay-${r}-${Date.now()}`, hostSpec!, {
				line: (l) => {
					rawB.push(l);
					lastB = Date.now();
				},
				exit: (reason) => {
					exited = reason;
				},
				log: () => {},
			});
			let diverged: string | null = null;
			for (const [i, { board, prompt, command }] of log.entries()) {
				const seat = commandSeat(command);
				const prior = log[i - 1];
				// Sent in the same breath as the one before it, from the same position: send it straight after.
				const burst = prior !== undefined && commandSeat(prior.command) === seat && prior.board === board && prior.prompt === prompt;
				if (seat !== null && !burst) {
					// Where A was: this seat's board and prompt, settled, so Forge is waiting for the input.
					const there = () => lastPrompt(rawB, seat) === prompt && boardOf(rawB, seat) === board;
					const deadline = Date.now() + 30_000;
					while (exited === null && Date.now() < deadline && !(Date.now() - lastB > 80 && there())) await sleep(20);
					if (exited !== null || !there()) {
						diverged = `command ${i} (${command.t} seat ${seat}) never found A's position.\n  prompt A ${JSON.stringify(prompt)}\n  prompt B ${JSON.stringify(lastPrompt(rawB, seat))}\n  first board difference ${boardDiff(board, boardOf(rawB, seat))}`;
						break;
					}
				}
				let out = command;
				if (command.t === 'reply' || command.t === 'abort') {
					const k = asksA.get(command.seat)?.indexOf(command.callId) ?? -1;
					await waitUntil(() => askIds(rawB).get(command.seat)?.[k] !== undefined || exited !== null, `ask #${k}`, 30_000).catch(() => {});
					const mapped = askIds(rawB).get(command.seat)?.[k];
					if (mapped === undefined) {
						diverged = `command ${i}: B has no ask #${k} for seat ${command.seat}`;
						break;
					}
					out = { ...command, callId: mapped };
				}
				hostB.send(out);
			}
			await waitUntil(() => Date.now() - lastB > 1500 || exited !== null, 'run B to settle', 30_000);
			const replayMs = Date.now() - tB;
			hostB.stop();
			jvmB.close();
			await waitUntil(() => liveJvmCount() === 0, 'run B to exit', 20_000);

			const report: string[] = [];
			let firstDiff: string | null = null;
			for (const seat of [0, 1]) {
				const a = controlFrames(raw, seat);
				const b = controlFrames(rawB, seat);
				let k = 0;
				while (k < a.length && k < b.length && a[k] === b[k]) k++;
				const sameBoard = boardOf(raw, seat) === boardOf(rawB, seat);
				report.push(`seat ${seat}: prompts ${k}/${a.length} identical (B ${b.length}), final board ${sameBoard ? 'identical' : 'DIFFERENT'}`);
				if (firstDiff === null && !sameBoard) firstDiff = `seat ${seat}: final boards differ at ${boardDiff(boardOf(raw, seat), boardOf(rawB, seat))}`;
			}
			console.log(`[replay] B${r}: ${replayMs} ms, ${report.join('; ')}${diverged === null ? '' : `; driver: ${diverged}`}`);
			if (firstDiff !== null) console.log(`[replay] B${r} first difference, ${firstDiff}`);
			const dump = process.env.CARDTABLE_REPLAY_DUMP;
			if (dump !== undefined) {
				mkdirSync(dump, { recursive: true });
				writeFileSync(join(dump, 'a.jsonl'), raw.map((l) => JSON.stringify(l)).join('\n'));
				writeFileSync(join(dump, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n'));
				writeFileSync(join(dump, `b${r}.jsonl`), rawB.map((l) => JSON.stringify(l)).join('\n'));
			}
			if (firstDiff !== null || diverged !== null) differed.push(r);
		}
		expect(differed).toEqual([]);
	}, 900_000);
});
