import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { callerOf } from './request.ts';

const reqOf = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

describe('callerOf', () => {
	it('carries the edge verification beside the userId', () => {
		const caller = callerOf(reqOf({ 'x-user-id': 'u-1', 'x-user-name': 'Ann', 'x-hadoku-verified': '1' }));
		expect(caller).toMatchObject({ name: 'Ann', userId: 'u-1', verified: true });
	});

	it('reads a caller with no verification header as not verified', () => {
		expect(callerOf(reqOf({ 'x-user-id': 'u-2', 'x-user-name': 'Bo' })).verified).toBe(false);
	});
});
