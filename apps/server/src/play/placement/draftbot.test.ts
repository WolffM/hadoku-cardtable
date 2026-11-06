/**
 * The draft bot's claws and failover, over fake agent links and a fake clock: which claws are told
 * to run it, the primary-then-backup call, and the alerts.
 */

import { describe, expect, it } from 'vitest';

import type { DraftbotHealth, ToAgent } from '../remote/wire.js';
import { Alerts } from './alerts.js';
import { ClawDraftbots, DRAFTBOT_DOWN_MS, DRAFTBOT_PRIMARY_MS, DRAFTBOT_RETRY_MS, DRAFTBOT_START_MS, type DraftbotClaw } from './draftbot.js';

const SHA = 'a'.repeat(64);
const INPUTS = [{ pack: ['x', 'y'], pool: [] }];
const RATED = [[{ oracle: 'x', rating: 0.9 }, { oracle: 'y', rating: 0.1 }]];

interface FakeLink {
	sent: ToAgent[];
	lost: string | null;
	health: DraftbotClaw['client']['health'];
	/** What its agent answers a draft bot call with: an answer, a refusal, or never. */
	answer: 'ok' | 'fail' | 'hang' | 'short';
	calls: number;
}

function link(): FakeLink & DraftbotClaw['client'] {
	const l: FakeLink & DraftbotClaw['client'] = {
		sent: [],
		lost: null,
		health: { at: 0, jvms: [], slice: { cgroup: null, delegated: false, memoryMaxMb: 4096, memoryCurrentMb: null, memoryEvents: {}, cpuStat: {}, cpus: 4 }, draftbot: null },
		answer: 'ok',
		calls: 0,
		send: (m) => void l.sent.push(m),
		call: <T,>(_method: string, _path: string, _body?: unknown, signal?: AbortSignal): Promise<T> => {
			l.calls += 1;
			if (l.answer === 'fail') return Promise.reject(new Error('agent POST /draftbot/batchdraft: 503 the draft bot is down here'));
			if (l.answer === 'short') return Promise.resolve({ success: true, results: [] } as T);
			if (l.answer === 'ok') return Promise.resolve({ success: true, results: RATED } as T);
			return new Promise<T>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
		},
	};
	return l;
}

function rig(names: string[]) {
	const clock = { t: Date.parse('2026-11-06T20:00:00Z') };
	const posted: string[] = [];
	const alerts = new Alerts({ sink: { post: (t) => (posted.push(t), Promise.resolve()) }, now: () => clock.t });
	const bots = new ClawDraftbots({ alerts, now: () => clock.t });
	const links = new Map(names.map((n) => [n, link()]));
	const claws = new Map<string, DraftbotClaw>(names.map((n) => [n, { name: n, client: links.get(n)!, usable: true, sha: SHA, error: null }]));
	/** The agent's heartbeat says this about its draft bot. */
	const report = (name: string, state: DraftbotHealth['state'] | null, error: string | null = null): void => {
		links.get(name)!.health!.draftbot = state === null ? null : { sha: SHA, state, pid: 1, memoryMb: 1200, restarts: 0, error, since: clock.t };
	};
	/** What each agent's heartbeat says once it has done what it was last told. */
	const obey = (): void => {
		for (const [name, l] of links) {
			const last = l.sent.at(-1);
			if (last?.op === 'draftbot') report(name, last.sha === null ? null : 'up');
		}
	};
	const step = (): void => bots.step([...claws.values()].filter((c) => c.client.lost === null));
	return { clock, posted, bots, links, claws, report, obey, step };
}

const told = (l: FakeLink): (string | null)[] => l.sent.flatMap((m) => (m.op === 'draftbot' ? [m.sha] : []));

