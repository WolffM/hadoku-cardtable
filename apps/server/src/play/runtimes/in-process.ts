/**
 * The simplest host there is: a game's own engine, run in THIS process, with no child process, no
 * fifo, and nothing to re-attach. `host.ts`'s Forge host spawns a JVM and talks to it over named
 * pipes because Forge's rules live in Java; a game whose rules are plain TypeScript needs none of
 * that — this file is the host for those. The toy game (`fixtures/toy-game/`) is its first, and
 * phase 6's native bomberman is expected to be its second.
 *
 * Reuses `host.ts`'s own generic `HostEvents<L, C>` / `MatchHost<C>` — so a `HostedMatch` built
 * over this runtime and one built over `host.ts`'s real JVM one differ
 * only in which factory they are handed. The one thing `host.ts`'s own `MatchHostFactory<L, C>`
 * does NOT give us is a factory generic over the match's `Spec` too — it is hardcoded to `host.ts`'s
 * own `MatchSpec`, because `host.ts` only ever hosts Forge. {@link GameHostFactory} is that one
 * further step, for a game whose config is not a `MatchSpec` at all.
 */

import type { HostEvents, MatchHost } from '../host.js';

/** A line or a command from any engine: `t` is the one thing every engine's own vocabulary agrees on. */
type EngineMsg = { t: string };

/** Makes a host for one match, generic over the match's own config too — see this file's header. */
export type GameHostFactory<Spec, L extends EngineMsg, C extends EngineMsg> = (matchId: string, spec: Spec, events: HostEvents<L, C>) => MatchHost<C>;

/**
 * The one thing an in-process engine supplies: run `spec`, call `line` for everything the game
 * says — including whatever it says before `start` even returns, a `ready` line, say — and hand
 * back how the host sends it commands and stops it.
 *
 * Nothing here is async. A toy game plays out as fast as the calling test drives it, on the same
 * tick: a `send` can be followed at once by an assertion on the lines it produced, with no `await`
 * and no fifo in between. An engine with real asynchrony of its own (a timer, a promise) is free
 * to call `line` later — `inProcessHost` below makes no assumption either way — but the toy game
 * does not need to.
 */
export interface InProcessEngine<Spec, L extends EngineMsg, C extends EngineMsg> {
	start(matchId: string, spec: Spec, line: (l: L) => void): { send(cmd: C): void; stop(): void };
}

/**
 * The simplest `EngineRuntime`-shaped host (`engine-runtime.ts`'s doc calls out the shape this
 * fits): wraps an {@link InProcessEngine} as a {@link GameHostFactory}, so a `HostedMatch` runs it
 * exactly as it runs Forge's JVM host — `send`/`stop` reach the engine directly, in this process,
 * and its lines reach `events.line` with nothing in between. `send`/`stop` after `stop()` are
 * silently dropped, the same idempotence `host.ts`'s own `MatchHost.stop` documents.
 */
export function inProcessHost<Spec, L extends EngineMsg, C extends EngineMsg>(engine: InProcessEngine<Spec, L, C>): GameHostFactory<Spec, L, C> {
	return (matchId, spec, events) => {
		let stopped = false;
		const running = engine.start(matchId, spec, (line) => {
			if (!stopped) events.line(line);
		});
		return {
			send(cmd) {
				if (stopped) return;
				running.send(cmd);
			},
			stop() {
				if (stopped) return;
				stopped = true;
				running.stop();
			},
		};
	};
}
