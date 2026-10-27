/**
 * The host agent and the remote launcher end to end on one box, against the
 * real Forge jar: the bundle (`deploy.sh build`) runs under node 22 without
 * cgroups, as a claw would run it, and this script is the coordinator.
 *
 *   AGENT_DIR=<scratch> CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *     apps/server/node_modules/.bin/tsx scripts/agent/local-e2e.ts
 *
 * `AGENT_DIR` holds `build/run` and `keys/signing.key` (deploy.sh keygen/build);
 * the agent's home, its log and the packed artifacts go there too.
 *
 * It shows: a `--host` JVM booting through the launcher, a match line relayed,
 * a coordinator disconnect → `attach` → replay, the agent's own restart with
 * the JVM adopted, and fencing killing the JVM.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { jvmHostConfig } from '../../apps/server/src/play/host.js';
import type { JvmTransport } from '../../apps/server/src/play/jvm-transport.js';
import { AGENT_KEY_ENV, connectRemoteHost, type RemoteHost } from '../../apps/server/src/play/remote/index.js';

const dir = process.env.AGENT_DIR ?? '';
if (dir === '') throw new Error('AGENT_DIR is not set');
const port = Number(process.env.AGENT_PORT ?? 17621);
const node22 = process.env.NODE22 ?? '/usr/local/bin/node';
const t0 = Date.now();
const say = (what: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${what}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function startAgent(): ChildProcess {
	mkdirSync(join(dir, 'home'), { recursive: true });
	const log = openSync(join(dir, 'agent.log'), 'a');
	const agent = spawn(node22, [join(dir, 'build', 'run')], {
		cwd: join(dir, 'home'),
		stdio: ['ignore', log, log],
		env: { PATH: process.env.PATH, CARDTABLE_AGENT_PORT: String(port), CARDTABLE_AGENT_LISTEN: '127.0.0.1', CARDTABLE_AGENT_NO_CGROUPS: '1', CARDTABLE_AGENT_MEMORY_MB: '6000' },
	});
	say(`agent started under ${node22} (${readFileSync('/proc/version', 'utf8').split(' ')[2]}), pid ${agent.pid}`);
	return agent;
}

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(50);
	}
}

type Line = { t: string; match?: string };
function watch(t: JvmTransport): { lines: Line[]; exit: string | null } {
	const seen = { lines: [] as Line[], exit: null as string | null };
	t.onLine((l) => seen.lines.push(JSON.parse(l) as Line));
	t.onExit((r) => (seen.exit = r));
	return seen;
}
const kinds = (lines: Line[]): string => {
	const n = new Map<string, number>();
	for (const l of lines) n.set(l.t, (n.get(l.t) ?? 0) + 1);
	return [...n].map(([k, v]) => `${k}×${v}`).join(' ');
};

const available = jvmHostConfig();
if (!available.ok) throw new Error(available.reason);
const config = available.config;
const env = { [AGENT_KEY_ENV]: readFileSync(join(dir, 'keys', 'signing.key'), 'utf8') };
const connect = (): Promise<RemoteHost> => connectRemoteHost('127.0.0.1', config, env, { port, log: () => {} });

let agent = startAgent();
await sleep(500);
try {
	say('coordinator 1: pack + push the JDK, jar, res and bridge, open the relay');
	const c1 = await connect();
	say(`artifacts on the agent: ${Object.entries((await c1.client.call<{ artifacts: Record<string, { sha: string }[]> }>('GET', '/status')).artifacts).map(([k, v]) => `${k}=${v[0]?.sha.slice(0, 8)}`).join(' ')}`);

	const hostId = 'e2e-host';
	const t1 = c1.launcher.launch(hostId, { xmxMb: 1200 });
	const s1 = watch(t1);
	await until('warm', () => s1.lines.length > 0, 120_000);
	say(`launched ${hostId}: first line ${JSON.stringify(s1.lines[0])}`);
	const deck = readFileSync(join(config.res, 'quest', 'precons', 'Spirit Flames.dck'), 'utf8');
	t1.send(JSON.stringify({ t: 'start', match: hostId, config: { matchId: 'm-e2e', seats: [{ name: 'human', ai: false, deck }, { name: 'bot', ai: true, deck }] } }));
	await until('a match line', () => s1.lines.some((l) => l.match === 'm-e2e' && l.t === 'frame'), 120_000);
	say(`match lines relayed: ${kinds(s1.lines.filter((l) => l.match === 'm-e2e'))}`);
	const pid = (await c1.client.call<{ jvms: { pid: number }[] }>('GET', '/status')).jvms[0]!.pid;

	say('coordinator 1 releases the JVM and goes away (a coordinator restart)');
	t1.release();
	c1.client.close();
	await sleep(5000);
	const record = JSON.parse(readFileSync(join(dir, 'home', 'jvms', hostId, 'jvm.json'), 'utf8')) as { acked: number };
	say(`coordinator 1 had taken ${s1.lines.length} line(s), through byte ${(t1 as unknown as { resumeFrom(): number }).resumeFrom()}; the agent recorded ${record.acked}`);

	const c2 = await connect();
	const running = await c2.launcher.running();
	const t2 = c2.launcher.attach(hostId);
	const s2 = watch(t2);
	await until('the replay', () => s2.lines.length > 0, 5000);
	await sleep(300);
	say(`coordinator 2: running() = ${JSON.stringify(running)}; attach replayed ${s2.lines.length} line(s) printed while away: ${kinds(s2.lines)}`);

	say(`the agent restarts (SIGKILL pid ${agent.pid}); the JVM ${pid} must outlive it`);
	agent.kill('SIGKILL');
	await sleep(1000);
	say(`JVM ${pid} alive with no agent: ${pidAlive(pid)}`);
	agent = startAgent();
	const before = s2.lines.length;
	await until('lines after the restart', () => s2.lines.length > before + 1, 15_000);
	say(`relay re-attached by itself; ${s2.lines.length - before} new line(s) since (${kinds(s2.lines.slice(before))}); JVM pid still ${pid}: ${pidAlive(pid)}`);
	say(`agent log: ${readFileSync(join(dir, 'agent.log'), 'utf8').split('\n').filter((l) => l.includes('"jvm-adopted"')).pop()}`);

	say(`heartbeat health: ${JSON.stringify(c2.client.health?.jvms[0])}`);
	say('coordinator 2 vanishes without a word; the fencing window is 10 s');
	c2.client.close();
	const gone = Date.now();
	await until('fenced', () => !pidAlive(pid), 20_000);
	say(`JVM ${pid} killed ${((Date.now() - gone) / 1000).toFixed(1)} s after the coordinator went silent`);
	say(`agent log: ${readFileSync(join(dir, 'agent.log'), 'utf8').split('\n').filter((l) => l.includes('"fenced"')).pop()}`);

	const c3 = await connect();
	const t3 = c3.launcher.attach(hostId);
	const s3 = watch(t3);
	await until('the exit', () => s3.exit !== null, 5000);
	say(`coordinator 3 attaches: ${s3.lines.length} unacknowledged line(s), then exit: ${s3.exit}`);
	c3.client.close();
} finally {
	agent.kill('SIGKILL');
}
