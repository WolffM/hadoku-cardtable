import { describe, expect, it } from 'vitest';

import { decodeSoundPack, encodeSoundPack } from './sound-pack.ts';
import { cueTakes } from './sounds.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: ArrayBuffer | undefined): string => new TextDecoder().decode(b);

describe('the sound pack', () => {
	it('gives back every take, each in a buffer of its own', () => {
		const body = encodeSoundPack([
			{ file: 'a/take-1.ogg', bytes: bytes('first') },
			{ file: 'b/take-2.ogg', bytes: bytes('') },
			{ file: 'c/take-3.ogg', bytes: bytes('third take') },
		]);
		const takes = decodeSoundPack(body.slice().buffer)!;
		expect([...takes.keys()]).toEqual(['a/take-1.ogg', 'b/take-2.ogg', 'c/take-3.ogg']);
		expect([...takes.values()].map(text)).toEqual(['first', '', 'third take']);
		expect(new Set(takes.values()).size).toBe(3);
	});

	it('is not a pack when it is cut short, runs on, or is not one at all', () => {
		const body = encodeSoundPack([{ file: 'a/take-1.ogg', bytes: bytes('first') }]);
		expect(decodeSoundPack(body.slice(0, body.length - 1).buffer)).toBeNull();
		expect(decodeSoundPack(new Uint8Array([...body, 0]).buffer)).toBeNull();
		expect(decodeSoundPack(bytes('<html>edge error</html>').slice().buffer)).toBeNull();
		expect(decodeSoundPack(new ArrayBuffer(2))).toBeNull();
	});
});

describe('cueTakes', () => {
	it('is every take off the music bus, once each, sorted', () => {
		expect(
			cueTakes({
				'ui.select|play': ['b/take-1.ogg'],
				'g.tap|play': ['b/take-1.ogg', 'a/take-1.ogg'],
				'W|creature': ['w/take-1.ogg'],
				'music.match|play': ['music-a/take-1.ogg'],
				'music.match.WU|play': ['music-b/take-1.ogg'],
			}),
		).toEqual(['a/take-1.ogg', 'b/take-1.ogg', 'w/take-1.ogg']);
	});
});
