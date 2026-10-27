import { describe, expect, it } from 'vitest';

import type { BridgeCommand, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from './host.js';
import { COLD_STARTS, coldStartsFrom, queueColdStarts, type StartEvents } from './start-queue.js';

const SPEC = { seats: [] } as unknown as MatchSpec;

/**
 * A pool that places matches the way `jvmHostFactory` does — a warm JVM with room first, then
 * one booting, else a new JVM — with no warm JVM kept, and records every placement. `warm(i)`
 * finishes JVM i's boot.
 */
function pool(perJvm = 2) {
	const asked: { id: string; jvm: number; events: HostEvents; sent: BridgeCommand[]; remembered: unknown[]; stopped: boolean }[] = [];
	const jvms: { warm: boolean; matches: number }[] = [];
	let watcher: (() => void) | null = null;
	const open = () => jvms.findIndex((j) => j.warm && j.matches < perJvm);
	const booting = () => jvms.findIndex((j) => !j.warm && j.matches < perJvm);
	const factory = ((id: string, _spec: MatchSpec, events: HostEvents): MatchHost => {
		let at = open();
		if (at < 0) at = booting();
		if (at < 0) {
			jvms.push({ warm: false, matches: 0 });
			at = jvms.length - 1;
		}
		jvms[at]!.matches += 1;
		const placed = { id, jvm: at, events, sent: [] as BridgeCommand[], remembered: [] as unknown[], stopped: false };
		asked.push(placed);
		return {
			send: (c) => placed.sent.push(c),
			stop: () => {
				placed.stopped = true;
			},
			remember: (r) => placed.remembered.push(r),
		};
	}) as MatchHostFactory;
	factory.room = () => (open() >= 0 ? 'warm' : booting() >= 0 ? 'booting' : 'none');
	factory.booting = () => jvms.filter((j) => !j.warm).length;
	factory.watchRoom = (listener) => {
		watcher = listener;
	};
	return {
		factory,
		asked,
		jvms,
		warm(i: number) {
			jvms[i]!.warm = true;
			watcher?.();
		},
		/** A match on JVM i ended. */
		freed(i: number) {
			jvms[i]!.matches -= 1;
			watcher?.();
		},
	};
}

function events() {
	const seen = { places: [] as number[], booting: 0, exits: [] as string[], lines: 0 };
	const ev: StartEvents = {
		line: () => {
			seen.lines += 1;
		},
		exit: (reason) => seen.exits.push(reason),
		log: () => {},
		queued: (place) => seen.places.push(place),
		booting: () => {
			seen.booting += 1;
		},
	};
	return { ev, seen };
}

describe('queueColdStarts', () => {
	it('a start that needs no boot goes at once; one that needs a JVM waits while `limit` JVMs boot, told its place as it moves', () => {
		const p = pool(2);
		const q = queueColdStarts(p.factory, 2, () => {});
		const starts = Array.from({ length: 7 }, (_, i) => ({ id: `m-${i}`, ...events() }));
		for (const s of starts) q(s.id, SPEC, s.ev);
		// m-0 boots JVM 0, m-1 joins it while it boots; m-2 boots JVM 1, m-3 joins it. Two JVMs
		// booting is the limit, and both are full: the rest wait.
		expect(p.asked.map((j) => [j.id, j.jvm])).toEqual([
			['m-0', 0],
			['m-1', 0],
			['m-2', 1],
			['m-3', 1],
		]);
		expect(starts.map((s) => s.seen.places)).toEqual([[], [], [], [], [1], [2], [3]]);
		expect(q.queue()).toEqual({ booting: 2, waiting: 3 });
		expect(starts.map((s) => s.seen.booting)).toEqual([1, 1, 1, 1, 0, 0, 0]);

		// A JVM turning warm frees a boot: the head of the queue boots JVM 2, the next joins it.
		p.warm(0);
		expect(p.asked.map((j) => [j.id, j.jvm]).slice(4)).toEqual([
			['m-4', 2],
			['m-5', 2],
		]);
		expect(starts.map((s) => s.seen.places)).toEqual([[], [], [], [], [1], [2], [3, 1]]);

		// A match ending in a warm JVM makes room there: the last waiter goes at once, no boot.
		p.freed(0);
		expect(p.asked.at(-1)).toMatchObject({ id: 'm-6', jvm: 0 });
		expect(q.queue()).toEqual({ booting: 2, waiting: 0 });
	});

	it('a factory that says nothing about room boots nothing, and every start goes at once', () => {
		const asked: string[] = [];
		const bare = ((id: string) => {
			asked.push(id);
			return { send: () => undefined, stop: () => undefined };
		}) as unknown as MatchHostFactory;
		const q = queueColdStarts(bare, 1, () => {});
		for (const id of ['m-0', 'm-1', 'm-2']) q(id, SPEC, events().ev);
		expect(asked).toEqual(['m-0', 'm-1', 'm-2']);
		expect(q.queue()).toEqual({ booting: 0, waiting: 0 });
	});

	it('a waiting start keeps what its match asks of it and hands it on, in order, once it is placed', () => {
		const p = pool(1);
		const q = queueColdStarts(p.factory, 1, () => {});
		q('m-0', SPEC, events().ev);
		const host = q('m-1', SPEC, events().ev);
		host.remember?.({ epoch: 'e', owners: ['x'] });
		host.send({ t: 'stop' } as BridgeCommand);
		expect(host.handOver?.()).toBe(false);
		p.warm(0);
		expect(p.asked[1]!.remembered).toEqual([{ epoch: 'e', owners: ['x'] }]);
		expect(p.asked[1]!.sent).toEqual([{ t: 'stop' }]);
	});

	it('a waiting start that is stopped leaves the queue, exits after stop returns, and moves those behind it up', async () => {
		const p = pool(1);
		const q = queueColdStarts(p.factory, 1, () => {});
		q('m-0', SPEC, events().ev);
		const b = events();
		const c = events();
		const host = q('m-1', SPEC, b.ev);
		q('m-2', SPEC, c.ev);
		host.stop();
		expect(b.seen.exits).toEqual([]);
		await Promise.resolve();
		expect(b.seen.exits).toEqual(['stopped before its JVM started']);
		expect(c.seen.places).toEqual([2, 1]);
		p.warm(0);
		expect(p.asked.map((j) => j.id)).toEqual(['m-0', 'm-2']);
	});

	it('closing drops every waiter with a reason; a factory that throws throws to its caller', () => {
		let fail = true;
		const p = pool(1);
		const throwing = Object.assign((id: string, spec: MatchSpec, ev: HostEvents) => {
			if (fail) throw new Error('no run dir');
			return p.factory(id, spec, ev);
		}, { room: p.factory.room, booting: p.factory.booting, watchRoom: p.factory.watchRoom }) as MatchHostFactory;
		const q = queueColdStarts(throwing, 1, () => {});
		expect(() => q('m-0', SPEC, events().ev)).toThrow('no run dir');
		expect(q.queue()).toEqual({ booting: 0, waiting: 0 });
		fail = false;
		q('m-1', SPEC, events().ev);
		const waiter = events();
		q('m-2', SPEC, waiter.ev);
		q.close?.();
		expect(waiter.seen.exits).toEqual(['the server is closing']);
	});

	// hosting-test-plan H5: a start the factory cannot make is refused the same way whether it waited or not.
	it('a waiter the factory cannot place is told why with the error itself, then exits', () => {
		let fail = false;
		const p = pool(1);
		const throwing = Object.assign((id: string, spec: MatchSpec, ev: HostEvents) => {
			if (fail) throw new Error('ENOSPC: no space left on device, write');
			return p.factory(id, spec, ev);
		}, { room: p.factory.room, booting: p.factory.booting, watchRoom: p.factory.watchRoom }) as MatchHostFactory;
		const q = queueColdStarts(throwing, 1, () => {});
		q('m-1', SPEC, events().ev);
		const waiter = events();
		const refused: Error[] = [];
		const told: StartEvents = { ...waiter.ev, unstartable: (err) => refused.push(err) };
		q('m-2', SPEC, told);
		expect(waiter.seen.places).toEqual([1]);
		fail = true;
		p.warm(0);
		expect(refused.map((e) => e.message)).toEqual(['ENOSPC: no space left on device, write']);
		expect(waiter.seen.exits).toEqual(['Forge could not be started: ENOSPC: no space left on device, write']);
		expect(q.queue()).toEqual({ booting: 0, waiting: 0 });
	});

	it('reads its limit from CARDTABLE_PLAY_COLD_STARTS, a whole number of at least 1', () => {
		expect(coldStartsFrom({})).toBe(COLD_STARTS);
		expect(coldStartsFrom({ CARDTABLE_PLAY_COLD_STARTS: '3' })).toBe(3);
		for (const bad of ['0', '-1', '1.5', 'two', ' ']) expect(coldStartsFrom({ CARDTABLE_PLAY_COLD_STARTS: bad })).toBe(COLD_STARTS);
	});
});
