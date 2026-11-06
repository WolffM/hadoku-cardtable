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
 *
 * With `DRAFTBOT_CLAWS=<claw>:<port>[,…]` it runs the draft bot instead, and needs no jar: each
 * agent runs ON THAT CLAW, over ssh, as a user unit in a delegated `hosting.slice` (so its cgroup
 * handling is the real one), reached through an ssh tunnel; this script is the coordinator, with
 * placement's own `ClawDraftbots` choosing and asking them. Two agents make a primary and a backup
 * (`claw-9:17621,claw-9:17622` puts both on one claw). `DRAFTBOT_CACHE` is where the pinned draft bot
 * is prepared and packed (default `~/.cache/cardtable`, the server's own).
 *
 * It shows: the artifact pushed and verified, the service up in its capped leaf, a 7-seat
 * `/batchdraft` answered through the agent, the service killed and started again (the backup
 * answering meanwhile), and an agent stopped: its service ends with it and the backup takes over.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { jvmHostConfig } from '../../apps/server/src/play/host.js';
import type { JvmTransport } from '../../apps/server/src/play/jvm-transport.js';
import { Alerts } from '../../apps/server/src/play/placement/alerts.js';
import { ClawDraftbots, type DraftbotClaw } from '../../apps/server/src/play/placement/draftbot.js';
import { DRAFTBOT_PIN, packDraftbot, pushDraftbot } from '../../apps/server/src/play/remote/artifacts.js';
import { AgentClient } from '../../apps/server/src/play/remote/client.js';
import { AGENT_KEY_ENV, connectRemoteHost, type RemoteHost } from '../../apps/server/src/play/remote/index.js';
import { privateKeyFrom } from '../../apps/server/src/play/remote/wire.js';

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

/* ── The draft bot, on claws ── */

async function draftbotRun(targets: { claw: string; port: number }[]): Promise<void> {
	const key = privateKeyFrom(readFileSync(join(dir, 'keys', 'signing.key'), 'utf8'));
	const cache = process.env.DRAFTBOT_CACHE ?? join(homedir(), '.cache', 'cardtable');
	const ssh = (claw: string, cmd: string): string => execFileSync('ssh', ['-o', 'BatchMode=yes', claw, cmd], { encoding: 'utf8' }).trim();
	const unit = (port: number): string => `cardtable-agent-e2e-${port}`;
	const remote = 'lane-agent-e2e';
	const tunnels: ChildProcess[] = [];

	say(`pack the pinned draft bot ${DRAFTBOT_PIN.commit.slice(0, 12)} (prepared once per pin, under ${cache})`);
	const packed = await packDraftbot(cache, undefined, (e) => say(JSON.stringify(e)));
	say(`artifact ${packed.sha.slice(0, 12)}: ${Math.round(statSync(packed.file).size / 1e6)} MB`);
	const oracles = Object.values(JSON.parse(readFileSync(join(cache, 'draftbot', DRAFTBOT_PIN.commit, 'packages', 'recommenderService', 'model', 'indexToOracleMap.json'), 'utf8')) as Record<string, string>);
	const inputs = Array.from({ length: 7 }, (_, s) => ({ pack: oracles.slice(1000 + s * 15, 1015 + s * 15), pool: oracles.slice(9000 + s * 10, 9010 + s * 10) }));

	const claws: (DraftbotClaw & { claw: string; port: number; client: AgentClient })[] = [];
	try {
		for (const { claw, port } of targets) {
			ssh(claw, `mkdir -p ~/${remote}/${port}`);
			execFileSync('scp', ['-q', join(dir, 'build', 'run'), `${claw}:${remote}/run`]);
			ssh(
				claw,
				`systemd-run --user --quiet --unit=${unit(port)} --slice=hosting -p Delegate=yes --setenv=CARDTABLE_AGENT_PORT=${port} --setenv=CARDTABLE_AGENT_LISTEN=127.0.0.1 ` +
					`--setenv=CARDTABLE_AGENT_MEMORY_MB=4096 --setenv=CARDTABLE_AGENT_HOME=$HOME/${remote}/${port} /usr/bin/node $HOME/${remote}/run`,
			);
			const local = port + 1000;
			const tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `${local}:127.0.0.1:${port}`, claw], { stdio: 'ignore' });
			tunnels.push(tunnel);
			say(`${claw}: agent ${unit(port)} on ${claw} (${ssh(claw, '/usr/bin/node --version')}), cgroup ${ssh(claw, `systemctl --user show -p ControlGroup --value ${unit(port)}`)}; tunnel pid ${tunnel.pid}, 127.0.0.1:${local}`);
			const client = new AgentClient({ url: `http://127.0.0.1:${local}`, key, log: (e) => say(JSON.stringify(e)) });
			for (let i = 0; ; i++) {
				try {
					await client.connect();
					break;
				} catch (e) {
					if (i > 40) throw e;
					await sleep(250);
				}
			}
			const started = Date.now();
			const sha = await pushDraftbot(client, packed);
			say(`${claw}:${port}: artifact pushed and installed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
			claws.push({ name: `${claw}:${port}`, claw, port, client, usable: true, sha, error: null });
		}

		const bots = new ClawDraftbots({ alerts: new Alerts({ sink: null, log: (e) => say(JSON.stringify(e)) }), log: (e) => say(JSON.stringify(e)) });
		const step = setInterval(() => bots.step(claws.filter((c) => c.client.lost === null)), 1000);
		const state = (c: (typeof claws)[number]) => c.client.health?.draftbot ?? null;
		const ask = async (what: string): Promise<void> => {
			const t = Date.now();
			const out = await bots.batchDraft(inputs, AbortSignal.timeout(1200));
			say(`${what}: 7 seats rated in ${Date.now() - t} ms; seat 1's top pick ${out[0]?.[0]?.oracle} (${out[0]?.[0]?.rating.toFixed(3)}) of ${out[0]?.length}`);
		};
		try {
			await until('both up', () => claws.every((c) => state(c)?.state === 'up'), 120_000);
			for (const c of claws) {
				const cg = ssh(c.claw, `systemctl --user show -p ControlGroup --value ${unit(c.port)}`);
				const leaf = `/sys/fs/cgroup${cg}/draftbot`;
				say(`${c.name}: up, pid ${state(c)?.pid}, ${state(c)?.memoryMb} MB; ${leaf}: memory.max ${ssh(c.claw, `cat ${leaf}/memory.max`)}, procs ${ssh(c.claw, `cat ${leaf}/cgroup.procs | tr '\\n' ' '`)}`);
			}
			say(`chosen: ${bots.view().chosen.join(', ')}`);
			for (let i = 1; i <= 3; i++) await ask(`call ${i}`);

			const [primary, backup] = claws as [(typeof claws)[number], (typeof claws)[number] | undefined];
			const pid = state(primary)!.pid!;
			say(`${primary.name}: kill -9 the service, pid ${pid}`);
			ssh(primary.claw, `kill -9 ${pid}`);
			await until('primary seen down', () => state(primary)?.state !== 'up', 10_000);
			if (backup !== undefined) await ask(`primary down (${state(primary)?.state}): the backup answers`);
			await until('primary up again', () => state(primary)?.state === 'up', 60_000);
			say(`${primary.name}: up again as pid ${state(primary)?.pid}, restarts ${state(primary)?.restarts}`);
			await ask('primary back');

			if (backup !== undefined) {
				const pid2 = state(primary)!.pid!;
				say(`${primary.name}: stop its agent unit; service pid ${pid2} must end with it`);
				ssh(primary.claw, `systemctl --user stop ${unit(primary.port)}`);
				say(`pid ${pid2} alive after the unit stopped: ${ssh(primary.claw, `kill -0 ${pid2} 2>/dev/null && echo yes || echo no`)}`);
				await until('primary lost', () => primary.client.lost !== null, 20_000);
				await until('re-picked', () => !bots.view().chosen.includes(primary.name), 5000);
				say(`link lost: ${primary.client.lost}; chosen now ${bots.view().chosen.join(', ')}`);
				await ask('after the primary claw is lost');
			}
		} finally {
			clearInterval(step);
		}
	} finally {
		for (const c of claws) c.client.close();
		for (const t of tunnels) t.kill();
		for (const { claw, port } of targets) {
			execFileSync('ssh', ['-o', 'BatchMode=yes', claw, `systemctl --user stop ${unit(port)} 2>/dev/null; rm -rf ~/${remote}`], { stdio: 'ignore' });
		}
		say('agents stopped, tunnels closed, claws cleaned');
	}
}

const draftbotClaws = (process.env.DRAFTBOT_CLAWS ?? '').split(',').filter((t) => t !== '');
if (draftbotClaws.length > 0) {
	await draftbotRun(draftbotClaws.map((t) => ({ claw: t.split(':')[0] as string, port: Number(t.split(':')[1] ?? 17621) })));
	process.exit(0);
}

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
