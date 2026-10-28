/**
 * A match's Forge server is for that match's own seats: nobody else can reach it, be heard by it,
 * or end the match by coming and going.
 *
 * Each bridge match boots a Forge server on a port of its own (`PlayBridge.java`'s `bootServer`),
 * and the bridge's seat clients connect to it. Anything else that opens that port is a stranger:
 * on hokon, every tailnet device when the port listens on all interfaces; on a claw, CI on the
 * same box over loopback.
 *
 * Skips, saying why in its name, unless the Forge build is configured (`CARDTABLE_FORGE_JAR`,
 * `CARDTABLE_FORGE_RES`), like every `*.jvm.test.ts`.
 *
 * One `--host` JVM, one human-against-AI match, and once it is `ready`:
 * - the match's port listens on loopback only (`/proc/net/tcp*`, so Linux only, as the claws are);
 * - a stranger speaking Forge's own wire format (`jvm/StrangerProbe.java`) is closed without
 *   hearing anything, whether it chats or logs in;
 * - a raw TCP connect-and-close, and the probes' own closes, are not a seat disconnect: the match
 *   is not failed, and its seat still reaches Forge (a concede ends the game).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bridgeLaunch, jvmHostConfig, stageRunDir } from './host.js';

const available = jvmHostConfig();
const title = available.ok
	? "a match's Forge server is for its own seats alone"
	: `a match's Forge server is for its own seats alone — SKIPPED: ${available.reason}`;

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'jvm', 'StrangerProbe.java');

type Line = { t: string; match: string; [k: string]: unknown };

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number, detail: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${detail()}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** The local address of every LISTEN socket on `port`, as `/proc/net/tcp{,6}` spells it (hex). */
function listeners(port: number): string[] {
	const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
	const found: string[] = [];
	for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
		for (const row of readFileSync(table, 'utf8').split('\n').slice(1)) {
			const cells = row.trim().split(/\s+/);
			const [address, p] = (cells[1] ?? '').split(':');
			if (p === hexPort && cells[3] === '0A') found.push(address ?? '');
		}
	}
	return found;
}

/** 127.0.0.0/8, ::1 and the v4-mapped 127/8, in `/proc/net` hex (each 32-bit word little-endian). */
function isLoopback(hex: string): boolean {
	if (hex.length === 8) return hex.endsWith('7F');
	if (hex === '00000000000000000000000001000000') return true;
	return hex.startsWith('0000000000000000FFFF0000') && hex.endsWith('7F');
}

