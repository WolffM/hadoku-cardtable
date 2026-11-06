/**
 * The agent and the coordinator's remote launcher over a real socket, with a
 * stand-in `java` (a shell script that says `warm` and echoes its stdin), so
 * no JDK or Forge is needed. The real-jar run is `scripts/agent/local-e2e.mjs`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushDraftbot, pushRuntime, type PackedRuntime } from '../../server/src/play/remote/artifacts.ts';
import { AgentClient } from '../../server/src/play/remote/client.ts';
import { RemoteJvmLauncher } from '../../server/src/play/remote/launcher.ts';
import type { JvmTransport } from '../../server/src/play/jvm-transport.ts';
import { DRAFTBOT_MB, DRAFTBOT_PATH, EMPTY_SHA, RELAY_PROTOCOL, sha256Hex, signRequest, type DraftbotHealth } from '../../server/src/play/remote/wire.ts';
import { Agent } from './agent.ts';
import { DraftbotService } from './draftbot.ts';
import { Cgroups } from './cgroups.ts';
import type { Log } from './jvm.ts';
import { procStartTicks } from './jvm.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanup.splice(0).reverse()) c();
});

function scratch(): string {
	const d = mkdtempSync(join(tmpdir(), 'agent-test-'));
	cleanup.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function tgz(src: string, name: string): { file: string; sha: string } {
	const file = join(src, `${name}.tgz`);
	spawnSync('tar', ['-czf', file, '-C', src, name]);
	return { file, sha: sha256Hex(readFileSync(file)) };
}

/** A JDK whose `java` is a script: by default `warm`, then every stdin line back. */
function fakeRuntime(java = '#!/bin/sh\necho \'{"t":"warm"}\'\nexec cat\n'): PackedRuntime {
	const src = scratch();
	mkdirSync(join(src, 'jdk', 'bin'), { recursive: true });
	writeFileSync(join(src, 'jdk', 'bin', 'java'), java);
	chmodSync(join(src, 'jdk', 'bin', 'java'), 0o755);
	for (const d of ['res', 'bridge']) {
		mkdirSync(join(src, d));
		writeFileSync(join(src, d, 'x'), d);
	}
	writeFileSync(join(src, 'forge.jar'), 'jar');
	return {
		files: { jdk: tgz(src, 'jdk'), res: tgz(src, 'res'), bridge: tgz(src, 'bridge'), jar: { file: join(src, 'forge.jar'), sha: sha256Hex('jar') } },
		main: 'PlayBridge',
	};
}

/**
 * The draft bot service as an artifact: its `scripts/run.sh` runs a stand-in on `$PORT` that answers
 * `/healthcheck` to anyone and `/batchdraft` only with the agent's secret, rating each pack in order.
 * It refuses to run with `NODE_ENV` set, as the real one must never see `production`.
 */
