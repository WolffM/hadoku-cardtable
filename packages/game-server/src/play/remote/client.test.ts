import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AgentClient, WATCH_STALL_MS } from './client.js';

function client() {
	const clock = { t: 1_000_000 };
	const logs: Record<string, unknown>[] = [];
	const c = new AgentClient({ url: 'http://claw-9:7621', key: generateKeyPairSync('ed25519').privateKey, fenceMs: 10_000, now: () => clock.t, log: (e) => logs.push(e) });
	const lost: string[] = [];
	c.onLost((r) => lost.push(r));
	/** One tick of the link clock every second for `ms`, as `connect`'s interval runs it. */
	const tick = (ms: number) => {
		for (let i = 0; i < ms / 1000; i++) {
			clock.t += 1000;
			c.watch();
		}
	};
	return { c, clock, logs, lost, tick };
}

describe('AgentClient link clock', () => {
	it('fails the claw after the fencing window of real silence', () => {
		const k = client();
		k.tick(10_000);
		expect(k.lost).toEqual([]);
		k.tick(1000);
		expect(k.lost).toEqual(['agent heartbeat lost for 11 s (window 10 s)']);
	});

	it('does not count its own stall as the claw going silent (hokon, 2026-10-31 21:59Z)', () => {
		const k = client();
		k.tick(2000);
		// The process froze for 24 s: no tick ran, and the heartbeats that came are still unread.
		k.clock.t += 24_000;
		k.c.watch();
		expect(k.lost).toEqual([]);
		expect(k.logs).toContainEqual({ evt: 'agent-watch-stalled', agent: 'claw-9:7621', gapMs: 24_000, silentMs: 26_000 });
		// From the resume the claw has a whole window again, and real silence past it is still loss.
		k.tick(10_000);
		expect(k.lost).toEqual([]);
		k.tick(1000);
		expect(k.lost).toEqual(['agent heartbeat lost for 11 s (window 10 s)']);
	});

	it('reports only the silence it was awake to hear, while its own stall is not yet ticked (hokon, 2026-11-24 00:31Z)', () => {
		const k = client();
		k.tick(2000);
		// Another claw's loss ran first after the resume and asked every claw's silence before this
		// claw's tick did: its heartbeats are still unread, so 19 s of "silence" is mostly our own
		// stall. What counts is the 2 s it heard before it froze.
		k.clock.t += 17_000;
		expect(k.c.silentMs()).toBe(2000);
		k.c.watch();
		expect(k.c.silentMs()).toBe(0);
		k.clock.t += 2000;
		expect(k.c.silentMs()).toBe(2000);
	});

	it('a late tick inside the stall threshold is not a stall', () => {
		const k = client();
		k.tick(8000);
		k.clock.t += WATCH_STALL_MS;
		k.c.watch();
		expect(k.lost).toEqual(['agent heartbeat lost for 11 s (window 10 s)']);
	});
});
