/**
 * The draft bot service on the claws: which two run it, and the `Draftbot` the draft rooms ask.
 *
 * - **Where.** The first `DRAFTBOT_CLAWS` usable claws in placement order that hold the artifact
 *   (`remote/index.ts` pushes it to every claw after the runtime) run it: a primary and a backup.
 *   Every other connected claw is told to run none. The choice is made again at every health tick,
 *   so a claw that is lost, quarantined or failing its draft bot gives way to the next at once.
 * - **Told** by `{op:'draftbot'}`, repeated whenever a claw's heartbeat shows it wanting something
 *   else (so an agent that restarted is told again), and counted in its slice (`sliceNeedMb`).
 * - **Failing.** A chosen claw whose service is refused, or not up for `DRAFTBOT_START_MS` since it
 *   was asked or last seen up, is skipped for `DRAFTBOT_RETRY_MS`, with one alert
 *   (`draftbot:<claw>`). No claw's service up for `DRAFTBOT_DOWN_MS` is one alert (`draftbot`).
 * - **Asked.** `batchDraft` goes to the primary through its agent (`DRAFTBOT_PATH`), with
 *   `DRAFTBOT_PRIMARY_MS` of the caller's time, then to the backup with whatever is left. It rejects
 *   when both fail, and the room's bots pick by the pick order.
 */

import { z } from 'zod';

import type { AgentClient } from '../remote/client.js';
import { DRAFTBOT_PATH } from '../remote/wire.js';
import type { Alerts } from './alerts.js';

/** Oracle ids: the cards in the pack being picked from, and the ones already taken. */
export interface DraftbotInput {
	pack: string[];
	pool: string[];
}

/** One list per input, in input order: each pack's known cards, best first. */
export type DraftbotRatings = { oracle: string; rating: number }[][];

export interface Draftbot {
	/** Rejects on any failure, including an answer of the wrong shape. */
	batchDraft(inputs: DraftbotInput[], signal: AbortSignal): Promise<DraftbotRatings>;
}

/** A primary and a backup. */
export const DRAFTBOT_CLAWS = 2;
/**
 * The primary's share of a call. The room aborts at its bot pick (1.2 s in prod); one pod's call
 * took 0.34–0.55 s on claw-9, the slowest hosting core, so this leaves the backup ~0.6 s.
 */
export const DRAFTBOT_PRIMARY_MS = 600;
/** Asked this long without coming up (or this long down since last up): failing on that claw. */
export const DRAFTBOT_START_MS = 90_000;
/** A claw whose draft bot failed is passed over this long, then tried again. */
export const DRAFTBOT_RETRY_MS = 5 * 60_000;
/** No draft bot up anywhere for this long is an alert. */
export const DRAFTBOT_DOWN_MS = 5 * 60_000;

/** One connected claw, as placement sees it at a tick. */
export interface DraftbotClaw {
	name: string;
	client: Pick<AgentClient, 'lost' | 'health' | 'send' | 'call'>;
	/** It may run it: not quarantined, not failing. */
	usable: boolean;
	/** The draft bot artifact it holds; null until pushed. */
	sha: string | null;
	/** Why it holds none, when the push failed. */
	error: string | null;
}

const Answer = z.object({
	success: z.literal(true),
	results: z.array(z.array(z.object({ oracle: z.string(), rating: z.number() }))),
});

export class ClawDraftbots implements Draftbot {
	private claws = new Map<string, DraftbotClaw>();
	private chosen: string[] = [];
	/** What each claw was asked to run, and since when it should have been up. */
	private readonly asked = new Map<string, { sha: string; since: number }>();
	private readonly failedUntil = new Map<string, number>();
	private downSince: number;
	private readonly now: () => number;
	private readonly log: (entry: Record<string, unknown>) => void;

