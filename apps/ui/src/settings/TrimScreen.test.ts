// @vitest-environment jsdom
/*
 * `#/ui` (the operator, 2026-10-21: "the UI selection stuff should land behind … #/ui not exposed to
 * all players"): an admin composes trim there; anyone else is sent to the lobby, and the Settings
 * popover no longer carries it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({
  prefs: null as Record<string, unknown> | null,
  saved: [] as Record<string, unknown>[],
  who: 'pending' as unknown,
  went: [] as unknown[],
}));
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
vi.mock('../room/whoami.ts', () => ({ useWhoami: () => store.who }));
vi.mock('../screens/route.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screens/route.ts')>()),
  navigate: (route: unknown) => store.went.push(route),
}));

import { SettingsGear } from './Settings.tsx';
import { TrimScreen } from './TrimScreen.tsx';

afterEach(() => {
  cleanup();
  store.prefs = null;
  store.saved = [];
  store.who = 'pending';
  store.went = [];
});

describe('#/ui', () => {
  it('an admin composes trim one family at a time: a choice is added to what is saved, None takes its family out', () => {
    store.who = { userId: 'u-op', tier: 'admin', name: 'Op' };
    store.prefs = { trim: { frame: 'scoop', ground: 'triangles' } };
    render(createElement(TrimScreen));
    expect((screen.getByTestId('trim-frame') as HTMLSelectElement).value).toBe('scoop');
    expect((screen.getByTestId('trim-corner') as HTMLSelectElement).value, 'an unchosen family reads None').toBe('');
    fireEvent.change(screen.getByTestId('trim-corner'), { target: { value: 'gems' } });
    fireEvent.change(screen.getByTestId('trim-frame'), { target: { value: '' } });
    expect(store.saved).toEqual([{ trim: { frame: 'scoop', ground: 'triangles', corner: 'gems' } }, { trim: { ground: 'triangles' } }]);
    expect(store.went).toEqual([]);
  });

  it('anyone else is sent to the lobby and sees nothing of it', async () => {
    store.who = { userId: 'u-f', tier: 'friend', name: 'Friend' };
    render(createElement(TrimScreen));
    expect(screen.queryByTestId('trim-screen')).toBeNull();
    await waitFor(() => expect(store.went).toEqual([{ kind: 'lobby' }]));
  });

  it('draws nothing and sends nobody anywhere while the tier is still unknown', () => {
    render(createElement(TrimScreen));
    expect(screen.queryByTestId('trim-screen')).toBeNull();
    expect(store.went).toEqual([]);
  });

  it('the Settings popover carries no trim', () => {
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    expect([...screen.getByTestId('settings').querySelectorAll('legend')].map((l) => l.textContent)).not.toContain('Trim');
    expect(screen.queryByTestId('trim-frame')).toBeNull();
  });
});
