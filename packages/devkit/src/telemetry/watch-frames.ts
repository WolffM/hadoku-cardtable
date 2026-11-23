/**
 * The frame rate in the daily report: the servers' 5-minute `frames` events (the kernel's
 * `framesTally`, `packages/service-kernel/src/relays/frames.ts`) summed per site and surface over the
 * report's window, set beside the same sums over the {@link BASELINE_DAYS} days before it, and a
 * `DEGRADED` line for every surface whose day is clearly worse than its week (or bad on its own).
 *
 * The measures are the ones a display's rate does not move: bad stretches and freezes per watched hour,
 * the share of watched time spent in visibly dropped motion (a summary's p95 over 30 ms) and the share
 * of scroll frames over 25 ms. fps is shown for context only (a 120 Hz screen idles at 120).
 *
 * Advisory: a degradation is a line in the report and the digest, never the exit code, until its
 * false-positive rate is known (AGENTS.md: ship a new check quiet).
 */

/** The days before the report's window that make the baseline. */
export const BASELINE_DAYS = 7;
/** Less watched time than this, on either side, is too little to compare. */
export const MIN_WATCHED_MIN = 10;
/** Worse than the week by this factor AND by the floor beside it is degraded. */
export const WORSE_BY = 2;
const FLOOR = { stretchesPerHour: 6, freezesPerHour: 2, slowShare: 0.1, scrollJank: 0.15 };
/** Bad whatever the week was: a stretch a minute, or a quarter of the watched time in dropped motion. */
const BAD = { stretchesPerHour: 60, slowShare: 0.25 };
/** How many of the window's worst sessions a site lists. */
const WORST_SHOWN = 5;

interface FrameEvent {
	timestamp: string;
	site: string;
	context: Record<string, unknown>;
}

export interface FrameStats {
	watchedMin: number;
	summaries: number;
	fps: number | null;
	stretches: number;
	freezes: number;
	stretchesPerHour: number;
	freezesPerHour: number;
	/** Watched time inside summaries whose p95 frame was over 30 ms, as a share of all watched time. */
	slowShare: number;
	scrolls: number;
	/** Scroll frames over 25 ms, as a share of scroll frames. */
	scrollJank: number | null;
}

export interface WorstSession {
	at: string;
	session: string;
	surface: string;
	stretches: number;
	watchedMs: number;
	fps: number | null;
	p95: number;
	worstMs: number;
	env?: Record<string, unknown>;
}

export interface SiteFrames {
	day: Record<string, FrameStats>;
	week: Record<string, FrameStats>;
	degraded: string[];
	worst: WorstSession[];
}

