/**
 * Bot games: two Forge AIs play a pod pairing out, headless, so the bracket shows a real result for
 * every pairing (the operator, 2026-11-07: "even better, can we have the bots play real games against
 * each other?", and of the two ways asked, "real games, headless").
 *
 * A bot game is a match on the same JVMs as every other (`MatchHostFactory`, so the same placement,
 * the same claws, the same JVM accounting), but never a `Match`: no seat, no frame, no watcher, no
 * recording. The bridge plays the whole best-of on Forge's own `Match` (`PlayBridge.java`'s
 * `playHeadless`) and says `gameover` once per game, with the winning seat. Each game past
 * {@link BOT_GAME_S} is drawn by the bridge, as Forge's own sim clock draws one.
 *
 * It holds a place in the server's ceiling while it plays (`MatchRegistry.botGame`), and is never
 * kept across a restart (`host.ts`'s `handOver`, `MatchRegistry.adopt`): its room plays it again.
 */

import { report } from '../telemetry.js';
import type { MatchHostFactory, MatchSpec } from './host.js';
import type { BridgeLine, BridgeCommand } from './bridge-protocol.js';

/** A bot game's one game, in seconds of wall clock, before the bridge calls it a draw (Forge's own sim clock is 120). */
export const BOT_GAME_S = 180;

export interface BotGameInput {
	/** Forge's player names; never an identity. */
	names: [string, string];
	/** Each side's `.dck` text. */
	decks: [string, string];
	bestOf: 1 | 3;
}

export type BotGameOutcome =
	| { ok: true; wins: [number, number]; gameMs: number[] }
	| { ok: false; why: 'capacity' | 'failed' | 'timeout'; error: string };

/**
 * The bridge's `start` for a bot game. Forge tells its players apart by name (`LobbyPlayer.equals`),
 * so two characters of one name are told apart here.
 */
export function botGameSpec(input: BotGameInput): MatchSpec {
	const [first, second] = input.names;
	return {
		seats: [
			{ name: first, ai: true, deck: input.decks[0] },
			{ name: second === first ? `${second} 2` : second, ai: true, deck: input.decks[1] },
		],
		headless: { bestOf: input.bestOf, gameS: BOT_GAME_S },
	};
}

/**
 * Play `input` as match `matchId` on `host`, and answer once its JVM has let it go: every game's winner
 * counted, or why there is no result. Past `timeoutMs` it is stopped and answers `timeout`; the caller
 * decides what a missing result means.
 */
export function runBotGame(host: MatchHostFactory<BridgeLine, BridgeCommand>, matchId: string, input: BotGameInput, opts: { timeoutMs: number; log: (entry: Record<string, unknown>) => void }): Promise<BotGameOutcome> {
	const { log } = opts;
	const startedAt = Date.now();
	const wins: [number, number] = [0, 0];
	const gameMs: number[] = [];
	let fatal: string | null = null;
	return new Promise((resolve) => {
		let done = false;
		const finish = (outcome: BotGameOutcome): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const ms = Date.now() - startedAt;
			log({ evt: 'bot-game-ended', matchId, ms, ...(outcome.ok ? { wins: outcome.wins, gameMs: outcome.gameMs } : { why: outcome.why, error: outcome.error }) });
			report('bot-game', { phase: outcome.ok ? 'finished' : outcome.why, matchId, ms, ...(outcome.ok ? { wins: outcome.wins.join('-') } : {}) }, outcome.ok ? 'info' : 'warn');
			resolve(outcome);
		};
		const timer = setTimeout(() => {
			finish({ ok: false, why: 'timeout', error: `no result after ${opts.timeoutMs} ms` });
			running?.stop();
		}, opts.timeoutMs);
		timer.unref();
		const onLine = (line: BridgeLine): void => {
			if (line.t === 'gameover') {
				if (line.seat === 0 || line.seat === 1) wins[line.seat] += 1;
				if (typeof line.ms === 'number') gameMs.push(line.ms);
			} else if (line.t === 'fatal') {
				fatal = line.message;
			}
		};
		let running: ReturnType<MatchHostFactory<BridgeLine, BridgeCommand>> | null = null;
		log({ evt: 'bot-game-started', matchId, names: input.names, bestOf: input.bestOf });
		report('bot-game', { phase: 'started', matchId });
		try {
			running = host(matchId, botGameSpec(input), {
				line: onLine,
				exit: (reason) => {
					// Played out: a side won the majority, or every game was played (draws can leave neither).
					const over = Math.max(...wins) > input.bestOf / 2 || gameMs.length >= input.bestOf;
					if (fatal !== null) finish({ ok: false, why: 'failed', error: fatal });
					else if (!over) finish({ ok: false, why: 'failed', error: `${reason} after ${gameMs.length} of ${input.bestOf} games` });
					else finish({ ok: true, wins: [...wins], gameMs: [...gameMs] });
				},
				log,
			});
		} catch (err) {
			finish({ ok: false, why: 'failed', error: (err as Error).message });
		}
	});
}
