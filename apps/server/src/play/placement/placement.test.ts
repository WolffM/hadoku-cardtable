/**
 * Placement, failover and alerts over real `jvmHostFactory` pools, with scripted launchers for the
 * claws (no JVM), fake agent links, a fake fleet and a fake clock.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { BridgeLine, HostEvents, JvmHostConfig, MatchSpec } from '../host.js';
import { PLAYED_OUT } from '../host.js';
import type { JvmLauncher, JvmTransport } from '../jvm-transport.js';
import type { JvmHealth, ToAgent } from '../remote/wire.js';
import { Alerts, type AlertSink } from './alerts.js';
import { contractViolations } from './audit.js';
import { CONTRACT, contractOf } from './contract.js';
import { CONTRACT_HOLD_MS, NOTICE_SLACK_MS, placement, type AgentLink, type Placement, type Restorer } from './coordinator.js';
import { ClawDraftbots } from './draftbot.js';
import type { FleetDemand, FleetNode, FleetSource, FleetStatus } from './fleet.js';
import { BOOT_STATUS_MAX_AGE_S, CHECKOUT_FLEET_CLI, MGMT_API_FLEET_CLI, PRIMED_MAX_AGE_MS, STATUS_MAX_AGE_S, fleetCli, fleetCliPath, parseDemand, parseNodeStatus, primeFleet } from './fleet.js';
import {
	BACKSTOP_IDLE,
	DEMAND_CALM_MS,
	DEMAND_IDLE,
	HOST_ORDER,
	backstopStep,
	bars,
	demandStep,
	inUse,
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
	link: AgentLink & { sent: ToAgent[]; holds: number[]; closed: boolean; silent: number; lose(reason: string): void; recycle(hostId: string): void; beat(): void };
}

const SLICE = { cgroup: null, delegated: false, memoryMaxMb: 4096, memoryCurrentMb: null, memoryEvents: {}, cpuStat: {}, cpus: 4 };

function fakeClaw(node: string, running: string[] = []): FakeClaw {
	const { launcher, jvms } = scripted(running);
	const listeners: ((reason: string) => void)[] = [];
	const link: FakeClaw['link'] = {
		lost: null,
		health: null,
		sent: [],
		holds: [],
		closed: false,
		silent: 0,
		onLost: (l) => listeners.push(l),
		hold: (ms) => link.holds.push(ms),
		close: () => {
			link.closed = true;
		},
		silentMs: () => link.silent,
		send: (m) => void link.sent.push(m),
		call: () => Promise.reject(new Error('no agent behind a fake link')),
		// As `AgentClient.lose`: the link is marked lost, every JVM exits, then the listeners hear it.
		lose(reason) {
			link.lost = reason;
			for (const j of jvms) j.die(reason);
			for (const l of listeners) l(reason);
		},
		recycle(hostId) {
			const health: JvmHealth = { hostId, pid: 1, xmxMb: 1000, rssMb: null, heapUsedMb: 900, heapMaxMb: 1000, gcShare: 0, recycleWanted: true, attached: true };
			link.health = { at: 0, jvms: [health], slice: SLICE, draftbot: null };
		},
		beat() {
			link.health = { at: 0, jvms: [], slice: SLICE, draftbot: null };
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
	/** The converger's answer: `unplaceable` is its verdict on our slices, which it counts out of `serving`. */
	converger: { auto: boolean; ending: string[]; unplaceable: FleetDemand['unplaceable']; blocked: string[] };
	posted: string[];
	logs: Record<string, unknown>[];
	backstopJvms: ScriptedJvm[];
	canary: { result: string | null; runs: string[] };
	warmAll(): void;
	order: string[];
	restored: Map<string, Rec>;
	restorer: Restorer & { outcome: 'snapshot' | 'spec' | null; ended: Set<string> };
}

