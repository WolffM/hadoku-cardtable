/**
 * The alert channel under a burst (2026-11-09): three claws recovering in one second resolved six
 * incidents, two per claw in the same words, and the seventh post met Discord's `429` and was lost.
 */

import { describe, expect, it } from 'vitest';

import { Alerts, ALERT_POST_TRIES, discordSink, RateLimited, type AlertSink } from './alerts.js';

function rig(sink: AlertSink): { alerts: Alerts; logs: Record<string, unknown>[]; waits: number[]; clock: { t: number } } {
	const logs: Record<string, unknown>[] = [];
	const waits: number[] = [];
	const clock = { t: 1_000_000 };
	const alerts = new Alerts({
		sink,
		now: () => clock.t,
		log: (e) => logs.push(e),
		sleep: (ms) => {
			waits.push(ms);
			return Promise.resolve();
		},
	});
	return { alerts, logs, waits, clock };
}

describe('alerts', () => {
	it("posts a claw's recovery once, though its failover and its lost incident both resolve with it", async () => {
		const posted: string[] = [];
		const { alerts, logs, clock } = rig({ post: (t) => (posted.push(t), Promise.resolve()) });
		alerts.fire('failover:claw-9', '🚨 Failover: claw-9');
		alerts.fire('lost:claw-9', '🚨 Match lost: 1 on claw-9');
		clock.t += 515_000;
		alerts.resolve('failover:claw-9', 'Recovered: claw-9 passed its canary and takes matches again');
		alerts.resolve('lost:claw-9', 'Recovered: claw-9 passed its canary and takes matches again');
		await alerts.settled();
		expect(posted).toEqual(['🚨 Failover: claw-9', '🚨 Match lost: 1 on claw-9', '✅ Recovered: claw-9 passed its canary and takes matches again (open 515 s)']);
		expect(logs.filter((e) => e.evt === 'alert-same-text').map((e) => e.key)).toEqual(['lost:claw-9:resolved']);
	});

	it('a post Discord rate-limits waits what it was told and goes again, rather than being lost', async () => {
		const posted: string[] = [];
		let refusals = 2;
		const { alerts, logs, waits } = rig({
			post: (t) => {
				if (refusals-- > 0) return Promise.reject(new RateLimited(750));
				posted.push(t);
				return Promise.resolve();
			},
		});
		alerts.note('lost:claw-9:resolved', '✅ Recovered: claw-9');
		await alerts.settled();
		expect(posted).toEqual(['✅ Recovered: claw-9']);
		expect(waits).toEqual([750, 750]);
		expect(logs.some((e) => e.evt === 'alert-post-failed')).toBe(false);
	});

	it(`gives up after ${ALERT_POST_TRIES} tries, and on any failure that is not a rate limit, saying so`, async () => {
		const { alerts, logs } = rig({ post: () => Promise.reject(new RateLimited(10)) });
		alerts.note('a', 'limited for good');
		const broken = rig({ post: () => Promise.reject(new Error('discord answered 500')) });
		broken.alerts.note('b', 'server error');
		await Promise.all([alerts.settled(), broken.alerts.settled()]);
		expect(logs.find((e) => e.evt === 'alert-post-failed')).toMatchObject({ key: 'a', tries: ALERT_POST_TRIES });
		expect(broken.logs.find((e) => e.evt === 'alert-post-failed')).toMatchObject({ key: 'b', tries: 1, error: 'discord answered 500' });
	});

	it('says an incident is being held once, not on every tick that fires it again', () => {
		const { alerts, logs } = rig({ post: () => Promise.resolve() });
		for (let i = 0; i < 100; i++) alerts.fire('draftbot', '⚠️ No ML draft bot');
		expect(logs.filter((e) => e.evt === 'alert-held')).toHaveLength(1);
		alerts.resolve('draftbot', 'back');
		alerts.fire('draftbot', '⚠️ No ML draft bot');
		alerts.fire('draftbot', '⚠️ No ML draft bot');
		expect(logs.filter((e) => e.evt === 'alert-held' && e.why === 'the incident is open')).toHaveLength(2);
	});

	it("reads Discord's 429 wait from its body", async () => {
		const sink = discordSink('https://discord.invalid/hook', () => Promise.resolve(new Response(JSON.stringify({ retry_after: 1.25 }), { status: 429 })));
		await expect(sink.post('x')).rejects.toMatchObject({ retryAfterMs: 1250 });
	});
});
