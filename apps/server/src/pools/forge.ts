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
 * reply to anything, and are logged rather than matched.
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
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { bridgeLaunch, type JvmHostConfig } from '../play/host.js';

export interface SetSummary {
	code: string;
	name: string;
	date: string;
	type: string;
}

export interface BoosterCard {
	name: string;
	set: string;
	collectorNumber: string;
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

/** `PoolService.java` beside `PlayBridge.java` under `tsx`, or from `dist/` in the bundle — same two candidates `host.ts`'s own `defaultBridgeSource` checks, for the same reason: `import.meta.url` is `dist/index.js` once bundled. */
function defaultPoolServiceSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, '..', 'play', 'bridge', 'PoolService.java'), resolve(here, '..', 'src', 'play', 'bridge', 'PoolService.java')];
	return candidates.find((p) => existsSync(p)) ?? (candidates[0] as string);
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

const CALL_TIMEOUT_MS = 30_000;

export function createForgePools(config: JvmHostConfig, log: (entry: Record<string, unknown>) => void = () => {}): ForgePools {
	const poolConfig: JvmHostConfig = { ...config, bridgeSource: defaultPoolServiceSource() };
	if (!existsSync(poolConfig.bridgeSource)) {
		throw new Error(`pool service source not found: ${poolConfig.bridgeSource}`);
	}

	let child: ChildProcessWithoutNullStreams | null = null;
	let nextId = 1;
	const pending = new Map<string, { resolve: (value: JsonResponse) => void; reject: (err: Error) => void }>();
	let chain: Promise<void> = Promise.resolve();

	function onExit(reason: string): void {
		child = null;
		const err = new Error(`the pool JVM is gone: ${reason}`);
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
		const c = spawn(poolConfig.java, ['-Djava.awt.headless=true', `-Djava.io.tmpdir=${join(run, 'tmp')}`, ...poolConfig.jvmOpts, ...bridge.args], {
			cwd: run,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log({ evt: 'pool-spawned', pid: c.pid, bridge: bridge.how });
		createInterface({ input: c.stdout }).on('line', onLine);
		c.stderr.on('data', (buf: Buffer) => log({ evt: 'pool-stderr', text: buf.toString('utf8') }));
		c.on('exit', (code, signal) => onExit(`exited (code ${code}, signal ${signal})`));
		c.on('error', (err) => onExit(`could not be started: ${err.message}`));
		child = c;
		return c;
	}

	function call(op: string, body: Record<string, unknown>): Promise<JsonResponse> {
		const run = (): Promise<JsonResponse> =>
			new Promise<JsonResponse>((resolveCall, reject) => {
				const c = child ?? spawnChild();
				const id = String(nextId++);
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`pool JVM did not answer "${op}" within ${CALL_TIMEOUT_MS}ms`));
				}, CALL_TIMEOUT_MS);
				pending.set(id, {
					resolve: (v) => {
						clearTimeout(timer);
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
			return resp.boosters as BoosterCard[][];
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
