/**
 * hosting-test-plan.md §D on a real claw: the production wiring (`clawPlacement`: fleet-manager's
 * CLI, the signed agent on the claw, hokon as the backstop) under the real match registry, so a
 * failover restores through `MatchRegistry.restore` from each match's turn-start snapshot.
 *
 *   AGENT_KEY_FILE=<signing.key> CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… \
 *   CARDTABLE_PLAY_WORK_DIR=<scratch>/play ACCEPT_DIR=<scratch> \
 *     apps/server/node_modules/.bin/tsx scripts/agent/claw-acceptance.ts <claw>[,<claw>…] [matches]
 *
 * Run it only under a lease drain of every claw named (`fleet drain <claw> --kind lease`), with the agent
 * built from the same key (`deploy.sh build`, `deploy.sh install`). Each match is a precon AI against
 * a seat that passes every priority; the alert
 * webhook is a local fake. The faults go through ssh and sudo on the claw, killing only the pids
 * this run printed.
 *
 *   D1  the busiest claw's agent and its JVMs SIGKILLed with live matches: every match restored
 *       on another claw, or on the backstop when none has room (from its snapshot where it had
 *       one), one alert, the claw quarantined. With `CARDTABLE_PLAY_MATCHES_PER_JVM=50` and two
 *       claws, 50 matches is D5.
 *   D3  the agent back (systemd restarts it): a canary before the claw hosts again, ✅ alert
 *   D4  the coordinator SIGTERMed with matches on the claw: the agent holds them past the fencing
 *       window, and the next coordinator re-attaches the same JVM
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DEFAULT_STOP_POLICY } from '../../apps/server/src/play/auto.js';
import { jvmHostConfig, type MatchSpec } from '../../apps/server/src/play/host.js';
import { createMatchRegistry, type Match } from '../../apps/server/src/play/match.js';
import { clawPlacement, registryRestorer } from '../../apps/server/src/play/placement/index.js';
import { AGENT_KEY_ENV } from '../../apps/server/src/play/remote/index.js';

const claws = (process.argv[2] ?? '').split(',').filter((c) => c !== '');
const role = process.env.ACCEPT_ROLE ?? 'driver';
const dir = process.env.ACCEPT_DIR ?? '';
if (claws.length === 0 || dir === '') throw new Error('usage: ACCEPT_DIR=<scratch> claw-acceptance.ts <claw>[,<claw>…] [matches]');
const COUNT = Number(process.argv[3] ?? '8');
/** What the placement says, as it says it: every event a step below waits on. */
const SHOWN = new Set([
	'play-hosts', 'claw-connected', 'claw-connect-failed', 'claw-quarantined', 'claw-failed-over', 'claw-recovered', 'canary-failed',
	'backstop-promoted', 'backstop-demoted', 'placement-down', 'jvm-warm', 'jvm-adopted', 'match-restored', 'match-host', 'match-fatal-again',
]);

