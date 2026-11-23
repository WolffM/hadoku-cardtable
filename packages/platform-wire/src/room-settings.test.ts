import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LIVE, bounded, choice, custom, defineRoomSettings, toggle } from './room-settings.ts';

// bomberman's, the first relay game to declare any.
const spec = defineRoomSettings(
	{
		mode: choice(['classic', 'roguelike', 'sandbox'], 'classic', { label: 'Mode', lock: LIVE, labels: { roguelike: 'Roguelike' } }),
		pickTimer: toggle(true, { label: 'Pick timer', lock: LIVE }),
		lives: bounded({ min: 1, max: 9 }, 3, { label: 'Lives' }),
		rope: custom(z.strictObject({ on: z.boolean() }), { on: false }, { label: 'Rope', must: 'must be { on: boolean }', lock: 'event' }),
	},
	{ retired: ['oldThing'] },
);

describe('defineRoomSettings', () => {
	it('declares its fields in order, with labels for each choice', () => {
		expect(spec.keys).toEqual(['mode', 'pickTimer', 'lives', 'rope']);
		expect(spec.fields.mode.choices).toEqual([
			{ value: 'classic', label: 'classic' },
			{ value: 'roguelike', label: 'Roguelike' },
			{ value: 'sandbox', label: 'sandbox' },
		]);
	});

	it('hands out fresh defaults every time', () => {
		const a = spec.defaults();
		expect(a).toEqual({ mode: 'classic', pickTimer: true, lives: 3, rope: { on: false } });
		a.rope.on = true;
		expect(spec.defaults().rope.on).toBe(false);
	});

	it('the whole-object schema needs every field and nothing else', () => {
		expect(spec.schema.safeParse(spec.defaults()).success).toBe(true);
		expect(spec.schema.safeParse({ mode: 'classic' }).success).toBe(false);
		expect(spec.schema.safeParse({ ...spec.defaults(), extra: 1 }).success).toBe(false);
	});
});

describe('parsePatch', () => {
	it('takes some fields', () => {
		expect(spec.parsePatch({ mode: 'sandbox' })).toEqual({ ok: true, patch: { mode: 'sandbox' } });
	});

	it.each([
		[null, 'settings must be an object'],
		[[], 'settings must be an object'],
		[{}, 'settings names no setting'],
		[{ mode: 'classic', speed: 2, x: 1 }, 'unknown setting(s): speed, x'],
		[{ constructor: 1 }, 'unknown setting(s): constructor'],
		[{ mode: 'chess', speed: 2 }, 'settings.mode must be one of: classic, roguelike, sandbox'],
		[{ mode: 'chess' }, 'settings.mode must be one of: classic, roguelike, sandbox'],
		[{ pickTimer: 'yes' }, 'settings.pickTimer must be a boolean'],
		[{ lives: 10 }, 'settings.lives must be an integer 1–9'],
		[{ lives: 2.5 }, 'settings.lives must be an integer 1–9'],
		[{ rope: { on: 1 } }, 'settings.rope must be { on: boolean }'],
	])('refuses %j: %s', (raw, error) => {
		expect(spec.parsePatch(raw)).toEqual({ ok: false, error });
	});

	it('a fractional step takes any number in range', () => {
		const s = defineRoomSettings({ speed: bounded({ min: 0.25, max: 4, step: 0.25 }, 1, { label: 'Speed' }) });
		expect(s.parsePatch({ speed: 0.5 }).ok).toBe(true);
		expect(s.parsePatch({ speed: 5 })).toEqual({ ok: false, error: 'settings.speed must be a number 0.25–4' });
	});
});

describe('readStored', () => {
	it('a room from before settings reads as the defaults', () => {
		expect(spec.readStored(undefined)).toEqual(spec.defaults());
	});

	it('fills what is missing and drops what is retired', () => {
		expect(spec.readStored({ mode: 'sandbox', oldThing: 'anything' })).toEqual({ ...spec.defaults(), mode: 'sandbox' });
	});

	it.each([[null], ['classic'], [{ nope: 1 }], [{ toString: 1 }], [{ mode: 'chess' }]])('%j is no settings at all', (raw) => {
		expect(spec.readStored(raw)).toBeNull();
	});
});

describe('apply', () => {
	const open = () => null;

	it('changes what moves and says which', () => {
		const result = spec.apply(spec.defaults(), { mode: 'sandbox', pickTimer: true }, open);
		expect(result).toEqual({ ok: true, next: { ...spec.defaults(), mode: 'sandbox' }, changed: ['mode'] });
	});

	it('a value that does not move is no change, even locked', () => {
		const result = spec.apply(spec.defaults(), { mode: 'classic', rope: { on: false } }, () => 'match-live');
		expect(result).toEqual({ ok: true, next: spec.defaults(), changed: [] });
	});

	it('a moving field under a held lock refuses the whole patch', () => {
		const asked: string[] = [];
		const result = spec.apply(spec.defaults(), { lives: 5, mode: 'sandbox' }, (lock) => {
			asked.push(lock);
			return lock === LIVE ? 'match-live' : null;
		});
		expect(result).toEqual({ ok: false, reason: 'match-live' });
		expect(asked).toEqual([LIVE]);
	});

	it('a field with no lock changes during a match', () => {
		expect(spec.apply(spec.defaults(), { lives: 5 }, () => 'match-live')).toMatchObject({ ok: true, changed: ['lives'] });
	});

	it('never shares a value with the patch', () => {
		const patch = { rope: { on: true } };
		const result = spec.apply(spec.defaults(), patch, open);
		patch.rope.on = false;
		expect(result.ok && result.next.rope.on).toBe(true);
	});
});
