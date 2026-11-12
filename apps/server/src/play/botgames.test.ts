import { describe, expect, it } from 'vitest';

import { BOT_GAME_S, botGameSpec, runBotGame, type BotGameInput } from './botgames.ts';
import type { HostEvents, MatchHostFactory, MatchSpec } from './host.ts';
import type { BridgeCommand, BridgeLine } from './bridge-protocol.ts';

const INPUT: BotGameInput = { names: ['Knight', 'Wizard'], decks: ['[main]\n40 Island', '[main]\n40 Swamp'], bestOf: 3 };

/** A host whose one match the test drives: its spec, its lines, its exit, and whether it was stopped. */
function fakeHost(): { host: MatchHostFactory<BridgeLine, BridgeCommand>; spec: () => MatchSpec; say: (line: BridgeLine) => void; exit: (reason: string) => void; stopped: () => boolean } {
	let events: HostEvents<BridgeLine, BridgeCommand> | null = null;
	let spec: MatchSpec | null = null;
	let stopped = false;
	const host = ((_id: string, s: MatchSpec, e: HostEvents<BridgeLine, BridgeCommand>) => {
		spec = s;
		events = e;
		return { send: () => {}, stop: () => void (stopped = true) };
	}) as unknown as MatchHostFactory<BridgeLine, BridgeCommand>;
	return { host, spec: () => spec!, say: (line) => events!.line(line), exit: (reason) => events!.exit(reason), stopped: () => stopped };
}

const over = (seat: number | null, ms: number): BridgeLine => ({ t: 'gameover', winner: seat === null ? null : `seat ${seat}`, seat, ms });

describe('runBotGame', () => {
	it('asks the bridge for a headless best-of with both seats AI and each game on the clock', () => {
		expect(botGameSpec(INPUT)).toEqual({
			seats: [
				{ name: 'Knight', ai: true, deck: INPUT.decks[0] },
				{ name: 'Wizard', ai: true, deck: INPUT.decks[1] },
			],
			headless: { bestOf: 3, gameS: BOT_GAME_S },
		});
	});

	it('tells two characters of one name apart: Forge counts a name as a player', () => {
		expect(botGameSpec({ ...INPUT, names: ['Knight', 'Knight'] }).seats.map((s) => s.name)).toEqual(['Knight', 'Knight 2']);
	});

	it('counts each game’s winner by seat, and answers once the JVM lets the match go', async () => {
		const f = fakeHost();
		const result = runBotGame(f.host, 'b-1', INPUT, { timeoutMs: 60_000, log: () => {} });
		expect(f.spec().headless).toEqual({ bestOf: 3, gameS: BOT_GAME_S });
		f.say(over(1, 40_000));
		f.say(over(0, 35_000));
		f.say(over(1, 51_000));
		f.exit('Forge ended the match without being asked to');
		expect(await result).toEqual({ ok: true, wins: [1, 2], gameMs: [40_000, 35_000, 51_000] });
	});

	it('a drawn game counts for nobody, and three games played is the match over', async () => {
		const f = fakeHost();
		const result = runBotGame(f.host, 'b-2', INPUT, { timeoutMs: 60_000, log: () => {} });
		f.say(over(null, 240_000));
		f.say(over(0, 30_000));
		f.say(over(1, 30_000));
		f.exit('stopped');
		expect(await result).toEqual({ ok: true, wins: [1, 1], gameMs: [240_000, 30_000, 30_000] });
	});

	it('a JVM lost before the match is decided is no result, never a partial one', async () => {
		const f = fakeHost();
		const result = runBotGame(f.host, 'b-3', INPUT, { timeoutMs: 60_000, log: () => {} });
		f.say(over(0, 30_000));
		f.exit('jvm-lost');
		expect(await result).toEqual({ ok: false, why: 'failed', error: 'jvm-lost after 1 of 3 games' });
	});

	it('Forge’s own failure is the reason given', async () => {
		const f = fakeHost();
		const result = runBotGame(f.host, 'b-4', INPUT, { timeoutMs: 60_000, log: () => {} });
		f.say({ t: 'fatal', message: 'a bot game failed: boom' });
		f.exit('Forge failed: a bot game failed: boom');
		expect(await result).toEqual({ ok: false, why: 'failed', error: 'a bot game failed: boom' });
	});

	it('past its clock it is stopped and answers timeout', async () => {
		const f = fakeHost();
		const result = await runBotGame(f.host, 'b-5', INPUT, { timeoutMs: 20, log: () => {} });
		expect(result).toEqual({ ok: false, why: 'timeout', error: 'no result after 20 ms' });
		expect(f.stopped()).toBe(true);
	});

	it('a host that cannot place it is no result', async () => {
		const host = (() => {
			throw new Error('no Forge host is configured');
		}) as unknown as MatchHostFactory<BridgeLine, BridgeCommand>;
		expect(await runBotGame(host, 'b-6', INPUT, { timeoutMs: 60_000, log: () => {} })).toEqual({ ok: false, why: 'failed', error: 'no Forge host is configured' });
	});
});
