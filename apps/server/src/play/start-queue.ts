/**
 * Match starts, held back while JVMs boot.
 *
 * A JVM boots in ~10 s alone, but boots share the box's CPU: ten started at once on a claw under
 * CI load took 44.7–52.4 s each (hosting test C7, `docs/planning/hosting-test-plan.md`), the
 * slowest within 8 s of the start timeout. A failover onto the claws is exactly that burst. Since
 * many matches share one JVM (`host.ts`), what costs a boot is a JVM, not a match. So every start
 * goes through here, wrapped around the host factory in `socket.ts`'s `attachPlay` — room starts,
 * rematches, tournament tables, vs-AI and the dev routes all reach Forge through
 * `MatchRegistry.create` → that one factory:
 *
 * - **A start that needs no boot goes at once**: a warm JVM with room starts it now, and one still
 *   booting with room starts it the moment it is warm (`room()`).
 * - **A start that would launch a JVM waits while `limit` JVMs are booting already** (`booting()`).
 *   The pool's own warm JVM boots among them.
 * - **The rest wait in order**, and each is told its place (`StartEvents.queued`) whenever it
 *   moves; `Match` keeps it for `GET /play/queue`. A waiting start's host is a stand-in that holds
 *   what the match asks of it until the real one exists.
 * - **The start timeout counts from the placement** (`StartEvents.booting`), not from the request:
 *   time in the queue is not Forge failing to start.
 *
 * A factory that says nothing about room (a test's replay host) boots nothing, and every start
 * goes at once. Re-attach (`attach`) is not a start and passes straight through, as does
 * everything else on the factory.
 */

import type { BridgeCommand, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from './host.js';

/**
 * JVMs booting at once before a start that needs another waits. A lone boot on a claw under CI
 * load took 7.8–10.5 s and ten together ~50 s, so two keeps one well inside the 60 s start timeout
 * while still overlapping the I/O-bound part of a boot.
 */
export const COLD_STARTS = 2;

/** `CARDTABLE_PLAY_COLD_STARTS`, a whole number ≥ 1; anything else is the default. */
export function coldStartsFrom(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CARDTABLE_PLAY_COLD_STARTS;
	const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
	return Number.isInteger(n) && n >= 1 ? n : COLD_STARTS;
}

/** What a start is told beyond a host's own events. Both optional: a host that boots at once says neither. */
export interface StartEvents extends HostEvents {
	/** Waiting for a boot slot, at this 1-based place. Said again each time the place changes. */
	queued?(place: number): void;
	/** The match is being placed now: the start timeout runs from here. */
	booting?(): void;
	/** The factory threw for a start that had waited: the same failure a start that never waited throws to its caller. */
	unstartable?(err: Error): void;
}

/** A waiting start's host until its JVM is asked for. */
class WaitingHost implements MatchHost {
	private host: MatchHost | null = null;
	private readonly held: BridgeCommand[] = [];
	private remembered: { epoch: string; owners: (string | null)[] } | null = null;
	private gone = false;

	constructor(private readonly leave: () => void, private readonly events: HostEvents) {}

	/** The real host: everything held goes to it, in order. */
	become(host: MatchHost): void {
		this.host = host;
		if (this.remembered !== null) host.remember?.(this.remembered);
		for (const command of this.held.splice(0)) host.send(command);
	}

	/** Never booted: the queue was dropped (the server is closing or handing over). */
	drop(reason: string): void {
		if (this.gone) return;
		this.gone = true;
		this.events.exit(reason);
	}

	send(command: BridgeCommand): void {
		if (this.host !== null) this.host.send(command);
		else this.held.push(command);
	}

	stop(): void {
		if (this.host !== null) {
			this.host.stop();
			return;
		}
		if (this.gone) return;
		this.leave();
		// A host's exit always comes after `stop` returns; so does this one.
		queueMicrotask(() => this.drop('stopped before its JVM started'));
	}

	remember(state: { epoch: string; owners: (string | null)[] }): void {
		if (this.host !== null) this.host.remember?.(state);
		else this.remembered = state;
	}

	/** A start still waiting has no JVM to leave running. */
	handOver(): boolean {
		return this.host?.handOver?.() ?? false;
	}
}

interface Waiting {
	matchId: string;
	spec: MatchSpec;
	events: StartEvents;
	host: WaitingHost;
	place: number;
	since: number;
}

export type QueuedFactory = MatchHostFactory & {
	/** JVMs booting now, and starts waiting, for diagnostics and tests. */
	queue(): { booting: number; waiting: number };
};

export function queueColdStarts(factory: MatchHostFactory, limit: number, log: (entry: Record<string, unknown>) => void): QueuedFactory {
	const waiting: Waiting[] = [];
	const booting = (): number => factory.booting?.() ?? 0;
	/** A start may go now: it needs no boot, or another boot fits. */
	const free = (): boolean => (factory.room?.() ?? 'warm') !== 'none' || booting() < limit;
	let pumping = false;

	/** Place this match now. Throws what the factory throws. */
	function begin(matchId: string, spec: MatchSpec, events: StartEvents, waitedMs: number | null): MatchHost {
		log({ evt: 'start-booting', matchId, room: factory.room?.() ?? 'warm', booting: booting(), ...(waitedMs === null ? {} : { waitedMs }) });
		events.booting?.();
		return factory(matchId, spec, events);
	}

	/** Start every waiter that may go, in order. Re-entered by a placement's own room change: once is enough. */
	function pump(): void {
		if (pumping) return;
		pumping = true;
		try {
			while (waiting.length > 0 && free()) {
				const next = waiting.shift()!;
				let host: MatchHost;
				try {
					host = begin(next.matchId, next.spec, next.events, Date.now() - next.since);
				} catch (err) {
					next.events.unstartable?.(err as Error);
					next.host.drop(`Forge could not be started: ${(err as Error).message}`);
					continue;
				}
				next.host.become(host);
			}
		} finally {
			pumping = false;
		}
		for (const [i, w] of waiting.entries()) {
			if (w.place === i + 1) continue;
			w.place = i + 1;
			w.events.queued?.(w.place);
		}
	}

	function dropAll(reason: string): void {
		for (const w of waiting.splice(0)) w.host.drop(reason);
	}

	const queued = ((matchId: string, spec: MatchSpec, events: StartEvents): MatchHost => {
		if (waiting.length === 0 && free()) return begin(matchId, spec, events, null);
		const entry: Waiting = {
			matchId,
			spec,
			events,
			place: 0,
			since: Date.now(),
			host: new WaitingHost(() => {
				const i = waiting.indexOf(entry);
				if (i >= 0) waiting.splice(i, 1);
				pump();
			}, events),
		};
		waiting.push(entry);
		log({ evt: 'start-queued', matchId, place: waiting.length, booting: booting(), limit });
		pump();
		return entry.host;
	}) as QueuedFactory;

	factory.watchRoom?.(pump);

	queued.queue = () => ({ booting: booting(), waiting: waiting.length });
	if (factory.room !== undefined) queued.room = () => factory.room!();
	if (factory.booting !== undefined) queued.booting = () => factory.booting!();
	if (factory.orphans !== undefined) queued.orphans = () => factory.orphans!();
	if (factory.attach !== undefined) queued.attach = (record, events) => factory.attach!(record, events);
	queued.close = () => {
		dropAll('the server is closing');
		factory.close?.();
	};
	if (factory.handOverAll !== undefined) {
		queued.handOverAll = () => {
			dropAll('the server is restarting');
			factory.handOverAll!();
		};
	}
	if (factory.reapOnExit !== undefined) queued.reapOnExit = () => factory.reapOnExit!();
	return queued;
}