function fakeDraftbot(): { file: string; sha: string } {
	const src = scratch();
	mkdirSync(join(src, 'draftbot', 'scripts'), { recursive: true });
	writeFileSync(join(src, 'draftbot', 'scripts', 'run.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/../server.mjs"\n');
	chmodSync(join(src, 'draftbot', 'scripts', 'run.sh'), 0o755);
	writeFileSync(
		join(src, 'draftbot', 'server.mjs'),
		`import { createServer } from 'node:http';
if (process.env.NODE_ENV !== undefined) process.exit(3);
createServer((req, res) => {
	if (req.url === '/healthcheck') return res.end('OK');
	if (req.headers['x-internal-token'] !== process.env.RECOMMENDER_SHARED_SECRET) { res.statusCode = 401; return res.end('{"success":false,"message":"Unauthorized"}'); }
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		const { inputs } = JSON.parse(body);
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ success: true, results: inputs.map((i) => i.pack.map((oracle, k) => ({ oracle, rating: 1 - k / 10 }))) }));
	});
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
	);
	mkdirSync(join(src, 'draftbot', 'packages', 'recommenderService', 'model'), { recursive: true });
	writeFileSync(join(src, 'draftbot', 'packages', 'recommenderService', 'model', 'indexToOracleMap.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i, `o${i}`]))));
	return tgz(src, 'draftbot');
}

/** A cgroup tree as fleet-manager delegates it, in a plain directory. */
function fakeCgroups(sliceMb = 4096): { root: string; ownCgroupFile: string; service: string } {
	const root = scratch();
	const unit = '/hosting.slice/hosting-cardtable.slice/cardtable-agent.service';
	mkdirSync(join(root, unit), { recursive: true });
	writeFileSync(join(root, unit, '..', 'memory.max'), String(sliceMb * 1024 * 1024));
	writeFileSync(join(root, unit, '..', 'cpu.max'), '400000 100000');
	writeFileSync(join(root, unit, '..', 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n');
	const ownCgroupFile = join(root, 'self-cgroup');
	writeFileSync(ownCgroupFile, `0::${unit}\n`);
	return { root, ownCgroupFile, service: join(root, unit) };
}

const clock = { t: Date.now() };
const now = (): number => clock.t;

async function startAgent(home: string, cg = fakeCgroups(), fenceMs = 10_000, log: Log = () => {}): Promise<{ agent: Agent; port: number; cg: typeof cg }> {
	const agent = new Agent({ home, port: 0, host: '127.0.0.1', publicKey, version: 'test', fenceMs, heartbeatMs: 100, cgroupRoot: cg.root, ownCgroupFile: cg.ownCgroupFile, now, log });
	const port = await agent.listen();
	cleanup.push(() => agent.close());
	return { agent, port, cg };
}

async function coordinator(port: number, runtime: PackedRuntime): Promise<{ client: AgentClient; launcher: RemoteJvmLauncher }> {
	const client = new AgentClient({ url: `http://127.0.0.1:${port}`, key: privateKey, heartbeatMs: 100, now });
	cleanup.push(() => client.close());
	const pushed = await pushRuntime(client, runtime);
	await client.connect();
	return { client, launcher: new RemoteJvmLauncher(client, pushed) };
}

function collect(t: JvmTransport): { lines: string[]; exit: Promise<string> } {
	const lines: string[] = [];
	t.onLine((l) => lines.push(l));
	const exit = new Promise<string>((resolve) => t.onExit(resolve));
	return { lines, exit };
}

async function until(what: string, ok: () => boolean, timeout = 5000): Promise<void> {
	await vi.waitFor(
		() => {
			if (!ok()) throw new Error(`not yet: ${what}`);
		},
		{ timeout, interval: 20 },
	);
}

const pidAlive = (pid: number): boolean => procStartTicks(pid) !== null;
/** Set the moment `tick` fences, before the kill lands. */
const fenced = (agent: Agent): boolean => (agent as unknown as { fenced: boolean }).fenced;

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve(101);
		});
		req.on('error', reject);
		req.end();
	});
}

