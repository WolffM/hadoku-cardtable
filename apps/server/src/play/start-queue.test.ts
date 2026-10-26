import { describe, expect, it } from 'vitest';

import type { BridgeCommand, BridgeLine, HostEvents, MatchHost, MatchHostFactory, MatchSpec } from './host.js';
import { COLD_STARTS, coldStartsFrom, queueColdStarts, type StartEvents } from './start-queue.js';

const SPEC = { seats: [] } as unknown as MatchSpec;
const READY: BridgeLine = { t: 'ready', forgePort: 1, bootMs: 1, seats: [] };

/** A pool that records every JVM asked for; `spare` is what its spare is. */
function pool(spare: 'none' | 'booting' | 'warm' = 'none') {
	const asked: { id: string; events: HostEvents; sent: BridgeCommand[]; remembered: unknown[]; stopped: boolean }[] = [];
	let watcher: (() => void) | null = null;
	const state = { spare };
	const factory = ((id: string, _spec: MatchSpec, events: HostEvents): MatchHost => {
		const jvm = { id, events, sent: [] as BridgeCommand[], remembered: [] as unknown[], stopped: false };
		asked.push(jvm);
		// Taking a warm spare leaves a booting replacement behind it, as `jvmHostFactory` does.
		if (state.spare === 'warm') state.spare = 'booting';
		return {
			send: (c) => jvm.sent.push(c),
			stop: () => {
				jvm.stopped = true;
			},
			remember: (r) => jvm.remembered.push(r),
		};
	}) as MatchHostFactory;
	factory.spare = () => state.spare;
	factory.watchSpare = (listener) => {
		watcher = listener;
	};
	return {
		factory,
		asked,
		state,
		spareWarms() {
			state.spare = 'warm';
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
	it('boots `limit` at once; each waiter is told its place as it moves, and boots when a slot frees', () => {
		const p = pool();
		const q = queueColdStarts(p.factory, 2, () => {});
		const starts = Array.from({ length: 5 }, (_, i) => ({ id: `m-${i}`, ...events() }));
		for (const s of starts) q(s.id, SPEC, s.ev);
		expect(p.asked.map((j) => j.id)).toEqual(['m-0', 'm-1']);
		expect(starts.map((s) => s.seen.places)).toEqual([[], [], [1], [2], [3]]);
		expect(q.queue()).toEqual({ booting: 2, waiting: 3 });

		// A JVM's first word ends its boot: the head of the queue starts.
		p.asked[0]!.events.line(READY);
		expect(starts[0]!.seen.lines).toBe(1);
		expect(p.asked.map((j) => j.id)).toEqual(['m-0', 'm-1', 'm-2']);
		expect(starts.map((s) => s.seen.places)).toEqual([[], [], [1], [2, 1], [3, 2]]);
		expect(starts.map((s) => s.seen.booting)).toEqual([1, 1, 1, 0, 0]);

		// A JVM that dies booting frees its slot too.
		p.asked[1]!.events.exit('crashed');
		expect(p.asked.map((j) => j.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
		expect(starts[1]!.seen.exits).toEqual(['crashed']);
		// Later lines from a booted JVM free nothing more.
		p.asked[0]!.events.line(READY);
		expect(q.queue()).toEqual({ booting: 2, waiting: 1 });
	});

	it('serves the warm spare first and holds no slot for it; a waiter takes the spare the moment it turns warm', () => {
		const p = pool('warm');
		const q = queueColdStarts(p.factory, 1, () => {});
		const [a, b, c] = [events(), events(), events()];
		q('m-a', SPEC, a.ev); // the warm spare
		q('m-b', SPEC, b.ev); // the booting replacement: a boot, holds the one slot
		q('m-c', SPEC, c.ev); // waits
		expect(p.asked.map((j) => j.id)).toEqual(['m-a', 'm-b']);
		expect(q.queue()).toEqual({ booting: 1, waiting: 1 });
		expect(c.seen.places).toEqual([1]);
		p.spareWarms();
		expect(p.asked.map((j) => j.id)).toEqual(['m-a', 'm-b', 'm-c']);
		expect(q.queue()).toEqual({ booting: 1, waiting: 0 });
	});

	it('a waiting start keeps what its match asks of it and hands it on, in order, once its JVM exists', () => {
		const p = pool();
		const q = queueColdStarts(p.factory, 1, () => {});
		q('m-0', SPEC, events().ev);
		const host = q('m-1', SPEC, events().ev);
		host.remember?.({ epoch: 'e', owners: ['x'] });
		host.send({ t: 'stop' } as BridgeCommand);
		expect(host.handOver?.()).toBe(false);
		p.asked[0]!.events.line(READY);
		expect(p.asked[1]!.remembered).toEqual([{ epoch: 'e', owners: ['x'] }]);
		expect(p.asked[1]!.sent).toEqual([{ t: 'stop' }]);
	});

	it('a waiting start that is stopped leaves the queue, exits after stop returns, and moves those behind it up', async () => {
		const p = pool();
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
		p.asked[0]!.events.line(READY);
		expect(p.asked.map((j) => j.id)).toEqual(['m-0', 'm-2']);
	});

	it('closing drops every waiter with a reason; a factory that throws gives its slot back', () => {
		let fail = true;
		const p = pool();
		const throwing = ((id: string, spec: MatchSpec, ev: HostEvents) => {
			if (fail) throw new Error('no run dir');
			return p.factory(id, spec, ev);
		}) as MatchHostFactory;
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

	it('reads its limit from CARDTABLE_PLAY_COLD_STARTS, a whole number of at least 1', () => {
		expect(coldStartsFrom({})).toBe(COLD_STARTS);
		expect(coldStartsFrom({ CARDTABLE_PLAY_COLD_STARTS: '3' })).toBe(3);
		for (const bad of ['0', '-1', '1.5', 'two', ' ']) expect(coldStartsFrom({ CARDTABLE_PLAY_COLD_STARTS: bad })).toBe(COLD_STARTS);
	});
});
