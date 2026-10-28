/**
 * Placement, failover and alerts over real `jvmHostFactory` pools, with scripted launchers for the
 * claws (no JVM), fake agent links, a fake fleet and a fake clock.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { BridgeLine, HostEvents, JvmHostConfig, MatchSpec } from '../host.js';
import type { JvmLauncher, JvmTransport } from '../jvm-transport.js';
import type { JvmHealth } from '../remote/wire.js';
import { Alerts, type AlertSink } from './alerts.js';
import { placement, type AgentLink, type Placement, type Restorer } from './coordinator.js';
import type { FleetDemand, FleetNode, FleetSource, FleetStatus } from './fleet.js';
import { parseDemand, parseNodeStatus } from './fleet.js';
import {
	BACKSTOP_IDLE,
	DEMAND_CALM_MS,
	DEMAND_IDLE,
	REPLACE_AFTER_MS,
	backstopStep,
	bars,
	demandStep,
	rankClaws,
	readForce,
	type BackstopState,
	type ClawState,
	type DemandClaw,
	type DemandState,
} from './rules.js';

const scratch = mkdtempSync(join(tmpdir(), 'cardtable-placement-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;

const config = (): JvmHostConfig => ({
	java: 'unused',
	jar: 'unused.jar',
	res: join(scratch, 'res'),
	workDir: join(scratch, `runs-${++dirs}`),
	jvmOpts: [],
	bridgeSource: 'BRIDGE',
	bridgeCache: join(scratch, 'bridge-cache'),
	stopGraceMs: 1000,
	warmJvm: true,
	perJvm: 2,
	// (4096 - 100) / (1000 + 400): two JVMs, four matches, in a 4 GiB slice.
	xmxMb: 1000,
});

const SPEC: MatchSpec = { seats: [{ name: 'Seat 1', ai: false, deck: null }, { name: 'Seat 2', ai: true, deck: null }] };

/* ── Fakes ── */

interface ScriptedJvm {
	hostId: string;
	sent: string[];
	say(line: object): void;
	die(reason: string): void;
	dead: boolean;
}

/** A launcher with no JVM behind it: every JVM is a script the test speaks for. `running` are JVMs an earlier server left. */
function scripted(running: string[] = []): { launcher: JvmLauncher; jvms: ScriptedJvm[] } {
	const jvms: ScriptedJvm[] = [];
	const launcher: JvmLauncher = {
			launch(hostId) {
				let onLine: (line: string) => void = () => undefined;
				let onExit: (reason: string) => void = () => undefined;
				const jvm: ScriptedJvm = {
					hostId,
					sent: [],
					dead: false,
					say: (line) => onLine(JSON.stringify(line)),
					die: (reason) => {
						if (jvm.dead) return;
						jvm.dead = true;
						onExit(reason);
					},
				};
				jvms.push(jvm);
				const transport: JvmTransport = {
					hostId,
					send: (line) => jvm.sent.push(line),
					onLine: (l) => (onLine = l),
					onExit: (l) => (onExit = l),
					kill: () => jvm.die('killed'),
					release: () => undefined,
				};
				return transport;
			},
			running: () => Promise.resolve(running),
			attach: (hostId) => {
				if (!running.includes(hostId)) throw new Error('nothing to attach');
				return launcher.launch(hostId, { xmxMb: 1000 });
			},
	};
	return { jvms, launcher };
}

interface FakeClaw {
	node: string;
	jvms: ScriptedJvm[];
	launcher: JvmLauncher;
	link: AgentLink & { holds: number[]; closed: boolean; silent: number; lose(reason: string): void; recycle(hostId: string): void };
}

function fakeClaw(node: string, running: string[] = []): FakeClaw {
	const { launcher, jvms } = scripted(running);
	const listeners: ((reason: string) => void)[] = [];
	const link: FakeClaw['link'] = {
		lost: null,
		health: null,
		holds: [],
		closed: false,
		silent: 0,
		onLost: (l) => listeners.push(l),
		hold: (ms) => link.holds.push(ms),
		close: () => {
			link.closed = true;
		},
		silentMs: () => link.silent,
		// As `AgentClient.lose`: the link is marked lost, every JVM exits, then the listeners hear it.
		lose(reason) {
			link.lost = reason;
			for (const j of jvms) j.die(reason);
			for (const l of listeners) l(reason);
		},
		recycle(hostId) {
			const health: JvmHealth = { hostId, pid: 1, xmxMb: 1000, rssMb: null, heapUsedMb: 900, heapMaxMb: 1000, gcShare: 0, recycleWanted: true, attached: true };
			link.health = { at: 0, jvms: [health], slice: { cgroup: null, delegated: false, memoryMaxMb: 4096, memoryCurrentMb: null, memoryEvents: {}, cpuStat: {}, cpus: 4 } };
		},
	};
	return { node, jvms, launcher, link };
}

const T0 = Date.parse('2026-10-27T20:00:00Z');

function fleetNode(node: string, extra: Partial<FleetNode> = {}): FleetNode {
	return {
		node,
		reachable: true,
		ok: true,
		findings: [],
		notices: [],
		hosting: { state: 'guaranteed', declared: { memoryMb: 4096, cores: 4, port: 7621 }, observed: { agent: 'listening' }, until: null },
		...extra,
	};
}

interface Rig {
	p: Placement;
	clock: { t: number };
	claws: Map<string, FakeClaw>;
	nodes: FleetNode[];
	/** What fleet answers next: the nodes, or null (could not look). */
	fleetDown: { on: boolean };
	/** Every `hosting-demand` asked, and whether the converger answers as `placement.auto`. */
	demands: { slices: number; releaseOrder: readonly string[] }[];
	converger: { auto: boolean };
	posted: string[];
	logs: Record<string, unknown>[];
	backstopJvms: ScriptedJvm[];
	canary: { result: string | null; runs: string[] };
	warmAll(): void;
	order: string[];
	restored: Map<string, Rec>;
	restorer: Restorer & { outcome: 'snapshot' | 'spec' | null; ended: Set<string> };
}

