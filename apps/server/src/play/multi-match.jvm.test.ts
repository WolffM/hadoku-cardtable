/**
 * Two real Forge matches at once in ONE bridge JVM (`PlayBridge --host`).
 *
 * Skips, saying why in its name, unless the Forge build is configured
 * (`CARDTABLE_FORGE_JAR`, `CARDTABLE_FORGE_RES`), like every `*.jvm.test.ts`.
 *
 * `host.ts` still runs one JVM per match; this drives the bridge's `--host`
 * mode directly, over its stdin/stdout line protocol, the way a host agent
 * would. Each match runs through the real path: a Forge server of its own
 * (`new FServerManager()` in the fork), a stock `FGameClient` per human seat
 * over loopback, Forge's game on its own `Game-N` thread.
 *
 * What it proves:
 * - both matches start side by side, each on its own Forge port;
 * - every line carries its match, and no match's frames or game log ever name
 *   a card only the other match's decks hold (each match plays one precon on
 *   both sides, Spirit Flames in A, Decay in B), while each human seat does see
 *   its own deck's cards — the check can fail;
 * - a server-side ask (`probe`) parked in each match at once is answered per
 *   match, each with its own answer;
 * - both games are live on Forge's `Game-…` threads at once (a thread dump);
 * - stopping A ends A alone (`stopped`), A's commands are refused afterwards,
 *   and B goes on: its seats still answer, and a concede ends B with a
 *   `gameover`;
 * - the JVM exits 0 when told to.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';

import { bridgeLaunch, jvmHostConfig, stageRunDir } from './host.js';

const available = jvmHostConfig();
const title = available.ok
	? 'two Forge matches in one bridge JVM'
	: `two Forge matches in one bridge JVM — SKIPPED: ${available.reason}`;

type Line = { t: string; match: string; [k: string]: unknown };

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, detail?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${detail === undefined ? '' : `\n${detail()}`}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

function precon(name: string): string {
	if (!available.ok) throw new Error('unreachable');
	return readFileSync(join(available.config.res, 'quest', 'precons', `${name}.dck`), 'utf8');
}

/** The card names a `.dck` lists (`4 Shock|M19` → `Shock`). */
function cardNames(dck: string): Set<string> {
	const names = new Set<string>();
	for (const line of dck.split(/\r?\n/)) {
		const m = /^\s*\d+\s+([^|]+?)\s*(\|.*)?$/.exec(line);
		if (m?.[1] !== undefined) names.add(m[1]);
	}
	return names;
}

