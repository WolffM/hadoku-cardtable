import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { UNNAMED } from '../room/constants.ts';
import type { Caller } from '../room/caller.ts';
import { callerOf } from './request.ts';

const reqOf = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

describe('callerOf', () => {
	it('carries the display name and the userId, and nothing about verification (the tier says that)', () => {
		const caller = callerOf(reqOf({ 'x-user-id': 'u-1', 'x-user-name': 'Ann', 'x-hadoku-verified': '1' }));
		expect(caller).toEqual({ id: caller.id, name: 'Ann', userId: 'u-1' });
	});

	it("names a caller the edge sent no name for with the lobby's own UNNAMED, as a lobby Caller", () => {
		// request.ts copies UNNAMED rather than import room/lobby.ts (a platform→tangled edge); this pins the copy.
		const caller: Caller = callerOf(reqOf({ 'x-user-id': 'u-3' }));
		expect(caller.name).toBe(UNNAMED);
	});
});
