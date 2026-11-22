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

import { SettingsGear, useMotion } from '@hadoku/game-ui/settings/Settings.tsx';
import { UI_SCALE } from '@hadoku/ui-shell/settings';

afterEach(() => {
  cleanup();
  store.prefs = null;
  store.saved = [];
});

describe('the gear outside a match', () => {
  it('opens sound and the game section, drawn from what is saved', () => {
    store.prefs = { boardLayout: 'type-separated', gameSpeed: 'fast', endStepStop: false };
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    const dialog = screen.getByTestId('settings');
    expect(dialog.querySelector('[data-testid="settings-sound"]')).not.toBeNull();
    expect([...dialog.querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Gameplay', 'Experimental', 'Display', 'Motion', 'Sound']);
    expect(['normal', 'fast', 'instant'].map((speed) => (screen.getByTestId(`live-settings-speed-${speed}`) as HTMLInputElement).checked)).toEqual([false, true, false]);
    expect((screen.getByTestId('live-settings-stop-end-step') as HTMLInputElement).checked).toBe(false);
    expect((dialog.querySelector('input[name="board-layout"][value="type-separated"]') as HTMLInputElement).checked).toBe(true);
    // A match's remembered triggers are its own: none outside one.
    expect(screen.queryByTestId('live-settings-trigger')).toBeNull();
  });

  it('saves each choice, for the next match to apply on join', () => {
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    fireEvent.click(screen.getByTestId('live-settings-speed-instant'));
    fireEvent.click(screen.getByTestId('live-settings-stop-end-step'));
    fireEvent.click(screen.getByTestId('settings').querySelector('input[name="board-layout"][value="type-separated"]')!);
    const experimental = screen.getByTestId('settings-experimental-features') as HTMLInputElement;
    expect(experimental.checked, 'Experimental features are off by default').toBe(false);
    fireEvent.click(experimental);
    expect(store.saved).toEqual([{ gameSpeed: 'instant' }, { endStepStop: false }, { boardLayout: 'type-separated' }, { experimental: true }]);
  });

  it('each motion switch is its own, drawn as the page applies it, and saves only itself', () => {
    store.prefs = { screenShake: false };
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    const box = (id: string): HTMLInputElement => screen.getByTestId(id) as HTMLInputElement;
    const ids = ['settings-card-motion', 'settings-screen-shake', 'settings-ambient-motion', 'settings-front-match'];
    // jsdom's system asks for no less motion: every switch nobody set reads on.
    expect(ids.map((id) => box(id).checked)).toEqual([true, false, true, true]);
    for (const id of ids) fireEvent.click(box(id));
    expect(store.saved).toEqual([{ cardMotion: false }, { screenShake: true }, { ambientMotion: false }, { frontMatch: false }]);
  });

  it('has a UI scale slider over its range, drawn from what is saved, saved once it is let go', () => {
    store.prefs = { uiScale: 1.1 };
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    expect([...screen.getByTestId('settings').querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Gameplay', 'Experimental', 'Display', 'Motion', 'Sound']);
    const slider = screen.getByTestId('settings-ui-scale') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect([slider.min, slider.max, slider.value]).toEqual([String(UI_SCALE.min * 100), String(UI_SCALE.max * 100), '110']);
    // A drag sends `input`; not saved while the thumb is still held, the page would re-scale under the pointer.
    fireEvent.input(slider, { target: { value: '120' } });
    expect(store.saved).toEqual([]);
    // Nor on `pointerup`, which comes before the browser has finished the press.
    fireEvent.pointerUp(slider);
    expect(store.saved).toEqual([]);
    expect(slider.value, 'the thumb stays where it was dragged').toBe('120');
    expect(slider.closest('label')!.querySelector('output'), 'no number beside it, as the sound levels have none').toBeNull();
    // Let go is the input's own `change`.
    fireEvent(slider, new Event('change', { bubbles: true }));
    expect(store.saved).toEqual([{ uiScale: 1.2 }]);
  });
});


/*
 * A switch nobody set is no attribute, so the sheets' own `prefers-reduced-motion` query answers in the frame the
 * system changes (`@hadoku/ui-shell/motion`'s `css.ts`). Written from a `change` event, a stale `full` held a
 * flyer's sway for a frame or more (af70's reduced-motion step).
 */
describe('a system that changes its mind mid-visit', () => {
  it('leaves card and ambient motion to the query, and rewrites the shake in the change itself', () => {
    let reduce = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query.includes('reduce') && reduce;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    try {
      const root = document.documentElement;
      function Page(): null {
        useMotion(() => root);
        return null;
      }
      render(createElement(Page));
      const attrs = (): (string | null)[] => ['data-motion', 'data-ambient', 'data-shake'].map((a) => root.getAttribute(a));
      expect(attrs()).toEqual([null, null, 'on']);
      reduce = true;
      for (const fn of listeners) fn();
      expect(attrs()).toEqual([null, null, 'off']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
