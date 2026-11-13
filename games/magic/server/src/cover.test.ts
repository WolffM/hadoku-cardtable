import { describe, expect, it } from 'vitest';

import { coverSvg } from './cover.js';

describe('the game-picker cover', () => {
	it('is our own drawing: an SVG that loads nothing', () => {
		const svg = coverSvg();
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
		expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/href|https?:|<image/);
	});

	it('fans three card backs', () => {
		expect(coverSvg().match(/rotate\(/g)).toHaveLength(3);
	});
});
