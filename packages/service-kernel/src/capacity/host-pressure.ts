/**
 * The host's own pressure, as fleet-manager reads it (its `src/host-pressure.ts`): every 2 s it
 * samples the host's PSI and the server's cgroup's, and every 30 s and on each change writes
 * `level` (`warn` once a line held for two samples), `reasons` and the sample to
 * `host-pressure.json`. This module reads that file and never samples PSI itself, so there is one
 * judge of "the host is under pressure" on the box.
 *
 * Anything this cannot vouch for is `unknown`, never `ok` nor `warn`: no file, a file older than
 * `PRESSURE_STALE_MS` (its writer stopped), a torn one, or one where fleet-manager says it could not
 * read a pressure source. Hokon's stalls (2026-11-27, 2026-11-28) stopped every claw's heartbeat at
 * once; with this beside them in telemetry, a stall is named as the host's.
 */
import { readFileSync } from 'node:fs';

/** fleet-manager's line: a file whose `at` is older than this means it could not look. */
export const PRESSURE_STALE_MS = 60_000;

export type PressureLevel = 'ok' | 'warn' | 'unknown';

export interface HostPressure {
	level: PressureLevel;
	/** Why the level is `unknown`; null otherwise. */
	why: string | null;
	since: string | null;
	reasons: string[];
	/** The PSI each of fleet-manager's lines is drawn on, as it last sampled them; null when unread. */
	psi: { hostIoFull: number; hostMemSome: number; prodIoSome: number; prodMemSome: number } | null;
}

/** Where fleet-manager writes it for this user (`/run/user/<uid>/fleet`); `HADOKU_HOST_PRESSURE_FILE` overrides. */
export function hostPressureFile(env: NodeJS.ProcessEnv = process.env): string {
	return env.HADOKU_HOST_PRESSURE_FILE ?? `/run/user/${process.getuid?.() ?? 0}/fleet/host-pressure.json`;
}

const unknown = (why: string): HostPressure => ({ level: 'unknown', why, since: null, reasons: [], psi: null });

interface Written {
	at?: unknown;
	level?: unknown;
	since?: unknown;
	reasons?: unknown;
	unreadable?: unknown;
	sample?: { host?: { io?: { full10?: unknown }; mem?: { some10?: unknown } }; prod?: { io?: { some10?: unknown }; mem?: { some10?: unknown } } };
}

export function readHostPressure(file: string, now: number): HostPressure {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return unknown('no file');
	}
	let w: Written;
	try {
		w = JSON.parse(text) as Written;
	} catch {
		return unknown('unreadable');
	}
	const at = Date.parse(String(w.at));
	if (!Number.isFinite(at)) return unknown('unreadable');
	if (now - at > PRESSURE_STALE_MS) return unknown(`stale: written ${Math.round((now - at) / 1000)} s ago`);
	if (Array.isArray(w.unreadable) && w.unreadable.length > 0) return unknown(`fleet-manager could not read ${w.unreadable.map(String).join(', ')}`);
	if (w.level !== 'ok' && w.level !== 'warn') return unknown(`level ${String(w.level)}`);
	const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	const s = w.sample;
	return {
		level: w.level,
		why: null,
		since: typeof w.since === 'string' ? w.since : null,
		reasons: Array.isArray(w.reasons) ? w.reasons.map(String) : [],
		psi:
			s === undefined
				? null
				: { hostIoFull: n(s.host?.io?.full10), hostMemSome: n(s.host?.mem?.some10), prodIoSome: n(s.prod?.io?.some10), prodMemSome: n(s.prod?.mem?.some10) },
	};
}

const RANK: Record<PressureLevel, number> = { ok: 0, unknown: 1, warn: 2 };

/** One capacity window's readings: the worst level, how many samples each, and every reason seen. */
export class PressureWindow {
	private counts: Record<PressureLevel, number> = { ok: 0, warn: 0, unknown: 0 };
	private reasons = new Set<string>();
	private last: HostPressure | null = null;

	/** A reading. Returns the level it changed from, or null when it did not change (the first reading changes from `ok`). */
	add(p: HostPressure): PressureLevel | null {
		this.counts[p.level] += 1;
		for (const r of p.reasons) this.reasons.add(r);
		const from = this.last?.level ?? 'ok';
		this.last = p;
		return from === p.level ? null : from;
	}

	/** The capacity event's `hostPressure`, then a fresh window; null when nothing was read. */
	take(): { worst: PressureLevel; ok: number; warn: number; unknown: number; reasons: string[]; now: PressureLevel; why: string | null } | null {
		const read = this.counts.ok + this.counts.warn + this.counts.unknown;
		const last = this.last;
		const out =
			read === 0 || last === null
				? null
				: {
						worst: (Object.keys(this.counts) as PressureLevel[]).filter((l) => this.counts[l] > 0).sort((a, b) => RANK[b] - RANK[a])[0]!,
						...this.counts,
						reasons: [...this.reasons],
						now: last.level,
						why: last.why,
					};
		this.counts = { ok: 0, warn: 0, unknown: 0 };
		this.reasons = new Set();
		return out;
	}
}
