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
 *   notice      no hosting end or reboot within `NOTICE_HORIZON_MS`
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
 * The same shape as fleet-manager's CI backstop: promoted when no claw is eligible, or when fewer
 * than half the declared claws are reachable, for `OUTAGE_POLLS` polls in a row — at once when a
 * start is waiting or a failed claw's matches need a host; demoted after `CALM_POLLS` calm polls in
 * a row; a poll that could not read fleet status holds whatever is current; an operator force,
 * time-boxed (`FORCE_DEFAULT_MS`, at most `FORCE_MAX_MS`), promotes regardless. Demotion takes no
 * new matches on hokon and moves none: a healthy match is never restored for nothing.
 *
 * ## Slices on demand (§6)
 *
 * `demandStep` decides, every poll, how many slices to ask fleet-manager for: more as load rises or
 * a claw stays unusable, fewer only after a calm spell, and the order they may be ended in.
 * fleet-manager's converger declares and ends them; which match runs where stays here.
 */

import { readFileSync, statSync } from 'node:fs';

import { coreRank, type FleetNode } from './fleet.js';

/** A claw with a hosting end or reboot this close takes no new match. */
export const NOTICE_HORIZON_MS = 30 * 60_000;
/** This close to that event, its remaining matches move at their next turn start. */
export const MOVE_AHEAD_MS = 5 * 60_000;
/**
 * Outage polls in a row before hokon steps in unasked. One was a hair trigger: on 2026-10-30 a
 * one-poll blip on the only claw promoted hokon, the prod box, again and again.
 */
export const OUTAGE_POLLS = 2;
/** Calm polls in a row before hokon stands down. */
export const CALM_POLLS = 3;
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
	const events = fleet.notices.map((n) => ({ at: Date.parse(n.at), what: `${n.event} (${n.kind})` }));
	if (fleet.hosting?.until) events.push({ at: Date.parse(fleet.hosting.until), what: 'the slice ends' });
	const valid = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
	return valid[0] ?? null;
}

export function bars(claw: ClawState, now: number, freshMs: number): Bar[] {
	const bar = (name: BarName, why: string | null): Bar => ({ bar: name, ok: why === null, why: why ?? '' });
	const f = claw.fleet;
	const event = nextEvent(f);
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
				: claw.agent.silentMs !== null && claw.agent.silentMs > freshMs
					? `no heartbeat for ${Math.round(claw.agent.silentMs / 1000)} s`
					: null,
		),
		bar('notice', event !== null && event.at - now < NOTICE_HORIZON_MS ? `${event.what} at ${new Date(event.at).toISOString()}` : null),
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
	/** Calm polls in a row while promoted. */
	calm: number;
	/** Outage polls in a row while not promoted. */
	outages: number;
	why: string;
}

export interface BackstopInput {
	/** This poll read fleet status. False: hold. */
	fresh: boolean;
	/** Claws with a slice declared for us. */
	declared: number;
	/** Of those, the ones fleet-manager reached. */
	reachable: number;
	eligible: number;
	/** The operator's force is in effect. */
	forced: boolean;
	/** A start found no host since the last poll, or a failed claw's matches need one now. */
	waiting: boolean;
	/** An event between polls: it counts no poll, so it promotes only for a waiting start. */
	between: boolean;
}

export const BACKSTOP_IDLE: BackstopState = { promoted: false, calm: 0, outages: 0, why: 'the claws are serving' };