function emit(o: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ at: Date.now(), ...o })}\n`);
}

/* ── The coordinator (a child process, so it can be SIGTERMed and replaced) ── */

async function coordinator(adopt: boolean): Promise<void> {
	const available = jvmHostConfig();
	if (!available.ok) throw new Error(available.reason);
	const config = available.config;
	const deck = readFileSync(join(config.res, 'quest', 'precons', 'Spirit Flames.dck'), 'utf8');
	// Seat 0 must be a human (the bridge's rule). Nobody plays it: no stops, so it passes every
	// priority until its first discard, a few turns in; the AI plays a real precon.
	const spec: MatchSpec = {
		seats: [{ name: 'seat one', ai: false, deck: '[metadata]\nName=Plains\n[main]\n60 Plains\n' }, { name: 'bot', ai: true, deck }],
		skipOpening: true,
	};
	const stopPolicy = { ...DEFAULT_STOP_POLICY, stopOnMyTurn: [], stopOnTheirTurn: [], stopWithPlayOnTheirTurn: [], stopWithPlayOnMyTurn: [], stopForPhaseAbility: false };
	const log = (e: Record<string, unknown>): void => {
		if (SHOWN.has(String(e.evt))) emit(e);
	};
	const p = clawPlacement(config, {
		webhook: `http://127.0.0.1:${process.env.HOOK_PORT}/hook`,
		forceFile: join(dir, 'backstop-force.json'),
		restartGraceMs: 90_000,
		log,
	});
	const registry = createMatchRegistry({ host: p, attach: (record, events) => p.attach(record, events), log, overGraceMs: 60_000, stopPolicy, emit: () => {} });
	p.restoreWith(registryRestorer(registry));
	const ids: string[] = [];
	const where = (id: string): string | null => p.hosts().hosts.find((h) => h.matches.includes(id))?.name ?? null;
	const view = (m: Match): Record<string, unknown> => ({ id: m.id, status: m.status, host: where(m.id), turn: m.latestSnapshot?.turn ?? null, epoch: m.epoch, failure: m.failure });

	if (adopt) {
		const t0 = Date.now();
		for (const record of await p.orphans()) {
			const m = registry.adopt(record);
			if (m !== null) ids.push(m.id);
		}
		emit({ evt: 'adopted', ms: Date.now() - t0, matches: ids.map((id) => view(registry.get(id)!)) });
	}
	process.on('SIGTERM', () => {
		const t0 = Date.now();
		const { handed, ending } = registry.handOver();
		for (const m of ending) m.stop();
		p.close();
		const reaped = p.reapOnExit();
		emit({ evt: 'handed-over', handed: handed.map((m) => m.id), ended: ending.map((m) => m.id), reaped, ms: Date.now() - t0 });
		setTimeout(() => process.exit(0), 200);
	});
	createInterface({ input: process.stdin }).on('line', (cmd) => {
		const [verb, arg] = cmd.split(' ');
		if (verb === 'start') {
			for (let i = 0; i < Number(arg); i++) ids.push(registry.create(spec).id);
			emit({ evt: 'started', ids: ids.slice(-Number(arg)) });
		} else if (verb === 'status') {
			const v = p.hosts();
			emit({
				evt: 'status',
				matches: ids.map((id) => view(registry.get(id)!)),
				backstop: v.backstop,
				hosts: v.hosts.map((h) => ({ name: h.name, eligible: h.eligible, failed: h.bars.filter((b) => !b.ok).map((b) => `${b.bar}: ${b.why}`), matches: h.matches.length })),
			});
		} else if (verb === 'stopall') {
			registry.stopAll();
			emit({ evt: 'stopped' });
		}
	});
	await p.ready;
	emit({ evt: 'coordinator-up', pid: process.pid, adopt });
}

/* ── The driver ─────────────────────────────────────────────────────────── */

interface Coord {
	proc: ChildProcess;
	seen: Record<string, unknown>[];
	send(cmd: string): void;
	until(what: string, ok: (e: Record<string, unknown>) => boolean, ms: number, after?: number): Promise<Record<string, unknown>>;
	status(): Promise<Status>;
}
interface Status {
	at: number;
	matches: { id: string; status: string; host: string | null; turn: number | null; epoch: string; failure: string | null }[];
	backstop: { promoted: boolean; why: string };
	hosts: { name: string; eligible: boolean; failed: string[]; matches: number }[];
}

