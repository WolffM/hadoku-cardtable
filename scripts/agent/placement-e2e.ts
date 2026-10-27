/**
 * Placement, failover and the restart grace end to end on one box, against the real Forge jar:
 * two host agents (the `deploy.sh build` bundle under node 22, no cgroups) standing in for two
 * claws, and the coordinator's placement (`apps/server/src/play/placement/`) in a child process of
 * its own, so it can be SIGTERMed and replaced the way pm2 restarts it.
 *
 *   AGENT_DIR=<scratch> CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=<scratch>/play \
 *     apps/server/node_modules/.bin/tsx scripts/agent/placement-e2e.ts
 *
 * `AGENT_DIR` holds `build/run` and `keys/signing.key` as for `local-e2e.ts`. fleet-manager is a
 * fixed status naming both agents' claws as guaranteed; the alert webhook is a local fake.
 *
 * It shows: 4 matches spread over both claws; one claw's agent and JVMs SIGKILLed; its matches
 * placed on the other claw by the failover, one Failover alert, the claw quarantined; then the
 * coordinator SIGTERMed, a new one started past the fencing window, and the JVMs re-attached with
 * no fencing. The match restore here is a restart from the match's spec through the placement
 * factory, standing in for `MatchRegistry.restore` (turn-start snapshots), which this tree lacks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { jvmHostConfig, type BridgeLine, type HostEvents, type MatchHost, type MatchSpec } from '../../apps/server/src/play/host.js';
import { Alerts, discordSink } from '../../apps/server/src/play/placement/alerts.js';
import { placement, type Placement } from '../../apps/server/src/play/placement/coordinator.js';
import type { FleetNode } from '../../apps/server/src/play/placement/fleet.js';
import { AGENT_KEY_ENV, connectRemoteHost } from '../../apps/server/src/play/remote/index.js';

const dir = process.env.AGENT_DIR ?? '';
if (dir === '') throw new Error('AGENT_DIR is not set');
const node22 = process.env.NODE22 ?? '/usr/local/bin/node';
const PORTS: Record<string, number> = { 'claw-a': 17631, 'claw-b': 17632 };
const role = process.argv[2] ?? 'driver';

/* ── The coordinator (a child process) ─────────────────────────────── */

