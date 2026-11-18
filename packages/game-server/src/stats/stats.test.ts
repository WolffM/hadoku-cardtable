/**
 * Reporting rounds to the game-stats store: the reporter's bounded, idempotent retry, who sat
 * where, and the result route's gate. A game's own payload shape is its own; here a trivial
 * `toReport` stands in for one.
 */
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { GameStatsError, type MatchReport, type RecordMatchOptions } from '@wolffm/prefs-client/games';

import { identityFromHeaders } from '../room/identity.ts';
import { createStatsReporter } from './reporter.ts';
import { attachResultRoute, buildFrozenSeats, type ReportOutcome, type ResultRoom, type RoundContext } from './relay-results.ts';

const REPORT: MatchReport = {
	matchId: 'm-round-0001',
	roomId: 'r1',
	endedAt: 61_000,
	attrs: {},
	counters: {},
	seats: [{ seat: 0, kind: 'user', userKey: 'alice-friend-key', displayName: 'Alice', placement: 1, counters: {} }],
};

function recorder(outcomes: Array<'ok' | Error>) {
	const calls: Array<{ opts: RecordMatchOptions; report: MatchReport }> = [];
	const record = async (opts: RecordMatchOptions, report: MatchReport) => {
		calls.push({ opts, report });
		const next = outcomes[calls.length - 1] ?? 'ok';
		if (next instanceof Error) throw next;
		return { matchId: report.matchId, duplicate: false, ratings: {} };
	};
	return { calls, record };
}

describe('createStatsReporter', () => {
	it('posts under the game’s id with the service key, without blocking the caller, and logs no key', async () => {
		const lines: Array<Record<string, unknown>> = [];
		const { calls, record } = recorder(['ok']);
		const reporter = createStatsReporter({ gameId: 'toy', serviceKey: 'svc-key', log: (l) => lines.push(l), record, retryDelaysMs: [] });
		expect(reporter.enabled).toBe(true);
		expect(reporter.report(REPORT)).toBeUndefined();
		await reporter.idle();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts).toMatchObject({ gameId: 'toy', serviceKey: 'svc-key' });
		expect(lines.at(-1)?.evt).toBe('stats-recorded');
		expect(JSON.stringify(lines)).not.toContain('friend-key');
		expect(JSON.stringify(lines)).not.toContain('svc-key');
	});

	it('retries a transient failure with the same matchId, and stops at the bound', async () => {
		const lines: Array<Record<string, unknown>> = [];
		const { calls, record } = recorder([new TypeError('fetch failed'), new GameStatsError(503, 'unavailable'), 'ok']);
		const reporter = createStatsReporter({ gameId: 'toy', serviceKey: 'k', log: (l) => lines.push(l), record, retryDelaysMs: [1, 1, 1] });
		reporter.report(REPORT);
		await reporter.idle();
		expect(new Set(calls.map((c) => c.report.matchId)).size).toBe(1);
		expect(lines.map((l) => l.evt)).toEqual(['stats-retry', 'stats-retry', 'stats-recorded']);

		const down = recorder([new Error('a'), new Error('b'), new Error('c'), new Error('d')]);
		const bounded = createStatsReporter({ gameId: 'toy', serviceKey: 'k', log: () => {}, record: down.record, retryDelaysMs: [1, 1] });
		bounded.report(REPORT);
		await bounded.idle();
		expect(down.calls).toHaveLength(3);
	});

	it('does not retry a report the store refused, and without a key says so once and posts nothing', async () => {
		const lines: Array<Record<string, unknown>> = [];
		const refused = recorder([new GameStatsError(400, 'unresolvable key')]);
		const reporter = createStatsReporter({ gameId: 'toy', serviceKey: 'k', log: (l) => lines.push(l), record: refused.record, retryDelaysMs: [1, 1] });
		reporter.report(REPORT);
		await reporter.idle();
		expect(refused.calls).toHaveLength(1);
		expect(lines.at(-1)).toMatchObject({ evt: 'stats-failed', status: 400 });

		const off: Array<Record<string, unknown>> = [];
		const none = recorder([]);
		const disabled = createStatsReporter({ gameId: 'toy', serviceKey: undefined, serviceKeyEnvVar: 'TOY_SERVICE_KEY', log: (l) => off.push(l), record: none.record });
		expect(disabled.enabled).toBe(false);
		disabled.report(REPORT);
		await disabled.idle();
		expect(none.calls).toHaveLength(0);
		expect(off).toEqual([{ evt: 'stats-disabled', reason: 'TOY_SERVICE_KEY unset' }]);
	});
});