async function rig(
	nodes: FleetNode[],
	opts: { forceFile?: string; takenBack?: Record<string, string[]>; runtime?: Record<string, Promise<unknown>>; draftbot?: Record<string, Promise<string>> } = {},
): Promise<Rig> {
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
	const converger: Rig['converger'] = { auto: true, ending: [], unplaceable: [], blocked: [] };
	const fleet: FleetSource = {
		status: () => Promise.resolve(fleetDown.on ? null : ({ at: clock.t, nodes } satisfies FleetStatus)),
		demand: (slices, releaseOrder) => {
			demands.push({ slices, releaseOrder });
			const declared = nodes.filter((n) => n.hosting !== null).map((n) => n.node);
			const answer: FleetDemand = {
				auto: converger.auto,
				live: converger.auto,
				declared,
				ending: [...converger.ending],
				actions: [],
				blocked: [...converger.blocked],
				demanded: slices,
				serving: declared.filter((n) => !converger.ending.includes(n) && !converger.unplaceable.some((u) => u.node === n)),
				unplaceable: [...converger.unplaceable],
				declaredMb: Object.fromEntries(declared.map((n) => [n, 4096])),
				minNodes: null,
				servingUnits: null,
			};
			return Promise.resolve(answer);
		},
	};
	const backstop = scripted();
	const canary = { result: null as string | null, runs: [] as string[] };
	const order: string[] = [];
	const restored = new Map<string, Rec>();
	const p = placement({
		config: cfg,
		// The coordinator on its own: two slices, whatever hosting.json says today.
		contract: { ...CONTRACT, min: 2 },
		draftbots: (deps) => new ClawDraftbots(deps),
		fleet,
		connect: (node) => {
			const claw = claws.get(node);
			if (claw === undefined) return Promise.reject(new Error(`no agent on ${node}`));
			const runtime = opts.runtime?.[node];
			const draftbot = opts.draftbot?.[node];
			return Promise.resolve({ client: claw.link, launcher: claw.launcher, ...(runtime === undefined ? {} : { runtime }), ...(draftbot === undefined ? {} : { draftbot }) });
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
		expect(failed({ ...ok, agent: { connected: true, silentMs: 0, error: 'claw-9 cannot be given this server\'s pin: disk full' } })).toEqual(["agent: claw-9 cannot be given this server's pin: disk full"]);
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
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'starts', at: at(31 * 60_000), kind: 'reboot' }] }) })).toEqual([]);
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { hosting: { ...fleetNode('x').hosting!, until: at(10 * 60_000) } }) })).toEqual([`notice: the slice ends at ${at(10 * 60_000)}`]);
	});

	it('a reboot under way fails the notice bar until fleet-manager lifts its drain, though the drain lapses hours out', () => {
		const at = (ms: number) => new Date(T0 + ms).toISOString();
		// Past its start fleet-manager lists only the drain's lapse, 2 h out: that alone passed the bar on
		// 2026-11-03, so claw-8 was placeable again from 21:47:38Z until it went down at 21:49:14Z.
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'ends', at: at(2 * 3600_000), kind: 'reboot' }] }) })).toEqual([
			`notice: a reboot is under way (its window ends at ${at(2 * 3600_000)})`,
		]);
		// A cached read can still list a start that has passed.
		expect(
			failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'starts', at: at(-1000), kind: 'reboot' }, { event: 'ends', at: at(2 * 3600_000), kind: 'reboot' }] }) }),
		).toEqual([`notice: a reboot is under way (its window ends at ${at(2 * 3600_000)})`]);
		// Before its start it is a notice like any other.
		expect(
			failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'starts', at: at(15 * 60_000), kind: 'reboot' }, { event: 'ends', at: at(2 * 3600_000 + 15 * 60_000), kind: 'reboot' }] }) }),
		).toEqual([`notice: starts (reboot) at ${at(15 * 60_000)}`]);
		// Any other drain's lapse, hours out, is not one.
		expect(failed({ ...ok, fleet: fleetNode('claw-9', { notices: [{ event: 'ends', at: at(2 * 3600_000), kind: 'maintenance' }] }) })).toEqual([]);
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

	it("reads hosting-demand's answer: auto, live, declared, ending, the count we asked for and the last pass's serving and unplaceable", () => {
		const demand = parseDemand(
			JSON.stringify({
				contract: 1,
				ok: true,
				app: 'cardtable',
				demand: { slices: 2, releaseOrder: ['claw-10', 'claw-5', 'claw-9', 'claw-8'], since: '2026-11-04T18:15:02.767Z', askedAt: '2026-11-04T18:50:10.154Z', by: 'hadoku' },
				limits: { min: 2, max: 4 },
				auto: false,
				declared: [
					{ node: 'claw-5', mode: 'shared', memoryMb: 4096, cores: 4 },
					{ node: 'claw-8', mode: 'shared', memoryMb: 4096, cores: 4 },
				],
				ending: [],
				lastPass: {
					dryRun: true,
					auto: false,
					live: false,
					desired: 2,
					serving: ['claw-5'],
					unplaceable: [{ node: 'claw-8', why: 'fails "not-beside-unbounded"', reachable: true }],
					actions: [],
					blocked: [{ node: '*', why: 'the release order names 0 serving one(s)', soft: true }],
				},
			}),
		);
		expect(demand).toEqual({
			auto: false,
			live: false,
			declared: ['claw-5', 'claw-8'],
			ending: [],
			actions: [],
			blocked: ['the release order names 0 serving one(s)'],
			demanded: 2,
			serving: ['claw-5'],
			unplaceable: [{ node: 'claw-8', why: 'fails "not-beside-unbounded"', reachable: true }],
			declaredMb: { 'claw-5': 4096, 'claw-8': 4096 },
			minNodes: null,
			servingUnits: null,
		});
		expect(parseDemand('{"contract":2,"auto":true}')).toBeNull();
		expect(parseDemand('not json')).toBeNull();
	});

	it('finds our slice among a node\'s tenants, wherever it sits; `hosting` is only the oldest', () => {
		const slice = (tenant: string) => ({ state: 'guaranteed', declared: { tenant, memoryMb: 4096, cores: 4, port: 7621 }, until: null, observed: null });
		const read = (node: object) => parseNodeStatus(JSON.stringify({ contract: 1, generatedAt: '2026-10-31T17:54:00.000Z', nodes: [{ node: 'claw-4', reachable: true, ok: true, ...node }] }))?.nodes[0]?.hosting;
		expect(read({ hosting: slice('pygmalion'), tenants: [slice('pygmalion'), slice('cardtable')] })?.state).toBe('guaranteed');
		expect(read({ hosting: slice('pygmalion'), tenants: [slice('pygmalion')] })).toBeNull();
		// A fleet-manager from before `tenants`.
		expect(read({ hosting: slice('cardtable') })?.state).toBe('guaranteed');
	});

	it("reads the fleet through mgmt-api's install by default; CARDTABLE_FLEET_CLI overrides; a missing install falls back to the checkout, loudly", async () => {
		expect(MGMT_API_FLEET_CLI).toMatch(/\/srv\/hadoku_site\/services\/mgmt-api\/node_modules\/@wolffm\/fleet-manager\/dist\/cli\.js$/);
		expect(fleetCliPath({}, (p) => p === MGMT_API_FLEET_CLI)).toEqual({ cli: MGMT_API_FLEET_CLI, fallback: null });
		expect(fleetCliPath({ CARDTABLE_FLEET_CLI: '/x/cli.js' }, () => true)).toEqual({ cli: '/x/cli.js', fallback: null });
		const missing = fleetCliPath({}, () => false);
		expect(missing.cli).toBe(CHECKOUT_FLEET_CLI);
		expect(missing.fallback).toMatch(/mgmt-api's fleet-manager install is missing/);
		// fleetCli says so in its log.
		const logs: Record<string, unknown>[] = [];
		const cli = join(scratch, 'fake-fleet-cli.mjs');
		writeFileSync(cli, 'process.stdout.write(process.argv[2])');
		fleetCli({ env: { CARDTABLE_FLEET_CLI: cli }, log: (e) => logs.push(e) });
		expect(logs).toEqual([]);
	});

	it('an unreadable answer is logged with the document\'s own reason, not a blanket "not contract 1"', async () => {
		const logs: Record<string, unknown>[] = [];
		const cli = join(scratch, 'refusing-fleet-cli.mjs');
		writeFileSync(
			cli,
			`const cmd = process.argv[2];
process.stdout.write(cmd === 'hosting-demand'
	? JSON.stringify({ contract: 1, ok: false, app: 'cardtable', at: '2026-10-31T07:00:00Z', reason: 'cannot read fleet state: EACCES' })
	: cmd === 'node-status' ? JSON.stringify({ contract: 2, ok: true }) : 'fleet-manager=0.34.109');
process.exit(1);`,
		);
		const fleet = fleetCli({ env: { CARDTABLE_FLEET_CLI: cli }, log: (e) => logs.push(e) });
		expect(await fleet.demand(2, ['claw-5'])).toBeNull();
		expect(await fleet.status()).toBeNull();
		expect(logs).toEqual([
			{ evt: 'fleet-unreadable', args: 'hosting-demand', error: 'cannot read fleet state: EACCES' },
			{ evt: 'fleet-unreadable', args: 'node-status', error: 'contract 2, not 1' },
		]);
	});
});