/** One poll of the backstop. `change` is set on the poll that promotes or demotes. */
export function backstopStep(state: BackstopState, input: BackstopInput): { state: BackstopState; change: 'promote' | 'demote' | null } {
	const next = (s: BackstopState): { state: BackstopState; change: 'promote' | 'demote' | null } => ({
		state: s,
		change: s.promoted === state.promoted ? null : s.promoted ? 'promote' : 'demote',
	});
	if (input.forced) return next({ promoted: true, calm: 0, outages: 0, why: 'forced by the operator' });
	if (!input.fresh) return { state, change: null };
	const outage =
		input.eligible === 0
			? 'no claw is eligible'
			: input.reachable * 2 < input.declared
				? `only ${input.reachable} of ${input.declared} declared claws are reachable`
				: null;
	if (outage !== null && (state.promoted || input.waiting)) return next({ promoted: true, calm: 0, outages: 0, why: outage });
	if (input.between) return { state, change: null };
	if (outage !== null) {
		const outages = state.outages + 1;
		if (outages >= OUTAGE_POLLS) return next({ promoted: true, calm: 0, outages: 0, why: outage });
		return { state: { ...state, outages }, change: null };
	}
	if (!state.promoted) return { state: state.outages === 0 ? state : { ...state, outages: 0 }, change: null };
	const calm = state.calm + 1;
	if (calm >= CALM_POLLS) return next({ ...BACKSTOP_IDLE, why: `calm for ${calm} polls` });
	return { state: { ...state, calm }, change: null };
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

/** A usable slice past this share of its matches asks for the next one (forge-hosting-plan §6). */
export const SCALE_UP_AT = 0.7;
/** A declared claw unusable this long is replaced, so one failed claw does not cost a slice. */
export const REPLACE_AFTER_MS = 10 * 60_000;
/**
 * The count drops only after asking for fewer this long without a break (the calm spell). Each
 * release costs the converger a `noticeMin` end (15 min), so a spell much shorter than a quiet
 * evening pays notice cycles for nothing.
 */
export const DEMAND_CALM_MS = 2 * 60 * 60_000;
/**
 * `hosting.json`'s `slices.min..max` (a unit test pins them equal). The floor is 2: one slice left
 * a calm evening on one claw, so any blip on it promoted hokon, and a failover had nowhere else to
 * go (operator, 2026-10-31).
 */
export const MIN_SLICES = 2;
export const MAX_SLICES = 4;

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
	/** Claws with a slice declared for us. */
	claws: readonly DemandClaw[];
	/** Matches placed anywhere, hokon included. */
	live: number;
	/** Matches one slice holds. */
	perSlice: number;
	/** The server's match ceiling (`MAX_CONCURRENT_MATCHES`): no slice is asked for past it. */
	ceiling: number;
	/** A start found no host since the last poll. */
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
 * Enough usable slices that live matches stay under `SCALE_UP_AT` of them, never more than the
 * ceiling needs, at least one more after a start found no host, plus one for each claw unusable for
 * `REPLACE_AFTER_MS` (its slice stays declared, so its canary can bring it back). More is asked for
 * at once; fewer only after `DEMAND_CALM_MS` of wanting fewer. The release order puts unusable claws
 * first (longest first), then the emptiest, then the slowest core: the converger ends from its head
 * with our notice, and a planned move takes what is still on it.
 */
export function demandStep(state: DemandState, input: DemandInput): { state: DemandState; slices: number; releaseOrder: string[] } {
	const per = Math.max(1, input.perSlice);
	const usable = input.claws.filter((c) => c.usable).length;
	const cap = Math.max(MIN_SLICES, Math.ceil(input.ceiling / per));
	let load = Math.min(cap, Math.floor(input.live / (SCALE_UP_AT * per)) + 1);
	if (input.short) load = Math.min(cap, Math.max(load, usable + 1));
	const replacing = input.claws.filter((c) => !c.usable && c.unusableSince !== null && input.now - c.unusableSince >= REPLACE_AFTER_MS).length;
	const want = Math.min(MAX_SLICES, Math.max(MIN_SLICES, load + replacing));
	const current = state.slices ?? input.claws.length;
	const lowSince = want >= current ? null : (state.lowSince ?? input.now);
	const slices = lowSince === null || input.now - lowSince >= DEMAND_CALM_MS ? want : current;
	const releaseOrder = [...input.claws]
		.sort(
			(a, b) =>
				Number(a.usable) - Number(b.usable) ||
				(a.unusableSince ?? 0) - (b.unusableSince ?? 0) ||
				a.live - b.live ||
				coreRank(b.node) - coreRank(a.node) ||
				a.node.localeCompare(b.node),
		)
		.map((c) => c.node);
	return { state: { slices, lowSince: slices === want ? null : lowSince }, slices, releaseOrder };
}