async function rig(nodes: FleetNode[], opts: { forceFile?: string; takenBack?: Record<string, string[]> } = {}): Promise<Rig> {
	const clock = { t: T0 };
	const cfg = config();
	// A JVM an earlier server left on a claw, with room and no match: its record, as that server wrote it.
	for (const [node, hostIds] of Object.entries(opts.takenBack ?? {})) {
		for (const hostId of hostIds) {
			mkdirSync(join(`${cfg.workDir}-claws`, node, hostId), { recursive: true });
			writeFileSync(join(`${cfg.workDir}-claws`, node, hostId, 'jvm.json'), JSON.stringify({ hostId, startedAt: new Date().toISOString(), matches: [] }));
		}
	}
	const claws = new Map(nodes.map((n) => [n.node, fakeClaw(n.node, opts.takenBack?.[n.node] ?? [])]));
	const fleetDown = { on: false };
	const posted: string[] = [];
	const logs: Record<string, unknown>[] = [];
	const sink: AlertSink = { post: (text) => (posted.push(text), Promise.resolve()) };
	const demands: Rig['demands'] = [];
	const converger = { auto: true };
	const fleet: FleetSource = {
		status: () => Promise.resolve(fleetDown.on ? null : ({ at: clock.t, nodes } satisfies FleetStatus)),
		demand: (slices, releaseOrder) => {
			demands.push({ slices, releaseOrder });
			const answer: FleetDemand = { auto: converger.auto, live: converger.auto, declared: nodes.filter((n) => n.hosting !== null).map((n) => n.node), ending: [], actions: [], blocked: [] };
			return Promise.resolve(answer);
		},
	};
	const backstop = scripted();
	const canary = { result: null as string | null, runs: [] as string[] };
	const order: string[] = [];
	const restored = new Map<string, Rec>();
	const p = placement({
		config: cfg,
		fleet,
		connect: (node) => {
			const claw = claws.get(node);
			if (claw === undefined) return Promise.reject(new Error(`no agent on ${node}`));
			return Promise.resolve({ client: claw.link, launcher: claw.launcher });
		},
		alerts: new Alerts({ sink, now: () => clock.t, log: (e) => logs.push(e) }),
		backstopLauncher: backstop.launcher,
		canary: (node) => {
			canary.runs.push(node);
			return Promise.resolve(canary.result);
		},
		...(opts.forceFile === undefined ? {} : { forceFile: opts.forceFile }),
		timers: false,
		now: () => clock.t,
		log: (e) => logs.push(e),
	});
	const restorer: Rig['restorer'] = {
		outcome: 'snapshot',
		ended: new Set(),
		over: (id) => restorer.ended.has(id),
		restore(id) {
			order.push(`restore ${id}`);
			if (restorer.outcome === null) return null;
			const r = rec(order, `new ${id}`);
			restored.set(id, r);
			p(id, SPEC, r);
			return restorer.outcome === 'snapshot' ? { from: 'snapshot', turn: 3 } : { from: 'spec' };
		},
	};
	p.restoreWith(restorer);
	await p.ready;
	const warmAll = (): void => {
		for (const c of claws.values()) for (const j of c.jvms) if (!j.dead) j.say({ t: 'warm', bootMs: 1, match: j.hostId });
	};
	warmAll();
	return { p, clock, claws, nodes, fleetDown, demands, converger, posted, logs, backstopJvms: backstop.jvms, canary, warmAll, order, restored, restorer };
}

interface Rec extends HostEvents {
	lines: BridgeLine[];
	exits: string[];
	logs: Record<string, unknown>[];
}

function rec(order: string[] = [], name = ''): Rec {
	const r: Rec = {
		lines: [],
		exits: [],
		logs: [],
		line: (l) => r.lines.push(l),
		exit: (reason) => {
			order.push(`exit ${name}`);
			r.exits.push(reason);
		},
		log: (e) => r.logs.push(e),
	};
	return r;
}

/** The scripted JVM a match was started in, by the `start` line it was sent. */
function jvmOf(rig: Rig, matchId: string): { claw: string; jvm: ScriptedJvm } {
	for (const [node, c] of rig.claws) {
		for (const j of c.jvms) if (!j.dead && j.sent.some((s) => s.includes(`"matchId":"${matchId}"`))) return { claw: node, jvm: j };
	}
	for (const j of rig.backstopJvms) if (!j.dead && j.sent.some((s) => s.includes(`"matchId":"${matchId}"`))) return { claw: 'hokon', jvm: j };
	throw new Error(`${matchId} is on no live JVM`);
}

function start(rig: Rig, id: string, r: Rec = rec(rig.order, id)): Rec {
	rig.p(id, SPEC, r);
	return r;
}

function ready(rig: Rig, id: string): void {
	const { jvm } = jvmOf(rig, id);
	jvm.say({ t: 'ready', forgePort: 1, bootMs: 1, seats: [], match: id });
}

const hostOf = (rig: Rig, name: string) => rig.p.hosts().hosts.find((h) => h.name === name)!;

/* ── Rules ── */

