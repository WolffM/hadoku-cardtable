/**
 * Can a match whose public stream has expired be rebuilt from its action log alone
 * (`docs/planning/wave77-2026-10-27.md` §D, `docs/planning/wave78-2026-10-27.md` §A)? Three things
 * are proven here, cheapest first:
 *
 * - `canRebuild` is a pure gate (every seat human, this server's own pin/bridge, a seed) — fast,
 *   always run.
 * - `rebuild` runs one at a time per server — fast, a stub host, always run.
 * - A real two-human match, driven by a crude scripted player, is recorded through the REAL
 *   `createRecorder` (never a hand-rolled copy of its logging), its public stream deleted (as if
 *   it had expired), and `rebuild()` is asked to recover it on a second JVM. The rebuild either
 *   reaches both seats' live final boards and the live watcher state, or it is refused and writes
 *   nothing. A different game is never written. The log does not yet reproduce every game (plan,
 *   "Wave 78 results"). `[nightly]`: a played match plus its rebuild is minutes of JVM.
 *   `CARDTABLE_REBUILD_DUMP=<dir>` writes the action log to `cmds.jsonl` there, for inspecting a
 *   divergence without re-running the JVM.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClientFrameSchema, deltaKey, DELTA_TYPE, type ServerFrame } from '@hadoku/forge-wire';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';
import type { ServerEnvelope } from '@hadoku/shared';

import type { DeckCosts } from '../deck-colors.js';
import { jvmHostConfig, jvmHostFactory, liveJvmCount, type BridgeLine, type MatchSpec } from '../host.js';
import { createMatchRegistry, WATCHER_SEAT } from '../match.js';
import { boardDigest } from './position.js';
import { nightly } from '../scenario.js';
import { COLD_STARTS, queueColdStarts } from '../start-queue.js';
import { foldFrames, type StateFrame, type WireObj } from '../visibility.js';
import { createRecorder, forgePin } from './recorder.js';
import { createMatchRecordingWriter, type PublicEnvLine } from './writer.js';
import {
	actionLogPath,
	canRebuild,
	currentForge,
	publicStreamPath,
	readActionLog,
	rebuild,
	type ActionCmdLine,
} from './rebuild.js';

const available = jvmHostConfig();
const title = !available.ok
	? `rebuild from the action log [nightly] — SKIPPED: ${available.reason}`
	: !nightly
		? 'rebuild from the action log [nightly] — SKIPPED: CARDTABLE_JVM_NIGHTLY is not 1'
		: 'rebuild from the action log [nightly]';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

const recordingsDir = process.env.CARDTABLE_RECORDINGS_DIR ?? join(tmpdir(), 'cardtable-rebuild-test');
mkdirSync(recordingsDir, { recursive: true });

/** The same cost map `deck-colors.ts`'s own `roomDeckCosts` falls back to when no format is given. */
const deckCosts: DeckCosts = () => LIBRARY_CARD_COSTS;

/** A seat's board, from the watcher channel's own frames: tag each as a fake seat-0 bridge line and fold it the same way `position.ts`'s `boardDigest` folds a real one. No format-specific copy needed — `isStateLine` already filters to the three state methods. */
const boardOfEnvelopeFrames = (frames: readonly ServerFrame[]): string => boardDigest(frames.map((frame) => ({ t: 'frame', seat: 0, frame })) as BridgeLine[], 0);

/* ── canRebuild: fast, no JVM ─────────────────────────────────────────────────────────────── */

