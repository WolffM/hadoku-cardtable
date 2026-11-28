import { afterEach, describe, expect, it } from 'vitest';
import * as inspector from 'node:inspector';
import { toggleInspector } from './inspector.ts';

afterEach(() => {
	if (inspector.url() !== undefined) inspector.close();
});

describe('toggleInspector: SIGUSR1 on a free loopback port', () => {
	it('opens the inspector on loopback and says where, then closes it on the next signal', () => {
		const lines: Record<string, unknown>[] = [];
		toggleInspector((l) => void lines.push(l));
		const url = inspector.url();
		expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
		// Never node's default 9229, which another process on the host may hold.
		expect(url).not.toMatch(/:9229\//);
		expect(lines).toEqual([{ evt: 'inspector-open', url }]);
		toggleInspector((l) => void lines.push(l));
		expect(inspector.url()).toBeUndefined();
		expect(lines.at(-1)).toEqual({ evt: 'inspector-closed' });
	});
});
