/**
 * The relay plugin reports a room's relay match to the game-stats store when its leader ends it,
 * under the ROOM's game type. `attachRelay` and the reporter are captured here, so this proves the
 * wiring alone; the report's own shape is `stats/relay-results.ts`'s (`stats.test.ts`).
 */
import type { MatchReport } from '@wolffm/prefs-client/games';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
	onEnded: undefined as undefined | ((matchId: string, outcome: { winners: readonly number[] } | null) => void),
	reports: [] as Array<{ gameId: string; report: MatchReport }>,
}));

vi.mock('@hadoku/game-server/play/relay-socket', () => ({
	attachRelay: (_io: unknown, deps: { onEnded?: typeof captured.onEnded }) => {
		captured.onEnded = deps.onEnded;
		return { close: () => {} };
	},
}));

vi.mock('@hadoku/game-server/stats/reporter', () => ({
	createStatsReporter: (opts: { gameId: string }) => ({
		enabled: true,
		report: (report: MatchReport) => void captured.reports.push({ gameId: opts.gameId, report }),
		idle: async () => {},
	}),
}));

const { relayPlugin } = await import('./relay.ts');

interface FakeRoom {
	gameType: string;
	testing: boolean;
	seats: (string | null)[];
	members: { id: string; name: string }[];
}

const ROOM: FakeRoom = {
	gameType: 'crossover-cards',
	testing: false,
	seats: ['fk:aaaaaaaaaaaaaaaa', 'fk:bbbbbbbbbbbbbbbb'],
	members: [
		{ id: 'fk:aaaaaaaaaaaaaaaa', name: 'Ada' },
		{ id: 'fk:bbbbbbbbbbbbbbbb', name: 'Bo' },
	],
};

async function setUp(rooms: Record<string, FakeRoom>): Promise<NonNullable<typeof captured.onEnded>> {
	await relayPlugin.setup({
		io: {},
		state: {
			lobby: { onRelayRoomOpened: () => {}, get: (id: string) => rooms[id] },
			roomsLog: () => {},
			statsKeys: { keyOf: (id: string) => (id === 'fk:aaaaaaaaaaaaaaaa' ? 'ada-key' : null) },
		},
	} as unknown as Parameters<typeof relayPlugin.setup>[0]);
	if (captured.onEnded === undefined) throw new Error('the plugin passed attachRelay no onEnded');
	return captured.onEnded;
}

beforeEach(() => {
	captured.onEnded = undefined;
	captured.reports = [];
});

describe('relayPlugin: stats', () => {
	it("the leader's over is reported under the room's own game type, each seat by key or as a guest", async () => {
		const onEnded = await setUp({ r1: ROOM });
		onEnded('r1', { winners: [1] });
		expect(captured.reports).toHaveLength(1);
		const [{ gameId, report }] = captured.reports as [{ gameId: string; report: MatchReport }];
		expect(gameId).toBe('crossover-cards');
		expect(report.roomId).toBe('r1');
		expect(report.seats).toEqual([
			{ seat: 0, kind: 'user', userKey: 'ada-key', displayName: 'Ada', placement: 2 },
			{ seat: 1, kind: 'guest', displayName: 'Bo', placement: 1 },
		]);
	});

	it('each round of the same room is its own match', async () => {
		const onEnded = await setUp({ r1: ROOM });
		onEnded('r1', { winners: [0] });
		onEnded('r1', { winners: [1] });
		const [a, b] = captured.reports;
		expect(a?.report.matchId).not.toBe(b?.report.matchId);
	});

	it('nothing is reported for a match everyone left, a testing room, a lone player or a room that is gone', async () => {
		const onEnded = await setUp({
			r1: ROOM,
			testing: { ...ROOM, testing: true },
			alone: { ...ROOM, seats: ['fk:aaaaaaaaaaaaaaaa', null] },
		});
		onEnded('r1', null);
		onEnded('testing', { winners: [0] });
		onEnded('alone', { winners: [0] });
		onEnded('gone', { winners: [0] });
		expect(captured.reports).toEqual([]);
	});
});