	constructor(private readonly opts: { alerts: Alerts; now?: () => number; log?: (entry: Record<string, unknown>) => void }) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.downSince = this.now();
	}

	/** Whether `claw` is chosen to run it: its slice reserves the room. */
	runsOn(claw: string): boolean {
		return this.chosen.includes(claw);
	}

	view(): { chosen: string[]; failing: string[] } {
		const t = this.now();
		return { chosen: [...this.chosen], failing: [...this.failedUntil].filter(([, until]) => until > t).map(([name]) => name) };
	}

	/** Every health tick, with every connected claw in placement order. */
	step(claws: DraftbotClaw[]): void {
		const t = this.now();
		this.claws = new Map(claws.map((c) => [c.name, c]));
		for (const name of this.chosen) this.judge(name, t);
		const before = this.chosen.join(',');
		this.chosen = claws
			.filter((c) => c.usable && c.sha !== null && c.client.lost === null && (this.failedUntil.get(c.name) ?? 0) <= t)
			.slice(0, DRAFTBOT_CLAWS)
			.map((c) => c.name);
		if (this.chosen.join(',') !== before) this.log({ evt: 'draftbot-claws', chosen: this.chosen, before: before === '' ? [] : before.split(',') });
		for (const c of claws) {
			const want = this.chosen.includes(c.name) ? c.sha : null;
			if (want === null) this.asked.delete(c.name);
			else if (this.asked.get(c.name)?.sha !== want) this.asked.set(c.name, { sha: want, since: t });
			// No heartbeat yet: nothing to compare with, and nothing to repeat to.
			if (c.client.health === null) continue;
			const has = c.client.health.draftbot ?? null;
			// A claw that refused it is asked again when chosen again: it may have room by now.
			if ((has?.sha ?? null) !== want || (want !== null && has?.state === 'refused')) c.client.send({ op: 'draftbot', sha: want });
		}
		this.watchDown(t);
	}

	/** A chosen claw whose service is refused or will not come up gives way, with one alert. */
	private judge(name: string, t: number): void {
		const asked = this.asked.get(name);
		const h = this.claws.get(name)?.client.health?.draftbot;
		if (asked === undefined || h == null || h.sha !== asked.sha) return;
		if (h.state === 'up') {
			asked.since = t;
			this.opts.alerts.resolve(`draftbot:${name}`, `Draft bot up on ${name} again`);
			return;
		}
		if (h.state !== 'refused' && t - asked.since <= DRAFTBOT_START_MS) return;
		const why = h.state === 'refused' ? `refused: ${h.error}` : `${h.state} for ${Math.round((t - asked.since) / 1000)} s${h.error === null ? '' : ` (${h.error})`}`;
		this.failedUntil.set(name, t + DRAFTBOT_RETRY_MS);
		this.log({ evt: 'draftbot-failing', claw: name, why, state: h.state, restarts: h.restarts });
		this.opts.alerts.fire(`draftbot:${name}`, `⚠️ Draft bot will not run on ${name}: ${why}. The next claw takes it; ${name} is tried again in ${DRAFTBOT_RETRY_MS / 60_000} min.`);
	}

	private up(name: string): boolean {
		const c = this.claws.get(name);
		return c !== undefined && c.client.lost === null && c.client.health?.draftbot?.state === 'up' && c.client.health.draftbot.sha === this.asked.get(name)?.sha;
	}

	private watchDown(t: number): void {
		const up = this.chosen.filter((n) => this.up(n));
		if (up.length > 0) {
			this.downSince = t;
			this.opts.alerts.resolve('draftbot', `ML draft bot answering again on ${up.join(', ')}`);
			return;
		}
		if (t - this.downSince <= DRAFTBOT_DOWN_MS) return;
		this.opts.alerts.fire('draftbot', `⚠️ No ML draft bot has been up for ${Math.round((t - this.downSince) / 60_000)} min (${this.whyDown()}). Draft bots pick by the pick order meanwhile.`);
	}

	private whyDown(): string {
		const parts = [...this.claws.values()].map((c) => {
			const h = c.client.health?.draftbot;
			if (c.sha === null) return `${c.name}: no artifact${c.error === null ? '' : ` (${c.error})`}`;
			if (h == null) return `${c.name}: ${this.chosen.includes(c.name) ? 'asked, no word yet' : 'not chosen'}`;
			return `${c.name}: ${h.state}${h.error === null ? '' : ` (${h.error})`}`;
		});
		return parts.length === 0 ? 'no claw connected' : parts.join('; ');
	}

	async batchDraft(inputs: DraftbotInput[], signal: AbortSignal): Promise<DraftbotRatings> {
		const targets = this.chosen.filter((n) => this.up(n)).map((n) => this.claws.get(n) as DraftbotClaw);
		if (targets.length === 0) throw new Error('no claw runs the draft bot now');
		let last: unknown = null;
		for (const [i, c] of targets.entries()) {
			if (signal.aborted) break;
			const attempt = i === targets.length - 1 ? signal : AbortSignal.any([signal, AbortSignal.timeout(DRAFTBOT_PRIMARY_MS)]);
			try {
				const parsed = Answer.safeParse(await c.client.call('POST', DRAFTBOT_PATH, { inputs }, attempt));
				if (!parsed.success) throw new Error(`answer malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
				if (parsed.data.results.length !== inputs.length) throw new Error(`answered ${parsed.data.results.length} packs for ${inputs.length}`);
				return parsed.data.results;
			} catch (err) {
				last = new Error(`draftbot on ${c.name}: ${(err as Error).message}`, { cause: err });
			}
		}
		throw last ?? new Error('draftbot: aborted before any claw was asked');
	}
}
