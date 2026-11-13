/**
 * Placement's rules, pure: which claw may take a match, which one should, and when hokon steps in.
 * Everything here is a function of its arguments, so the tests drive it with a fake clock.
 *
 * ## Eligibility (forge-hosting-plan §4.1, §4.2)
 *
 * A claw takes a new match only while every bar holds:
 *
 *   fleet       fleet-manager says it is reachable and its slice is `guaranteed`
 *   agent       our agent link is up and its heartbeat is fresh
 *   notice      no hosting end or reboot within `NOTICE_HORIZON_MS`, and no reboot under way
 *   quarantine  it has not failed a match since it last passed a canary
 *   room        a JVM with room, or room in the slice for another (the agent's own fit rule)
 *   ai          Forge cut no AI decision short on it within `AI_CUTOFF_WINDOW_MS`
 *
 * A bar that fails stops new matches at once and moves nothing: live matches stay unless the claw
 * actually fails (the hosting rulings). Admission control, never degradation: with no eligible
 * host a start waits, and the Capacity alert fires.
 *
 * The `ai` bar is live quality (§4.2, "Live quality is watched"): past Forge's 5 s cutoff the AI
 * plays its best so far, so a host short of CPU plays worse, not slower, and any cutoff counts. It
 * holds for hokon too: the backstop takes nothing new while its AI is being cut short.
 *
 * ## hokon as the backstop (§4.3)
 *
 * fleet-manager decides how a hosted tenant's backstop works (operator, 2026-11-04: "this is not up
 * for you to determine. fleet-manager decides how that works"). Its rule, until it reports the
 * decision itself (an additive `backstop` object in `hosting-demand`): **hokon is emergency-only**.
 * It is promoted, at once, when no claw can take a match (`eligible` is 0: a start found no host);
 * fewer claws than `slices.min` is the converger's shortfall to replace, not a trigger. It stands
 * down as soon as one claw can take a match again. A poll that could not read fleet status holds
 * whatever is current; an operator force, time-boxed (`FORCE_DEFAULT_MS`, at most
 * `FORCE_MAX_MS`), promotes regardless. Demotion takes no new matches on hokon and moves none: a
 * healthy match is never restored for nothing.
 *
 * ## Slices on demand (§6)
 *
 * `demandStep` decides, every poll, how many slices to ask fleet-manager for: `slices.min` (the
 * serving claws), one more only while hokon is promoted and still short (the emergency claw), fewer
 * only after a calm spell, and the order they may be ended in, the emergency claw first.
 * fleet-manager's converger declares and ends them, ranking nodes by `hosting.json`'s
 * `placement.order`; which match runs where stays here.
 *
 * ## Only the slices we asked for (`inUse`)
 *
 * fleet-manager may hold more of our slices than we ask for (on 2026-11-04 it held four for a
 * demand of two, after placing other tenants' services beside claw-8 and claw-9). A match goes to
 * the first `demand` usable claws, in `HOST_ORDER`; any other claw, in order, once those are full;
 * hokon only when no claw can take it.
 */

import { readFileSync, statSync } from 'node:fs';

import { CONTRACT } from './contract.js';
import { coreRank, type FleetNode } from './fleet.js';

/** A claw with a hosting end or reboot this close takes no new match. */
export const NOTICE_HORIZON_MS = 30 * 60_000;
/** This close to that event, its remaining matches move at their next turn start. */
export const MOVE_AHEAD_MS = 5 * 60_000;
/** The operator's force on hokon: the default, and the ceiling from when it was written. */
export const FORCE_DEFAULT_MS = 60 * 60_000;
export const FORCE_MAX_MS = 6 * 60 * 60_000;

/** A host with this many AI cutoffs within `AI_CUTOFF_WINDOW_MS` fails the `ai` bar. */
export const AI_CUTOFFS_DEGRADED = 1;
export const AI_CUTOFF_WINDOW_MS = 5 * 60_000;

export type BarName = 'fleet' | 'agent' | 'notice' | 'quarantine' | 'room' | 'ai' | 'backstop';

