/**
 * `relayPlugin` is thin by design (`relay.ts`'s own header): this only
 * proves it wires `play/relay-socket.ts`'s `attachRelay` to the context's
 * `io` and that its `shutdown` closes it. The relay socket's own behaviour
 * is proven in `play/relay-socket.test.ts`.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';

import { relayPlugin } from './relay.ts';

let http: HttpServer | null = null;
let io: SocketIOServer | null = null;

afterEach(() => {
	io?.close();
	http?.close();
	http = null;
	io = null;
});

/**
 * `relayPlugin.setup` also wires `ctx.state.lobby.onRelayRoomOpened` — kept as a hook rather than
 * a direct import of `runtimes/relay-match.ts` from `room/lobby.ts`, which would close an import
 * cycle back to `match.ts` (see `Lobby.onRelayRoomOpened`'s own doc) — so the fake context needs
 * a minimal stand-in lobby with that one method, same as it needs an `io`.
 */
function fakeCtx(): Parameters<typeof relayPlugin.setup>[0] {
	http = createServer();
	io = new SocketIOServer(http, { serveClient: false });
	return {
		io,
		state: { lobby: { onRelayRoomOpened: vi.fn() }, roomsLog: () => {} },
	} as unknown as Parameters<typeof relayPlugin.setup>[0];
}

describe('relayPlugin', () => {
	it('is a sockets-phase plugin', () => {
		expect(relayPlugin.phase).toBe('sockets');
	});

	it('attaches the relay route to the context io, refusing every join (no roster exists yet)', async () => {
		const ctx = fakeCtx();
		const hooks = await relayPlugin.setup(ctx);
		expect(hooks).toBeDefined();
		expect(typeof hooks?.shutdown).toBe('function');
	});

	it("shutdown() closes the relay handle without throwing, even with no live matches", async () => {
		const ctx = fakeCtx();
		const hooks = await relayPlugin.setup(ctx);
		expect(() => hooks?.shutdown?.()).not.toThrow();
	});

	it("wires ctx.state.lobby.onRelayRoomOpened, never importing room/lobby.ts itself (the import cycle that would close)", async () => {
		const ctx = fakeCtx();
		await relayPlugin.setup(ctx);
		expect(ctx.state.lobby.onRelayRoomOpened).toHaveBeenCalledTimes(1);
		expect(ctx.state.lobby.onRelayRoomOpened).toHaveBeenCalledWith(expect.any(Function));
	});

	it("rosterOf reads runtimes/relay-match.ts's own registry: a registered match answers a join, an unregistered id refuses it", async () => {
		const { relayMatches } = await import('../play/runtimes/relay-match.ts');
		const match = relayMatches.register('m-plugin-test', 2, { log: () => {} });
		const ctx = fakeCtx();
		await relayPlugin.setup(ctx);
		expect(match.roleOf('fk:zzzzzzzzzzzzzzzz')).not.toBeUndefined();
	});
});

describe("relayPlugin, CARDTABLE_PLAY_PROBE=1 (e2e/play/harness.ts's own posture)", () => {
	let relayPluginProbe: typeof relayPlugin;
	let isRegisteredGameType: (id: string) => boolean;
	let RELAY_TEST_GAME_TYPE: string;

	beforeEach(async () => {
		process.env.CARDTABLE_PLAY_PROBE = '1';
		vi.resetModules();
		({ isRegisteredGameType } = await import('@hadoku/shared'));
		({ relayPlugin: relayPluginProbe, RELAY_TEST_GAME_TYPE } = await import('./relay.ts'));
	});

	afterEach(() => {
		delete process.env.CARDTABLE_PLAY_PROBE;
	});

	it("registers 'relay-test' — never in production's registry, only this one dev-diagnostics posture", async () => {
		expect(isRegisteredGameType(RELAY_TEST_GAME_TYPE)).toBe(false);
		await relayPluginProbe.setup(fakeCtx());
		expect(isRegisteredGameType(RELAY_TEST_GAME_TYPE)).toBe(true);
	});
});