describe('eligibility', () => {
	const ok: ClawState = { node: 'claw-9', fleet: fleetNode('claw-9'), agent: { connected: true, silentMs: 0, error: null }, quarantine: null, room: { free: 4, why: null }, aiCutoffs: 0 };
	const failed = (s: ClawState): string[] => bars(s, T0, 6000).filter((b) => !b.ok).map((b) => `${b.bar}: ${b.why}`);

	it('every bar holds: eligible', () => {
		expect(failed(ok)).toEqual([]);
	});

	it('each bar fails on its own, with its reason', () => {
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { reachable: false }) })).toEqual(['fleet: fleet-manager cannot reach it']);
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { hosting: { ...fleetNode('x').hosting!, state: 'pending' } }) })).toEqual(['fleet: its slice is pending, not guaranteed']);
		expect(failed({ ...ok, fleet: null })).toEqual(['fleet: fleet-manager has not reported this node']);
		expect(failed({ ...ok, agent: { connected: false, silentMs: null, error: 'ECONNREFUSED' } })).toEqual(['agent: no agent link: ECONNREFUSED']);
		expect(failed({ ...ok, agent: { connected: true, silentMs: 7000, error: null } })).toEqual(['agent: no heartbeat for 7 s']);
		expect(failed({ ...ok, quarantine: 'failed: jvm exited' })).toEqual(['quarantine: failed: jvm exited']);
		expect(failed({ ...ok, room: { free: 0, why: null } })).toEqual(['room: full']);
		expect(failed({ ...ok, aiCutoffs: 1 })).toEqual(['ai: 1 AI decision cut short in the last 5 min']);
		expect(failed({ ...ok, aiCutoffs: 3 })).toEqual(['ai: 3 AI decisions cut short in the last 5 min']);
	});

	it('a hosting end or reboot inside 30 min fails the notice bar; one further out does not', () => {
		const at = (ms: number) => new Date(T0 + ms).toISOString();
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'ends', at: at(29 * 60_000), kind: 'maintenance' }] }) })).toEqual([
			`notice: ends (maintenance) at ${at(29 * 60_000)}`,
		]);
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'reboot', at: at(31 * 60_000), kind: 'drain' }] }) })).toEqual([]);
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { hosting: { ...fleetNode('x').hosting!, until: at(10 * 60_000) } }) })).toEqual([`notice: the slice ends at ${at(10 * 60_000)}`]);
	});

	it('spreads: the most free room first, and between equals the faster core (claw-8 > claw-9 > claw-5/6)', () => {
		expect(rankClaws([{ node: 'claw-9', free: 2 }, { node: 'claw-5', free: 6 }, { node: 'claw-8', free: 4 }]).map((c) => c.node)).toEqual(['claw-5', 'claw-8', 'claw-9']);
		expect(rankClaws([{ node: 'claw-6', free: 4 }, { node: 'claw-9', free: 4 }, { node: 'claw-8', free: 4 }, { node: 'claw-4', free: 4 }]).map((c) => c.node)).toEqual([
			'claw-8',
			'claw-9',
			'claw-6',
			'claw-4',
		]);
	});

	it('reads the pinned fields of a real node-status as of its generatedAt, and refuses what is not contract 1', () => {
		const doc = (over: object): string =>
			JSON.stringify({
				contract: 1,
				generatedAt: '2026-10-27T19:59:30.000Z',
				cached: true,
				ok: false,
				nodes: [
					{ node: 'claw-1', reachable: true, ok: true, findings: [{ class: 'advisory', category: 'cpu-thermal', why: 'hot' }], notices: [], hosting: null },
					{
						node: 'claw-9',
						reachable: true,
						ok: true,
						findings: [],
						notices: [{ event: 'ends', at: '2026-10-27T20:22:24.196Z', kind: 'maintenance', reason: 'RAM' }],
						hosting: { state: 'guaranteed', declared: { tenant: 'cardtable', memoryMb: 4096, cores: 4, port: 7621 }, until: null, observed: { agent: 'listening', memoryInUseMb: 764, portReach: {} } },
					},
				],
				...over,
			});
		const status = parseNodeStatus(doc({}));
		expect(status?.at).toBe(Date.parse('2026-10-27T19:59:30.000Z'));
		expect(status?.nodes.map((n) => [n.node, n.hosting?.state ?? null, n.hosting?.declared?.memoryMb ?? null, n.notices.length])).toEqual([
			['claw-1', null, null, 0],
			['claw-9', 'guaranteed', 4096, 1],
		]);
		expect(parseNodeStatus('site=… fleet-manager=0.34.109')).toBeNull();
		expect(parseNodeStatus('{"ok":true}')).toBeNull();
		expect(parseNodeStatus(doc({ contract: 2 }))).toBeNull();
		expect(parseNodeStatus(doc({ contract: undefined }))).toBeNull();
		expect(parseNodeStatus(doc({ generatedAt: undefined }))).toBeNull();
	});

	it("counts only our tenant's primary slice: another tenant's, or a standby, is no slice of ours", () => {
		const slice = (declared: object) => ({
			node: 'claw-4',
			reachable: true,
			ok: true,
			findings: [],
			notices: [],
			hosting: { state: 'guaranteed', declared: { memoryMb: 1024, cores: 1, port: 9002, ...declared }, until: null, observed: null },
		});
		const read = (node: object) => parseNodeStatus(JSON.stringify({ contract: 1, generatedAt: '2026-10-28T19:00:00.000Z', nodes: [node] }))?.nodes[0]?.hosting;
		expect(read(slice({ tenant: 'pygmalion' }))).toBeNull();
		expect(read(slice({ tenant: 'cardtable', role: 'standby' }))).toBeNull();
		expect(read(slice({}))).toBeNull();
		expect(read(slice({ tenant: 'cardtable' }))?.declared?.memoryMb).toBe(1024);
		expect(read(slice({ tenant: 'cardtable', role: 'primary' }))?.state).toBe('guaranteed');
	});

	it("reads hosting-demand's answer: auto, live, declared, ending and the last pass", () => {
		const demand = parseDemand(
			JSON.stringify({
				contract: 1,
				ok: true,
				app: 'cardtable',
				demand: 2,
				limits: { min: 1, max: 4 },
				auto: false,
				declared: [
					{ node: 'claw-8', mode: 'shared', memoryMb: 4096, cores: 4 },
					{ node: 'claw-9', mode: 'shared', memoryMb: 4096, cores: 4 },
				],
				ending: [],
				lastPass: { dryRun: true, auto: false, live: false, desired: 1, actions: [], blocked: [{ node: '*', why: 'the release order names 0 serving one(s)', soft: true }] },
			}),
		);
		expect(demand).toEqual({ auto: false, live: false, declared: ['claw-8', 'claw-9'], ending: [], actions: [], blocked: ['the release order names 0 serving one(s)'] });
		expect(parseDemand('{"contract":2,"auto":true}')).toBeNull();
		expect(parseDemand('not json')).toBeNull();
	});
});

