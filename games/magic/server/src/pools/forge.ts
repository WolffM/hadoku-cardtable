/**
 * The Forge pool service — `check`, `sets`, `setCards` and `boosters`
 * (`docs/planning/draft-pools-plan.md`, "The jar's pool service"), answered by
 * `play/bridge/PoolService.java` on its own long-lived JVM.
 *
 * It is a SEPARATE JVM from the per-match bridge (`play/host.ts`), on purpose:
 * `host.ts`'s JVM hosts one match for as long as that match lives, and a pool
 * request (a cube's playability, a booster) has nothing to do with any match in
 * progress — running it inside a match's JVM would mean a pool lookup can stall
 * a game, or a slow draft check ties up a seat's match host. This module boots
 * its own JVM instead, lazily (on the first call), and keeps it for the life of
 * the server.
 *
 * It reuses `host.ts`'s compile/launch helpers rather than re-implementing
 * them: `jvmHostConfig` resolves the jar, the res dir and the `java` binary
 * once (the caller does this — see `createForgePools`'s `config` param), and
 * `bridgeLaunch` is the same compile-once-per-version-then-launch-by-classname
 * logic the match bridge uses, pointed at `PoolService.java` instead of
 * `PlayBridge.java` by overriding `bridgeSource` on the config object (nothing
 * else about the config is Forge-match-specific). No other part of `host.ts` is
 * reused: the fifo/run-directory machinery there exists so a MATCH can outlive
 * the server that started it, which does not apply here — this JVM dies with
 * the server, and a dead JVM is simply respawned on the next request.
 *
 * ## The line protocol
 *
 * One JSON object per line, each direction, matching `PoolService.java`'s
 * `main`: `{ id, op, ...body }` in, `{ id, ok, ...body }` or
 * `{ id, ok: false, error }` out. `id` correlates a response to its request;
 * `t` lines (`{"t":"ready"}`, `{"t":"fatal",...}`) are the boot handshake, not a
 * reply to anything: logged, and they settle the boot.
 *
 * ## Boot is not a call's time
 *
 * Forge loads every card before the service says ready: about 5 s on an idle
 * host, 54 s on a loaded one (prod, 2026-11-25). A call waits for ready under
 * `bootTimeoutMs`, and only then starts its own `callTimeoutMs`. When the first
 * call's clock counted the boot, a slow boot failed it (the boot-time set list
 * warm-up, never retried), and the first person to open a draft's Set tab then
 * waited for every set to be walked.
 *
 * ## Serialisation and restart
 *
 * Every call is queued onto one promise chain, so at most one request is ever
 * in flight — `PoolService.java`'s `main` loop is single-threaded and would
 * otherwise have to interleave two requests' output lines. A JVM that exits
 * (crash, or killed from outside) fails every request still waiting on it and
 * drops the reference; the NEXT call lazily spawns a fresh one, so one dead JVM
 * costs at most the in-flight request, never a half-open protocol.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { pidWork } from '@hadoku/game-server/play/engine-runtime';
import { bridgeLaunch, FORGE_JVM_FLAGS, type JvmHostConfig } from '@hadoku/game-server/play/host';
import { POOL_SERVICE_SOURCE } from '../root.js';

export interface SetSummary {
	code: string;
	name: string;
	date: string;
	type: string;
	/** The code Scryfall, and so the card catalog, prints the set under (Conflux: CFX here, CON there). */
	scryfallCode?: string;
}

export interface BoosterCard {
	name: string;
	set: string;
	collectorNumber: string;
	/**
	 * `PaperCard.isFoil()`, carried straight off `PoolService.java`. `getBoosterPack` can add one
	 * foil of any rarity in place of a common slot card (the edition's own foil chance) — a real,
	 * EXTRA card a reader must set aside before counting a pack's rarity collation, not a miscount.
	 */
	foil: boolean;
}