describe('the backstop', () => {
	const calm = { fresh: true, eligible: 2, forced: false };
	const out = { ...calm, eligible: 0 };
	const run = (inputs: (typeof calm)[], from: BackstopState = BACKSTOP_IDLE) => {
		let s = from;
		return inputs.map((i) => {
			const step = backstopStep(s, i);
			s = step.state;
			return step.change ?? (s.promoted ? 'up' : 'down');
		});
	};

	it("fleet-manager's rule: hokon comes up at once when no claw can take a match, and stands down as soon as one can", () => {
		expect(run([calm, out, out, calm, calm])).toEqual(['down', 'promote', 'up', 'demote', 'down']);
		expect(backstopStep(BACKSTOP_IDLE, out).state.why).toBe('no claw can take a match');
		expect(backstopStep({ promoted: true, why: '' }, { ...calm, eligible: 1 }).state.why).toBe('1 claw can take matches again');
		// Fewer claws than slices.min is the converger's shortfall to replace, not a trigger.
		expect(run([{ ...calm, eligible: 1 }, { ...calm, eligible: 1 }])).toEqual(['down', 'down']);
	});

	it('an unreadable fleet status holds: it neither promotes nor demotes', () => {
		expect(run([{ ...out, fresh: false }, { ...out, fresh: false }])).toEqual(['down', 'down']);
		expect(run([out, { ...calm, fresh: false }, calm])).toEqual(['promote', 'up', 'demote']);
	});

	it("the operator's force promotes, is time-boxed, and is capped at 6 h from when it was written", () => {
		expect(run([{ ...calm, forced: true }, { ...calm, forced: true }, calm])).toEqual(['promote', 'up', 'demote']);
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
	// The demand rule on its own: a floor of 2 and a ceiling of 4, whatever hosting.json says today.
	const input = (claws: DemandClaw[], over: Partial<Parameters<typeof demandStep>[1]> = {}) => ({
		claws,
		limits: { min: 2, max: 4 },
		perSlice: 25,
		ceiling: 100,
		backstop: false,
		short: false,
		now: T0,
		...over,
	});

	it("the floor is the contract's: a quiet evening still asks for it, not one slice", () => {
		expect(HOST_ORDER).toBe(CONTRACT.order);
		// A quiet evening on one claw still asks for a second, so a blip has somewhere to go but hokon.
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 0)])).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input([])).slices).toBe(2);
	});

	it('idle is the floor: a restart with three declared and none busy asks for 2 at once, not after the calm spell', () => {
		const three = [claw('claw-8'), claw('claw-9'), claw('claw-5')];
		expect(demandStep(DEMAND_IDLE, input(three)).slices).toBe(2);
		// A restart keeps a slice that still carries matches.
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 1), claw('claw-9', 1), claw('claw-5', 1)])).slices).toBe(3);
	});

	it('the third unit of demand is hokon, not a slice: busy serving claws, or a start that waits while hokon is down, ask for 2', () => {
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 25), claw('claw-9', 25)])).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 25), claw('claw-9', 25)], { short: true })).slices).toBe(2);
	});

	it('no replacement slice is asked for while hokon is up, however long a serving claw is dead', () => {
		const dead = claw('claw-9', 0, T0 - 60 * 60_000);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 2), dead], { backstop: true })).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8', 2), dead])).slices).toBe(2);
	});

	it('claw-5 is asked for only when hokon is up AND still short, never past the ceiling', () => {
		const both = [claw('claw-8', 0, T0 - 60_000), claw('claw-9', 0, T0 - 60_000)];
		expect(demandStep(DEMAND_IDLE, input(both, { backstop: true })).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input(both, { short: true })).slices).toBe(2);
		expect(demandStep(DEMAND_IDLE, input(both, { backstop: true, short: true })).slices).toBe(3);
		expect(demandStep(DEMAND_IDLE, input(both, { backstop: true, short: true, ceiling: 50 })).slices).toBe(2);
	});

	it('asks for more at once and for fewer only after the calm spell', () => {
		const three = [claw('claw-8', 1), claw('claw-9', 0), claw('claw-5', 0)];
		let state: DemandState = { slices: 3, lowSince: null };
		const at = (t: number): number => {
			const step = demandStep(state, input(three, { now: t }));
			state = step.state;
			return step.slices;
		};
		expect(at(T0)).toBe(3);
		expect(at(T0 + DEMAND_CALM_MS - 1)).toBe(3);
		expect(at(T0 + DEMAND_CALM_MS)).toBe(2);
		// Never under the floor, however long the calm.
		expect(at(T0 + 10 * DEMAND_CALM_MS)).toBe(2);
		// A poll that wants more breaks the spell.
		state = { slices: 3, lowSince: T0 };
		expect(demandStep(state, input(three, { now: T0 + 60_000, backstop: true, short: true })).state).toEqual({ slices: 4, lowSince: null });
	});

	it('the release order is HOST_ORDER backwards: anything unlisted, then claw-5, then claw-9, then claw-8, whatever their state', () => {
		const order = demandStep(DEMAND_IDLE, input([claw('claw-8', 0, T0 - 1), claw('claw-5', 3), claw('claw-9', 0)])).releaseOrder;
		expect(order).toEqual(['claw-5', 'claw-9', 'claw-8']);
		expect(demandStep(DEMAND_IDLE, input([claw('claw-8'), claw('claw-6'), claw('claw-5'), claw('claw-9')])).releaseOrder).toEqual(['claw-6', 'claw-5', 'claw-9', 'claw-8']);
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

	it('a restart with claw-5 declared and idle asks for the floor at once, claw-5 first; once it is ending, the count holds at 2', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-5')]);
		expect(r.demands.at(-1)).toEqual({ slices: 2, releaseOrder: ['claw-5', 'claw-9', 'claw-8'] });
		// The converger ends claw-5 with our notice: its end shows as a hosting notice, and in `ending`.
		r.converger.ending = ['claw-5'];
		const end = new Date(r.clock.t + 15 * 60_000).toISOString();
		r.nodes[2] = fleetNode('claw-5', { notices: [{ event: 'ends', at: end, kind: 'hosting' }] });
		await r.p.poll();
		r.clock.t += 60 * 60_000;
		await r.p.poll();
		await r.p.poll();
		expect(r.demands.slice(-3).map((d) => d.slices)).toEqual([2, 2, 2]);
		expect(r.demands.at(-1)?.releaseOrder).toEqual(['claw-9', 'claw-8']);
		expect(r.p.hosts().backstop.promoted).toBe(false);
	});

	it('a dry-run converger: the Capacity alert says declaring is the operator\'s call', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.converger.auto = false;
		await r.p.poll();
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8']) start(r, id);
		// The claws are full: the next start promotes hokon at once and goes there, until it is full too.
		for (const id of ['m-9', 'm-10']) start(r, id);
		expect(['m-9', 'm-10'].map((id) => jvmOf(r, id).claw)).toEqual(['hokon', 'hokon']);
		expect(() => start(r, 'm-11')).toThrow(/no Forge host/);
		expect(r.posted.at(-1)).toMatch(/its converger only plans \(no placement\.auto\), so declaring another is the operator's call\.$/);
		// hokon was short: the next poll asks for one more, which only the operator can declare here.
		await r.p.poll();
		expect(r.demands.at(-1)?.slices).toBe(3);
	});

	it('a third slice is asked for only once hokon is up and a start still finds no host; claw-5 is released first', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[0] = fleetNode('claw-9', { reachable: false });
		await r.p.poll();
		await r.p.poll();
		// claw-8 still takes matches: hokon stays down, and no replacement for claw-9 is asked for.
		expect(r.p.hosts().backstop.promoted).toBe(false);
		r.clock.t += 30 * 60_000;
		await r.p.poll();
		expect(r.demands.at(-1)?.slices).toBe(2);
		// claw-8 and hokon fill up; the next start waits, and only now is a third slice asked for.
		for (let i = 0; i < 100 && r.p.room() !== 'full'; i += 1) start(r, `m-${i}`);
		expect(r.p.room()).toBe('full');
		expect(() => start(r, 'm-short')).toThrow(/no Forge host/);
		await r.p.poll();
		expect(r.demands.at(-1)).toEqual({ slices: 3, releaseOrder: ['claw-9', 'claw-8'] });
		// claw-5 arrives; it is the first to end.
		r.nodes.push(fleetNode('claw-5'));
		await r.p.poll();
		expect(r.demands.at(-1)?.releaseOrder[0]).toBe('claw-5');
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

describe('the hosting contract', () => {
	const hosting = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../../../../../hosting.json', import.meta.url), 'utf8')) as Record<string, unknown>;

	it("is hosting.json's, read whole, so an edit to the file is the only edit there is", () => {
		expect(CONTRACT).toEqual(contractOf(hosting()));
		expect(Object.keys(CONTRACT).sort()).toEqual(['max', 'min', 'noticeMin', 'order', 'ports', 'require', 'unit']);
	});

	it('a hosting.json that lacks a field, or names a node twice, refuses to load', () => {
		const without = (path: string[]): unknown => {
			const doc = hosting();
			let at = doc;
			for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
			delete at[path.at(-1)!];
			return doc;
		};
		expect(() => contractOf(without(['slices', 'unit', 'memoryMb']))).toThrow('hosting.json: slices.unit.memoryMb is not a number');
		expect(() => contractOf(without(['placement', 'require']))).toThrow('hosting.json: placement.require is not a list of names');
		expect(() => contractOf(without(['availability']))).toThrow('hosting.json: no availability');
		const twice = hosting();
		(twice.placement as { order: string[] }).order = ['claw-8', 'claw-8'];
		expect(() => contractOf(twice)).toThrow('placement.order names a node twice');
		const upside = hosting();
		(upside.slices as { min: number }).min = 5;
		expect(() => contractOf(upside)).toThrow('slices.min..max is 5..4');
	});

	const slice = (node: string, extra: Partial<NonNullable<FleetNode['hosting']>> = {}): FleetNode =>
		fleetNode(node, { hosting: { state: 'guaranteed', declared: { memoryMb: 4096, cores: 4, port: 7621 }, observed: { agent: 'listening', memoryMinMb: 4096, cores: 4 }, until: null, ...extra } });
	const answer = (extra: Partial<FleetDemand> = {}): FleetDemand => ({
		auto: true,
		live: true,
		declared: ['claw-8', 'claw-9'],
		ending: [],
		actions: [],
		blocked: [],
		demanded: 2,
		serving: ['claw-8', 'claw-9'],
		unplaceable: [],
		declaredMb: {},
		minNodes: null,
		servingUnits: null,
		...extra,
	});
	const keys = (status: FleetNode[], demand: FleetDemand): string[] => contractViolations(CONTRACT, { at: T0, nodes: status }, demand, T0).map((v) => v.key);

	it('kept: nothing to say about two slices served as declared', () => {
		expect(keys([slice('claw-8'), slice('claw-9')], answer())).toEqual([]);
	});

	it("2026-11-04 18:50Z: watchparty's and archivebot's standbys beside claw-8 and claw-9 broke §3, and the replacements broke §1", () => {
		const nodes = [slice('claw-5'), slice('claw-8'), slice('claw-9'), slice('claw-10')];
		const now = answer({
			declared: ['claw-5', 'claw-8', 'claw-9', 'claw-10'],
			serving: ['claw-5', 'claw-10'],
			unplaceable: [
				{ node: 'claw-8', why: 'fails "not-beside-unbounded"', reachable: true },
				{ node: 'claw-9', why: 'fails "not-beside-unbounded"', reachable: true },
			],
		});
		const found = contractViolations(CONTRACT, { at: T0, nodes }, now, T0);
		expect(found.map((v) => [v.key, v.clause])).toEqual([
			['kept:claw-8:not-beside-unbounded', 'kept'],
			['kept:claw-9:not-beside-unbounded', 'kept'],
			['count:over', 'count'],
		]);
		expect(found[0]?.what).toBe('claw-8 holds one of our slices but fails "not-beside-unbounded"');
		expect(found[2]?.what).toBe('fleet-manager holds 4 units on 4 claws for our 2 (claw-5 ×1, claw-8 ×1, claw-9 ×1, claw-10 ×1; it counts claw-5, claw-10 as serving)');
	});

	it('a box that cannot be reached may be replaced; a slice it is ending is not counted; a drain is not §3', () => {
		const down = answer({ declared: ['claw-8', 'claw-9', 'claw-10'], serving: ['claw-9', 'claw-10'], unplaceable: [{ node: 'claw-8', why: 'cannot be reached', reachable: false }] });
		expect(keys([fleetNode('claw-8', { reachable: false }), slice('claw-9'), slice('claw-10')], down)).toEqual([]);
		expect(keys([slice('claw-8'), slice('claw-9'), slice('claw-10')], answer({ declared: ['claw-8', 'claw-9', 'claw-10'], ending: ['claw-10'] }))).toEqual([]);
		const drained = answer({ unplaceable: [{ node: 'claw-8', why: 'has a maintenance drain starting 2026-10-27T20:10:00Z', reachable: true }], serving: ['claw-9'] });
		expect(keys([slice('claw-8'), slice('claw-9')], drained)).toEqual(['count:short']);
	});

	it('short: fewer served than asked for, with the reasons fleet-manager gives', () => {
		const found = contractViolations(CONTRACT, { at: T0, nodes: [slice('claw-8')] }, answer({ declared: ['claw-8'], serving: ['claw-8'], blocked: ['no node can take it'] }), T0);
		expect(found.map((v) => v.what)).toEqual(['fleet-manager serves 1 of the 2 units we asked for: no node can take it']);
	});

	it('§1 in units and claws (fleet-manager e481a94): 3 units on 3 claws is kept; a claw of 2 units counts twice; fewer claws than minNodes is short', () => {
		const three = answer({ declared: ['claw-8', 'claw-9', 'claw-10'], serving: ['claw-8', 'claw-9', 'claw-10'], demanded: 3, minNodes: 3, servingUnits: 3, declaredMb: { 'claw-8': 4096, 'claw-9': 4096, 'claw-10': 4096 } });
		expect(keys([slice('claw-8'), slice('claw-9'), slice('claw-10')], three)).toEqual([]);
		// Demand 2 under a floor of 3 claws: the third is the fleet's floor, not one too many.
		expect(keys([slice('claw-8'), slice('claw-9'), slice('claw-10')], { ...three, demanded: 2 })).toEqual([]);
		// One claw grown to 2 units: 4 units for a demand of 3 is one too many.
		const grown = { ...three, servingUnits: 4, declaredMb: { ...three.declaredMb, 'claw-8': 8192 } };
		expect(keys([slice('claw-8'), slice('claw-9'), slice('claw-10')], grown)).toEqual(['count:over']);
		// 3 units on 2 claws: enough units, too few claws.
		const packed = answer({ declared: ['claw-8', 'claw-9'], serving: ['claw-8', 'claw-9'], demanded: 3, minNodes: 3, servingUnits: 3, declaredMb: { 'claw-8': 8192, 'claw-9': 4096 } });
		expect(contractViolations(CONTRACT, { at: T0, nodes: [slice('claw-8'), slice('claw-9')] }, packed, T0).map((v) => v.what)).toEqual([
			'fleet-manager serves 3 of the 3 units we asked for, on 2 of at least 3 claws',
		]);
	});

	it('a shrink notice is fewer units on a claw that goes on serving: no notice bar, no move', () => {
		const at = new Date(T0 + 10 * 60_000).toISOString();
		const ok: ClawState = { node: 'claw-9', fleet: fleetNode('claw-9', { notices: [{ event: 'ends', at, kind: 'hosting', shrinkTo: { memoryMb: 4096, cores: 4 } }] }), agent: { connected: true, silentMs: 0, error: null }, quarantine: null, room: { free: 4, why: null }, aiCutoffs: 0 };
		expect(bars(ok, T0, 6000).filter((b) => !b.ok)).toEqual([]);
		expect(parseNodeStatus(JSON.stringify({ contract: 1, generatedAt: new Date(T0).toISOString(), nodes: [{ node: 'claw-9', reachable: true, ok: true, notices: [{ event: 'ends', at, kind: 'hosting', shrinkTo: { memoryMb: 4096, cores: 4 } }] }] }))?.nodes[0]?.notices).toEqual([
			{ event: 'ends', at, kind: 'hosting', shrinkTo: { memoryMb: 4096, cores: 4 } },
		]);
	});

	it('§4: each slice is declared and served at our unit, on our port, guaranteed', () => {
		const bad = slice('claw-8', { state: 'pending', declared: { memoryMb: 2048, cores: 2, port: 7622 }, observed: { agent: 'listening', memoryMinMb: 1024, cores: 3 } });
		expect(contractViolations(CONTRACT, { at: T0, nodes: [bad, slice('claw-9')] }, answer(), T0).map((v) => v.what)).toEqual([
			'claw-8: its slice is declared at 2048 MB, under our 4096 MB',
			'claw-8: its slice is declared with 2 cores, under our 4',
			'claw-8: its slice is declared on port 7622, not ours (7621)',
			'claw-8: its slice is pending, not guaranteed',
			'claw-8: it guarantees 1024 MB of our 4096 MB (memory.min)',
			'claw-8: it gives our slice 3 cores of 4',
		]);
		// Down, or inside its announced reboot, a slice is the count's business, not its own.
		const rebooting = slice('claw-8', { state: 'unknown' });
		rebooting.notices = [{ event: 'ends', at: new Date(T0 + 3600_000).toISOString(), kind: 'reboot' }];
		expect(keys([rebooting, slice('claw-9')], answer())).toEqual([]);
		expect(keys([{ ...slice('claw-8', { state: 'unknown' }), reachable: false }, slice('claw-9')], answer())).toEqual([]);
	});

	it('inUse: the first `want` usable claws in the order, an unlisted one last', () => {
		expect(inUse(['claw-5', 'claw-10', 'claw-9', 'claw-8'], 2)).toEqual(['claw-8', 'claw-9']);
		expect(inUse(['claw-5', 'claw-10', 'claw-9'], 2)).toEqual(['claw-9', 'claw-10']);
		expect(inUse(['claw-5', 'claw-10'], 3)).toEqual(['claw-10', 'claw-5']);
		expect(inUse(['claw-4', 'claw-5', 'claw-9', 'claw-10'], 3)).toEqual(['claw-9', 'claw-10', 'claw-5']);
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

	it('admission control: a full claw promotes hokon for the next start at once; with hokon full too a start waits, and one Capacity alert names the next slice', async () => {
		const r = await rig([fleetNode('claw-9')]);
		for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) start(r, id);
		// claw-9 is full: fleet-manager's rule promotes hokon for this start, at once.
		start(r, 'm-5');
		expect(jvmOf(r, 'm-5').claw).toBe('hokon');
		expect(r.posted[0]).toMatch(/^🔺 hokon promoted to the Forge backstop: no claw can take a match\. claw-9: room \(full\)/);
		start(r, 'm-6');
		expect(r.p.room()).toBe('full');
		expect(() => start(r, 'm-7')).toThrow(/no Forge host can take a match now \(claw-9: room \(full\); hokon: promoted but full/);
		await vi.waitFor(() => expect(r.posted.filter((t) => t.startsWith('⚠️ Capacity'))).toHaveLength(1));
		expect(r.posted.at(-1)).toMatch(/fleet-manager has 1 declared for us; the next poll asks for one more\.$/);
		// The incident is open: asking again posts nothing.
		r.p.room();
		expect(r.logs.filter((l) => l.evt === 'alert' && l.key === 'capacity')).toHaveLength(1);
		// A second slice arrives: the next start is placed, and the alert resolves.
		r.claws.set('claw-8', fakeClaw('claw-8'));
		r.nodes.push(fleetNode('claw-8'));
		await r.p.poll();
		r.warmAll();
		start(r, 'm-7');
		expect(jvmOf(r, 'm-7').claw).toBe('claw-8');
		expect(r.posted.at(-1)).toMatch(/^✅ Capacity: Forge matches are being placed again/);
	});

	it('no claw reachable: hokon comes up on that poll, and its log and alert say which bar emptied the eligible set', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[0] = fleetNode('claw-9', { reachable: false });
		r.nodes[1] = fleetNode('claw-8', { reachable: false });
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(true);
		const whyNone = 'claw-9: fleet (fleet-manager cannot reach it); claw-8: fleet (fleet-manager cannot reach it); hokon: promoted';
		expect(r.logs.filter((l) => l.evt === 'backstop-promoted')).toEqual([{ evt: 'backstop-promoted', why: 'no claw can take a match', whyNone }]);
		expect(r.posted.filter((t) => t.startsWith('🔺'))).toEqual([`🔺 hokon promoted to the Forge backstop: no claw can take a match. ${whyNone}.`]);
	});

	it('hokon stands down on the first poll a claw can take a match again, holds while fleet status is unreadable, and keeps its live matches', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[0] = fleetNode('claw-9', { reachable: false });
		r.nodes[1] = fleetNode('claw-8', { reachable: false });
		await r.p.poll();
		start(r, 'm-1');
		expect(jvmOf(r, 'm-1').claw).toBe('hokon');
		r.nodes[0] = fleetNode('claw-9');
		r.nodes[1] = fleetNode('claw-8');
		r.fleetDown.on = true;
		await r.p.poll();
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(true);
		r.fleetDown.on = false;
		await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(false);
		expect(r.posted.at(-1)).toMatch(/^🔻 hokon stood down as the Forge backstop: 2 claws can take matches again/);
		expect(hostOf(r, 'hokon').matches).toEqual(['m-1']);
		start(r, 'm-2');
		expect(jvmOf(r, 'm-2').claw).toBe('claw-8');
	});

	it('one of the two serving claws down is no backstop trigger: the other takes the matches and hokon stays down', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[1] = fleetNode('claw-8', { reachable: false });
		for (let i = 0; i < 4; i += 1) await r.p.poll();
		expect(r.p.hosts().backstop.promoted).toBe(false);
		expect(r.posted.filter((t) => t.startsWith('🔺'))).toEqual([]);
		start(r, 'm-1');
		expect(jvmOf(r, 'm-1').claw).toBe('claw-9');
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

	it('the last eligible claw degrading leaves no claw to take a match: hokon comes up at once, and the next start goes there', async () => {
		const r = await rig([fleetNode('claw-9')]);
		start(r, 'm-1');
		jvmOf(r, 'm-1').jvm.say({ t: 'cutoff', match: 'm-1' });
		expect(r.p.hosts().backstop).toMatchObject({ promoted: true, why: 'no claw can take a match' });
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
		expect(r.posted[0]).toMatch(/^🔺 hokon promoted to the Forge backstop: no claw can take a match/);
		expect(r.posted[1]).toMatch(/^🚨 Failover: claw-9 — gone\. Moved 2: m-1 → hokon .*; m-2 → hokon/);
		expect(r.posted[2]).toBe(
			'🚨 Match lost: 1 on claw-9 — gone: m-3 (no host can take it). claw-9 is quarantined until fleet-manager reports it healthy and a canary match passes on it.',
		);
	});

	it('a bot game that plays out ends on its own and fails nothing: its claw stays in, and the human match beside it stays put', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		const human = start(r, 'm-1');
		ready(r, 'm-1');
		const bot = rec(r.order, 'b-1');
		const botSpec: MatchSpec = {
			seats: [
				{ name: 'Bot 1', ai: true, deck: null },
				{ name: 'Bot 2', ai: true, deck: null },
			],
			headless: { bestOf: 3, gameS: 180 },
		};
		r.p('b-1', botSpec, bot);
		const humanOn = jvmOf(r, 'm-1').claw;
		const botOn = jvmOf(r, 'b-1').claw;
		jvmOf(r, 'b-1').jvm.say({ t: 'stopped', match: 'b-1' });
		expect(bot.exits).toEqual([PLAYED_OUT]);
		expect(hostOf(r, botOn).quarantine).toBeNull();
		expect(hostOf(r, humanOn).quarantine).toBeNull();
		expect(jvmOf(r, 'm-1').claw).toBe(humanOn);
		expect(human.exits).toEqual([]);
		expect(r.order).toEqual(['exit b-1']);
		expect(r.posted).toEqual([]);
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

	it('runs the draft bot on the first two claws in placement order, counts it in their slices, and moves it off a lost claw', async () => {
		const big = fleetNode('claw-8');
		big.hosting!.declared!.memoryMb = 8192;
		const sha = 'd'.repeat(64);
		const held = Promise.resolve(sha);
		const r = await rig([fleetNode('claw-10'), fleetNode('claw-9'), big], { draftbot: { 'claw-8': held, 'claw-9': held, 'claw-10': held } });
		// 100 MB agent + 1400 MB a JVM (-Xmx1000 + 400): 5 in 8192 and 2 in 4096; with the draft bot's 1536 MB, 4 and 1.
		expect(['claw-8', 'claw-9', 'claw-10'].map((c) => hostOf(r, c).maxJvms)).toEqual([5, 2, 2]);
		for (const c of r.claws.values()) c.link.beat();
		r.p.tick();
		expect(r.p.hosts().draftbot.chosen).toEqual(['claw-8', 'claw-9']);
		expect(['claw-8', 'claw-9', 'claw-10'].map((c) => hostOf(r, c).maxJvms)).toEqual([4, 1, 2]);
		expect(r.claws.get('claw-9')!.link.sent.filter((m) => m.op === 'draftbot')).toEqual([{ op: 'draftbot', sha }]);
		expect(r.claws.get('claw-10')!.link.sent.filter((m) => m.op === 'draftbot')).toEqual([]);

		r.claws.get('claw-9')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		r.p.tick();
		expect(r.p.hosts().draftbot.chosen).toEqual(['claw-8', 'claw-10']);
		expect(hostOf(r, 'claw-10').maxJvms).toBe(1);
		expect(r.claws.get('claw-10')!.link.sent.filter((m) => m.op === 'draftbot')).toEqual([{ op: 'draftbot', sha }]);
	});

	// Prod v0.53.0, 2026-11-06 16:00Z: a new pin's runtime was packed and pushed to every claw before its
	// link opened, so the JVMs an earlier server left running were adopted 13–20 s late.
	it('a claw is linked and its JVMs taken back before its runtime arrives; one that cannot be given it takes no new match', async () => {
		let fail = (_: Error): void => {};
		const pending = new Promise<unknown>((_, reject) => (fail = reject));
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')], { takenBack: { 'claw-9': ['h-old-9'] }, runtime: { 'claw-9': pending, 'claw-8': Promise.resolve() } });
		expect(r.logs.filter((l) => l.evt === 'jvm-adopted').map((l) => l.id)).toEqual(['h-old-9']);
		expect(hostOf(r, 'claw-9').eligible).toBe(true);

		fail(new Error("claw-9 cannot be given this server's pin: disk full"));
		await vi.waitFor(() => expect(r.posted).toEqual(["⚠️ Pin not servable: claw-9 cannot be given this server's pin: disk full"]));
		expect(hostOf(r, 'claw-9').eligible).toBe(false);
		expect(r.logs.filter((l) => l.evt === 'claw-runtime-failed')).toMatchObject([{ host: 'claw-9' }]);
		start(r, 'm-1');
		expect(jvmOf(r, 'm-1').claw).toBe('claw-8');
	});

	it('a coordinator restart longer than the 10 s fence window quarantines no claw: both claws fence the JVMs it took back, every match moves, and hokon stays down', async () => {
		// Prod 2026-10-28T21:10:22Z: an 11 s restart, then both claws quarantined with this cause (fixed by b68cc034).
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')], { takenBack: { 'claw-9': ['h-old-9'], 'claw-8': ['h-old-8'] } });
		start(r, 'm-1');
		start(r, 'm-2');
		ready(r, 'm-1');
		ready(r, 'm-2');
		const before = ['m-1', 'm-2'].map((id) => jvmOf(r, id));
		expect(before.map((j) => j.jvm.hostId).sort()).toEqual(['h-old-8', 'h-old-9']);
		const cause = 'fenced: no word from the coordinator for 11 s (window 10 s)';
		for (const { jvm } of before) jvm.die(cause);
		await Promise.resolve();
		for (const claw of ['claw-9', 'claw-8']) {
			expect(hostOf(r, claw).quarantine).toBeNull();
			expect(hostOf(r, claw).eligible).toBe(true);
		}
		for (const id of ['m-1', 'm-2']) expect(['h-old-9', 'h-old-8']).not.toContain(jvmOf(r, id).jvm.hostId);
		expect(r.p.hosts().backstop.promoted).toBe(false);
		expect(r.logs.filter((l) => l.evt === 'claw-quarantined')).toEqual([]);
		expect(r.posted.filter((t) => t.startsWith('🚨') || t.startsWith('🔺'))).toEqual([]);
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

	it('a slice the converger ended at our asking, past its end: its lost agent is a release, not a page or a quarantine', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-5')]);
		const end = new Date(r.clock.t + 15 * 60_000).toISOString();
		r.nodes[2] = fleetNode('claw-5', { notices: [{ event: 'ends', at: end, kind: 'hosting' }] });
		r.converger.ending = ['claw-5'];
		await r.p.poll();
		await r.p.poll();
		r.clock.t += 15 * 60_000 + 30_000;
		r.claws.get('claw-5')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted).toEqual([]);
		expect(hostOf(r, 'claw-5').quarantine).toBeNull();
		expect(r.logs.some((l) => l.evt === 'claw-released' && l.host === 'claw-5')).toBe(true);
		// Before its end, the same loss is still a fault.
		const early = await rig([fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-5')]);
		early.nodes[2] = fleetNode('claw-5', { notices: [{ event: 'ends', at: end, kind: 'hosting' }] });
		early.converger.ending = ['claw-5'];
		await early.p.poll();
		await early.p.poll();
		early.claws.get('claw-5')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(early.posted[0]).toMatch(/^⚠️ Claw heartbeat lost: claw-5/);
	});

	it('a release still reads as one when the removal reached our snapshots before the lost link (claw-5, 2026-11-01 07:45Z)', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-5')]);
		const end = new Date(r.clock.t + 15 * 60_000).toISOString();
		r.nodes[2] = fleetNode('claw-5', { notices: [{ event: 'ends', at: end, kind: 'hosting' }] });
		r.converger.ending = ['claw-5'];
		await r.p.poll();
		await r.p.poll();
		// The end passes and fleet-manager removes the slice: its record, and so its `until` and its
		// place in `ending`, are gone from the next reads — and only then does the agent's link drop.
		r.clock.t += 15 * 60_000 + 30_000;
		r.nodes[2] = fleetNode('claw-5', { hosting: null });
		r.converger.ending = [];
		await r.p.poll();
		r.claws.get('claw-5')!.link.lose('agent heartbeat lost for 10 s (window 10 s)');
		expect(r.posted).toEqual([]);
		expect(hostOf(r, 'claw-5').quarantine).toBeNull();
		expect(r.logs.some((l) => l.evt === 'claw-released' && l.host === 'claw-5')).toBe(true);
	});

	it('an end taken back with --keep makes a later loss a fault again', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-5')]);
		const end = new Date(r.clock.t + 15 * 60_000).toISOString();
		r.nodes[2] = fleetNode('claw-5', { notices: [{ event: 'ends', at: end, kind: 'hosting' }] });
		r.converger.ending = ['claw-5'];
		await r.p.poll();
		await r.p.poll();
		r.nodes[2] = fleetNode('claw-5');
		r.converger.ending = [];
		await r.p.poll();
		await r.p.poll();
		r.clock.t += 15 * 60_000 + 30_000;
		r.claws.get('claw-5')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted[0]).toMatch(/^⚠️ Claw heartbeat lost: claw-5/);
	});

	it('agent lost with matches: one failover for the claw, not one per JVM', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		for (const id of ['m-1', 'm-2', 'm-3']) start(r, id);
		for (const id of ['m-1', 'm-2', 'm-3']) ready(r, id);
		r.claws.get('claw-8')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted.filter((t) => t.startsWith('🚨'))).toHaveLength(1);
		// claw-9 can still take claw-8's matches: hokon stays down, and claw-9 takes them.
		expect(r.p.hosts().backstop.promoted).toBe(false);
		expect(r.posted.find((t) => t.startsWith('🚨'))).toMatch(/^🚨 Failover: claw-8 — agent heartbeat lost .* Moved 2: m-1 → claw-9 .*; m-3 → claw-9/);
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
		r.nodes[idx] = fleetNode(from.claw, { notices: [{ event: 'starts', at: new Date(T0 + 4 * 60_000).toISOString(), kind: 'reboot' }] });
		await r.p.poll();
		expect(r.order).toEqual([]);
		from.jvm.say({ t: 'snapshot', turn: 4, state: '…', match: 'm-1' });
		expect(r.order).toEqual(['restore m-1']);
		expect(jvmOf(r, 'm-1').claw).not.toBe(from.claw);
		expect(hostOf(r, from.claw).quarantine).toBeNull();
		expect(r.posted.filter((t) => t.startsWith('🚨'))).toEqual([]);
	});
});

describe('planned reboots', () => {
	const LEASE_MS = 2 * 3600_000;
	const iso = (t: number) => new Date(t).toISOString();
	/** fleet-manager's reboot cycle on `node`, as node-status lists it before the reboot starts at `at`. */
	const announced = (node: string, at: number): FleetNode =>
		fleetNode(node, { notices: [{ event: 'starts', at: iso(at), kind: 'reboot' }, { event: 'ends', at: iso(at + LEASE_MS), kind: 'reboot' }] });
	/** The same, once its start has passed: only the drain's lapse is listed, until the cycle lifts it. */
	const underway = (node: string, at: number, extra: Partial<FleetNode> = {}): FleetNode =>
		fleetNode(node, { notices: [{ event: 'ends', at: iso(at + LEASE_MS), kind: 'reboot' }], ...extra });

	it("claw-8's kernel reboot (2026-11-03 21:32–21:50Z): no promotion, no page, and no match on it in its window", async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		// 21:32:38Z: the cycle announces the reboot with our 15 min notice.
		const at = r.clock.t + 15 * 60_000;
		r.nodes[1] = announced('claw-8', at);
		for (let i = 0; i < 15; i++) {
			await r.p.poll();
			r.clock.t += 60_000;
		}
		expect(hostOf(r, 'claw-8').eligible).toBe(false);
		// 21:47:38Z: the drain starts; the cycle waits for the box to go idle before it reboots.
		r.nodes[1] = underway('claw-8', at);
		r.clock.t += 1000;
		await r.p.poll();
		expect(hostOf(r, 'claw-8').bars.filter((b) => !b.ok).map((b) => b.why)).toEqual([`a reboot is under way (its window ends at ${iso(at + LEASE_MS)})`]);
		start(r, 'm-1');
		expect(jvmOf(r, 'm-1').claw).toBe('claw-9');
		// 21:49:14Z: the box goes down, and the agent's heartbeat is lost 10 s later.
		r.clock.t += 95_000;
		r.claws.get('claw-8')!.link.lose('agent heartbeat lost for 10 s (window 10 s)');
		expect(hostOf(r, 'claw-8').quarantine?.cause).toBe('agent heartbeat lost for 10 s (window 10 s)');
		expect(r.logs.some((l) => l.evt === 'claw-rebooting' && l.host === 'claw-8' && l.windowEnds === iso(at + LEASE_MS))).toBe(true);
		r.nodes[1] = underway('claw-8', at, { reachable: false });
		r.clock.t += 30_000;
		await r.p.poll();
		// 21:50:10Z: up on its new kernel. The canary passes; the drain still holds it out.
		r.claws.set('claw-8', fakeClaw('claw-8'));
		r.nodes[1] = underway('claw-8', at);
		r.clock.t += 30_000;
		await r.p.poll();
		expect(r.canary.runs).toEqual(['claw-8']);
		expect(hostOf(r, 'claw-8').quarantine).toBeNull();
		expect(hostOf(r, 'claw-8').eligible).toBe(false);
		// 21:50:29Z: verified, and the drain is lifted.
		r.nodes[1] = fleetNode('claw-8');
		r.clock.t += 20_000;
		await r.p.poll();
		expect(hostOf(r, 'claw-8').eligible).toBe(true);
		expect(r.logs.filter((l) => l.evt === 'backstop-promoted')).toEqual([]);
		expect(r.posted).toEqual([]);
	});

	it('a link lost before its reboot is under way is a fault: paged', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[1] = announced('claw-8', r.clock.t + 15 * 60_000);
		await r.p.poll();
		r.claws.get('claw-8')!.link.lose('agent heartbeat lost for 11 s (window 10 s)');
		expect(r.posted).toEqual([
			'⚠️ Claw heartbeat lost: claw-8 — agent heartbeat lost for 11 s (window 10 s). No match was on it. Quarantined until a healthy status and a canary.',
		]);
		expect(hostOf(r, 'claw-8').quarantine).not.toBeNull();
	});
});

