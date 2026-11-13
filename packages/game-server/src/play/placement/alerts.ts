/**
 * Hosting alerts to Discord (`DISCORD_CARDTABLE_ALERT_WEBHOOK`, forge-hosting-plan §7).
 *
 * One message per incident, not per match: an incident has a key (`failover:claw-9`, `capacity`,
 * …), and while it is open nothing more is posted under it. Its resolution posts one ✅ follow-up.
 * A key that fired within `repeatMs` is not posted again even after it resolved, so a flapping
 * claw is one message, not one a minute. Availability only: nothing that needs no action.
 *
 * With no webhook every alert is logged and nothing is posted; that is said once.
 *
 * Coordinator down and crash loop cannot be raised from inside the process that is down. They run
 * elsewhere: an outside `/health` check (a hadoku_site cron is the likely home) for the first, and
 * pm2's restart count read by that same check for the second. Not built here.
 *
 * AI degraded (forge-hosting-plan §4.2, "Live quality is watched"): Forge's AI cutoff happens inside
 * the JVM (`AiController`), and the bridge turns the line it prints into a `cutoff` line of the
 * match whose game was cut (`PlayBridge.CutoffWatch`). `host.ts` hands each to placement, which
 * counts them per host: any cutoff within `AI_CUTOFF_WINDOW_MS` fails the host's `ai` bar and opens
 * `ai:<host>`, claws and hokon alike, and the health tick posts the ✅ once the window is clean.
 * Only with `CARDTABLE_PLAY_HOSTS=claws`: the single local pool has no placement, so there a cutoff
 * is logged (`ai-cutoff`) and nothing else.
 */

export interface AlertSink {
	post(text: string): Promise<void>;
}

/** The sink said to wait (`429`): post again after `retryAfterMs`. */
export class RateLimited extends Error {
	constructor(readonly retryAfterMs: number) {
		super(`rate limited for ${retryAfterMs} ms`);
	}
}

/** Discord's webhook API: `{content}`, at most 2000 characters. A `429` says how long to wait, in its body's `retry_after` seconds. */
export function discordSink(url: string, fetchImpl: typeof fetch = fetch): AlertSink {
	return {
		async post(text) {
			const res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text.length > 1990 ? `${text.slice(0, 1990)}…` : text, allowed_mentions: { parse: [] } }),
			});
			if (res.status === 429) {
				const body = (await res.json().catch(() => null)) as { retry_after?: unknown } | null;
				const seconds = typeof body?.retry_after === 'number' ? body.retry_after : Number(res.headers.get('retry-after'));
				throw new RateLimited(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1000);
			}
			if (!res.ok) throw new Error(`discord answered ${res.status}`);
		},
	};
}

export const ALERT_REPEAT_MS = 10 * 60_000;
/** The same words posted again within this are one message (an incident's keys resolving together). */
export const ALERT_SAME_TEXT_MS = 60_000;
/** A rate-limited post is tried this many times in all; a wait past {@link ALERT_MAX_WAIT_MS} gives up. */
export const ALERT_POST_TRIES = 4;
export const ALERT_MAX_WAIT_MS = 30_000;

export interface AlertsOptions {
	/** Null: log only. */
	sink: AlertSink | null;
	now?: () => number;
	repeatMs?: number;
	log?: (entry: Record<string, unknown>) => void;
	/** How a rate-limited post waits; tests pass their own. */
	sleep?: (ms: number) => Promise<void>;
}

export class Alerts {
	private readonly openKeys = new Map<string, { at: number; text: string; posted: boolean; held: boolean }>();
	private readonly lastPosted = new Map<string, number>();
	/** When each text was last sent, so the same words are one message. */
	private readonly lastText = new Map<string, number>();
	/** Posts still being tried (a rate-limited one waits and goes again). */
	private readonly posting = new Set<Promise<void>>();
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly repeatMs: number;
	private readonly log: (entry: Record<string, unknown>) => void;
	private saidOff = false;