export interface ForgePools {
	/** Names `StaticData.getCommonCards()` does not know at this jar's pin. */
	check(names: readonly string[]): Promise<string[]>;
	/** Every set the jar can make a draft booster for. */
	sets(): Promise<SetSummary[]>;
	/** Non-basic unique names in the set. */
	setCards(code: string): Promise<string[]>;
	/** `count` draft boosters of `code`; the same seed gives the same boosters. */
	boosters(code: string, count: number, seed: string): Promise<BoosterCard[][]>;
	/** Stop the JVM, if one is running. Idempotent. */
	close(): Promise<void>;
}

const POOL_RUN_DIR_NAME = 'pool';

/**
 * A scratch directory this JVM boots in: Forge resolves `res/` against its
 * working directory, so this is the minimum every boot needs — a `res`
 * symlink and a profile pointing `userDir`/`cacheDir` here instead of the
 * platform default (which would otherwise write into the operator's home
 * directory). No fifos, no per-match deck directories: this JVM is never
 * re-attached, so none of that machinery applies.
 */
function stagePoolDir(config: JvmHostConfig): string {
	const run = join(config.workDir, POOL_RUN_DIR_NAME);
	rmSync(run, { recursive: true, force: true });
	mkdirSync(join(run, 'user', 'preferences'), { recursive: true });
	mkdirSync(join(run, 'cache'), { recursive: true });
	mkdirSync(join(run, 'tmp'), { recursive: true });
	symlinkSync(config.res, join(run, 'res'));
	writeFileSync(join(run, 'forge.profile.properties'), [`userDir=${run}/user/`, `cacheDir=${run}/cache/`, ''].join('\n'));
	return run;
}

/** `{ id, ok, ... }` or `{ id, ok: false, error }` — see the module header. */
interface JsonResponse {
	id?: unknown;
	ok?: unknown;
	[key: string]: unknown;
}

