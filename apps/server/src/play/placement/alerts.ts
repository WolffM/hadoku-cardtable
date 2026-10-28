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

/** Discord's webhook API: `{content}`, at most 2000 characters. */
export function discordSink(url: string, fetchImpl: typeof fetch = fetch): AlertSink {
	return {
		async post(text) {
			const res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text.length > 1990 ? `${text.slice(0, 1990)}…` : text, allowed_mentions: { parse: [] } }),
			});
			if (!res.ok) throw new Error(`discord answered ${res.status}`);
		},
	};
}

export const ALERT_REPEAT_MS = 10 * 60_000;

export interface AlertsOptions {
	/** Null: log only. */
	sink: AlertSink | null;
	now?: () => number;
	repeatMs?: number;
	log?: (entry: Record<string, unknown>) => void;
}

export class Alerts {
	private readonly openKeys = new Map<string, { at: number; text: string; posted: boolean }>();
	private readonly lastPosted = new Map<string, number>();
	private readonly now: () => number;
	private readonly repeatMs: number;
	private readonly log: (entry: Record<string, unknown>) => void;
	private saidOff = false;

	constructor(private readonly opts: AlertsOptions) {
		this.now = opts.now ?? Date.now;
		this.repeatMs = opts.repeatMs ?? ALERT_REPEAT_MS;
		this.log = opts.log ?? (() => {});
	}

	/** Open incident `key` and post `text`, unless it is open already or fired within `repeatMs`. */
	fire(key: string, text: string): boolean {
		if (this.openKeys.has(key)) {
			this.log({ evt: 'alert-held', key, why: 'the incident is open' });
			return false;
		}
		this.openKeys.set(key, { at: this.now(), text, posted: false });
		const last = this.lastPosted.get(key);
		if (last !== undefined && this.now() - last < this.repeatMs) {
			this.log({ evt: 'alert-held', key, why: `posted ${Math.round((this.now() - last) / 1000)} s ago`, text });
			return false;
		}
		this.lastPosted.set(key, this.now());
		this.openKeys.set(key, { at: this.now(), text, posted: true });
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
		this.send(`${key}:resolved`, `${mark === '' ? '' : `${mark} `}${text} (open ${Math.round((this.now() - open.at) / 1000)} s)`);
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

	private send(key: string, text: string): void {
		this.log({ evt: 'alert', key, text });
		if (this.opts.sink === null) {
			if (!this.saidOff) this.log({ evt: 'alerts-off', why: 'DISCORD_CARDTABLE_ALERT_WEBHOOK is not set: alerts are logged, not posted' });
			this.saidOff = true;
			return;
		}
		this.opts.sink.post(text).catch((err: unknown) => this.log({ evt: 'alert-post-failed', key, error: (err as Error).message }));
	}
}