describe.skipIf(!available.ok)(title, () => {
	let child: ChildProcess | null = null;
	let run = '';

	afterAll(() => {
		if (child !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		if (run !== '') rmSync(run, { recursive: true, force: true });
	});

	it('hosts two matches at once, keeps them apart, and ends one without the other', { timeout: 240_000 }, async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = available.config;
		const hostId = `mm-host-${process.pid}`;
		run = stageRunDir(config, hostId);
		const bridge = bridgeLaunch(config, () => {});
		const stderr = openSync(join(run, 'bridge.stderr.txt'), 'a');
		const jvm = spawn(
			config.java,
			['-Djava.awt.headless=true', `-Djava.io.tmpdir=${join(run, 'jvm-tmp')}`, ...config.jvmOpts, ...bridge.args, '--host', hostId],
			{ cwd: run, stdio: ['pipe', 'pipe', stderr] },
		);
		closeSync(stderr);
		child = jvm;
		const { stdin, stdout } = jvm;
		if (stdin === null || stdout === null) throw new Error('the JVM has no stdio pipes');
		const exited = new Promise<number | null>((resolve) => jvm.on('exit', (code) => resolve(code)));

		const lines: Line[] = [];
		const raw: string[] = [];
		createInterface({ input: stdout }).on('line', (text) => {
			raw.push(text);
			lines.push(JSON.parse(text) as Line);
		});
		const send = (cmd: Record<string, unknown>): void => {
			stdin.write(`${JSON.stringify(cmd)}\n`);
		};
		const of = (match: string, t?: string): Line[] => lines.filter((l) => l.match === match && (t === undefined || l.t === t));
		const tail = (): string =>
			`${raw.slice(-15).join('\n')}\n--- bridge.stderr.txt (tail)\n${readFileSync(join(run, 'bridge.stderr.txt'), 'utf8').split('\n').slice(-40).join('\n')}`;

		await waitUntil(() => of(hostId, 'warm').length === 1, 'the host to boot', 90_000, tail);

		const A = `mm-a-${process.pid}`;
		const B = `mm-b-${process.pid}`;
		const flames = precon('Spirit Flames');
		const decay = precon('Decay');
		const onlyA = [...cardNames(flames)].filter((n) => !cardNames(decay).has(n));
		const onlyB = [...cardNames(decay)].filter((n) => !cardNames(flames).has(n));
		expect(onlyA.length).toBeGreaterThan(5);
		expect(onlyB.length).toBeGreaterThan(5);

		send({
			t: 'start',
			match: hostId,
			config: { matchId: A, seats: [{ name: 'A human', ai: false, deck: flames }, { name: 'A bot', ai: true, deck: flames }] },
		});
		send({
			t: 'start',
			match: hostId,
			config: { matchId: B, seats: [{ name: 'B one', ai: false, deck: decay }, { name: 'B two', ai: false, deck: decay }] },
		});

		// The driver: every ask a game raises is answered as aborted (Forge's own default), so each
		// game reaches a human input and parks there. The probes below are answered on purpose.
		const probeText = { [A]: 'probe for A', [B]: 'probe for B' } as Record<string, string>;
		const answered = new Set<string>();
		const drive = setInterval(() => {
			for (const l of lines) {
				if (l.t !== 'frame') continue;
				const frame = l.frame as { kind?: string; callId?: string };
				if (frame.kind !== 'ask' || frame.callId === undefined) continue;
				const key = `${l.match}/${String(l.seat)}/${frame.callId}`;
				if (answered.has(key)) continue;
				const text = JSON.stringify(frame);
				if (Object.values(probeText).some((p) => text.includes(p))) continue;
				answered.add(key);
				send({ t: 'abort', match: l.match, seat: l.seat, callId: frame.callId, reason: 'timeout' });
			}
		}, 50);

		try {
			await waitUntil(() => of(A, 'ready').length === 1 && of(B, 'ready').length === 1, 'both matches to be ready', 90_000, tail);
			const portA = of(A, 'ready')[0]?.forgePort;
			const portB = of(B, 'ready')[0]?.forgePort;
			expect(typeof portA).toBe('number');
			expect(portA).not.toBe(portB);

			// Each human seat sees its own opening hand: its frames name its own deck's cards.
			const seatSees = (match: string, seat: number, names: string[]): boolean =>
				of(match, 'frame').some((l) => l.seat === seat && names.some((n) => JSON.stringify(l.frame).includes(`"${n}"`)));
			await waitUntil(
				() => seatSees(A, 0, onlyA) && seatSees(B, 0, onlyB) && seatSees(B, 1, onlyB),
				'every human seat to see its own cards',
				90_000,
				tail,
			);

			// A server-side ask parked in each match at once, answered differently per match.
			send({ t: 'probe', match: A, seat: 0, probeId: 'pa', message: probeText[A] });
			send({ t: 'probe', match: B, seat: 0, probeId: 'pb', message: probeText[B] });
			const probeAsk = (match: string): { callId: string } | undefined =>
				of(match, 'frame')
					.map((l) => l.frame as { kind?: string; callId?: string })
					.find((f) => f.kind === 'ask' && JSON.stringify(f).includes(probeText[match] as string)) as { callId: string } | undefined;
			await waitUntil(() => probeAsk(A) !== undefined && probeAsk(B) !== undefined, 'both probe asks', 30_000, tail);
			expect(of(A, 'frame').some((l) => JSON.stringify(l.frame).includes(probeText[B] as string))).toBe(false);
			expect(of(B, 'frame').some((l) => JSON.stringify(l.frame).includes(probeText[A] as string))).toBe(false);

			// Both games are live on Forge's own game threads at this moment.
			const jcmd = join(dirname(config.java), 'jcmd');
			if (existsSync(jcmd) && jvm.pid !== undefined) {
				const dump = spawnSync(jcmd, [String(jvm.pid), 'Thread.print'], { encoding: 'utf8' }).stdout;
				const gameThreads = new Set(dump.match(/^"Game-\d+"/gm) ?? []);
				expect(gameThreads.size, dump.slice(0, 2000)).toBeGreaterThanOrEqual(2);
			}

			send({ t: 'reply', match: A, seat: 0, callId: probeAsk(A)?.callId, result: true });
			send({ t: 'reply', match: B, seat: 0, callId: probeAsk(B)?.callId, result: false });
			await waitUntil(() => of(A, 'probe').length === 1 && of(B, 'probe').length === 1, 'both probe answers', 30_000, tail);
			expect(of(A, 'probe')[0]).toMatchObject({ probeId: 'pa', answer: true });
			expect(of(B, 'probe')[0]).toMatchObject({ probeId: 'pb', answer: false });

			// Stop A. A alone ends; B goes on.
			send({ t: 'stop', match: A });
			await waitUntil(() => of(A, 'stopped').length === 1, 'A to stop', 30_000, tail);
			expect(of(B, 'stopped')).toHaveLength(0);
			expect(of(A, 'fatal')).toHaveLength(0);

			send({ t: 'probe', match: A, seat: 0, probeId: 'pa2', message: 'too late' });
			await waitUntil(() => lines.some((l) => l.t === 'rejected' && String(l.command).includes('pa2')), 'the refusal of a command for A', 10_000, tail);
			expect(lines.find((l) => l.t === 'rejected' && String(l.command).includes('pa2'))?.message).toMatch(/no match .* is hosted here/);

			send({ t: 'probe', match: B, seat: 1, probeId: 'pb2', message: probeText[B] });
			await waitUntil(
				() => of(B, 'frame').some((l) => l.seat === 1 && JSON.stringify(l.frame).includes(probeText[B] as string)),
				"B's second probe",
				30_000,
				tail,
			);
			const second = of(B, 'frame')
				.filter((l) => l.seat === 1)
				.map((l) => l.frame as { kind?: string; callId?: string })
				.find((f) => f.kind === 'ask' && JSON.stringify(f).includes(probeText[B] as string));
			send({ t: 'reply', match: B, seat: 1, callId: second?.callId, result: true });
			await waitUntil(() => of(B, 'probe').length === 2, "B's second probe answer", 30_000, tail);
			expect(of(B, 'probe')[1]).toMatchObject({ probeId: 'pb2', seat: 1, answer: true });

			send({ t: 'act', match: B, seat: 0, frame: { method: 'concede' } });
			await waitUntil(() => of(B, 'gameover').length === 1, 'B to end on a concede', 60_000, tail);
			expect((of(B, 'gameover')[0]?.losers as number[] | undefined)?.length).toBe(1);

			send({ t: 'stop', match: B });
			await waitUntil(() => of(B, 'stopped').length === 1, 'B to stop', 30_000, tail);
		} finally {
			clearInterval(drive);
		}

		// No cross-talk: every line is the host's or a match's, and no match ever named the other's cards.
		expect(lines.every((l) => [hostId, A, B].includes(l.match))).toBe(true);
		const names = (match: string): string => of(match).filter((l) => l.t === 'frame' || l.t === 'log').map((l) => JSON.stringify(l)).join('\n');
		const textA = names(A);
		const textB = names(B);
		expect(onlyB.filter((n) => textA.includes(`"${n}"`) || textA.includes(` ${n} `))).toEqual([]);
		expect(onlyA.filter((n) => textB.includes(`"${n}"`) || textB.includes(` ${n} `))).toEqual([]);
		expect(of(B, 'log').length).toBeGreaterThan(0);

		send({ t: 'stop', match: hostId });
		expect(await exited).toBe(0);
		child = null;
	});
});