describe('the backstop', () => {
	const calm = { fresh: true, declared: 4, reachable: 4, eligible: 3, forced: false };
	const run = (inputs: (typeof calm)[], from: BackstopState = BACKSTOP_IDLE) => {
		let s = from;
		return inputs.map((i) => {
			const step = backstopStep(s, i);
			s = step.state;
			return step.change ?? (s.promoted ? 'up' : 'down');
		});
	};

	it('promotes when no claw is eligible, or under half the declared claws answer; stands down after 3 calm polls', () => {
		expect(run([calm, { ...calm, eligible: 0 }, calm, calm, calm, calm])).toEqual(['down', 'promote', 'up', 'up', 'demote', 'down']);
		expect(run([{ ...calm, reachable: 1 }])).toEqual(['promote']);
		expect(run([{ ...calm, reachable: 2 }])).toEqual(['down']);
		// A storm in the calm resets the count.
		expect(run([{ ...calm, eligible: 0 }, calm, calm, { ...calm, eligible: 0 }, calm, calm, calm])).toEqual(['promote', 'up', 'up', 'up', 'up', 'up', 'demote']);
	});

	it('an unreadable fleet status holds: it neither promotes nor demotes', () => {
		expect(run([{ ...calm, fresh: false, eligible: 0 }])).toEqual(['down']);
		expect(run([{ ...calm, eligible: 0 }, { ...calm, fresh: false }, { ...calm, fresh: false }, { ...calm, fresh: false }, calm])).toEqual(['promote', 'up', 'up', 'up', 'up']);
	});

	it("the operator's force promotes, is time-boxed, and is capped at 6 h from when it was written", () => {
		expect(run([{ ...calm, forced: true }, calm, calm, calm])).toEqual(['promote', 'up', 'up', 'demote']);
		const file = join(scratch, 'force.json');
		writeFileSync(file, JSON.stringify({ until: new Date(Date.now() + 2 * 3600_000).toISOString() }));
		expect(readForce(file, Date.now())?.until).toBeGreaterThan(Date.now() + 3600_000);
		expect(readForce(file, Date.now() + 3 * 3600_000)).toBeNull();
		writeFileSync(file, JSON.stringify({ until: new Date(Date.now() + 24 * 3600_000).toISOString() }));
		expect(readForce(file, Date.now() + 6 * 3600_000 + 1000)).toBeNull();
		writeFileSync(file, '{}');
		expect(readForce(file, Date.now() + 59 * 60_000)).not.toBeNull();
		expect(readForce(file, Date.now() + 61 * 60_000)).toBeNull();
		expect(readForce(join(scratch, 'absent.json'), Date.now())).toBeNull();
	});
});

describe('slice demand', () => {
	const claw = (node: string, live = 0, unusableSince: number | null = null): DemandClaw => ({ node, usable: unusableSince === null, unusableSince, live });
	const input = (claws: DemandClaw[], over: Partial<Parameters<typeof demandStep>[1]> = {}) => ({
		claws,
		live: claws.reduce((n, c) => n + c.live, 0),
		perSlice: 25,
		ceiling: 50,
		short: false,
		now: T0,
		...over,
	});

	it('asks for the next slice once live matches pass 70% of the usable ones, never past the ceiling', () => {
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 17)])).slices).toBe(1);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 18)])).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 25), claw('claw-9', 25)])).slices).toBe(2);
		// A start that found no host asks for one more than is usable.
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 3)], { short: true })).slices).toBe(2);
	});

	it('replaces a claw unusable for 10 min, and keeps its slice for its canary', () => {
		const down = claw('claw-9', 0, T0 - REPLACE_AFTER_MS + 1);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 2), down])).slices).toBe(2);
		const long = claw('claw-9', 0, T0 - REPLACE_AFTER_MS);
		const step = demandStep(DEMAND_IDLE, input([claw('claw-8', 20), long]));
		expect(step.slices).toBe(3);
		expect(step.releaseOrder[0]).toBe('claw-9');
	});

	it('asks for more at once and for fewer only after the calm spell; the first poll starts from what is declared', () => {
		const two = [claw('claw-8', 1), claw('claw-9', 0)];
		let state: DemandState = DEMAND_IDLE;
		const at = (t: number): number => {
			const step = demandStep(state, input(two, { now: t }));
			state = step.state;
			return step.slices;
		};
		expect(at(T0)).toBe(2);
		expect(at(T0 + DEMAND_CALM_MS - 1)).toBe(2);
		expect(at(T0 + DEMAND_CALM_MS)).toBe(1);
		// A poll that wants more breaks the spell.
		state = { slices: 2, lowSince: T0 };
		expect(demandStep(state, input([claw('claw-8', 18), claw('claw-9', 0)], { now: T0 + 60_000 })).state).toEqual({ slices: 2, lowSince: null });
	});

	it('ends unusable claws first, then the emptiest, then the slowest core', () => {
		const order = demandStep(DEMAND_IDLE, input([claw('claw-8', 0), claw('claw-9', 0), claw('claw-4', 3), claw('claw-6', 0, T0 - 1)])).releaseOrder;
		expect(order).toEqual(['claw-6', 'claw-9', 'claw-8', 'claw-4']);
	});

	it('every poll that read fleet status restates the count with its release order; one that could not look asks nothing', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		expect(r.demands.at(-1)).toEqual({ slices: 2, releaseOrder: ['claw-9', 'claw-8'] });
		start(r, 'm-1');
		await r.p.poll();
		expect(r.demands.at(-1)?.releaseOrder).toEqual(['claw-9', 'claw-8']);
		expect(r.p.hosts().slices).toMatchObject({ asked: 2, converger: { auto: true, declared: ['claw-9', 'claw-8'] } });
		const asked = r.demands.length;
		r.fleetDown.on = true;
		await r.p.poll();
		expect(r.demands).toHaveLength(asked);
	});

	it('a dry-run converger: the Capacity alert says declaring is the operator\'s call', async () => {
		const r = await rig([fleetNode('claw-9')]);
		r.converger.auto = false;
		await r.p.poll();
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) start(r, id);
		expect(() => start(r, 'm-5')).toThrow(/no Forge host/);
		expect(r.posted.at(-1)).toMatch(/its converger only plans \(no placement\.auto\), so declaring another is the operator's call\.$/);
		// The next poll asks for one more than is usable.
		await r.p.poll();
		expect(r.demands.at(-1)?.slices).toBe(2);
	});
});