/** A response the protocol loop could not match to a pending call, or a boot line (`{"t":...}`). */
function isReply(value: unknown): value is JsonResponse & { id: string } {
	return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

/**
 * The pool JVM's heap cap. Its live set is Forge's card data, 190 MB after a full GC, and an
 * 8-seat booster deal or the boot's whole-catalog load fit in 512 MB (measured 2026-11-28);
 * this is that with room. Without a cap the JVM took a quarter of the cgroup's limit (8 GB),
 * grew to 1.1–1.75 GB at boot and kept it. `CARDTABLE_PLAY_JVM_OPTS`' own `-Xmx` wins.
 */
export const POOL_JVM_HEAP_MB = 768;

export interface PoolTiming {
	/** A call fails once the JVM has done no work on it for this long. */
	callTimeoutMs: number;
	/** And once it has taken this long, working or not: under the edge's 100 s request deadline. */
	callCapMs: number;
	bootTimeoutMs: number;
}

const DEFAULT_TIMING: PoolTiming = { callTimeoutMs: 30_000, callCapMs: 90_000, bootTimeoutMs: 180_000 };

/** Linux's `/proc` clock tick (USER_HZ), the same 100 on every architecture's user ABI. */
const MS_PER_TICK = 10;

/**
 * Whether the JVM worked through the last `windowMs`: a twentieth of it on CPU (collecting,
 * computing a pack), or a page-in every 100 ms (reading its heap back from swap). An idle JVM
 * does neither; a JVM waiting on nothing for a whole window is stuck, not slow.
 */
function worked(before: ReturnType<typeof pidWork>, after: ReturnType<typeof pidWork>, windowMs: number): boolean {
	if (before === null || after === null) return false;
	return (after.cpuTicks - before.cpuTicks) * MS_PER_TICK >= windowMs / 20 || after.majorFaults - before.majorFaults >= windowMs / 100;
}

export function createForgePools(config: JvmHostConfig, log: (entry: Record<string, unknown>) => void = () => {}, timing: PoolTiming = DEFAULT_TIMING): ForgePools {
	const CALL_TIMEOUT_MS = timing.callTimeoutMs;
	const poolConfig: JvmHostConfig = { ...config, bridgeSource: POOL_SERVICE_SOURCE };
	if (!existsSync(poolConfig.bridgeSource)) {
		throw new Error(`pool service source not found: ${poolConfig.bridgeSource}`);
	}

	let child: ChildProcessWithoutNullStreams | null = null;
	/** The current child's boot: settled by its ready or fatal line, its exit, or the boot deadline. */
	let booted: Promise<void> = Promise.resolve();
	let settleBoot: (err?: Error) => void = () => {};
	let nextId = 1;
	const pending = new Map<string, { resolve: (value: JsonResponse) => void; reject: (err: Error) => void }>();
	let chain: Promise<void> = Promise.resolve();

	function onExit(reason: string): void {
		child = null;
		const err = new Error(`the pool JVM is gone: ${reason}`);
		settleBoot(err);
		for (const waiter of pending.values()) waiter.reject(err);
		pending.clear();
	}

	function onLine(text: string): void {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			log({ evt: 'pool-bad-line', text });
			return;
		}
		if (!isReply(value)) {
			log({ evt: 'pool-line', value });
			const boot = value as { t?: unknown; message?: unknown } | null;
			if (boot?.t === 'ready') settleBoot();
			if (boot?.t === 'fatal') settleBoot(new Error(`the pool JVM could not boot: ${String(boot.message)}`));
			return;
		}
		const waiter = pending.get(value.id);
		if (waiter === undefined) return; // late reply to a call that already timed out
		pending.delete(value.id);
		waiter.resolve(value);
	}

	function spawnChild(): ChildProcessWithoutNullStreams {
		const run = stagePoolDir(poolConfig);
		const bridge = bridgeLaunch(poolConfig, log);
		if (bridge.how !== 'compiled') {
			// PoolService.java calls PlayBridge.forgeCardName, resolved only via
			// javac's -sourcepath (host.ts's bridgeLaunch). JEP 330's single-file
			// source launcher has no sourcepath equivalent, so it would fail to
			// compile PoolService.java INSIDE the JVM — a late, opaque crash well
			// after this point. Refuse to spawn at all instead: a clear, synchronous
			// rejection here beats a mysterious "the pool JVM is gone" after one.
			throw new Error(
				'the pool service needs a compiled bridge (javac) and none is available — PoolService.java calls ' +
					"PlayBridge.forgeCardName, which the no-javac source launcher cannot resolve; see the preceding " +
					'"bridge-compile-failed" log line, or that no javac exists beside CARDTABLE_JAVA',
			);
		}
		// Out of heap, the JVM exits rather than limping on at ~94 % GC (hosting-test-plan H7): every
		// waiter is then rejected by `onExit` and the next call spawns a fresh pool JVM. Idle, it hands
		// its spare heap back and keeps its live set paged in (`FORGE_JVM_FLAGS`).
		const flags = ['-Djava.awt.headless=true', ...FORGE_JVM_FLAGS, `-Xmx${POOL_JVM_HEAP_MB}m`, `-Djava.io.tmpdir=${join(run, 'tmp')}`, ...poolConfig.jvmOpts];
		const c = spawn(poolConfig.java, [...flags, ...bridge.args], {
			cwd: run,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log({ evt: 'pool-spawned', pid: c.pid, bridge: bridge.how });
		createInterface({ input: c.stdout }).on('line', onLine);
		c.stderr.on('data', (buf: Buffer) => log({ evt: 'pool-stderr', text: buf.toString('utf8') }));
		c.on('exit', (code, signal) => onExit(`exited (code ${code}, signal ${signal})`));
		c.on('error', (err) => onExit(`could not be started: ${err.message}`));
		child = c;
		booted = new Promise<void>((resolveBoot, rejectBoot) => {
			const timer = setTimeout(() => {
				settleBoot(new Error(`the pool JVM did not boot within ${timing.bootTimeoutMs}ms`));
				c.kill('SIGKILL');
			}, timing.bootTimeoutMs);
			settleBoot = (err) => {
				clearTimeout(timer);
				settleBoot = () => {};
				if (err === undefined) resolveBoot();
				else rejectBoot(err);
			};
		});
		// A boot nobody is waiting on yet must not surface as an unhandled rejection.
		booted.catch(() => {});
		return c;
	}

	function call(op: string, body: Record<string, unknown>): Promise<JsonResponse> {
		const run = async (): Promise<JsonResponse> => {
			const c = child ?? spawnChild();
			await booted;
			return new Promise<JsonResponse>((resolveCall, reject) => {
				const id = String(nextId++);
				const started = Date.now();
				// Slow is not stuck: a JVM paging its heap back in or collecting it is still on the call,
				// so each window it worked through buys another, up to the cap.
				let seen = c.pid === undefined ? null : pidWork(c.pid);
				let slow = false;
				const check = (): void => {
					const now = c.pid === undefined ? null : pidWork(c.pid);
					const left = timing.callCapMs - (Date.now() - started);
					const working = worked(seen, now, CALL_TIMEOUT_MS);
					seen = now;
					if (working && left > 0) {
						slow = true;
						timer = setTimeout(check, Math.min(CALL_TIMEOUT_MS, left));
						return;
					}
					pending.delete(id);
					if (slow) log({ evt: 'pool-call-slow', op, ms: Date.now() - started, answered: false });
					reject(new Error(`pool JVM did not answer "${op}" within ${left <= 0 ? timing.callCapMs : CALL_TIMEOUT_MS}ms`));
				};
				let timer = setTimeout(check, CALL_TIMEOUT_MS);
				pending.set(id, {
					resolve: (v) => {
						clearTimeout(timer);
						if (slow) log({ evt: 'pool-call-slow', op, ms: Date.now() - started, answered: true });
						resolveCall(v);
					},
					reject: (e) => {
						clearTimeout(timer);
						reject(e);
					},
				});
				c.stdin.write(`${JSON.stringify({ id, op, ...body })}\n`, (err) => {
					if (err) {
						clearTimeout(timer);
						pending.delete(id);
						reject(err);
					}
				});
			});
		};
		// Queued after whatever is already pending, so at most one request is ever
		// in flight; a failed call does not break the chain for the next one.
		const result = chain.then(run, run);
		chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function expectOk(resp: JsonResponse, what: string): JsonResponse {
		if (resp.ok !== true) throw new Error(typeof resp.error === 'string' ? resp.error : `${what} failed`);
		return resp;
	}

	/** `resp.boosters`, checked field-by-field rather than cast — a wire card missing `foil` (an old jar, a protocol slip) fails loudly instead of handing every reader `undefined`. */
	function parseBoosters(value: unknown): BoosterCard[][] {
		if (!Array.isArray(value)) throw new Error(`boosters: expected an array of packs, got ${JSON.stringify(value)}`);
		return value.map((pack) => {
			if (!Array.isArray(pack)) throw new Error(`boosters: expected a pack of cards, got ${JSON.stringify(pack)}`);
			return pack.map((card) => {
				const c = card as Record<string, unknown>;
				if (typeof c.name !== 'string' || typeof c.set !== 'string' || typeof c.collectorNumber !== 'string' || typeof c.foil !== 'boolean') {
					throw new Error(`boosters: malformed card: ${JSON.stringify(card)}`);
				}
				return { name: c.name, set: c.set, collectorNumber: c.collectorNumber, foil: c.foil };
			});
		});
	}

	return {
		async check(names) {
			const resp = expectOk(await call('check', { names }), 'check');
			return resp.unknown as string[];
		},
		async sets() {
			const resp = expectOk(await call('sets', {}), 'sets');
			return resp.sets as SetSummary[];
		},
		async setCards(code) {
			const resp = expectOk(await call('setCards', { code }), 'setCards');
			return resp.cards as string[];
		},
		async boosters(code, count, seed) {
			const resp = expectOk(await call('boosters', { code, count, seed }), 'boosters');
			return parseBoosters(resp.boosters);
		},
		async close() {
			const c = child;
			if (c === null) return;
			try {
				await call('stop', {});
			} catch {
				// Already gone, or didn't answer in time. Confirmed dead below either way.
			}
			await new Promise<void>((resolveClose) => {
				if (c.exitCode !== null || c.signalCode !== null) {
					resolveClose();
					return;
				}
				const timer = setTimeout(() => {
					try {
						c.kill('SIGKILL');
					} catch {
						// Already gone between the check above and here.
					}
				}, 3000);
				c.once('exit', () => {
					clearTimeout(timer);
					resolveClose();
				});
			});
		},
	};
}
