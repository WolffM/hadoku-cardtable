import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { rankOf, tierOf } from '../auth/index.ts';
import { createGate } from './index.ts';

/** A minimal sanitizeHeaders stand-in: believes an `x-edge-auth: ok` header, else degrades to public. */
function sanitizeHeaders(headers: Record<string, unknown>): void {
	if (headers['x-edge-auth'] !== 'ok') {
		headers['x-hadoku-tier'] = 'public';
		delete headers['x-user-id'];
	}
}

function edgeProvenance(req: Request, _res: Response, next: NextFunction): void {
	sanitizeHeaders(req.headers as Record<string, unknown>);
	next();
}

function newGate(minTier: string) {
	const reportSealRefused = vi.fn();
	const gate = createGate({ sanitizeHeaders, edgeProvenance, tierOf, rankOf, reportSealRefused, minTier: () => minTier });
	return { gate, reportSealRefused };
}

describe('createGate: knows no game, every dependency is injected', () => {
	it('floor sanitizes in place, then ranks the result against minTier', () => {
		const { gate } = newGate('friend');
		const headers: Record<string, unknown> = { 'x-edge-auth': 'ok', 'x-hadoku-tier': 'friend' };
		expect(gate.floor(headers, 'friend')).toEqual({ ok: true, tier: 'friend' });
		expect(gate.floor({ 'x-hadoku-tier': 'admin' }, 'friend')).toEqual({ ok: false, tier: 'public' });
	});

	it('floor promotes a verified member to friend, same as the auth module does', () => {
		const { gate } = newGate('friend');
		const headers = { 'x-edge-auth': 'ok', 'x-hadoku-tier': 'member', 'x-hadoku-verified': '1' };
		expect(gate.floor(headers, 'friend')).toEqual({ ok: true, tier: 'friend' });
	});

	it('requireMinTier reads minTier live: a floor the app changes at runtime takes effect on the next call', () => {
		let minTier = 'friend';
		const reportSealRefused = vi.fn();
		const gate = createGate({ sanitizeHeaders, edgeProvenance, tierOf, rankOf, reportSealRefused, minTier: () => minTier });
		const req = { headers: { 'x-edge-auth': 'ok', 'x-hadoku-tier': 'member' }, path: '/x' } as unknown as Request;
		let passed = false;
		const res = { status: () => res, type: () => res, send: () => res } as unknown as Response;
		gate.requireMinTier(req, res, () => {
			passed = true;
		});
		expect(passed).toBe(false);

		minTier = 'member';
		gate.requireMinTier(req, res, () => {
			passed = true;
		});
		expect(passed).toBe(true);
	});

	it('requireMinTier reports seal-refused under the "http" surface, with the request path', () => {
		const { gate, reportSealRefused } = newGate('friend');
		const req = { headers: { 'x-hadoku-tier': 'public' }, path: '/secret' } as unknown as Request;
		const res = { status: () => res, type: () => res, send: () => res } as unknown as Response;
		gate.requireMinTier(req, res, () => undefined);
		expect(reportSealRefused).toHaveBeenCalledTimes(1);
		expect(reportSealRefused).toHaveBeenCalledWith('http', req.headers, '/secret');
	});

	it('requireMinTier answers 404, never 403: a private app does not confirm its own existence', () => {
		const { gate } = newGate('friend');
		const req = { headers: {}, path: '/x' } as unknown as Request;
		const status = vi.fn(() => res);
		const type = vi.fn(() => res);
		const send = vi.fn(() => res);
		const res = { status, type, send } as unknown as Response;
		gate.requireMinTier(req, res, () => undefined);
		expect(status).toHaveBeenCalledWith(404);
	});

	it('gateUpgrade reports under the app-supplied surface label, which can be any string the kernel has never heard of', () => {
		const { gate, reportSealRefused } = newGate('friend');
		const req = { headers: {}, url: '/ws' } as unknown as Parameters<typeof gate.gateUpgrade>[0];
		const result = gate.gateUpgrade(req, { minTier: 'friend', surface: 'a-surface-the-kernel-has-never-heard-of' });
		expect(result.ok).toBe(false);
		expect(reportSealRefused).toHaveBeenCalledWith('a-surface-the-kernel-has-never-heard-of', req.headers, '/ws');
	});

	it('gateUpgrade admits at the floor and reports nothing', () => {
		const { gate, reportSealRefused } = newGate('friend');
		const req = { headers: { 'x-edge-auth': 'ok', 'x-hadoku-tier': 'friend' }, url: '/ws' } as unknown as Parameters<
			typeof gate.gateUpgrade
		>[0];
		const result = gate.gateUpgrade(req, { minTier: 'friend', surface: 'stream' });
		expect(result.ok).toBe(true);
		expect(reportSealRefused).not.toHaveBeenCalled();
	});
});