describe('the draft bot on the claws', () => {
	it('runs on the first two usable claws that hold it, in placement order, and on no other', () => {
		const r = rig(['claw-8', 'claw-9', 'claw-10']);
		r.claws.get('claw-8')!.usable = false;
		r.step();
		expect(r.bots.view().chosen).toEqual(['claw-9', 'claw-10']);
		expect(told(r.links.get('claw-9')!)).toEqual([SHA]);
		expect(told(r.links.get('claw-10')!)).toEqual([SHA]);
		// claw-8 runs nothing, and its heartbeat already says so: nothing to tell it.
		expect(told(r.links.get('claw-8')!)).toEqual([]);
		expect(r.bots.runsOn('claw-8')).toBe(false);
		expect(r.bots.runsOn('claw-9')).toBe(true);
	});

	it('repeats the order until the heartbeat shows it obeyed (an agent that restarted is told again)', () => {
		const r = rig(['claw-8']);
		r.step();
		r.step();
		expect(told(r.links.get('claw-8')!)).toEqual([SHA, SHA]);
		r.obey();
		r.step();
		expect(told(r.links.get('claw-8')!)).toEqual([SHA, SHA]);
		r.report('claw-8', null);
		r.step();
		expect(told(r.links.get('claw-8')!)).toEqual([SHA, SHA, SHA]);
	});

	it('picks again when a chosen claw is lost or stops being usable, and stops it on the claw passed over', () => {
		const r = rig(['claw-8', 'claw-9', 'claw-10']);
		r.step();
		r.obey();
		r.links.get('claw-8')!.lost = 'agent heartbeat lost for 11 s';
		r.step();
		expect(r.bots.view().chosen).toEqual(['claw-9', 'claw-10']);
		r.obey();
		r.claws.get('claw-9')!.usable = false;
		r.step();
		expect(r.bots.view().chosen).toEqual(['claw-10']);
		expect(told(r.links.get('claw-9')!).at(-1)).toBeNull();
	});

	it('asks the primary, then the backup when the primary fails or is slow, and rejects when both fail', async () => {
		const r = rig(['claw-8', 'claw-9']);
		r.step();
		r.obey();
		const [a, b] = [r.links.get('claw-8')!, r.links.get('claw-9')!];
		expect(await r.bots.batchDraft(INPUTS, new AbortController().signal)).toEqual(RATED);
		expect([a.calls, b.calls]).toEqual([1, 0]);

		a.answer = 'fail';
		expect(await r.bots.batchDraft(INPUTS, new AbortController().signal)).toEqual(RATED);
		expect([a.calls, b.calls]).toEqual([2, 1]);

		a.answer = 'hang';
		const started = Date.now();
		expect(await r.bots.batchDraft(INPUTS, new AbortController().signal)).toEqual(RATED);
		expect(Date.now() - started).toBeGreaterThanOrEqual(DRAFTBOT_PRIMARY_MS - 20);

		b.answer = 'short';
		a.answer = 'fail';
		await expect(r.bots.batchDraft(INPUTS, new AbortController().signal)).rejects.toThrow('draftbot on claw-9: answered 0 packs for 1');

		// The caller's own deadline ends the backup too.
		b.answer = 'hang';
		await expect(r.bots.batchDraft(INPUTS, AbortSignal.timeout(50))).rejects.toThrow('draftbot on claw-9: aborted');
	});

	it('skips a claw whose service is not up, and rejects at once when none is', async () => {
		const r = rig(['claw-8', 'claw-9']);
		r.step();
		r.obey();
		r.report('claw-8', 'starting');
		expect(await r.bots.batchDraft(INPUTS, new AbortController().signal)).toEqual(RATED);
		expect(r.links.get('claw-8')!.calls).toBe(0);
		r.report('claw-9', 'down');
		await expect(r.bots.batchDraft(INPUTS, new AbortController().signal)).rejects.toThrow('no claw runs the draft bot now');
	});

	it('gives a claw whose service is refused or will not come up to the next one, with one alert, and tries it again later', () => {
		const r = rig(['claw-8', 'claw-9', 'claw-10']);
		r.step();
		r.obey();
		r.report('claw-8', 'refused', 'does not fit: 4136 MB needed (its 1536 MB beside the JVMs here) in a 4096 MB slice');
		r.step();
		expect(r.bots.view()).toEqual({ chosen: ['claw-9', 'claw-10'], failing: ['claw-8'] });
		expect(r.posted).toEqual([expect.stringMatching(/^⚠️ Draft bot will not run on claw-8: refused: does not fit/)]);

		r.obey();
		r.report('claw-9', 'down', 'exited SIGKILL');
		r.clock.t += DRAFTBOT_START_MS - 1000;
		r.step();
		expect(r.bots.view().chosen).toEqual(['claw-9', 'claw-10']);
		r.clock.t += 2000;
		r.step();
		expect(r.bots.view().chosen).toEqual(['claw-10']);
		expect(r.posted).toHaveLength(2);
		expect(r.posted[1]).toMatch(/^⚠️ Draft bot will not run on claw-9: down for 91 s \(exited SIGKILL\)/);
		r.obey();
		expect(r.links.get('claw-9')!.health!.draftbot).toBeNull();

		r.clock.t += DRAFTBOT_RETRY_MS;
		r.step();
		expect(r.bots.view()).toEqual({ chosen: ['claw-8', 'claw-9'], failing: [] });
		r.obey();
		r.step();
		expect(r.posted.slice(2)).toEqual([expect.stringMatching(/^✅ Draft bot up on claw-8 again/), expect.stringMatching(/^✅ Draft bot up on claw-9 again/)]);
	});

	it('alerts once when no draft bot has been up for five minutes, and says so when one is back', () => {
		const r = rig(['claw-8', 'claw-9']);
		const why = 'draftbot 2cc347d2b897: git clone: could not read from remote repository';
		for (const c of r.claws.values()) Object.assign(c, { sha: null, error: why });
		r.step();
		r.clock.t += DRAFTBOT_DOWN_MS;
		r.step();
		expect(r.posted).toEqual([]);
		r.clock.t += 60_000;
		r.step();
		r.clock.t += 60_000;
		r.step();
		expect(r.posted).toEqual([`⚠️ No ML draft bot has been up for 6 min (claw-8: no artifact (${why}); claw-9: no artifact (${why})). Draft bots pick by the pick order meanwhile.`]);
		r.claws.get('claw-8')!.sha = SHA;
		r.step();
		r.obey();
		r.step();
		expect(r.posted.at(-1)).toMatch(/^✅ ML draft bot answering again on claw-8/);
	});
});
