// @vitest-environment jsdom
/*
 * Cardtable's own settings outside a match: the gear's popover carries the game
 * section too (the operator, 2026-10-10), on the saved preferences alone. A
 * match reads the same preferences on join (`play/live/LiveBoard.test.ts`
 * proves that half), so a choice made here is the next match's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const store = vi.hoisted(() => ({ prefs: null as Record<string, unknown> | null, saved: [] as Record<string, unknown>[] }));
vi.mock('@wolffm/prefs-client/react', () => ({
  usePrefs: () => ({
    prefs: store.prefs,
    save: (patch: Record<string, unknown>) => {
      store.saved.push(patch);
      return Promise.resolve();
    },
    loading: false,
    error: null,
  }),
}));
vi.mock('../play/live/prefs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../play/live/prefs.ts')>()),
  getPlayPrefsClient: () => ({}),
}));

import { SettingsGear } from './Settings.tsx';

afterEach(() => {
  cleanup();
  store.prefs = null;
  store.saved = [];
});

describe('the gear outside a match', () => {
  it('opens sound and the game section, drawn from what is saved', () => {
    store.prefs = { boardLayout: 'type-separated', fastMode: true, endStepStop: false };
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    const dialog = screen.getByTestId('settings');
    expect(dialog.querySelector('[data-testid="settings-sound"]')).not.toBeNull();
    expect([...dialog.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Sound', 'Game']);
    expect((screen.getByTestId('live-settings-fast-mode') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('live-settings-stop-end-step') as HTMLInputElement).checked).toBe(false);
    expect((dialog.querySelector('input[name="board-layout"][value="type-separated"]') as HTMLInputElement).checked).toBe(true);
    // A match's remembered triggers are its own: none outside one.
    expect(screen.queryByTestId('live-settings-trigger')).toBeNull();
  });

  it('saves each choice, for the next match to apply on join', () => {
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    fireEvent.click(screen.getByTestId('live-settings-fast-mode'));
    fireEvent.click(screen.getByTestId('live-settings-stop-end-step'));
    fireEvent.click(screen.getByTestId('settings').querySelector('input[name="board-layout"][value="type-separated"]')!);
    expect(store.saved).toEqual([{ fastMode: true }, { endStepStop: false }, { boardLayout: 'type-separated' }]);
  });
});