export interface FrameRate {
	sites: Record<string, SiteFrames>;
	/** Why the baseline could not be read; the day is still summarised, nothing is compared. */
	error: string | null;
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const round = (x: number, places = 1): number => Math.round(x * 10 ** places) / 10 ** places;

/** Each surface's sums over a set of `frames` events. */
export function frameStats(events: FrameEvent[]): Record<string, FrameStats> {
	const sums = new Map<string, Record<string, number>>();
	for (const e of events)
		for (const [surface, raw] of Object.entries((e.context.surfaces ?? {}) as Record<string, Record<string, unknown>>)) {
			const s = sums.get(surface) ?? {};
			for (const k of ['summaries', 'frames', 'watchedMs', 'slowMs', 'stretches', 'freezes', 'scrolls', 'scrollFrames', 'scrollJanky']) s[k] = (s[k] ?? 0) + n(raw[k]);
			sums.set(surface, s);
		}
	return Object.fromEntries(
		[...sums].map(([surface, s]) => {
			const hours = s.watchedMs / 3_600_000;
			return [
				surface,
				{
					watchedMin: round(s.watchedMs / 60_000),
					summaries: s.summaries,
					fps: s.watchedMs > 0 ? round((s.frames * 1000) / s.watchedMs) : null,
					stretches: s.stretches,
					freezes: s.freezes,
					stretchesPerHour: hours > 0 ? round(s.stretches / hours) : 0,
					freezesPerHour: hours > 0 ? round(s.freezes / hours) : 0,
					slowShare: s.watchedMs > 0 ? round(s.slowMs / s.watchedMs, 3) : 0,
					scrolls: s.scrolls,
					scrollJank: s.scrollFrames > 0 ? round(s.scrollJanky / s.scrollFrames, 3) : null,
				},
			];
		}),
	);
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Why a surface's day is worse than its week, or bad on its own; empty when it is neither. */
export function degradations(surface: string, day: FrameStats, week: FrameStats | undefined): string[] {
	if (day.watchedMin < MIN_WATCHED_MIN) return [];
	const out: string[] = [];
	const comparable = week !== undefined && week.watchedMin >= MIN_WATCHED_MIN;
	const worse = (key: 'stretchesPerHour' | 'freezesPerHour' | 'slowShare', show: (x: number) => string, label: string) => {
		if (!comparable) return;
		const d = day[key];
		const w = week[key];
		if (d >= w * WORSE_BY && d - w >= FLOOR[key]) out.push(`${surface}: ${label} ${show(d)} against the week's ${show(w)}`);
	};
	worse('stretchesPerHour', (x) => `${x}/h`, 'bad stretches');
	worse('freezesPerHour', (x) => `${x}/h`, 'freezes');
	worse('slowShare', pct, 'time in dropped motion');
	if (comparable && day.scrollJank !== null && week.scrollJank !== null && day.scrollJank >= week.scrollJank * WORSE_BY && day.scrollJank - week.scrollJank >= FLOOR.scrollJank)
		out.push(`${surface}: janky scroll frames ${pct(day.scrollJank)} against the week's ${pct(week.scrollJank)}`);
	if (out.length === 0) {
		if (day.stretchesPerHour >= BAD.stretchesPerHour) out.push(`${surface}: ${day.stretchesPerHour} bad stretches/h`);
		if (day.slowShare >= BAD.slowShare) out.push(`${surface}: ${pct(day.slowShare)} of watched time in dropped motion`);
	}
	return out;
}

/**
 * The day's worst sessions: each window names its own, and a match spans several windows, so a
 * session's windows are merged (stretches and watched time summed, the worst frame kept, its newest
 * window's time) before they are ranked by stretches per watched minute.
 */
export function worstSessions(events: FrameEvent[]): WorstSession[] {
	const merged = new Map<string, WorstSession & { frames: number }>();
	for (const e of events)
		for (const w of (e.context.worst ?? []) as Omit<WorstSession, 'at'>[]) {
			const m = merged.get(w.session) ?? { ...w, at: e.timestamp, stretches: 0, watchedMs: 0, frames: 0, p95: 0, worstMs: 0 };
			m.at = e.timestamp > m.at ? e.timestamp : m.at;
			m.stretches += n(w.stretches);
			m.watchedMs += n(w.watchedMs);
			m.frames += (n(w.fps) * n(w.watchedMs)) / 1000;
			m.p95 = Math.max(m.p95, n(w.p95));
			m.worstMs = Math.max(m.worstMs, n(w.worstMs));
			m.env = w.env ?? m.env;
			merged.set(w.session, m);
		}
	const perMinute = (w: WorstSession) => w.stretches / Math.max(1, w.watchedMs / 60_000);
	return [...merged.values()]
		.map(({ frames, ...w }) => ({ ...w, fps: w.watchedMs > 0 ? round((frames * 1000) / w.watchedMs) : null }))
		.sort((a, b) => perMinute(b) - perMinute(a) || b.worstMs - a.worstMs)
		.slice(0, WORST_SHOWN);
}

/** The day's frames per site against the week before `since`. `history` holds both; `error` is the baseline read's. */
export function frameRate(history: FrameEvent[], since: string, error: string | null): FrameRate {
	const sites = [...new Set(history.map((e) => e.site))].sort();
	return {
		error,
		sites: Object.fromEntries(
			sites.map((site) => {
				const mine = history.filter((e) => e.site === site);
				const today = mine.filter((e) => e.timestamp >= since);
				const day = frameStats(today);
				const week = frameStats(mine.filter((e) => e.timestamp < since));
				const worst = worstSessions(today);
				const degraded = Object.entries(day).flatMap(([surface, d]) => degradations(surface, d, error === null ? week[surface] : undefined));
				return [site, { day, week, degraded, worst }];
			}),
		),
	};
}

/** One line per surface: the day, then the week beside it. */
export function frameLines(f: SiteFrames): string[] {
	const line = (s: FrameStats) =>
		`${s.watchedMin} min watched, ${s.stretchesPerHour} stretches/h, ${s.freezesPerHour} freezes/h, ${pct(s.slowShare)} dropped${s.fps === null ? '' : `, ${s.fps} fps`}${s.scrollJank === null ? '' : `, scroll ${pct(s.scrollJank)} janky`}`;
	return [
		...f.degraded.map((d) => `  DEGRADED ${d}`),
		...Object.entries(f.day).flatMap(([surface, s]) => [`  ${surface.padEnd(8)} day  ${line(s)}`, ...(f.week[surface] ? [`  ${''.padEnd(8)} week ${line(f.week[surface])}`] : [])]),
		...f.worst.map(
			(w) =>
				`  worst ${w.at.slice(5, 16).replace('T', ' ')} ${w.session} ${w.stretches} stretch(es) in ${round(w.watchedMs / 60_000)} min, p95 ${w.p95} ms, worst ${w.worstMs} ms${w.fps === null ? '' : `, ${w.fps} fps`}${w.env ? ` · ${Object.entries(w.env).map(([k, v]) => `${k} ${String(v)}`).join(', ')}` : ''}`,
		),
	];
}