describe('alerts', () => {
	const make = (sink: AlertSink | null) => {
		const clock = { t: T0 };
		const logs: Record<string, unknown>[] = [];
		return { clock, logs, alerts: new Alerts({ sink, now: () => clock.t, log: (e) => logs.push(e) }) };
	};

	it('one message per incident, a ✅ when it resolves, and a flapping key is not posted again inside the repeat window', () => {
		const posted: string[] = [];
		const { clock, alerts } = make({ post: (t) => (posted.push(t), Promise.resolve()) });
		expect(alerts.fire('failover:claw-9', '🚨 one')).toBe(true);
		expect(alerts.fire('failover:claw-9', '🚨 two')).toBe(false);
		clock.t += 60_000;
		expect(alerts.resolve('failover:claw-9', 'Recovered')).toBe(true);
		expect(posted).toEqual(['🚨 one', '✅ Recovered (open 60 s)']);
		clock.t += 60_000;
		expect(alerts.fire('failover:claw-9', '🚨 three')).toBe(false);
		// Its resolution is quiet too: nothing was posted for it.
		expect(alerts.resolve('failover:claw-9', 'Recovered')).toBe(false);
		clock.t += 10 * 60_000;
		expect(alerts.fire('failover:claw-9', '🚨 four')).toBe(true);
		expect(posted).toEqual(['🚨 one', '✅ Recovered (open 60 s)', '🚨 four']);
	});

	it('with no webhook: logged, never posted, and said once', () => {
		const { alerts, logs } = make(null);
		alerts.fire('a', 'x');
		alerts.fire('b', 'y');
		expect(logs.filter((l) => l.evt === 'alerts-off')).toHaveLength(1);
		expect(logs.filter((l) => l.evt === 'alert').map((l) => l.key)).toEqual(['a', 'b']);
	});
});

/* ── The coordinator ── */

describe('placement', () => {
	it('spreads matches across eligible claws, never onto hokon while the claws serve', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) start(r, id);
		expect(['m-1', 'm-2', 'm-3', 'm-4'].map((id) => jvmOf(r, id).claw)).toEqual(['claw-8', 'claw-9', 'claw-8', 'claw-9']);
		expect(r.backstopJvms).toEqual([]);
		expect(hostOf(r, 'hokon').eligible).toBe(false);
	});

	it('admission control: with no eligible host a start waits (`full`), one Capacity alert names the next slice, and it resolves once a match is placed', async () => {
		const r = await rig([fleetNode('claw-9')]);
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) start(r, id);
		// claw-9 is full, and hokon is promoted only by a poll.
		expect(r.p.room()).toBe('full');
		expect(() => start(r, 'm-5')).toThrow(/no Forge host can take a match now \(claw-9: room \(full\); hokon: not promoted/);
		await vi.waitFor(() => expect(r.posted.filter((t) => t.startsWith('⚠️ Capacity'))).toHaveLength(1));
		expect(r.posted[0]).toMatch(/fleet-manager has 1 declared for us; the next poll asks for more\.$/);
		// The incident is open: asking again posts nothing.
		r.p.room();
		expect(r.logs.filter((l) => l.evt === 'alert' && l.key === 'capacity')).toHaveLength(1);
		// A poll sees no eligible claw and promotes hokon, which takes the next start.
		await r.p.poll();
		expect(r.posted.some((t) => t.startsWith('🔺 hokon promoted to the Forge backstop: no claw is eligible'))).toBe(true);
		expect(r.p.room()).not.toBe('full');
		start(r, 'm-5');
		expect(jvmOf(r, 'm-5').claw).toBe('hokon');
		expect(r.posted.at(-1)).toMatch(/^✅ Capacity: Forge matches are being placed again/);
	});

	it('hokon stands down after 3 calm polls and keeps its live matches', async () => {
		const r = await rig([fleetNode('claw-9')]);
		r.nodes[0] = fleetNode('claw-9', { reachable: false });
		await r.p.poll();
		start(r, 'm-1');
		expect(jvmOf(r, 'm-1').claw).toBe('hokon');
		r.nodes[0] = fleetNode('claw-9');
		r.fleetDown.on = true;
		await r.p.poll();
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(true);
		r.fleetDown.on = false;
		await r.p.poll();
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(true);
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(false);
		expect(r.posted.at(-1)).toMatch(/^🔻 hokon stood down as the Forge backstop: calm for 3 polls/);
		expect(hostOf(r, 'hokon').matches).toEqual(['m-1']);
		start(r, 'm-2');
		expect(jvmOf(r, 'm-2').claw).toBe('claw-9');
	});

	it('a heap that wants recycling takes no new match, and its JVM retires once empty', async () => {
		const r = await rig([fleetNode('claw-9')]);
		start(r, 'm-1');
		const { jvm } = jvmOf(r, 'm-1');
		r.claws.get('claw-9')!.link.recycle(jvm.hostId);
		r.p.tick();
		start(r, 'm-2');
		expect(jvmOf(r, 'm-2').jvm).not.toBe(jvm);
		expect(hostOf(r, 'claw-9').jvms.find((j) => j.hostId === jvm.hostId)?.draining).toBe(true);
	});

	it('a hosting end inside 30 min: no new match there at once', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[1] = fleetNode('claw-8', { notices: [{ event: 'ends', at: new Date(T0 + 20 * 60_000).toISOString(), kind: 'maintenance' }] });
		await r.p.poll();
		for (const id of ['m-1', 'm-2', 'm-3']) start(r, id);
		expect(['m-1', 'm-2', 'm-3'].map((id) => jvmOf(r, id).claw)).toEqual(['claw-9', 'claw-9', 'claw-9']);
		expect(hostOf(r, 'claw-8').bars.find((b) => b.bar === 'notice')?.ok).toBe(false);
	});
});

