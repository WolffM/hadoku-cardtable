import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { callerOf } from './request.ts';

const reqOf = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

describe('callerOf', () => {
	it('carries the edge vouch beside the userId', () => {
		const caller = callerOf(reqOf({ 'x-user-id': 'u-1', 'x-user-name': 'Ann', 'x-hadoku-vouched': '1' }));
		expect(caller).toMatchObject({ name: 'Ann', userId: 'u-1', vouched: true });
	});

	it('reads a caller with no vouch header as not vouched', () => {
		expect(callerOf(reqOf({ 'x-user-id': 'u-2', 'x-user-name': 'Bo' })).vouched).toBe(false);
	});
});