describe.skipIf(!available.ok)(title, () => {
	const hostId = `h16-host-${process.pid}`;
	const M = `h16-match-${process.pid}`;
	const lines: Line[] = [];
	const raw: string[] = [];
	let child: ChildProcess | null = null;
	let exited: Promise<number | null> = Promise.resolve(null);
	let run = '';
	let probeDir = '';
	let port = 0;

	const send = (cmd: Record<string, unknown>): void => {
		child?.stdin?.write(`${JSON.stringify(cmd)}\n`);
	};
	const of = (match: string, t?: string): Line[] => lines.filter((l) => l.match === match && (t === undefined || l.t === t));
	const stderr = (): string => readFileSync(join(run, 'bridge.stderr.txt'), 'utf8');
	const detail = (): string =>
		`${raw.filter((l) => !l.includes('"t":"alive"')).slice(-20).join('\n')}\n--- bridge.stderr.txt (tail)\n${stderr().slice(-6000)}`;

	/** The probe's own lines, one array of tab-separated cells each. */
	const stranger = (mode: 'chat' | 'login'): string[][] => {
		if (!available.ok) throw new Error('unreachable');
		const out = spawnSync(available.config.java, ['-cp', `${probeDir}:${available.config.jar}`, 'StrangerProbe', '127.0.0.1', String(port), mode, '3000'], {
			encoding: 'utf8',
			timeout: 60_000,
		});
		expect(out.status, out.stderr.slice(-4000)).toBe(0);
		const said = out.stdout
			.split('\n')
			.filter((l) => l !== '')
			.map((l) => l.split('\t'));
		console.log(`[h16] stranger ${mode}: ${JSON.stringify(said)}`);
		return said;
	};

	beforeAll(async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = available.config;
		probeDir = mkdtempSync(join(config.workDir, 'h16-probe-'));
		const javac = spawnSync(join(dirname(config.java), 'javac'), ['-proc:none', '-nowarn', '-cp', config.jar, '-d', probeDir, PROBE], {
			encoding: 'utf8',
			timeout: 120_000,
		});
		expect(javac.status, javac.stderr).toBe(0);

		const deck = readFileSync(join(config.res, 'quest', 'precons', 'Spirit Flames.dck'), 'utf8');
		run = stageRunDir(config, hostId);
		const bridge = bridgeLaunch(config, () => {});
		const err = openSync(join(run, 'bridge.stderr.txt'), 'a');
		const jvm = spawn(
			config.java,
			['-Djava.awt.headless=true', `-Djava.io.tmpdir=${join(run, 'jvm-tmp')}`, ...config.jvmOpts, ...bridge.args, '--host', hostId],
			{ cwd: run, stdio: ['pipe', 'pipe', err] },
		);
		closeSync(err);
		child = jvm;
		if (jvm.stdout === null) throw new Error('the JVM has no stdout pipe');
		exited = new Promise((resolve) => jvm.on('exit', (code) => resolve(code)));
		createInterface({ input: jvm.stdout }).on('line', (text) => {
			raw.push(text);
			lines.push(JSON.parse(text) as Line);
		});
		await waitUntil(() => of(hostId, 'warm').length === 1, 'the host to boot', 90_000, detail);
		send({ t: 'start', match: hostId, config: { matchId: M, seats: [{ name: 'human', ai: false, deck }, { name: 'bot', ai: true, deck }] } });
		await waitUntil(() => of(M, 'ready').length === 1, 'the match to be ready', 90_000, detail);
		port = Number(of(M, 'ready')[0]?.forgePort);
		expect(port, detail()).toBeGreaterThan(0);
	}, 240_000);

	afterAll(() => {
		if (child !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		if (run !== '') rmSync(run, { recursive: true, force: true });
		if (probeDir !== '') rmSync(probeDir, { recursive: true, force: true });
	});

	it("listens on loopback only, so no other machine can reach the match's port", () => {
		const bound = listeners(port);
		console.log(`[h16] port ${port} listens on ${JSON.stringify(bound)}`);
		expect(bound.length, `nothing listens on ${port}`).toBeGreaterThan(0);
		expect(bound.filter((a) => !isLoopback(a)), `port ${port} listens beyond loopback`).toEqual([]);
	});

	it('a stranger that chats without logging in is closed, and hears nothing', { timeout: 90_000 }, () => {
		const said = stranger('chat');
		expect(said[0]?.[0], 'the stranger reached the port over loopback').toBe('connected');
		expect(said.filter((c) => c[0] === 'recv'), 'what the stranger heard').toEqual([]);
		expect(said.map((c) => c[0]).slice(-2), 'the server closed the stranger before it gave up').toEqual(['closed', 'done']);
	});

	it('a stranger that logs in is closed, and is given no lobby slot or state', { timeout: 90_000 }, () => {
		const said = stranger('login');
		expect(said[0]?.[0]).toBe('connected');
		expect(said.filter((c) => c[0] === 'recv'), 'what the stranger heard').toEqual([]);
		expect(said.map((c) => c[0]).slice(-2), 'the server closed the stranger before it gave up').toEqual(['closed', 'done']);
		// Closed at the door, not by a full lobby: the same login after a seat's disconnect would otherwise
		// reach Forge's reconnect-by-name path, and before the seats connect it would take a slot.
		expect(stderr(), detail()).toMatch(/Refusing \S+: a login without this server's credential/);
	});

	it('a stranger coming and going is not a seat disconnect: the match lives, and its seat still reaches Forge', { timeout: 120_000 }, async () => {
		await new Promise<void>((resolve, reject) => {
			const socket = connect(port, '127.0.0.1', () => socket.destroy());
			socket.on('close', () => resolve());
			socket.on('error', reject);
		});
		// Long enough for any seat-disconnect path the closes above set off to say so.
		await new Promise((r) => setTimeout(r, 3000));
		expect(of(M, 'fatal'), detail()).toEqual([]);

		send({ t: 'act', match: M, seat: 0, frame: { method: 'concede' } });
		await waitUntil(() => of(M, 'gameover').length === 1, 'the concede to end the game', 60_000, detail);
		expect(of(M, 'fatal'), detail()).toEqual([]);

		send({ t: 'stop', match: hostId });
		expect(await exited, detail()).toBe(0);
		child = null;
	});
});