describe('AI degraded', () => {
	const aiPosts = (r: Rig): string[] => r.posted.filter((t) => t.includes('AI degraded') || t.includes('AI clean'));

	it('one cutoff fails the claw\'s ai bar at once with one ⚠️, moves nothing, and a clean window posts the ✅ and opens it again', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		start(r, 'm-1');
		start(r, 'm-2');
		expect(['m-1', 'm-2'].map((id) => jvmOf(r, id).claw)).toEqual(['claw-8', 'claw-9']);
		const { jvm } = jvmOf(r, 'm-1');
		expect(hostOf(r, 'claw-8').bars.find((b) => b.bar === 'ai')).toEqual({ bar: 'ai', ok: true, why: '' });

		jvm.say({ t: 'cutoff', where: 'AiController.chooseSpellAbilityToPlayFromList', match: 'm-1' });
		expect(aiPosts(r)).toEqual([
			'⚠️ AI degraded: claw-8 — Forge cut an AI decision short (m-1, in AiController.chooseSpellAbilityToPlayFromList), so its AI is playing its best guess, not its best move. It takes no new match until 5 min pass without one.',
		]);
		expect(hostOf(r, 'claw-8').bars.filter((b) => !b.ok)).toEqual([{ bar: 'ai', ok: false, why: '1 AI decision cut short in the last 5 min' }]);
		// Equal room would send the next start to claw-8, the faster core; it goes to claw-9.
		start(r, 'm-3');
		expect(jvmOf(r, 'm-3').claw).toBe('claw-9');
		// One incident: a second cutoff, this one the JVM's own, posts nothing more.
		r.clock.t += 60_000;
		jvm.say({ t: 'cutoff', match: jvm.hostId });
		expect(aiPosts(r)).toHaveLength(1);
		expect(r.logs.filter((l) => l.evt === 'host-ai-cutoff').map((l) => [l.host, l.matchId, l.recent])).toEqual([
			['claw-8', 'm-1', 1],
			['claw-8', null, 2],
		]);
		// Nothing moved, and the match never saw the line.
		expect(jvmOf(r, 'm-1').claw).toBe('claw-8');
		expect(r.order).toEqual([]);

		// The window runs from the LAST cutoff.
		r.clock.t += 5 * 60_000 - 1;
		r.p.tick();
		expect(aiPosts(r)).toHaveLength(1);
		r.clock.t += 1;
		r.p.tick();
		expect(aiPosts(r).at(-1)).toBe('✅ AI clean: claw-8 — no AI decision cut short for 5 min (open 360 s)');
		expect(hostOf(r, 'claw-8').eligible).toBe(true);
		start(r, 'm-4');
		expect(jvmOf(r, 'm-4').claw).toBe('claw-8');

		// It flaps back inside the repeat window: the bar fails again, and nothing more is posted.
		jvm.say({ t: 'cutoff', match: 'm-1' });
		expect(hostOf(r, 'claw-8').eligible).toBe(false);
		expect(aiPosts(r)).toHaveLength(2);
	});

	it('hokon as the backstop takes nothing new while its AI is cut short, and says why', async () => {
		const r = await rig([fleetNode('claw-9')]);
		r.nodes[0] = fleetNode('claw-9', { reachable: false });
		await r.p.poll();
		start(r, 'm-1');
		const { claw, jvm } = jvmOf(r, 'm-1');
		expect(claw).toBe('hokon');
		jvm.say({ t: 'cutoff', match: 'm-1' });
		expect(aiPosts(r)).toEqual([
			'⚠️ AI degraded: hokon — Forge cut an AI decision short (m-1), so its AI is playing its best guess, not its best move. It takes no new match until 5 min pass without one.',
		]);
		expect(r.p.room()).toBe('full');
		expect(() => start(r, 'm-2')).toThrow(/hokon: promoted, ai \(1 AI decision cut short in the last 5 min\)/);
		r.clock.t += 5 * 60_000;
		r.p.tick();
		expect(aiPosts(r).at(-1)).toMatch(/^✅ AI clean: hokon/);
		start(r, 'm-2');
		expect(jvmOf(r, 'm-2').claw).toBe('hokon');
	});

	it('the last eligible claw degrading promotes hokon at once, without waiting for a poll', async () => {
		const r = await rig([fleetNode('claw-9')]);
		start(r, 'm-1');
		jvmOf(r, 'm-1').jvm.say({ t: 'cutoff', match: 'm-1' });
		expect(r.p.hosts().backstop).toMatchObject({ promoted: true, why: 'no claw is eligible' });
		start(r, 'm-2');
		expect(jvmOf(r, 'm-2').claw).toBe('hokon');
	});
});