describe('buildFrozenSeats', () => {
	it('a keyed human by key, a keyless one as a guest, a bot by its seat and the room’s name for it — in dense seat order', () => {
		const seats = buildFrozenSeats(
			{
				seats: [null, 'ai', 'p-ada', 'closed', 'p-bo', 'ai'],
				members: [
					{ id: 'p-ada', name: 'Ada' },
					{ id: 'p-bo', name: 'Bo' },
				],
				aiSeats: [null, { name: 'Sunny' }, null, null, null, null],
			},
			new Map([['p-ada', 'ada-key']]),
		);
		expect(seats).toEqual([
			{ playerId: 0, clientId: 'ai:1', kind: 'bot', name: 'Sunny' },
			{ playerId: 1, clientId: 'p-ada', kind: 'user', userKey: 'ada-key', name: 'Ada' },
			{ playerId: 2, clientId: 'p-bo', kind: 'guest', name: 'Bo' },
			// No persona from the server (an older one): counted, never left nameless.
			{ playerId: 3, clientId: 'ai:5', kind: 'bot', name: 'Bot 2' },
		]);
	});
});

describe('attachResultRoute', () => {
	const HEADERS = { 'x-user-id': 'u-host', 'content-type': 'application/json' };
	const hostId = identityFromHeaders({ 'x-user-id': 'u-host' } as never, 'unused');

	async function serve(room: ResultRoom | undefined) {
		const reports: MatchReport[] = [];
		const handed: Array<{ raw: unknown; ctx: RoundContext }> = [];
		const app = express();
		app.use(express.json());
		attachResultRoute(app as unknown as express.Router, {
			lobby: { get: () => room },
			userKeys: new Map(),
			stats: { enabled: true, report: (r) => void reports.push(r), idle: async () => {} },
			toReport: (raw, ctx): ReportOutcome => {
				handed.push({ raw, ctx });
				return raw === 'bad' ? { ok: false, reason: 'bad-result' } : { ok: true, report: { ...REPORT, matchId: ctx.matchId, roomId: ctx.roomId } };
			},
			log: () => {},
			now: () => 99,
		});
		const server = createServer(app);
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const post = (body: unknown) => fetch(`${base}/rooms/r1/result`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
		return { post, reports, handed, close: () => new Promise<void>((r) => server.close(() => r())) };
	}

	it('404s a missing room and 403s a caller neither leading nor seated', async () => {
		const missing = await serve(undefined);
		expect((await missing.post({ matchId: 'm-round-0001', result: {} })).status).toBe(404);
		await missing.close();
		const stranger = await serve({ leader: 'someone-else', seats: ['someone-else'], members: [] });
		expect((await stranger.post({ matchId: 'm-round-0001', result: {} })).status).toBe(403);
		await stranger.close();
	});

	it('a seated host reports under the round’s own id; no id is refused, and so is a payload the game refuses', async () => {
		const room: ResultRoom = { leader: 'someone-else', seats: ['someone-else', hostId], members: [{ id: hostId, name: 'Host' }] };
		const s = await serve(room);
		try {
			expect((await s.post({ result: {} })).status).toBe(400);
			expect((await s.post({ matchId: 'm-round-0002', result: 'bad' })).status).toBe(400);
			const ok = await s.post({ matchId: 'm-round-0003', result: { any: 'thing' } });
			expect(ok.status).toBe(200);
			expect(s.reports.map((r) => r.matchId)).toEqual(['m-round-0003']);
			expect(s.handed.at(-1)).toMatchObject({ raw: { any: 'thing' }, ctx: { matchId: 'm-round-0003', roomId: 'r1', endedAt: 99 } });
			expect(s.handed.at(-1)?.ctx.seats.map((seat) => seat.clientId)).toEqual(['someone-else', hostId]);
		} finally {
			await s.close();
		}
	});
});