describe('host agent', () => {
	it('refuses unsigned, replayed and stale requests over loopback, and an unsigned relay', async () => {
		const { port } = await startAgent(scratch());
		expect(await rawGet(port, '/status', {})).toBe(401);
		const signed = { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, now()) };
		expect(await rawGet(port, '/status', signed)).toBe(200);
		expect(await rawGet(port, '/status', signed)).toBe(401);
		expect(await rawGet(port, '/status', { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, now() - 60_000) })).toBe(401);
		const relay = { connection: 'Upgrade', upgrade: RELAY_PROTOCOL };
		expect(await rawGet(port, '/relay', relay)).toBe(401);
		expect(await rawGet(port, '/relay', { ...relay, ...signRequest(privateKey, 'GET', '/relay', EMPTY_SHA, now()) })).toBe(101);
	});

	it('refuses a blob whose bytes are not its name', async () => {
		const { port } = await startAgent(scratch());
		const client = new AgentClient({ url: `http://127.0.0.1:${port}`, key: privateKey, now });
		const dir = scratch();
		writeFileSync(join(dir, 'jar'), 'not what was promised');
		await expect(client.call('PUT', `/blob/${sha256Hex('jar')}`, { file: join(dir, 'jar'), sha: sha256Hex('jar') })).rejects.toThrow(/500 blob hashed to/);
	});

	it('launches a JVM in its own leaf cgroup, relays both ways, and kills it on request', async () => {
		const { port, cg } = await startAgent(scratch());
		const { launcher } = await coordinator(port, fakeRuntime());
		const t = launcher.launch('h1', { xmxMb: 1000 });
		const { lines, exit } = collect(t);
		await until('warm', () => lines.length === 1);
		expect(lines).toEqual(['{"t":"warm"}']);
		t.send('{"t":"start","match":"m1"}');
		await until('echo', () => lines.length === 2);
		expect(lines[1]).toBe('{"t":"start","match":"m1"}');
		const pid = Number(readFileSync(join(cg.service, 'run-h1', 'cgroup.procs'), 'utf8'));
		expect(pidAlive(pid)).toBe(true);
		t.kill();
		expect(await exit).toBe('killed by the coordinator');
		expect(pidAlive(pid)).toBe(false);
	});

	it("names a JVM's exit by what it said about itself, not by Forge's log chatter", async () => {
		const { port } = await startAgent(scratch());
		const stderr = [
			'01:00:00 [INFO ] GameProtocolHandler: Received: GuiGameEvent 1: openView (1 args)',
			'Exception in thread "Game" java.lang.IllegalStateException: boom',
			'\tat forge.game.Game.run(Game.java:42)',
			'[bridge] the game thread failed',
			...Array.from({ length: 8 }, (_, i) => `01:00:0${i} [INFO ] NetworkGuiGame: [DeltaSync] === END seq=${i} ===`),
		];
		const java = `#!/bin/sh\necho '{"t":"warm"}'\ncat >&2 <<'EOF'\n${stderr.join('\n')}\nEOF\nexit 1\n`;
		const { launcher } = await coordinator(port, fakeRuntime(java));
		const { exit } = collect(launcher.launch('h1', { xmxMb: 1000 }));
		expect(await exit).toBe('exited (code 1, signal none): Exception in thread "Game" java.lang.IllegalStateException: boom at forge.game.Game.run(Game.java:42) | [bridge] the game thread failed');
	});

	it('refuses a launch that would not fit the slice', async () => {
		const { port } = await startAgent(scratch());
		const { launcher } = await coordinator(port, fakeRuntime());
		const a = collect(launcher.launch('a', { xmxMb: 2000 }));
		await until('a warm', () => a.lines.length === 1);
		// 100 + (2000 + 400) + (1600 + 400) = 4500 MB > 4096
		const b = collect(launcher.launch('b', { xmxMb: 1600 }));
		expect(await b.exit).toMatch(/^refused: does not fit: 4500 MB needed .* in a 4096 MB slice$/);
	});

	it('fences: kills every JVM once the coordinator has been silent past the window, and not before', async () => {
		const { agent, port } = await startAgent(scratch());
		const { client, launcher } = await coordinator(port, fakeRuntime());
		const t = collect(launcher.launch('h1', { xmxMb: 1000 }));
		await until('warm', () => t.lines.length === 1);
		const pid = agent.jvms.get('h1')!.pid;
		client.close();
		await until('relay closed', () => !(agent as unknown as { session: unknown }).session);
		clock.t += 9_000;
		agent.tick();
		expect(pidAlive(pid)).toBe(true);
		clock.t += 2_000;
		agent.tick();
		await until('killed', () => !pidAlive(pid));
		await until('exit recorded', () => agent.jvms.get('h1')!.exited);
		expect(JSON.parse(readFileSync(join(agent.jvms.get('h1')!.dir, 'exit.json'), 'utf8')).reason).toMatch(/^fenced: no word from the coordinator for 11 s \(window 10 s\)$/);
	});

	it('holds its JVMs past the window for a coordinator that said it is restarting, across its own restart, until the next coordinator', async () => {
		const home = scratch();
		const cg = fakeCgroups();
		const first = await startAgent(home, cg);
		const c = await coordinator(first.port, fakeRuntime());
		const transport = c.launcher.launch('h1', { xmxMb: 1000 });
		const t = collect(transport);
		await until('warm', () => t.lines.length === 1);
		const pid = first.agent.jvms.get('h1')!.pid;
		c.client.hold(90_000);
		transport.release();
		c.client.close();
		await until('relay closed', () => !(first.agent as unknown as { session: unknown }).session);
		// Past the window, inside the hold: kept, by this agent and by a restarted one.
		clock.t += 60_000;
		first.agent.tick();
		expect(fenced(first.agent)).toBe(false);
		first.agent.close();
		const logged: { what: string; data?: Record<string, unknown> }[] = [];
		const second = await startAgent(home, cg, undefined, (what, data) => void logged.push({ what, data }));
		clock.t += 39_000;
		second.agent.tick();
		expect(fenced(second.agent)).toBe(false);
		expect(pidAlive(pid)).toBe(true);
		// The next coordinator ends the hold: once it goes silent without a word, the window alone counts.
		const c2 = await coordinator(second.port, fakeRuntime());
		await until('relay open', () => (second.agent as unknown as { session: unknown }).session !== null);
		// How long the claw went without a coordinator, not what was left of the hold.
		expect(logged.find((l) => l.what === 'hold-ended')?.data?.heldMs).toBe(99_000);
		c2.client.close();
		await until('relay closed', () => !(second.agent as unknown as { session: unknown }).session);
		clock.t += 11_000;
		second.agent.tick();
		await until('killed', () => !pidAlive(pid));
	});

	it('a hold past its own cap still fences: the coordinator that never comes back', async () => {
		const { agent, port } = await startAgent(scratch());
		const { client, launcher } = await coordinator(port, fakeRuntime());
		const t = collect(launcher.launch('h1', { xmxMb: 1000 }));
		await until('warm', () => t.lines.length === 1);
		const pid = agent.jvms.get('h1')!.pid;
		client.hold(24 * 60 * 60_000);
		client.close();
		await until('relay closed', () => !(agent as unknown as { session: unknown }).session);
		clock.t += 10_000 + 5 * 60_000 - 1000;
		agent.tick();
		expect(fenced(agent)).toBe(false);
		clock.t += 2000;
		agent.tick();
		await until('killed', () => !pidAlive(pid));
	});

	it('does not reset the fencing clock when it restarts', async () => {
		const home = scratch();
		const cg = fakeCgroups();
		const first = await startAgent(home, cg);
		const c = await coordinator(first.port, fakeRuntime());
		const t = collect(c.launcher.launch('h1', { xmxMb: 1000 }));
		await until('warm', () => t.lines.length === 1);
		const pid = first.agent.jvms.get('h1')!.pid;
		c.client.close();
		first.agent.close();
		clock.t += 6_000;
		const second = await startAgent(home, cg);
		second.agent.tick();
		expect(pidAlive(pid)).toBe(true);
		clock.t += 5_000;
		second.agent.tick();
		await until('killed', () => !pidAlive(pid));
	});

	it('the coordinator fails the claw over when heartbeats stop for the window', async () => {
		const { agent, port } = await startAgent(scratch());
		const { client, launcher } = await coordinator(port, fakeRuntime());
		const t = collect(launcher.launch('h1', { xmxMb: 1000 }));
		await until('warm', () => t.lines.length === 1);
		agent.close(); // the agent goes silent
		clock.t += 10_001;
		client.watch();
		expect(await t.exit).toMatch(/^agent heartbeat lost for 10 s/);
		expect(client.lost).not.toBeNull();
	});

	it('survives its own restart: adopts the live JVM from its leaf, and replays what it printed meanwhile', async () => {
		const home = scratch();
		const cg = fakeCgroups();
		const first = await startAgent(home, cg);
		const c1 = await coordinator(first.port, fakeRuntime());
		const tr1 = c1.launcher.launch('h1', { xmxMb: 1000 });
		const t1 = collect(tr1);
		await until('warm', () => t1.lines.length === 1);
		t1.lines.length = 0;
		const pid = first.agent.jvms.get('h1')!.pid;
		// The coordinator lets go to take the JVM back later; then the agent restarts.
		tr1.release();
		await until('release recorded', () => JSON.parse(readFileSync(join(home, 'jvms', 'h1', 'jvm.json'), 'utf8')).acked === '{"t":"warm"}\n'.length);
		c1.client.close();
		first.agent.close();
		// While no agent runs, the JVM keeps printing into its file.
		writeFileSync(join(home, 'jvms', 'h1', 'in.fifo'), '{"t":"while-away"}\n', { flag: 'a' });
		await until('printed while away', () => readFileSync(join(home, 'jvms', 'h1', 'out.jsonl'), 'utf8').includes('while-away'));

		const second = await startAgent(home, cg);
		expect(second.agent.jvms.get('h1')?.pid).toBe(pid);
		expect(second.agent.jvms.get('h1')?.exited).toBe(false);
		expect(second.agent.cgroups.liveLeaves().get('h1')).toEqual([pid]);
		const c2 = await coordinator(second.port, fakeRuntime());
		expect(await c2.launcher.running()).toEqual(['h1']);
		const t2 = c2.launcher.attach('h1');
		const got = collect(t2);
		await until('replayed', () => got.lines.length === 1);
		expect(got.lines).toEqual(['{"t":"while-away"}']);
		t2.send('{"t":"after"}');
		await until('live again', () => got.lines.length === 2);
		t2.kill();
		expect(await got.exit).toBe('killed by the coordinator');
		await until('forgotten', () => !existsSync(join(home, 'jvms', 'h1')));
	});
});