describe('failover', () => {
	it('a lost JVM fails the claw: every match restored elsewhere BEFORE its old self is failed, the claw quarantined, one alert listing all', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) start(r, id);
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) ready(r, id);
		// m-1 and m-3 are on claw-8; m-2 and m-4 on claw-9, in one JVM.
		const { jvm } = jvmOf(r, 'm-2');
		expect(jvmOf(r, 'm-4').jvm).toBe(jvm);
		r.order.length = 0;
		jvm.die('the JVM exited with code 137');
		expect(r.order).toEqual(['restore m-2', 'exit m-2', 'restore m-4', 'exit m-4']);
		expect(jvmOf(r, 'm-2').claw).toBe('claw-8');
		expect(jvmOf(r, 'm-4').claw).toBe('claw-8');
		expect(hostOf(r, 'claw-9').quarantine?.cause).toBe('the JVM exited with code 137');
		expect(hostOf(r, 'claw-9').eligible).toBe(false);
		// Every JVM still on the claw was killed: the fence.
		expect(r.claws.get('claw-9')!.jvms.every((j) => j.dead)).toBe(true);
		const failovers = r.posted.filter((t) => t.startsWith('🚨 Failover'));
		expect(failovers).toHaveLength(1);
		expect(failovers[0]).toMatch(/^🚨 Failover: claw-9 — the JVM exited with code 137\. Moved 2: m-2 → claw-8 \(restored at the start of turn 3, 0 ms\); m-4 → claw-8 .* until-end-of-turn effects.* claw-9 is quarantined/);
		// A line the old JVM still says for a moved match is dropped.
		const before = r.restored.get('m-2')!.lines.length;
		jvm.say({ t: 'frame', seat: 0, frame: {}, match: 'm-2' });
		expect(r.restored.get('m-2')!.lines.length).toBe(before);
	});

	it('never restores onto the claw that failed: the last claw down promotes hokon first, and what hokon cannot take is lost, with a Match lost alert', async () => {
		const r = await rig([fleetNode('claw-9')]);
		for (const id of ['m-1', 'm-2', 'm-3']) start(r, id);
		for (const id of ['m-1', 'm-2', 'm-3']) ready(r, id);
		jvmOf(r, 'm-1').jvm.die('gone');
		expect(r.order).toEqual(['restore m-1', 'exit m-1', 'restore m-2', 'exit m-2', 'exit m-3']);
		expect(jvmOf(r, 'm-1').claw).toBe('hokon');
		expect(jvmOf(r, 'm-2').claw).toBe('hokon');
		expect(r.posted[0]).toMatch(/^🔺 hokon promoted to the Forge backstop: no claw is eligible/);
		expect(r.posted[1]).toMatch(/^🚨 Failover: claw-9 — gone\. Moved 2: m-1 → hokon .*; m-2 → hokon/);
		expect(r.posted[2]).toBe(
			'🚨 Match lost: 1 on claw-9 — gone: m-3 (no host can take it). claw-9 is quarantined until fleet-manager reports it healthy and a canary match passes on it.',
		);
	});

	it('a match that never started is placed again on another claw, under the same Match', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		const m = start(r, 'm-1');
		const first = jvmOf(r, 'm-1');
		first.jvm.die('boot failed');
		const second = jvmOf(r, 'm-1');
		expect(second.claw).not.toBe(first.claw);
		expect(m.exits).toEqual([]);
		expect(r.order).toEqual([]);
		second.jvm.say({ t: 'ready', forgePort: 1, bootMs: 1, seats: [], match: 'm-1' });
		expect(m.lines.map((l) => l.t)).toEqual(['ready']);
	});

	it('a match-level fatal fails the claw over; the same match failing again is lost without blaming the second claw', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		start(r, 'm-1');
		start(r, 'm-2');
		ready(r, 'm-1');
		ready(r, 'm-2');
		const a = jvmOf(r, 'm-1');
		a.jvm.say({ t: 'fatal', message: 'NullPointerException in the game thread', match: 'm-1' });
		expect(hostOf(r, a.claw).quarantine?.cause).toBe('a match failed on it: NullPointerException in the game thread');
		const b = jvmOf(r, 'm-1');
		expect(b.claw).not.toBe(a.claw);
		ready(r, 'm-1');
		b.jvm.say({ t: 'fatal', message: 'NullPointerException in the game thread', match: 'm-1' });
		expect(hostOf(r, b.claw).quarantine).toBeNull();
		expect(r.posted.at(-1)).toMatch(/^🚨 Match lost: m-1 on claw-\d: a match failed on it: .*it failed again after a move/);
	});

	it('restore unavailable or impossible: the match ends with a plain reason', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.restorer.outcome = null;
		const m = start(r, 'm-1');
		ready(r, 'm-1');
		jvmOf(r, 'm-1').jvm.die('gone');
		expect(m.exits).toEqual(['the match was lost: gone, and it could not be restored']);
	});

	it('a finished game on a failed claw is ended, never played again from its last turn start', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		const m = start(r, 'm-1');
		ready(r, 'm-1');
		r.restorer.ended.add('m-1');
		jvmOf(r, 'm-1').jvm.die('the JVM exited with code 137');
		expect(r.order).toEqual(['exit m-1']);
		expect(m.exits).toEqual(['its game was over, and its host failed: the JVM exited with code 137']);
		expect(r.posted.join('\n')).not.toContain('m-1');
	});

	it('a fenced JVM fails no claw: its match is restored into a fresh JVM, never one taken back from the earlier server', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')], { takenBack: { 'claw-9': ['h-old-9'], 'claw-8': ['h-old-8'] } });
		start(r, 'm-1');
		ready(r, 'm-1');
		const first = jvmOf(r, 'm-1');
		expect(['h-old-9', 'h-old-8']).toContain(first.jvm.hostId);
		const cause = 'fenced: no word from the coordinator for 11 s (window 10 s)';
		first.jvm.die(cause);
		expect(r.order).toEqual(['restore m-1', 'exit m-1']);
		const second = jvmOf(r, 'm-1');
		expect(['h-old-9', 'h-old-8']).not.toContain(second.jvm.hostId);
		expect(hostOf(r, 'claw-9').quarantine).toBeNull();
		expect(hostOf(r, 'claw-8').quarantine).toBeNull();
		await Promise.resolve();
		expect(r.posted).toHaveLength(1);
		expect(r.posted[0]).toMatch(/^🔁 Fenced: claw-\d — fenced: no word from the coordinator .* stays in service\. Moved 1: m-1 → claw-\d \(restored at the start of turn 3/);
	});

	it('an agent silent past the window with no match on it: a heartbeat-lost alert and quarantine, then back after a healthy status and a canary', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.claws.get('claw-9')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted).toEqual([
			'⚠️ Claw heartbeat lost: claw-9 — agent heartbeat lost for 11 s (window 10 s). No match was on it. Quarantined until a healthy status and a canary.',
		]);
		expect(hostOf(r, 'claw-9').eligible).toBe(false);
		// The agent is back; a status read after the failure, then a canary that fails, then one that passes.
		r.claws.set('claw-9', fakeClaw('claw-9'));
		r.canary.result = 'no frame within 120 s';
		r.clock.t += 1000;
		await r.p.poll();
		expect(r.canary.runs).toEqual(['claw-9']);
		expect(hostOf(r, 'claw-9').quarantine?.canary).toBe('no frame within 120 s');
		r.canary.result = null;
		r.clock.t += 60_000;
		await r.p.poll();
		expect(r.canary.runs).toEqual(['claw-9']);
		r.clock.t += 5 * 60_000;
		await r.p.poll();
		expect(r.canary.runs).toEqual(['claw-9', 'claw-9']);
		expect(hostOf(r, 'claw-9').quarantine).toBeNull();
		expect(r.posted.at(-1)).toMatch(/^✅ Recovered: claw-9 passed its canary and takes matches again/);
	});

	it('a quarantined claw takes no canary until fleet-manager has reported it since the failure', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		start(r, 'm-1');
		ready(r, 'm-1');
		const { claw, jvm } = jvmOf(r, 'm-1');
		jvm.die('gone');
		r.fleetDown.on = true;
		r.clock.t += 1000;
		await r.p.poll();
		expect(r.canary.runs).toEqual([]);
		r.nodes[r.nodes.findIndex((n) => n.node === claw)] = fleetNode(claw, { reachable: false });
		r.fleetDown.on = false;
		await r.p.poll();
		expect(r.canary.runs).toEqual([]);
		r.nodes[r.nodes.findIndex((n) => n.node === claw)] = fleetNode(claw);
		await r.p.poll();
		expect(r.canary.runs).toEqual([claw]);
	});

	it('agent lost with matches: one failover for the claw, not one per JVM', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		for (const id of ['m-1', 'm-2', 'm-3']) start(r, id);
		for (const id of ['m-1', 'm-2', 'm-3']) ready(r, id);
		r.claws.get('claw-8')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted.filter((t) => t.startsWith('🚨'))).toHaveLength(1);
		expect(r.posted[0]).toMatch(/^🚨 Failover: claw-8 — agent heartbeat lost .* Moved 2: m-1 → claw-9 .*; m-3 → claw-9/);
		expect(r.posted.some((t) => t.startsWith('⚠️ Claw heartbeat lost'))).toBe(false);
	});
});

