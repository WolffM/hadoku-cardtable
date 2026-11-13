import { describe, expect, it } from 'vitest';

import { AI_FLAT_MC, aiFlatMcFrom } from './local-jvm.ts';

describe('aiFlatMcFrom (CARDTABLE_AI_FLAT_MC)', () => {
	it('is the default when unset or blank', () => {
		expect(aiFlatMcFrom(undefined)).toBe(AI_FLAT_MC);
		expect(aiFlatMcFrom('  ')).toBe(AI_FLAT_MC);
	});

	it('takes each level, whatever its case', () => {
		expect(['off', 'base', 'lite', 'max', ' MAX ', 'Lite'].map(aiFlatMcFrom)).toEqual(['off', 'base', 'lite', 'max', 'max', 'lite']);
	});

	it('is off for anything that is not a level, so a typo never leaves it on', () => {
		expect(['of', '0', 'false', 'maximum', 'on'].map(aiFlatMcFrom)).toEqual(['off', 'off', 'off', 'off', 'off']);
	});
});
