/**
 * ONE presence tracker for the whole server, as production boots it: the `rooms` and `room` plugins,
 * taken from the very list `index.ts` boots (`PLUGINS`), set up in that order against one state.
 * The draft pods (`createDraftRooms`) and the served room (`serveRoom`) must be handed the same
 * instance the state keeps (`state.seatPresence`); handing either a tracker of its own splits "who is
 * here" in two, which is what this is for.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';

const handed = vi.hoisted(() => ({ drafts: [] as unknown[], served: [] as unknown[] }));

vi.mock('@hadoku/magic-server/room/draftRooms', async (importOriginal) => {
	const real = await importOriginal<typeof import('@hadoku/magic-server/room/draftRooms')>();
	return {
		...real,
		createDraftRooms: (options: Parameters<typeof real.createDraftRooms>[0]) => {
			handed.drafts.push(options.presence);
			return real.createDraftRooms(options);
		},
	};
});

vi.mock('@wolffm/rooms-server/room', async (importOriginal) => {
	const real = await importOriginal<typeof import('@wolffm/rooms-server/room')>();
	return {
		...real,
		serveRoom: ((io, opts) => {
			handed.served.push(opts.presence);
			return real.serveRoom(io, opts);
		}) as typeof real.serveRoom,
	};
});

let dir = '';
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'cardtable-presence-boot-'));
	process.env.CARDTABLE_STATE_DIR = dir;
});
afterAll(async () => {
	delete process.env.CARDTABLE_STATE_DIR;
	await rm(dir, { recursive: true, force: true });
});

it('the draft pods and the served room run on the one tracker the state keeps', async () => {
	const { PLUGINS } = await import('./index.ts');
	const { createPeople } = await import('@hadoku/game-server/people');
	const http = createServer();
	const io = new SocketIOServer(http, { serveClient: false });
	const state = {
		repoRoot: dir,
		library: { formats: [] },
		cubeStore: { list: () => [{ id: 'c-1', name: 'cube' }], cards: () => [] },
		setsStore: { cachedCards: () => [], nameOf: () => null, onNamed: () => undefined, list: async () => [] },
		roomsLog: () => undefined,
		tournaments: { record: () => undefined },
		matchStats: { seriesEnd: () => undefined },
		checkDraftPlan: async () => ({ ok: true }),
		people: createPeople({ baseUrl: 'https://prefs.test', serviceKey: '', log: () => undefined }),
	} as unknown as import('@hadoku/magic-server/plugins/state').Cardtable;
	const ctx = { io, state, bootPhase: () => undefined, gauge: () => undefined, counts: () => undefined, busy: () => undefined } as unknown as Parameters<(typeof PLUGINS)[number]['setup']>[0];
	try {
		const names = ['rooms', 'room'];
		for (const plugin of PLUGINS.filter((p) => names.includes(p.name))) await plugin.setup(ctx);
		expect(PLUGINS.map((p) => p.name).filter((n) => names.includes(n)), 'both are in the list production boots, in this order').toEqual(names);
		expect(state.seatPresence).toBeDefined();
		expect(handed.drafts).toEqual([state.seatPresence]);
		expect(handed.drafts[0]).toBe(state.seatPresence);
		expect(handed.served).toHaveLength(1);
		expect(handed.served[0]).toBe(state.seatPresence);
	} finally {
		io.close();
	}
});