describe('the hosting contract, on the coordinator', () => {
	const at = (ms: number) => new Date(T0 + ms).toISOString();
	const nodes = (): FleetNode[] => [fleetNode('claw-9'), fleetNode('claw-8'), fleetNode('claw-10'), fleetNode('claw-5')];

	it('a violation pages once it has held one converger pass, says which section it breaks, and resolves when kept again', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.converger.unplaceable = [{ node: 'claw-8', why: 'fails "not-beside-unbounded"', reachable: true }];
		await r.p.poll();
		expect(r.posted).toEqual([]);
		expect(r.p.hosts().contract.map((v) => [v.key, v.paged])).toEqual([
			['kept:claw-8:not-beside-unbounded', false],
			['count:short', false],
		]);
		r.clock.t += CONTRACT_HOLD_MS;
		await r.p.poll();
		expect(r.posted).toEqual([
			'⚠️ Hosting contract: claw-8 holds one of our slices but fails "not-beside-unbounded". docs/HOSTING_CONTRACT.md §3.',
			'⚠️ Hosting contract: fleet-manager serves 1 of the 2 units we asked for. docs/HOSTING_CONTRACT.md §1.',
		]);
		r.clock.t += 60_000;
		await r.p.poll();
		expect(r.posted).toHaveLength(2);
		r.converger.unplaceable = [];
		r.clock.t += 60_000;
		await r.p.poll();
		expect(r.posted.slice(2)).toEqual([
			'✅ Hosting contract kept again: claw-8 holds one of our slices but fails "not-beside-unbounded" (open 120 s)',
			'✅ Hosting contract kept again: fleet-manager serves 1 of the 2 units we asked for (open 120 s)',
		]);
		expect(r.p.hosts().contract).toEqual([]);
	});

	it('one that clears inside the hold never pages', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.converger.unplaceable = [{ node: 'claw-8', why: 'fails "not-beside-unbounded"', reachable: true }];
		await r.p.poll();
		r.clock.t += CONTRACT_HOLD_MS - 1000;
		r.converger.unplaceable = [];
		await r.p.poll();
		r.clock.t += CONTRACT_HOLD_MS;
		await r.p.poll();
		expect(r.posted).toEqual([]);
	});

	it('§5: a reboot announced under our 15 min is posted once; one already there when we start is not judged', async () => {
		const r = await rig([fleetNode('claw-9'), fleetNode('claw-8')]);
		r.nodes[1] = fleetNode('claw-8', { notices: [{ event: 'starts', at: at(10 * 60_000), kind: 'reboot' }] });
		await r.p.poll();
		await r.p.poll();
		expect(r.posted).toEqual([`⚠️ Hosting contract: claw-8's starts (reboot) at ${at(10 * 60_000)} was announced 10 min ahead, under our 15 min. docs/HOSTING_CONTRACT.md §5.`]);
		// Our 15 min, read up to a poll and a status copy late, is kept.
		r.nodes[0] = fleetNode('claw-9', { notices: [{ event: 'starts', at: at(14 * 60_000), kind: 'reboot' }] });
		await r.p.poll();
		expect(r.posted.filter((t) => t.startsWith('⚠️ Hosting contract'))).toHaveLength(1);
		const late = await rig([fleetNode('claw-9'), fleetNode('claw-8', { notices: [{ event: 'starts', at: at(5 * 60_000), kind: 'reboot' }] })]);
		await late.p.poll();
		expect(late.posted).toEqual([]);
	});

	it('four slices for a demand of two: matches go to claw-8 and claw-9, then claw-10 and claw-5 in that order, and hokon only once every claw is full', async () => {
		const r = await rig(nodes());
		// A slice here holds two JVMs of two matches: four each.
		const ids = Array.from({ length: 12 }, (_, i) => `m-${i + 1}`);
		const on = (some: string[]): string[] => some.map((id) => jvmOf(r, id).claw).sort();
		for (const id of ids.slice(0, 8)) start(r, id);
		expect(on(ids.slice(0, 8))).toEqual(['claw-8', 'claw-8', 'claw-8', 'claw-8', 'claw-9', 'claw-9', 'claw-9', 'claw-9']);
		for (const id of ids.slice(8)) start(r, id);
		expect(on(ids.slice(8))).toEqual(['claw-10', 'claw-10', 'claw-10', 'claw-10']);
		for (const id of ['m-13', 'm-14', 'm-15', 'm-16']) start(r, id);
		expect(on(['m-13', 'm-14', 'm-15', 'm-16'])).toEqual(['claw-5', 'claw-5', 'claw-5', 'claw-5']);
		expect(r.p.hosts().backstop.promoted).toBe(false);
		start(r, 'm-17');
		expect(jvmOf(r, 'm-17').claw).toBe('hokon');
	});

	it('claw-8 down with claw-10 declared: claw-9 and claw-10 serve, and hokon stays down', async () => {
		const r = await rig(nodes());
		r.nodes[1] = fleetNode('claw-8', { reachable: false });
		for (let i = 0; i < 4; i++) {
			r.clock.t += 60_000;
			await r.p.poll();
		}
		expect(r.p.hosts().backstop.promoted).toBe(false);
		start(r, 'm-1');
		start(r, 'm-2');
		expect(['m-1', 'm-2'].map((id) => jvmOf(r, id).claw).sort()).toEqual(['claw-10', 'claw-9']);
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

describe('primeFleet: the first fleet read starts at boot', () => {
	const status = (at: number): FleetStatus => ({ at, nodes: [] }) as unknown as FleetStatus;
	const counting = () => {
		let reads = 0;
		const ages: (number | undefined)[] = [];
		const source: FleetSource = {
			status: (maxAgeS) => {
				ages.push(maxAgeS);
				return Promise.resolve(status(++reads));
			},
			demand: () => Promise.resolve(null),
		};
		return { source, reads: () => reads, ages };
	};

	it("boot's read takes a copy the last server's polls left; the polls after it read as usual", async () => {
		const { source, ages } = counting();
		const primed = primeFleet(source, () => 0);
		await primed.status();
		await primed.status();
		expect(ages).toEqual([BOOT_STATUS_MAX_AGE_S, undefined]);
		expect(BOOT_STATUS_MAX_AGE_S).toBeGreaterThan(STATUS_MAX_AGE_S);
		// A copy that old still lets the notice audit judge a late notice fairly.
		expect(BOOT_STATUS_MAX_AGE_S * 1000).toBeLessThanOrEqual(NOTICE_SLACK_MS);
	});

	it('the CLI is asked for that age', async () => {
		const cli = join(scratch, 'args-fleet-cli.mjs');
		const argsFile = join(scratch, 'args-fleet-cli.txt');
		writeFileSync(cli, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write('{}');`);
		const fleet = fleetCli({ env: { CARDTABLE_FLEET_CLI: cli }, log: () => {} });
		await primeFleet(fleet).status();
		await fleet.status();
		expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
			`node-status --json --max-age ${BOOT_STATUS_MAX_AGE_S}`,
			`node-status --json --max-age ${STATUS_MAX_AGE_S}`,
		]);
	});

	it('asks at once, and the first status() is that answer, not a second read', async () => {
		const { source, reads } = counting();
		const primed = primeFleet(source, () => 0);
		expect(reads()).toBe(1);
		expect((await primed.status())?.at).toBe(1);
		expect(reads()).toBe(1);
		expect((await primed.status())?.at).toBe(2);
	});

	it('a primed answer older than its limit is not used: the poll reads live', async () => {
		const { source, reads } = counting();
		let t = 0;
		const primed = primeFleet(source, () => t);
		t = PRIMED_MAX_AGE_MS + 1;
		expect((await primed.status())?.at).toBe(2);
		expect(reads()).toBe(2);
	});
});
