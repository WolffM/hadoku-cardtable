/**
 * The frame rate, rolled up for telemetry. A browser's frame watch sends `perf` client events (a
 * summary every few turns or as a page closes, one per bad stretch, one per scroll burst, the machine
 * once); the server logs each one as a `client` line, and this tally reads the same lines as they are
 * logged and posts one `frames` event per window, so a slowdown reaches monitoring-api rather than only
 * this host's stdout, and the daily report can compare a day against the week before it.
 *
 * Per surface (`match`, or the page's own name: `front`, `draft`, …):
 *
 *   - `summaries`, `frames`, `watchedMs`, `fps`: what the summaries counted. fps follows the display's
 *     own rate (a 120 Hz screen idles at 120), so it is context, never the measure of a slowdown.
 *   - `stretches`, `freezes`, `stretchMs`: the bad stretches reported (a second with three slow frames,
 *     or one gap over the freeze line), how many of them were freezes, and how long they lasted.
 *   - `slowMs`: watched time inside summaries whose p95 frame was over {@link SLOW_P95_MS}: motion that
 *     visibly dropped under 33 fps on any display.
 *   - `scrolls`, `scrollFrames`, `scrollJanky`: scroll bursts, their frames and those over 25 ms.
 *
 * And `worst`: the {@link WORST_TOP} sessions with the most bad stretches per watched minute, with their
 * machine (`hz`, `dpr`, `cores`, `gpu`) when its `env` arrived, so a bad number can be told apart from a
 * slow laptop. A session is a match seat, or a page and its user.
 *
 * Nothing is posted for a window with no perf events. This module knows no game: the events' shape is
 * the frame watch's flat facts, read defensively; anything not a number is ignored.
 */
import { report as defaultReport, type Report, type TelemetryValue } from '../telemetry/telemetry.ts';

export const FRAMES_WINDOW_MS = 5 * 60_000;
/** A summary whose p95 gap is over this spent its watched time in visibly dropped motion (under 33 fps). */
export const SLOW_P95_MS = 30;
/** How many sessions a `frames` event names. */
export const WORST_TOP = 5;
/** The most sessions one window tracks; a flood beyond it is counted in the surface totals only. */
const SESSIONS_MAX = 500;

export interface FramesTallyOptions {
	report?: Report;
	now?: () => number;
	windowMs?: number;
}

export interface FramesTally {
	/** Read one logged line; only `evt: 'client'`, `kind: 'perf'` lines count. */
	note(line: Record<string, unknown>): void;
	/** Post the window counted so far, if anything arrived, and start a new one. */
	flush(): void;
	stop(): void;
}

interface Surface {
	summaries: number;
	frames: number;
	watchedMs: number;
	slowMs: number;
	stretches: number;
	freezes: number;
	stretchMs: number;
	scrolls: number;
	scrollFrames: number;
	scrollJanky: number;
}