describe('canRebuild', () => {
	const specWith = (seed: number | undefined, seat1Ai: boolean): MatchSpec => ({
		seed,
		seats: [
			{ name: 'A', ai: false, deck: null },
			{ name: 'B', ai: seat1Ai, deck: null },
		],
	});
	const running = { pin: 'pin-1', bridge: 'bridge-1' };

	it('refuses an AI seat: the AI never decides in a replay', () => {
		const r = canRebuild({ pin: 'pin-1', bridge: 'bridge-1', spec: specWith(1, true) }, running);
		expect(r).toEqual({ ok: false, reason: expect.stringContaining('AI') as unknown as string });
	});

	it('refuses when this server cannot resolve its own Forge', () => {
		const r = canRebuild({ pin: 'pin-1', bridge: 'bridge-1', spec: specWith(1, false) }, null);
		expect(r).toEqual({ ok: false, reason: expect.stringContaining('not available') as unknown as string });
	});

	it('refuses an unpinned jar on either side', () => {
		expect(canRebuild({ pin: null, bridge: 'bridge-1', spec: specWith(1, false) }, running).ok).toBe(false);
		expect(canRebuild({ pin: 'pin-1', bridge: 'bridge-1', spec: specWith(1, false) }, { pin: null, bridge: 'bridge-1' }).ok).toBe(false);
	});

	it('refuses a different jar (pin)', () => {
		const r = canRebuild({ pin: 'other-pin', bridge: 'bridge-1', spec: specWith(1, false) }, running);
		expect(r.ok).toBe(false);
	});

	it('refuses a different bridge', () => {
		const r = canRebuild({ pin: 'pin-1', bridge: 'other-bridge', spec: specWith(1, false) }, running);
		expect(r.ok).toBe(false);
	});

	it('refuses a spec with no seed', () => {
		const r = canRebuild({ pin: 'pin-1', bridge: 'bridge-1', spec: specWith(undefined, false) }, running);
		expect(r.ok).toBe(false);
	});

	it('allows two humans, this server\'s own pin and bridge, and a seed', () => {
		const r = canRebuild({ pin: 'pin-1', bridge: 'bridge-1', spec: specWith(1, false) }, running);
		expect(r).toEqual({ ok: true });
	});

	it('currentForge resolves the live jar\'s pin, from its name or its bundle directory', () => {
		if (!available.ok) return;
		const forge = currentForge();
		expect(forge).not.toBeNull();
		// Production names the jar `<pin>.jar`; CI's bundle names it `<pin>/forge.jar` (`forgePin`).
		expect(forge!.pin).toBe(forgePin(available.config.jar));
		expect(forge!.pin).toMatch(/^[0-9a-f]{40}$/);
		expect(forge!.bridge).toMatch(/^[0-9a-f]{64}$/);
	});
});

/* ── one rebuild at a time per server: fast, a stub host, no JVM ───────────────────────────── */

describe('rebuild: one at a time per server', () => {
	it('never starts the second while the first is still running', async () => {
		const dir = join(recordingsDir, 'mutex');
		mkdirSync(dir, { recursive: true });
		const writerFor = (matchId: string) =>
			createMatchRecordingWriter({
				dir,
				matchId,
				actionsHeader: { matchId, roomId: 'r', pin: 'p', bridge: 'b', server: 'test', startedAt: new Date().toISOString(), spec: { seed: 1, seats: [{ name: 'A', ai: false, deck: null }, { name: 'B', ai: false, deck: null }] } },
				publicHeader: { matchId, roomId: 'r', players: ['A', 'B'], ai: [false, false], decks: [null, null], startedAt: new Date().toISOString() },
				log: () => {},
			});
		// A reply, not an act: a reply waits for its ask, which this stub host (silent) never
		// produces, so the drive loop is still blocked on command 0 when the second `rebuild` call
		// starts — exactly what this test needs to prove they never overlap.
		const cmd: Omit<ActionCmdLine, 't'> = { seat: 0, cmd: { t: 'reply', seat: 0, callId: 'never-mapped', result: null } };
		for (const matchId of ['mutex-1', 'mutex-2']) {
			const writer = writerFor(matchId);
			writer.actionCmd(cmd);
			await writer.finish({ endedAt: new Date().toISOString(), reason: 'test' }, { endedAt: new Date().toISOString(), winner: null });
			rmSync(publicStreamPath(dir, matchId)); // simulate "expired" — only the action log is used
		}

		const order: string[] = [];
		const stubHostFor = (label: string) => (_id: string, _spec: MatchSpec, _events: unknown) => {
			order.push(`start:${label}`);
			return { send: () => {}, stop: () => {} };
		};
		const depsFor = (label: string) => ({ recordingsDir: dir, host: stubHostFor(label), log: () => {}, deckCosts, positionBudgetMs: 60, running: { pin: 'p', bridge: 'b' } });

		const [r1, r2] = await Promise.all([
			rebuild('mutex-1', depsFor('mutex-1')).then((r) => {
				order.push('end:mutex-1');
				return r;
			}),
			rebuild('mutex-2', depsFor('mutex-2')).then((r) => {
				order.push('end:mutex-2');
				return r;
			}),
		]);

		expect(order.indexOf('start:mutex-2')).toBeGreaterThan(order.indexOf('end:mutex-1'));
		expect(r1.ok).toBe(false);
		expect(r2.ok).toBe(false);
	});
});