	constructor(private readonly opts: AlertsOptions) {
		this.now = opts.now ?? Date.now;
		this.repeatMs = opts.repeatMs ?? ALERT_REPEAT_MS;
		this.log = opts.log ?? (() => {});
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
	}

	/** Every post so far has been sent or given up on. */
	async settled(): Promise<void> {
		while (this.posting.size > 0) await Promise.all(this.posting);
	}

	/** Open incident `key` and post `text`, unless it is open already or fired within `repeatMs`. */
	fire(key: string, text: string): boolean {
		const already = this.openKeys.get(key);
		if (already !== undefined) {
			// Said once per incident: the callers re-fire on every tick while it lasts.
			if (!already.held) this.log({ evt: 'alert-held', key, why: 'the incident is open' });
			already.held = true;
			return false;
		}
		this.openKeys.set(key, { at: this.now(), text, posted: false, held: false });
		const last = this.lastPosted.get(key);
		if (last !== undefined && this.now() - last < this.repeatMs) {
			this.log({ evt: 'alert-held', key, why: `posted ${Math.round((this.now() - last) / 1000)} s ago`, text });
			return false;
		}
		this.lastPosted.set(key, this.now());
		this.openKeys.set(key, { at: this.now(), text, posted: true, held: false });
		this.send(key, text);
		return true;
	}

	/** Close incident `key`, with a follow-up (`✅` unless `mark` says otherwise) when its alert was posted. */
	resolve(key: string, text: string, mark = '✅'): boolean {
		const open = this.openKeys.get(key);
		if (open === undefined) return false;
		this.openKeys.delete(key);
		if (!open.posted) {
			this.log({ evt: 'alert-resolved-quietly', key, text });
			return false;
		}
		this.send(`${key}:resolved`, `${mark === '' ? '' : `${mark} `}${text}`, ` (open ${Math.round((this.now() - open.at) / 1000)} s)`);
		return true;
	}

	/** Post `text` once and open no incident: something that happened and is already over. */
	note(key: string, text: string): void {
		this.send(key, text);
	}

	isOpen(key: string): boolean {
		return this.openKeys.has(key);
	}

	open(): { key: string; at: number; text: string }[] {
		return [...this.openKeys].map(([key, v]) => ({ key, at: v.at, text: v.text }));
	}

	/** `suffix` is said but not compared: two incidents of one claw resolve with the same words and different ages. */
	private send(key: string, text: string, suffix = ''): void {
		const last = this.lastText.get(text);
		if (last !== undefined && this.now() - last < ALERT_SAME_TEXT_MS) {
			this.log({ evt: 'alert-same-text', key, text });
			return;
		}
		this.lastText.set(text, this.now());
		for (const [t, at] of this.lastText) if (this.now() - at >= ALERT_SAME_TEXT_MS) this.lastText.delete(t);
		const words = text + suffix;
		this.log({ evt: 'alert', key, text: words });
		const sink = this.opts.sink;
		if (sink === null) {
			if (!this.saidOff) this.log({ evt: 'alerts-off', why: 'DISCORD_CARDTABLE_ALERT_WEBHOOK is not set: alerts are logged, not posted' });
			this.saidOff = true;
			return;
		}
		const posting = this.post(sink, key, words);
		this.posting.add(posting);
		void posting.finally(() => this.posting.delete(posting));
	}

	/** Posted at once, so a burst goes out together; a `429` waits what Discord asks and tries again. */
	private async post(sink: AlertSink, key: string, text: string): Promise<void> {
		for (let tries = 1; ; tries++) {
			try {
				await sink.post(text);
				return;
			} catch (err) {
				const wait = err instanceof RateLimited ? err.retryAfterMs : null;
				if (wait === null || tries >= ALERT_POST_TRIES || wait > ALERT_MAX_WAIT_MS) {
					this.log({ evt: 'alert-post-failed', key, error: (err as Error).message, tries });
					return;
				}
				this.log({ evt: 'alert-post-waiting', key, ms: wait, tries });
				await this.sleep(wait);
			}
		}
	}
}