interface Session {
	surface: string;
	frames: number;
	watchedMs: number;
	stretches: number;
	worstMs: number;
	p95: number;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
/** A machine fact as sent: a number or a short string, else null. */
const fact = (x: unknown): TelemetryValue => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' ? x.slice(0, 80) : null);

const blank = (): Surface => ({
	summaries: 0,
	frames: 0,
	watchedMs: 0,
	slowMs: 0,
	stretches: 0,
	freezes: 0,
	stretchMs: 0,
	scrolls: 0,
	scrollFrames: 0,
	scrollJanky: 0,
});

/** Which surface and session a line is: a match seat, or a page and its user; null for a line that names neither. */
function whose(line: Record<string, unknown>): { surface: string; session: string } | null {
	if (typeof line.matchId === 'string') return { surface: 'match', session: `${line.matchId}:${String(line.seat ?? '')}` };
	if (typeof line.page === 'string') return { surface: line.page, session: `${line.page}:${String(line.userId ?? '')}` };
	return null;
}

export function framesTally(opts: FramesTallyOptions = {}): FramesTally {
	const report = opts.report ?? defaultReport;
	const now = opts.now ?? Date.now;
	let surfaces = new Map<string, Surface>();
	let sessions = new Map<string, Session>();
	/** A session's machine, kept across windows: `env` arrives once a match, beside its first summary. */
	const envs = new Map<string, Record<string, TelemetryValue>>();
	let windowStart = now();

	const note = (line: Record<string, unknown>): void => {
		if (line.evt !== 'client' || line.kind !== 'perf') return;
		const who = whose(line);
		if (who === null) return;
		if (line.what === 'env') {
			if (envs.size >= SESSIONS_MAX) envs.delete(envs.keys().next().value as string);
			envs.set(who.session, { hz: fact(line.hz), dpr: fact(line.dpr), cores: fact(line.cores), gpu: fact(line.gpu) });
			return;
		}
		const s = surfaces.get(who.surface) ?? blank();
		surfaces.set(who.surface, s);
		let session = sessions.get(who.session);
		if (session === undefined && sessions.size < SESSIONS_MAX) {
			session = { surface: who.surface, frames: 0, watchedMs: 0, stretches: 0, worstMs: 0, p95: 0 };
			sessions.set(who.session, session);
		}
		if (line.what === 'summary') {
			const watched = num(line.watchedMs);
			s.summaries += 1;
			s.frames += num(line.frames);
			s.watchedMs += watched;
			if (num(line.p95) > SLOW_P95_MS) s.slowMs += watched;
			if (session !== undefined) {
				session.frames += num(line.frames);
				session.watchedMs += watched;
				session.worstMs = Math.max(session.worstMs, num(line.worstMs));
				session.p95 = Math.max(session.p95, num(line.p95));
			}
		} else if (line.what === 'stretch') {
			s.stretches += 1;
			s.stretchMs += num(line.ms);
			if (line.freeze === true) s.freezes += 1;
			if (session !== undefined) {
				session.stretches += 1;
				session.worstMs = Math.max(session.worstMs, num(line.worstMs));
			}
		} else if (line.what === 'scroll') {
			s.scrolls += 1;
			s.scrollFrames += num(line.frames);
			s.scrollJanky += num(line.over25);
		}
	};

	const flush = (): void => {
		const start = windowStart;
		windowStart = now();
		if (surfaces.size === 0) return;
		const perMinute = (x: Session) => x.stretches / Math.max(1, x.watchedMs / 60_000);
		const worst = [...sessions]
			.filter(([, x]) => x.stretches > 0)
			.sort(([, a], [, b]) => perMinute(b) - perMinute(a) || b.worstMs - a.worstMs)
			.slice(0, WORST_TOP)
			.map(([id, x]) => ({
				session: id,
				surface: x.surface,
				stretches: x.stretches,
				watchedMs: Math.round(x.watchedMs),
				fps: x.watchedMs > 0 ? Math.round((x.frames * 10_000) / x.watchedMs) / 10 : null,
				p95: x.p95,
				worstMs: x.worstMs,
				...(envs.has(id) ? { env: envs.get(id) as Record<string, TelemetryValue> } : {}),
			}));
		report('frames', {
			from: new Date(start).toISOString(),
			minutes: Math.round((windowStart - start) / 60_000),
			sessions: sessions.size,
			surfaces: Object.fromEntries(
				[...surfaces].map(([name, s]) => [
					name,
					{
						...s,
						watchedMs: Math.round(s.watchedMs),
						slowMs: Math.round(s.slowMs),
						stretchMs: Math.round(s.stretchMs),
						fps: s.watchedMs > 0 ? Math.round((s.frames * 10_000) / s.watchedMs) / 10 : null,
					},
				]),
			),
			worst,
		});
		surfaces = new Map();
		sessions = new Map();
	};
	const timer = setInterval(flush, opts.windowMs ?? FRAMES_WINDOW_MS);
	timer.unref();
	return { note, flush, stop: () => clearInterval(timer) };
}