export interface Bar {
	bar: BarName;
	ok: boolean;
	/** What failed, in words; empty when it holds. */
	why: string;
}

export interface ClawState {
	node: string;
	/** fleet-manager's latest readable word on this node; null when it never said. */
	fleet: FleetNode | null;
	/** `error` with a link: the agent could not be given this server's runtime, so it launches nothing. */
	agent: { connected: boolean; silentMs: number | null; error: string | null };
	quarantine: string | null;
	/** Matches it could still take; `why` when none. */
	room: { free: number; why: string | null };
	/** AI cutoffs on it within `AI_CUTOFF_WINDOW_MS`. */
	aiCutoffs: number;
}

/** The earliest announced end of this node's hosting: a notice, or the slice's `until`. */
export function nextEvent(fleet: FleetNode | null): { at: number; what: string } | null {
	if (fleet === null) return null;
	// A shrink (`shrinkTo`) is fewer units on a claw that goes on serving, not an end.
	const events = fleet.notices.filter((n) => n.shrinkTo === undefined).map((n) => ({ at: Date.parse(n.at), what: `${n.event} (${n.kind})` }));
	if (fleet.hosting?.until) events.push({ at: Date.parse(fleet.hosting.until), what: 'the slice ends' });
	const valid = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
	return valid[0] ?? null;
}

/**
 * fleet-manager's announced reboot of this node, or null. Its reboot cycle announces one as a
 * planned drain of kind `reboot`: a `starts` notice at the reboot, and an `ends` notice at the
 * drain's lapse. Once the start passes only the `ends` is listed, until the cycle has verified the
 * node and lifted the drain: the reboot is `underway` all that time.
 */
export function rebootOf(fleet: FleetNode | null, now: number): { underway: boolean; until: number | null } | null {
	const notices = fleet?.notices.filter((n) => n.kind === 'reboot') ?? [];
	if (notices.length === 0) return null;
	const first = (event: string): number | null =>
		notices
			.filter((n) => n.event === event)
			.map((n) => Date.parse(n.at))
			.filter((t) => Number.isFinite(t))
			.sort((a, b) => a - b)[0] ?? null;
	const starts = first('starts');
	return { underway: starts === null || starts <= now, until: first('ends') };
}

export function bars(claw: ClawState, now: number, freshMs: number): Bar[] {
	const bar = (name: BarName, why: string | null): Bar => ({ bar: name, ok: why === null, why: why ?? '' });
	const f = claw.fleet;
	const event = nextEvent(f);
	const reboot = rebootOf(f, now);
	return [
		bar(
			'fleet',
			f === null
				? 'fleet-manager has not reported this node'
				: !f.reachable
					? 'fleet-manager cannot reach it'
					: f.hosting === null
						? 'no hosting slice is declared on it'
						: f.hosting.state !== 'guaranteed'
							? `its slice is ${f.hosting.state || 'unknown'}, not guaranteed`
							: null,
		),
		bar(
			'agent',
			!claw.agent.connected
				? `no agent link${claw.agent.error === null ? '' : `: ${claw.agent.error}`}`
				: claw.agent.error !== null
					? claw.agent.error
					: claw.agent.silentMs !== null && claw.agent.silentMs > freshMs
					? `no heartbeat for ${Math.round(claw.agent.silentMs / 1000)} s`
					: null,
		),
		bar(
			'notice',
			reboot?.underway === true
				? `a reboot is under way${reboot.until === null ? '' : ` (its window ends at ${new Date(reboot.until).toISOString()})`}`
				: event !== null && event.at - now < NOTICE_HORIZON_MS
					? `${event.what} at ${new Date(event.at).toISOString()}`
					: null,
		),
		bar('quarantine', claw.quarantine),
		bar('room', claw.room.free > 0 ? null : (claw.room.why ?? 'full')),
		aiBar(claw.aiCutoffs),
	];
}