async function driver(): Promise<void> {
	const t0 = Date.now();
	const say = (what: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} s] ${what}`);
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	const secs = (from: number, to: number): string => `${((to - from) / 1000).toFixed(1)} s`;
	const onClaw = (claw: string, script: string): string => execFileSync('ssh', ['-o', 'BatchMode=yes', claw, script], { encoding: 'utf8', timeout: 30_000 }).trim();
	/** The agent and its JVMs on a claw, as `pid comm` lines (the agent's user owns both). */
	const clawProcs = (claw: string): { pid: number; comm: string }[] =>
		onClaw(claw, 'pgrep -u cardtable-agent -l || true')
			.split('\n')
			.filter((l) => l !== '')
			.map((l) => ({ pid: Number(l.split(' ')[0]), comm: l.split(' ')[1] ?? '' }));

	mkdirSync(dir, { recursive: true });
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
	const env = { ...process.env, ACCEPT_ROLE: 'coordinator', HOOK_PORT: String((hook.address() as { port: number }).port), [AGENT_KEY_ENV]: readFileSync(process.env.AGENT_KEY_FILE ?? '', 'utf8').trim() };

	const start = (adopt: boolean): Coord => {
		const proc = spawn(process.execPath, [...process.execArgv, process.argv[1]!, claws.join(',')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, ACCEPT_ROLE: adopt ? 'adopt' : 'coordinator' } });
		const seen: Record<string, unknown>[] = [];
		createInterface({ input: proc.stdout! }).on('line', (l) => {
			appendFileSync(join(dir, 'events.jsonl'), `${l}\n`);
			try {
				seen.push(JSON.parse(l) as Record<string, unknown>);
			} catch {
				say(`coordinator: ${l}`);
			}
		});
		const c: Coord = {
			proc,
			seen,
			send: (cmd) => proc.stdin!.write(`${cmd}\n`),
			async until(what, ok, ms, after = 0) {
				const end = Date.now() + ms;
				for (;;) {
					const hit = seen.find((e) => Number(e.at) >= after && ok(e));
					if (hit !== undefined) return hit;
					if (proc.exitCode !== null) throw new Error(`the coordinator exited (${proc.exitCode}) waiting for ${what}`);
					if (Date.now() > end) throw new Error(`timed out: ${what}`);
					await sleep(100);
				}
			},
			async status() {
				const asked = Date.now();
				c.send('status');
				return (await c.until('status', (e) => e.evt === 'status', 10_000, asked)) as unknown as Status;
			},
		};
		return c;
	};
	const table = (s: Status): string => {
		const by = new Map<string, number>();
		for (const m of s.matches) by.set(`${m.status}@${m.host ?? '-'}`, (by.get(`${m.status}@${m.host ?? '-'}`) ?? 0) + 1);
		const failures = [...new Set(s.matches.filter((m) => m.failure !== null).map((m) => m.failure))];
		return `${[...by].map(([k, n]) => `${n} ${k}`).join(', ')}; turns ${s.matches.map((m) => m.turn ?? '-').join(' ')}${failures.length === 0 ? '' : `; failures ${JSON.stringify(failures)}`}`;
	};
	const live = (s: Status): Status['matches'] => s.matches.filter((m) => m.status === 'starting' || m.status === 'running');

	let c1: Coord | null = null;
	let c2: Coord | null = null;
	try {
		const jvmsOnClaws = (): string => claws.map((c) => `${c} ${JSON.stringify(clawProcs(c).filter((p) => p.comm === 'java'))}`).join(', ');
		for (const claw of claws) say(`claw ${claw} before: ${JSON.stringify(clawProcs(claw))}`);
		c1 = start(false);
		for (const claw of claws) {
			await c1.until(`${claw} connected`, (e) => e.evt === 'claw-connected' && e.host === claw, 300_000);
			await c1.until(`${claw} warm`, (e) => e.evt === 'jvm-warm' && e.host === claw, 300_000);
			say(`${claw} connected and warm: ${JSON.stringify(c1.seen.find((e) => e.evt === 'claw-connected' && e.host === claw))}`);
		}

		/* D1: matches on the claws, then the busiest one's agent and JVMs killed */
		c1.send(`start ${COUNT}`);
		const startedAt = Date.now();
		for (;;) {
			const s = await c1.status();
			if (s.matches.length === COUNT && s.matches.every((m) => m.status === 'running')) {
				say(`${COUNT} running ${secs(startedAt, Date.now())} after the start: ${table(s)}`);
				break;
			}
			if (Date.now() - startedAt > 300_000) throw new Error(`not all running: ${table(s)}`);
			await sleep(2000);
		}
		// Past a few turn starts, so most matches restore from a snapshot rather than from their spec.
		for (;;) {
			const s = await c1.status();
			if (live(s).length === 0) throw new Error(`no match is live: ${table(s)}`);
			const snapped = live(s).filter((m) => (m.turn ?? 0) >= 3).length;
			if (snapped * 2 >= live(s).length || Date.now() - startedAt > 240_000) {
				say(`before the kill: ${table(s)}`);
				break;
			}
			await sleep(3000);
		}
		const before = await c1.status();
		const onEach = claws.map((c) => ({ claw: c, n: live(before).filter((m) => m.host === c).length }));
		const victim = onEach.sort((a, b) => b.n - a.n)[0]!.claw;
		const onIt = live(before).filter((m) => m.host === victim);
		const procs = clawProcs(victim);
		say(`live matches per claw ${JSON.stringify(onEach)}; ${victim}: killing ${JSON.stringify(procs)}`);
		const killedAt = Date.now();
		onClaw(victim, `sudo kill -9 ${procs.map((p) => p.pid).join(' ')}`);
		const failed = await c1.until('failover', (e) => e.evt === 'claw-failed-over' && e.host === victim, 60_000, killedAt);
		say(`D1 failover ${secs(killedAt, Number(failed.at))} after the kill: moved ${JSON.stringify(failed.moved)}, lost ${JSON.stringify(failed.lost)}`);
		const restored = c1.seen.filter((e) => e.evt === 'match-restored' && Number(e.at) >= killedAt);
		say(`D1 restores: ${restored.map((e) => `${String(e.matchId)} from ${String(e.from)}${e.turn === undefined ? '' : ` turn ${String(e.turn)}`}`).join(', ')}`);
		for (;;) {
			const s = await c1.status();
			const moved = s.matches.filter((m) => onIt.some((o) => o.id === m.id));
			if (moved.every((m) => m.status !== 'starting')) {
				const went = new Map<string, number>();
				for (const m of moved) went.set(m.host ?? '-', (went.get(m.host ?? '-') ?? 0) + 1);
				say(`D1 the ${moved.length} moved went to ${JSON.stringify(Object.fromEntries(went))}`);
				say(`D1 ${secs(killedAt, Date.now())} after the kill: ${table(s)}; failures ${JSON.stringify(moved.filter((m) => m.failure !== null).map((m) => m.failure))}`);
				break;
			}
			if (Date.now() - killedAt > 180_000) throw new Error(`moved matches never ran: ${table(s)}`);
			await sleep(1000);
		}
		say(`D1 alerts since the kill:\n${hooks.filter((h) => h.at >= killedAt).map((h) => `            ${h.content}`).join('\n')}`);
		say(`D1 hosts: ${JSON.stringify((await c1.status()).hosts)} backstop ${JSON.stringify((await c1.status()).backstop)}`);

		/* D3: systemd brings the agent back; a canary must pass before the claw hosts again */
		const recovered = await c1.until('recovered', (e) => (e.evt === 'claw-recovered' || e.evt === 'canary-failed') && e.host === victim, 300_000, killedAt);
		say(`D3 ${String(recovered.evt)} ${secs(killedAt, Number(recovered.at))} after the kill; ${victim} now ${JSON.stringify(clawProcs(victim))}`);
		say(`D3 alerts: ${hooks.filter((h) => h.at >= Number(recovered.at) - 1000).map((h) => h.content).join(' | ')}`);
		if (c1.seen.some((e) => e.evt === 'backstop-promoted' && Number(e.at) >= killedAt)) {
			await c1.until('backstop demoted', (e) => e.evt === 'backstop-demoted', 300_000, Number(recovered.at));
			say(`backstop demoted: ${JSON.stringify((await c1.status()).backstop)}`);
		} else say(`the backstop was never promoted: ${JSON.stringify((await c1.status()).backstop)}`);

		/* D4: matches on the claw again, then the coordinator SIGTERMed past the fencing window */
		c1.send('start 4');
		const second = Date.now();
		for (;;) {
			const s = await c1.status();
			const fresh = s.matches.slice(-4);
			if (fresh.every((m) => m.status === 'running')) {
				say(`4 more running: ${table(s)}`);
				break;
			}
			if (Date.now() - second > 180_000) throw new Error(`the 4 never ran: ${table(s)}`);
			await sleep(2000);
		}
		say(`D4 SIGTERM the coordinator; JVMs ${jvmsOnClaws()}`);
		const termAt = Date.now();
		c1.proc.kill('SIGTERM');
		await new Promise((r) => c1!.proc.once('exit', r));
		say(`D4 handed over: ${JSON.stringify(c1.seen.find((e) => e.evt === 'handed-over'))}`);
		await sleep(15_000);
		say(`D4 15 s later (past the 10 s fencing window): JVMs ${jvmsOnClaws()}`);
		c2 = start(true);
		const adopted = await c2.until('adopted', (e) => e.evt === 'adopted', 300_000);
		say(`D4 re-attached ${secs(termAt, Number(adopted.at))} after the SIGTERM: ${JSON.stringify(adopted.matches)}`);
		await sleep(10_000);
		const after = await c2.status();
		say(`D4 10 s on: ${table(after)}; JVMs ${jvmsOnClaws()}`);
	} finally {
		for (const c of [c2, c1]) {
			if (c === null || c.proc.exitCode !== null) continue;
			c.send('stopall');
			await sleep(3000);
			c.proc.kill('SIGTERM');
			await new Promise((r) => c.proc.once('exit', r));
		}
		await sleep(5000);
		for (const claw of claws) say(`cleanup: ${claw} now ${JSON.stringify(clawProcs(claw))}`);
		hook.close();
	}
	say('done');
}

if (role === 'coordinator' || role === 'adopt') await coordinator(role === 'adopt');
else await driver();