describe('the draft bot service on the agent', () => {
	const draftbotOf = (client: AgentClient): DraftbotHealth | null => client.health?.draftbot ?? null;

	async function withDraftbot(cg = fakeCgroups(), log: Log = () => {}): Promise<{ agent: Agent; client: AgentClient; launcher: RemoteJvmLauncher; sha: string; cg: typeof cg }> {
		const { agent, port } = await startAgent(scratch(), cg, undefined, log);
		const { client, launcher } = await coordinator(port, fakeRuntime());
		// The clock stands still in these tests, and a second `GET /status` at the same instant is a replay.
		clock.t += 1;
		const sha = await pushDraftbot(client, fakeDraftbot());
		return { agent, client, launcher, sha, cg };
	}

	it('runs it in its own capped leaf when asked, and proxies a signed call to it with its secret', async () => {
		const logged: { what: string; data?: Record<string, unknown> }[] = [];
		const { client, sha, cg } = await withDraftbot(fakeCgroups(), (what, data) => void logged.push({ what, data }));
		await expect(client.call('POST', DRAFTBOT_PATH, { inputs: [] })).rejects.toThrow(/503 the draft bot is not running here/);
		client.send({ op: 'draftbot', sha });
		await until('up', () => draftbotOf(client)?.state === 'up', 10_000);
		const pid = draftbotOf(client)!.pid!;
		expect(Number(readFileSync(join(cg.service, 'draftbot', 'cgroup.procs'), 'utf8'))).toBe(pid);
		expect(Number(readFileSync(join(cg.service, 'draftbot', 'memory.max'), 'utf8'))).toBe(DRAFTBOT_MB * 1024 * 1024);
		expect(readFileSync(join(cg.service, 'cgroup.subtree_control'), 'utf8')).toBe('+memory');
		// Up only after one pod's call, from the model's own vocabulary, warmed it.
		expect(logged.find((l) => l.what === 'draftbot-up')?.data).toMatchObject({ sha, warmMs: expect.any(Number) });
		const answer = await client.call<{ success: boolean; results: { oracle: string; rating: number }[][] }>('POST', DRAFTBOT_PATH, { inputs: [{ pack: ['a', 'b'], pool: [] }, { pack: ['c'], pool: ['a'] }] });
		expect(answer).toEqual({ success: true, results: [[{ oracle: 'a', rating: 1 }, { oracle: 'b', rating: 0.9 }], [{ oracle: 'c', rating: 1 }]] });
	});

	it('starts it again when it dies, and stops it when asked for none', async () => {
		const { client, sha } = await withDraftbot();
		client.send({ op: 'draftbot', sha });
		await until('up', () => draftbotOf(client)?.state === 'up', 10_000);
		const first = draftbotOf(client)!.pid!;
		process.kill(first, 'SIGKILL');
		await until('down', () => draftbotOf(client)?.state !== 'up');
		await until('up again', () => draftbotOf(client)?.state === 'up' && draftbotOf(client)?.pid !== first, 10_000);
		expect(draftbotOf(client)).toMatchObject({ sha, restarts: 1, error: null });
		const second = draftbotOf(client)!.pid!;
		client.send({ op: 'draftbot', sha: null });
		await until('stopped', () => draftbotOf(client) === null && !pidAlive(second));
	});

	it('refuses one it does not hold, and one the slice has no room for beside its JVMs', async () => {
		const unknown = 'f'.repeat(64);
		const a = await withDraftbot();
		a.client.send({ op: 'draftbot', sha: unknown });
		await until('refused', () => draftbotOf(a.client)?.state === 'refused');
		expect(draftbotOf(a.client)?.error).toBe(`draftbot ${unknown} is not installed`);

		// 100 + (2000 + 400) + 1536 = 4036 MB fits 4096; 100 + (2100 + 400) + 1536 = 4136 MB does not.
		const b = await withDraftbot();
		const jvm = collect(b.launcher.launch('h1', { xmxMb: 2100 }));
		await until('warm', () => jvm.lines.length === 1);
		b.client.send({ op: 'draftbot', sha: b.sha });
		await until('refused', () => draftbotOf(b.client)?.state === 'refused');
		expect(draftbotOf(b.client)?.error).toBe('does not fit: 4136 MB needed (its 1536 MB beside the JVMs here) in a 4096 MB slice');
	});

	it('counts its memory against every launch while it runs', async () => {
		const { client, launcher, sha } = await withDraftbot();
		client.send({ op: 'draftbot', sha });
		await until('up', () => draftbotOf(client)?.state === 'up', 10_000);
		// 100 + 1536 + (2100 + 400) = 4136 MB > 4096
		const t = collect(launcher.launch('h1', { xmxMb: 2100 }));
		expect(await t.exit).toBe('refused: does not fit: 4136 MB needed (each JVM -Xmx + 400 MB, agent 100 MB, draft bot 1536 MB) in a 4096 MB slice');
	});

	it('kills what an earlier agent left running: it is stateless, and waits to be asked again', async () => {
		const home = scratch();
		const left = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
		cleanup.push(() => left.kill('SIGKILL'));
		writeFileSync(join(home, 'draftbot.pid'), JSON.stringify({ pid: left.pid, startTicks: procStartTicks(left.pid!) }));
		const logged: string[] = [];
		new DraftbotService(home, new Cgroups(null), (what) => void logged.push(what));
		await until('killed', () => !pidAlive(left.pid!));
		expect(logged).toEqual(['draftbot-leftover']);
		expect(existsSync(join(home, 'draftbot.pid'))).toBe(false);
	});
});