/** The `ai` bar, for a claw and for hokon alike. */
export function aiBar(cutoffs: number): Bar {
	const ok = cutoffs < AI_CUTOFFS_DEGRADED;
	return { bar: 'ai', ok, why: ok ? '' : `${cutoffs} AI ${cutoffs === 1 ? 'decision' : 'decisions'} cut short in the last ${AI_CUTOFF_WINDOW_MS / 60_000} min` };
}

export const eligible = (b: readonly Bar[]): boolean => b.every((x) => x.ok);

/**
 * Where the next match goes among eligible claws: spread, not packed — the most free room first —
 * and between equals, the faster core.
 */
export function rankClaws<T extends { node: string; free: number }>(claws: readonly T[]): T[] {
	return [...claws].sort((a, b) => b.free - a.free || coreRank(a.node) - coreRank(b.node) || a.node.localeCompare(b.node));
}

/** JVMs of `xmxMb` a slice of `memoryMb` holds, by the agent's fit rule (`sliceNeedMb`). */
export function jvmsThatFit(memoryMb: number, xmxMb: number, need: (xmxs: number[]) => number): number {
	let n = 0;
	while (need(Array.from({ length: n + 1 }, () => xmxMb)) <= memoryMb) n += 1;
	return n;
}

/* ── The backstop ─────────────────────────────────────────────────────── */

export interface BackstopState {
	promoted: boolean;
	why: string;
}

export interface BackstopInput {
	/** This poll read fleet status. False: hold. */
	fresh: boolean;
	/** Claws that can take a new match now (every bar holds). */
	eligible: number;
	/** The operator's force is in effect. */
	forced: boolean;
}

export const BACKSTOP_IDLE: BackstopState = { promoted: false, why: 'the claws are serving' };

/** One step of the backstop, fleet-manager's rule. `change` is set on the step that promotes or demotes. */
export function backstopStep(state: BackstopState, input: BackstopInput): { state: BackstopState; change: 'promote' | 'demote' | null } {
	const next = (s: BackstopState): { state: BackstopState; change: 'promote' | 'demote' | null } => ({
		state: s,
		change: s.promoted === state.promoted ? null : s.promoted ? 'promote' : 'demote',
	});
	if (input.forced) return next({ promoted: true, why: 'forced by the operator' });
	if (!input.fresh) return { state, change: null };
	if (input.eligible === 0) return next({ promoted: true, why: 'no claw can take a match' });
	if (!state.promoted) return { state, change: null };
	return next({ promoted: false, why: `${input.eligible} ${input.eligible === 1 ? 'claw' : 'claws'} can take matches again` });
}

/**
 * The operator's force switch: a JSON file `{"until":"<ISO time>"}` (or `{}` for the default hour).
 * It holds until `until`, never past `FORCE_MAX_MS` after the file was written. Absent or
 * unreadable: no force.
 */
export function readForce(file: string, now: number): { until: number } | null {
	let text: string;
	let written: number;
	try {
		written = statSync(file).mtimeMs;
		text = readFileSync(file, 'utf8');
	} catch {
		return null; // no force file: no force
	}
	let asked = written + FORCE_DEFAULT_MS;
	try {
		const until = Date.parse(String((JSON.parse(text) as { until?: unknown }).until ?? ''));
		if (Number.isFinite(until)) asked = until;
	} catch {
		// not JSON: the default hour, from when it was written
	}
	const until = Math.min(asked, written + FORCE_MAX_MS);
	return until > now ? { until } : null;
}

/* ── Slice demand ─────────────────────────────────────────────────────── */

/**
 * The count drops only after asking for fewer this long without a break (the calm spell). Each
 * release costs the converger a `noticeMin` end (15 min), so a spell much shorter than a quiet
 * evening pays notice cycles for nothing.
 */
export const DEMAND_CALM_MS = 2 * 60 * 60_000;

/**
 * The operator's Forge host priority, hokon aside: `hosting.json`'s `placement.order`, which
 * fleet-manager's converger ranks nodes by. A node not listed ranks after every listed one.
 */