function emit(o: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ at: Date.now(), ...o })}\n`);
}

async function coordinator(adopt: boolean): Promise<void> {
	const available = jvmHostConfig();
	if (!available.ok) throw new Error(available.reason);
	const config = { ...available.config, xmxMb: 1200 };
	const env = { [AGENT_KEY_ENV]: readFileSync(join(dir, 'keys', 'signing.key'), 'utf8') };
	const deck = readFileSync(join(config.res, 'quest', 'precons', 'Spirit Flames.dck'), 'utf8');
	const spec: MatchSpec = { seats: [{ name: 'human', ai: false, deck }, { name: 'bot', ai: true, deck }] };
	const node = (name: string): FleetNode => ({
		node: name,
		reachable: true,
		ok: true,
		findings: [],
		notices: [],
		hosting: { state: 'guaranteed', declared: { memoryMb: 6000, cores: 4, port: PORTS[name]! }, observed: { agent: 'listening' }, until: null },
	});
	const links = new Map<string, Awaited<ReturnType<typeof connectRemoteHost>>>();
	const faces = new Map<string, MatchHost>();
	const p: Placement = placement({
		config,
		fleet: { status: () => Promise.resolve({ at: Date.now(), nodes: [node('claw-a'), node('claw-b')] }), nextSlice: () => Promise.resolve('claw-x') },
		connect: async (name) => {
			const link = await connectRemoteHost('127.0.0.1', config, env, { port: PORTS[name]!, log: () => {} });
			links.set(name, link);
			return link;
		},
		alerts: new Alerts({ sink: discordSink(`http://127.0.0.1:${process.env.HOOK_PORT}/hook`), log: (e) => emit({ evt: 'alert-log', ...e }) }),
		pollMs: 5000,
		log: (e) => {
			if (['claw-connected', 'claw-connect-failed', 'claw-quarantined', 'claw-failed-over', 'placement-down', 'jvm-adopted', 'jvm-warm', 'claw-recovered', 'canary-failed'].includes(String(e.evt))) emit(e);
		},
	});
	const events = (id: string): HostEvents => {
		let frames = 0;
		return {
			line: (l: BridgeLine) => {
				if (l.t === 'ready') emit({ evt: 'match-ready', id, host: p.hosts().hosts.find((h) => h.matches.includes(id))?.name });
				if (l.t === 'frame' && ++frames === 1) emit({ evt: 'match-frame', id, host: p.hosts().hosts.find((h) => h.matches.includes(id))?.name });
			},
			exit: (reason) => emit({ evt: 'match-exit', id, reason }),
			log: (e) => {
				if (e.evt === 'match-moved' || e.evt === 'match-lost' || e.evt === 'match-resumed') emit({ ...e, evt: String(e.evt), id });
			},
		};
	};
	// The restore: the same match id and spec, placed again through the factory (a new game).
	p.restoreWith({
		restore(id) {
			faces.set(id, p(id, spec, events(id)));
			return { from: 'spec' };
		},
	});
	await p.ready;
	const jvmPids = async (): Promise<Record<string, number[]>> => {
		const out: Record<string, number[]> = {};
		for (const [name, link] of links) {
			if (link.client.lost !== null) continue;
			out[name] = (await link.client.call<{ jvms: { pid: number }[] }>('GET', '/status')).jvms.map((j) => j.pid);
		}
		return out;
	};
	if (adopt) {
		const t0 = Date.now();
		const records = await p.orphans();
		for (const r of records) faces.set(r.matchId, p.attach(r, events(r.matchId)));
		emit({ evt: 'adopted', ms: Date.now() - t0, matches: records.map((r) => [r.matchId, r.hostId]), pids: await jvmPids() });
	}
	process.on('SIGTERM', () => {
		const t0 = Date.now();
		const handed = [...faces].filter(([, f]) => f.handOver?.() === true).map(([id]) => id);
		p.close();
		const reaped = p.reapOnExit();
		emit({ evt: 'handed-over', handed, reaped, ms: Date.now() - t0 });
		setTimeout(() => process.exit(0), 200);
	});
	const rl = createInterface({ input: process.stdin });
	rl.on('line', (cmd) => {
		void (async () => {
			if (cmd.startsWith('start ')) {
				const id = cmd.slice(6);
				faces.set(id, p(id, spec, events(id)));
				emit({ evt: 'placed', id, host: p.hosts().hosts.find((h) => h.matches.includes(id))?.name });
			} else if (cmd === 'pids') {
				emit({ evt: 'pids', pids: await jvmPids() });
			} else if (cmd === 'hosts') {
				const v = p.hosts();
				emit({ evt: 'hosts', backstop: v.backstop.promoted, hosts: v.hosts.map((h) => ({ name: h.name, eligible: h.eligible, failed: h.bars.filter((b) => !b.ok).map((b) => `${b.bar}: ${b.why}`), matches: h.matches })) });
			}
		})();
	});
	emit({ evt: 'coordinator-up', pid: process.pid, adopt });
}

/* ── The driver ─────────────────────────────────────────────────────── */

