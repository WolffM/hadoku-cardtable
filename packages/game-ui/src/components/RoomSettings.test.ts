// @vitest-environment jsdom
/*
 * The generic Room settings panel, drawn from a game's declaration: a row per field it can draw, the
 * leader's to change one field at a time, everybody else's to read, and a `LIVE` field locked while a
 * match is live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { z } from 'zod';
import { LIVE, bounded, choice, custom, defineRoomSettings, toggle } from '@hadoku/platform-wire/room-settings';

import { RoomSettingsPanel, settingTestId } from './RoomSettings.tsx';

afterEach(cleanup);

const SPEC = defineRoomSettings({
	mode: choice(['classic', 'roguelike', 'sandbox'], 'classic', { label: 'Mode', lock: LIVE, labels: { classic: 'Classic', roguelike: 'Roguelike', sandbox: 'Sandbox' } }),
	pickTimer: toggle(true, { label: 'Pick timer', lock: LIVE }),
	lives: bounded({ min: 1, max: 9 }, 3, { label: 'Lives' }),
	rope: custom(z.strictObject({ on: z.boolean() }), { on: false }, { label: 'Rope', must: 'must be { on: boolean }' }),
});

function panel(over: Partial<Parameters<typeof RoomSettingsPanel>[0]> = {}) {
	const onChange = vi.fn();
	render(createElement(RoomSettingsPanel, { spec: SPEC, value: SPEC.defaults(), leader: true, onChange, ...over }));
	fireEvent.click(screen.getByTestId('room-settings'));
	return onChange;
}

const labels = (): (string | null)[] => [...screen.getByTestId('room-settings-popover').querySelectorAll('.room-settings__label')].map((el) => el.textContent);

describe('RoomSettingsPanel', () => {
	it('draws a row per field it can draw, in the declaration’s order; a custom field is the game’s own to draw', () => {
		panel();
		expect(screen.getByTestId('room-settings').textContent).toBe('Room settings');
		expect(labels()).toEqual(['Mode', 'Pick timer', 'Lives']);
		expect((screen.getByTestId('mode-classic') as HTMLInputElement).checked).toBe(true);
		expect(screen.getByTestId('pick-timer').getAttribute('aria-pressed')).toBe('true');
		expect((screen.getByTestId('lives') as HTMLInputElement).value).toBe('3');
	});

	it('the leader changes one field at a time, as the PATCH takes it', () => {
		const onChange = panel();
		fireEvent.click(screen.getByTestId('mode-sandbox'));
		fireEvent.click(screen.getByTestId('pick-timer'));
		fireEvent.change(screen.getByTestId('lives'), { target: { value: '5' } });
		expect(onChange.mock.calls).toEqual([[{ mode: 'sandbox' }], [{ pickTimer: false }], [{ lives: 5 }]]);
	});

	it('a number out of its range is never sent', () => {
		const onChange = panel();
		fireEvent.change(screen.getByTestId('lives'), { target: { value: '12' } });
		expect(onChange).not.toHaveBeenCalled();
	});

	it('everybody else reads it, every control disabled', () => {
		panel({ leader: false });
		expect((screen.getByTestId('mode-roguelike') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId('pick-timer') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('lives') as HTMLInputElement).disabled).toBe(true);
	});

	it('while a match is live, a LIVE field is locked and wears the lock; a field with no lock is not', () => {
		panel({ live: true });
		expect((screen.getByTestId('mode-roguelike') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId('pick-timer') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('lives') as HTMLInputElement).disabled).toBe(false);
		const locked = [...screen.getByTestId('room-settings-popover').querySelectorAll('.room-settings__label[data-locked="true"]')].map((el) => el.textContent);
		expect(locked).toEqual(['Mode', 'Pick timer']);
	});

	it('a lock of the game’s own holds as the game says', () => {
		const spec = defineRoomSettings({ decks: toggle(false, { label: 'Decks', lock: 'event' }) });
		render(createElement(RoomSettingsPanel, { spec, value: spec.defaults(), leader: true, onChange: vi.fn(), locked: (lock: string) => lock === 'event' }));
		fireEvent.click(screen.getByTestId('room-settings'));
		expect((screen.getByTestId('decks') as HTMLButtonElement).disabled).toBe(true);
	});

	it('`only` draws those fields in that order, and a declaration with nothing to draw draws no button', () => {
		panel({ only: ['lives', 'mode', 'rope'] });
		expect(labels()).toEqual(['Lives', 'Mode']);
		cleanup();
		const { container } = render(createElement(RoomSettingsPanel, { spec: SPEC, value: SPEC.defaults(), leader: true, onChange: vi.fn(), only: ['rope'] }));
		expect(container.innerHTML).toBe('');
	});

	it('names a field’s test id after its key', () => {
		expect(settingTestId('pickTimer')).toBe('pick-timer');
		expect(settingTestId('mode')).toBe('mode');
	});
});