export const HOST_ORDER: readonly string[] = CONTRACT.order;
/**
 * Which claws take new matches first: the first `want` usable claws in `HOST_ORDER` (an unlisted
 * one after every listed one). `want` is the count we ask fleet-manager for; a slice it holds past
 * that waits behind them.
 */
export function inUse(usable: readonly string[], want: number): string[] {
	return [...usable].sort((a, b) => hostRank(a) - hostRank(b) || a.localeCompare(b)).slice(0, Math.max(0, want));
}

/** Where a node stands in `HOST_ORDER`; an unlisted one after them all. */
export function hostRank(node: string): number {
	const i = HOST_ORDER.indexOf(node);
	return i < 0 ? HOST_ORDER.length : i;
}

export interface DemandClaw {
	node: string;
	/** Takes matches, room and AI quality aside: the fleet, agent, notice and quarantine bars hold. */
	usable: boolean;
	/** When it last stopped being usable; null while usable. */
	unusableSince: number | null;
	/** Matches on it now. */
	live: number;
}

export interface DemandInput {
	/** The contract's `slices.min..max` (`contract.ts`). */
	limits: { min: number; max: number };
	/** Claws with a slice declared for us. */
	claws: readonly DemandClaw[];
	/** Matches one slice holds. */
	perSlice: number;
	/** The server's match ceiling (`MAX_CONCURRENT_MATCHES`): no slice is asked for past it. */
	ceiling: number;
	/** hokon is promoted: the step between the serving claws and the emergency one is taken. */
	backstop: boolean;
	/** A start found no host since the last poll while hokon was promoted: hokon is short too. */
	short: boolean;
	now: number;
}

export interface DemandState {
	/** The count last asked for; null before the first poll, which starts from what is declared. */
	slices: number | null;
	/** Since when every poll has wanted fewer. */
	lowSince: number | null;
}

export const DEMAND_IDLE: DemandState = { slices: null, lowSince: null };

/**
 * How many slices to ask fleet-manager for, and which to end first when that drops.
 *
 * `slices.min`, the serving claws, however busy: the next unit of demand is hokon, not a slice. A
 * dead serving claw is not replaced, since that is what pulled claw-5 in; it stays declared for its
 * canary, and hokon covers it. One more than is declared only when hokon is promoted AND a start
 * still found no host, never past the ceiling's need. More is asked for at once; fewer only after
 * `DEMAND_CALM_MS` of wanting fewer. The first poll after a restart starts from that floor, or from
 * the claws still carrying matches if more: a restart is no reason to keep an idle third slice.
 *
 * The release order is `HOST_ORDER` backwards (the emergency claw, and anything unlisted, first),
 * then unusable claws (longest first), then the emptiest: the converger ends from its head with our
 * notice, and a planned move takes what is still on it.
 */
export function demandStep(state: DemandState, input: DemandInput): { state: DemandState; slices: number; releaseOrder: string[] } {
	const per = Math.max(1, input.perSlice);
	const { min, max } = input.limits;
	const cap = Math.min(max, Math.max(min, Math.ceil(input.ceiling / per)));
	const want = input.backstop && input.short ? Math.min(cap, Math.max(min, input.claws.length + 1)) : min;
	const current = state.slices ?? Math.max(want, input.claws.filter((c) => c.live > 0).length);
	const lowSince = want >= current ? null : (state.lowSince ?? input.now);
	const slices = lowSince === null || input.now - lowSince >= DEMAND_CALM_MS ? want : current;
	const releaseOrder = [...input.claws]
		.sort(
			(a, b) =>
				hostRank(b.node) - hostRank(a.node) ||
				Number(a.usable) - Number(b.usable) ||
				(a.unusableSince ?? 0) - (b.unusableSince ?? 0) ||
				a.live - b.live ||
				coreRank(b.node) - coreRank(a.node) ||
				a.node.localeCompare(b.node),
		)
		.map((c) => c.node);
	return { state: { slices, lowSince: slices === want ? null : lowSince }, slices, releaseOrder };
}
