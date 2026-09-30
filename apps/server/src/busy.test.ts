import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { busyHandler, busyReport, isLocalProbe, type BusyReport, type BusySources } from './busy.js';

const src = (over: Partial<BusySources> = {}): BusySources => ({ matches: () => [], drafts: () => [], ...over });
const match = (status: string) => ({ id: 'm1', status, seats: [{}, {}] });

describe('busyReport: destroyable work only', () => {
	it('idle server is idle', () => expect(busyReport(src())).toEqual({ busy: false, count: 0, runs: [] }));
	it('starting and running matches are busy', () => {
		for (const s of ['starting', 'running']) expect(busyReport(src({ matches: () => [match(s)] })).busy).toBe(true);
	});
	it('finished matches are not', () => {
		for (const s of ['over', 'failed', 'stopped']) expect(busyReport(src({ matches: () => [match(s)] })).busy).toBe(false);
	});
	it('a drafting pod is busy, a complete one is not', () => {
		expect(busyReport(src({ drafts: () => [{ id: 'd', status: 'drafting', packNumber: 2, pickNumber: 7 }] })).runs[0].label).toBe('pack 2 pick 7');
		expect(busyReport(src({ drafts: () => [{ id: 'd', status: 'complete' }] })).busy).toBe(false);
	});
	it('never carries a display name', () => {
		const r = busyReport(src({ matches: () => [{ ...match('running'), seats: [{ name: 'alice' }, { name: 'bob' }] }] }));
		expect(JSON.stringify(r)).not.toMatch(/alice|bob/);
	});
});

describe('isLocalProbe', () => {
	const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
		({ socket: { remoteAddress }, headers }) as never;
	it('accepts loopback without proxy headers', () => {
		for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLocalProbe(req(a))).toBe(true);
	});
	it('rejects non-loopback and unknown addresses', () => {
		expect(isLocalProbe(req('10.0.0.5'))).toBe(false);
		expect(isLocalProbe(req(undefined))).toBe(false);
	});
	it('rejects loopback that came through Cloudflare or the edge', () => {
		for (const h of ['cf-ray', 'cf-connecting-ip', 'x-forwarded-for', 'x-edge-auth', 'x-real-ip'])
			expect(isLocalProbe(req('127.0.0.1', { [h]: 'x' }))).toBe(false);
	});
});

describe('busyHandler over real HTTP', () => {
	let server: Server | undefined;
	afterEach(() => void server?.close());
	const get = async (s: BusySources, headers: Record<string, string> = {}) => {
		const app = express();
		app.get('/health/busy', busyHandler(s));
		server = createServer(app);
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
		return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health/busy`, { headers });
	};
	it('answers a local caller', async () => {
		const res = await get(src({ matches: () => [match('running')] }));
		expect(res.status).toBe(200);
		expect(((await res.json()) as BusyReport).busy).toBe(true);
	});
	it('404s, with no data, anything that came through Cloudflare even while a match is live', async () => {
		const res = await get(src({ matches: () => [match('running')] }), { 'cf-ray': 'abc' });
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('');
	});
	it('fails SAFE: if computing throws it says busy, not idle', async () => {
		const res = await get(src({ matches: () => { throw new Error('boom'); } }));
		const body = (await res.json()) as BusyReport;
		expect(body.busy).toBe(true);
		expect(body.runs[0].kind).toBe('unknown');
	});
});