describe('planned moves', () => {
	it('5 min before a hosting end, each match moves at its next turn start (its snapshot)', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		start(r, 'm-1');
		ready(r, 'm-1');
		const from = jvmOf(r, 'm-1');
		const idx = r.nodes.findIndex((n) => n.node === from.claw);
		r.nodes[idx] = fleetNode(from.claw, { notices: [{ event: 'reboot', at: new Date(T0 + 4 * 60_000).toISOString(), kind: 'drain' }] });
		await r.p.poll();
		expect(r.order).toEqual([]);
		from.jvm.say({ t: 'snapshot', turn: 4, state: '…', match: 'm-1' });
		expect(r.order).toEqual(['restore m-1']);
		expect(jvmOf(r, 'm-1').claw).not.toBe(from.claw);
		expect(hostOf(r, from.claw).quarantine).toBeNull();
		expect(r.posted.filter((t) => t.startsWith('🚨'))).toEqual([]);
	});
});

describe('restart grace', () => {
	it('going down asks every agent to hold its JVMs for the grace, before the links close', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		start(r, 'm-1');
		r.p.close();
		r.p.reapOnExit();
		for (const c of r.claws.values()) {
			expect(c.link.holds).toEqual([90_000]);
			expect(c.link.closed).toBe(true);
		}
	});
});

mkdirSync(join(scratch, 'res'), { recursive: true });