async function driver(): Promise<void> {
	const t0 = Date.now();
	const say = (what: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${what}`);
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	const alive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const hooks: { at: number; content: string }[] = [];
	const hook = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += String(c)));
		req.on('end', () => {
			hooks.push({ at: Date.now(), content: (JSON.parse(body) as { content: string }).content });
			res.writeHead(204).end();
		});
	});
	await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
	const hookPort = (hook.address() as { port: number }).port;

	const agents = new Map<string, ChildProcess>();
	/** Every JVM pid this run printed: killed at the end, whatever happened. */
	const printedPids = new Set<number>();
	const startAgent = (name: string): ChildProcess => {
		const home = join(dir, name);
		mkdirSync(home, { recursive: true });
		const log = openSync(join(dir, `${name}.log`), 'a');
		const agent = spawn(node22, [join(dir, 'build', 'run')], {
			cwd: home,
			stdio: ['ignore', log, log],
			env: { PATH: process.env.PATH, CARDTABLE_AGENT_PORT: String(PORTS[name]), CARDTABLE_AGENT_LISTEN: '127.0.0.1', CARDTABLE_AGENT_NO_CGROUPS: '1', CARDTABLE_AGENT_MEMORY_MB: '6000' },
		});
		agents.set(name, agent);
		say(`agent ${name} started, pid ${agent.pid}`);
		return agent;
	};

	interface Coord {
		proc: ChildProcess;
		seen: Record<string, unknown>[];
		send(cmd: string): void;
		until(what: string, ok: (e: Record<string, unknown>) => boolean, ms: number): Promise<Record<string, unknown>>;
	}
	const startCoordinator = (adopt: boolean): Coord => {
		const proc = spawn(process.execPath, [...process.execArgv, process.argv[1]!, adopt ? 'adopt' : 'coordinator'], {
			stdio: ['pipe', 'pipe', 'inherit'],
			env: { ...process.env, HOOK_PORT: String(hookPort) },
		});
		const seen: Record<string, unknown>[] = [];
		createInterface({ input: proc.stdout! }).on('line', (l) => {
			try {
				seen.push(JSON.parse(l) as Record<string, unknown>);
			} catch {
				say(`coordinator: ${l}`);
			}
		});
		return {
			proc,
			seen,
			send: (cmd) => proc.stdin!.write(`${cmd}\n`),
			async until(what, ok, ms) {
				const end = Date.now() + ms;
				for (;;) {
					const hit = seen.find(ok);
					if (hit !== undefined) return hit;
					if (Date.now() > end) throw new Error(`timed out: ${what}`);
					await sleep(50);
				}
			},
		};
	};

	for (const name of Object.keys(PORTS)) startAgent(name);
	await sleep(500);
	try {
		say('coordinator 1: connects to both agents, pushes the runtime');
		const c1 = startCoordinator(false);
		const count = (c: Coord, evt: string): number => c.seen.filter((e) => e.evt === evt).length;
		await c1.until('both claws connected', () => count(c1, 'claw-connected') >= 2, 180_000);
		await c1.until('warm on both', () => count(c1, 'jvm-warm') >= 2, 180_000);
		say(`both claws warm: ${c1.seen.filter((e) => e.evt === 'jvm-warm').map((e) => `${String(e.host)} boot ${String(e.bootMs)} ms`).join(', ')}`);

		const ids = ['m-e2e1', 'm-e2e2', 'm-e2e3', 'm-e2e4'];
		for (const id of ids) c1.send(`start ${id}`);
		for (const id of ids) await c1.until(`${id} frame`, (e) => e.evt === 'match-frame' && e.id === id, 120_000);
		const where = ids.map((id) => `${id}→${String(c1.seen.find((e) => e.evt === 'placed' && e.id === id)?.host)}`);
		say(`4 matches placed and at their first frame: ${where.join(' ')}`);
		c1.send('pids');
		const pids = (await c1.until('pids', (e) => e.evt === 'pids', 10_000)).pids as Record<string, number[]>;
		say(`JVM pids: ${JSON.stringify(pids)}`);
		for (const list of Object.values(pids)) for (const pid of list) printedPids.add(pid);

		const victim = 'claw-a';
		const agentPid = agents.get(victim)!.pid!;
		const killedAt = Date.now();
		agents.get(victim)!.kill('SIGKILL');
		for (const pid of pids[victim] ?? []) process.kill(pid, 'SIGKILL');
		say(`SIGKILLed ${victim}'s agent (pid ${agentPid}) and its JVMs ${JSON.stringify(pids[victim])}`);
		const failed = await c1.until('failover', (e) => e.evt === 'claw-failed-over', 30_000);
		say(`failover ${((Number(failed.at) - killedAt) / 1000).toFixed(1)} s after the kill: ${JSON.stringify((failed as { moved: unknown }).moved)}`);
		const movedIds = ((failed as { moved: { matchId: string }[] }).moved ?? []).map((m) => m.matchId);
		for (const id of movedIds) {
			const ready = await c1.until(`${id} restarted`, (e) => e.evt === 'match-frame' && e.id === id && Number(e.at) > killedAt, 120_000);
			say(`${id} at its first frame on ${String(ready.host)}, ${((Number(ready.at) - killedAt) / 1000).toFixed(1)} s after the kill`);
		}
		const alerts = hooks.filter((h) => h.at >= killedAt);
		say(`webhook received ${alerts.length} message(s) since the kill:\n${alerts.map((h) => `           ${h.content}`).join('\n')}`);
		c1.send('hosts');
		const hosts = await c1.until('hosts', (e) => e.evt === 'hosts', 10_000);
		say(`hosts: ${JSON.stringify(hosts.hosts)}`);

		say(`${victim}'s agent comes back: the next poll reconnects, and a canary match must pass before it hosts again`);
		const backAt = Date.now();
		startAgent(victim);
		const recovered = await c1.until('recovered', (e) => e.evt === 'claw-recovered' || e.evt === 'canary-failed', 120_000);
		say(`${String(recovered.evt)} ${((Number(recovered.at) - backAt) / 1000).toFixed(1)} s after the agent came back; webhook: ${hooks.at(-1)?.content}`);

		c1.send('pids');
		await sleep(500);
		for (const list of Object.values([...c1.seen].reverse().find((e) => e.evt === 'pids')!.pids as Record<string, number[]>)) for (const pid of list) printedPids.add(pid);
		const before = ([...c1.seen].reverse().find((e) => e.evt === 'pids')!.pids as Record<string, number[]>)['claw-b'] ?? [];
		for (const pid of before) printedPids.add(pid);
		say(`restart grace: SIGTERM the coordinator; claw-b JVMs ${JSON.stringify(before)}`);
		const termAt = Date.now();
		c1.proc.kill('SIGTERM');
		await new Promise((r) => c1.proc.once('exit', r));
		const handed = c1.seen.find((e) => e.evt === 'handed-over');
		say(`coordinator 1 exited ${Date.now() - termAt} ms after SIGTERM; handed over ${JSON.stringify(handed?.handed)} (handover ${String(handed?.ms)} ms)`);
		await sleep(15_000);
		say(`15 s later (past the 10 s fencing window), claw-b JVMs alive: ${before.map((pid) => `${pid}=${alive(pid)}`).join(' ')}`);
		const upAt = Date.now();
		const c2 = startCoordinator(true);
		const adopted = await c2.until('adopted', (e) => e.evt === 'adopted', 120_000);
		say(
			`coordinator 2 re-attached ${JSON.stringify(adopted.matches)} in ${String(adopted.ms)} ms of its own (${((Number(adopted.at) - upAt) / 1000).toFixed(1)} s from spawn, ${((Number(adopted.at) - termAt) / 1000).toFixed(1)} s from the SIGTERM); claw-b JVM pids now ${JSON.stringify((adopted.pids as Record<string, number[]>)['claw-b'])}`,
		);
		for (const list of Object.values(adopted.pids as Record<string, number[]>)) for (const pid of list) printedPids.add(pid);
		const resumed = c2.seen.filter((e) => e.evt === 'match-resumed');
		say(`replayed: ${resumed.map((e) => `${String(e.id)} ${String(e.replayed)} lines`).join(', ')}`);
		const fenced = readFileSync(join(dir, 'claw-b.log'), 'utf8').split('\n').filter((l) => l.includes('"fenced"') || l.includes('"hold'));
		say(`claw-b agent log, hold and fencing:\n${fenced.map((l) => `           ${l}`).join('\n')}`);
		c2.proc.kill('SIGTERM');
		await new Promise((r) => c2.proc.once('exit', r));
	} finally {
		for (const a of agents.values()) a.kill('SIGKILL');
		for (const pid of printedPids) if (alive(pid)) process.kill(pid, 'SIGKILL');
		await sleep(500);
		say(`cleanup: agents and printed JVMs ${JSON.stringify([...printedPids])} killed; alive now: ${[...printedPids].filter(alive).length}`);
		hook.close();
	}
	say('done');
}

if (role === 'coordinator' || role === 'adopt') await coordinator(role === 'adopt');
else await driver();