/* ── a real match, rebuilt on a second JVM ──────────────────────────────────────────────────── */

describe.skipIf(!available.ok || !nightly)(title, () => {
	afterAll(async () => {
		await waitUntil(() => liveJvmCount() === 0, 'every JVM to exit', 20_000);
	});

	it('rebuilds the same game, and the same watcher stream, from the action log alone', async () => {
		if (!available.ok) return;
		const spec: MatchSpec = {
			seed: Number(process.env.CARDTABLE_PLAY_SEED ?? 20261027),
			seats: [
				{ name: 'A', ai: false, deck: precon(process.env.CARDTABLE_REBUILD_DECK_A ?? 'Spirit Flames') },
				{ name: 'B', ai: false, deck: precon(process.env.CARDTABLE_REBUILD_DECK_B ?? 'Decay') },
			],
		};

		// ---- Play a real match, recorded through the REAL recorder (never a hand-rolled copy). ----
		const raw: BridgeLine[] = [];
		let hostSpec: MatchSpec | null = null;
		let lastLineAt = Date.now();
		const sent: { seat: number; envelope: ServerEnvelope }[] = [];
		const liveWatcherFrames: ServerFrame[] = [];
		const notes = [0, 1].map(() => ({ prompt: '', ok: false, actionable: null as number[] | null }));
		const forge = currentForge();
		expect(forge).not.toBeNull();
		const recorder = createRecorder({
			dir: recordingsDir,
			identity: { pin: forge!.pin, bridge: forge!.bridge, server: 'rebuild.jvm.test' },
			roomOf: () => 'rebuild-test-room',
			deckCosts,
			log: () => {},
		});
		const jvmA = queueColdStarts(jvmHostFactory({ ...available.config, workDir: join(available.config.workDir, 'a') }, { warm: false, log: () => {} }), COLD_STARTS, () => {});
		const hostedA = recorder.host(jvmA);
		const registry = createMatchRegistry({
			host: (id, s, events) => {
				hostSpec = s;
				return hostedA(id, s, {
					...events,
					line: (l) => {
						raw.push(l);
						lastLineAt = Date.now();
						events.line(l);
					},
				});
			},
			log: () => {},
			overGraceMs: 60_000,
			emit: (m, seat, envelope) => {
				recorder.onEnvelope(m.id, seat, envelope);
				if (seat === WATCHER_SEAT) {
					liveWatcherFrames.push(envelope.frame);
					return;
				}
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

		const maxTurn = Number(process.env.CARDTABLE_REBUILD_TURNS ?? 10);
		const deadline = Date.now() + Number(process.env.CARDTABLE_REBUILD_PLAY_MS ?? 200_000);
		let turn = 0;
		let samePrompt = { text: '', since: Date.now() };
		while (Date.now() < deadline && turn < maxTurn && match.status === 'running') {
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
				if (!myMain && offered.length > 0 && !n.prompt.startsWith('Priority:')) {
					const pick = offered.find((id) => !tried.has(`${key}:${id}`));
					if (pick !== undefined) {
						tried.add(`${key}:${pick}`);
						act(seat, select(pick));
						continue;
					}
				}
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
		await waitUntil(() => Date.now() - lastLineAt > 1500, 'the played match to settle', 30_000);
		const playedMs = Date.now() - t0;
		const liveBoard: [string, string] = [boardDigest(raw, 0), boardDigest(raw, 1)];
		const matchId = match.id;
		match.stop();
		await waitUntil(() => liveJvmCount() === 0, 'the played match\'s JVM to exit', 20_000);
		jvmA.close?.();
		console.log(`[rebuild] played: turn ${turn}, ${raw.length} lines, ${playedMs} ms`);

		// ---- The real recorder flushes on the host's own exit: wait for its action log on disk. ----
		const actionsPath = actionLogPath(recordingsDir, matchId);
		await waitUntil(() => existsSync(actionsPath), 'the action log to flush to disk', 10_000);
		rmSync(publicStreamPath(recordingsDir, matchId)); // simulate "expired" — only the action log is used below
		expect(existsSync(publicStreamPath(recordingsDir, matchId))).toBe(false);

		const written = readActionLog(recordingsDir, matchId);
		const header = written[0];
		if (header === undefined || header.t !== 'header') throw new Error('no header in what was just written');
		expect(header.v).toBe(2);
		expect(canRebuild(header)).toEqual({ ok: true });
		const cmdCount = written.filter((l) => l.t === 'cmd').length;
		expect(cmdCount).toBeGreaterThan(10);
		const dump = process.env.CARDTABLE_REBUILD_DUMP;
		if (dump !== undefined) {
			mkdirSync(dump, { recursive: true });
			writeFileSync(join(dump, 'cmds.jsonl'), written.map((c) => JSON.stringify(c)).join('\n'));
		}
		void hostSpec; // read above only to satisfy the `host` factory's own signature

		// ---- Rebuild it on a second JVM, through the same kind of queued factory a real server uses. ----
		// A pool of its own directory, as the server's rebuild pool has: one sharing jvmA's would take its JVMs back.
		const jvmR = queueColdStarts(jvmHostFactory({ ...available.config, workDir: join(available.config.workDir, 'rebuild') }, { warm: false, log: () => {} }), COLD_STARTS, () => {});
		const tR = Date.now();
		const result = await rebuild(matchId, { recordingsDir, host: jvmR, log: (e) => console.log('[rebuild-log]', JSON.stringify(e)), deckCosts });
		const rebuildMs = Date.now() - tR;
		await waitUntil(() => liveJvmCount() === 0, 'the rebuild\'s JVM to exit', 20_000);
		jvmR.close?.();
		console.log(`[rebuild] rebuilt: ${result.ok ? 'ok' : `REFUSED: ${result.reason}`}, ${rebuildMs} ms`);
		// The log does not yet reproduce every game (plan, "Wave 78 results"). What must always hold:
		// a rebuild is either the live game, or refused and never written — never a different game served.
		if (!result.ok) {
			expect(existsSync(publicStreamPath(recordingsDir, matchId)), `a refused rebuild (${result.reason}) writes nothing`).toBe(false);
			return;
		}

		expect(result.perSeatBoard).toEqual(liveBoard);
		expect(existsSync(publicStreamPath(recordingsDir, matchId))).toBe(true);

		const rebuiltEnvs = result.lines.filter((l): l is PublicEnvLine => l.t === 'env');
		expect(rebuiltEnvs.length).toBeGreaterThan(0);
		const liveWatcherBoard = boardOfEnvelopeFrames(liveWatcherFrames);
		const rebuiltWatcherBoard = boardOfEnvelopeFrames(rebuiltEnvs.map((e) => (e.env as ServerEnvelope).frame));
		expect(rebuiltWatcherBoard).toEqual(liveWatcherBoard);
	}, 900_000);
});
