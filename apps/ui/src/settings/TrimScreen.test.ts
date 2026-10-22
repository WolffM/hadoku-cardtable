// @vitest-environment jsdom
/*
 * The site's trim (the operator, 2026-10-21: "make it set the look for every player"): every
 * screen draws the one trim `/api/trim` answers, `#/ui` writes it for an admin and sends anyone
 * else to the lobby, and the Settings popover has none of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const went = vi.hoisted(() => [] as unknown[]);
vi.mock('../screens/route.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screens/route.ts')>()),
  navigate: (route: unknown) => went.push(route),
}));
vi.mock('@wolffm/prefs-client/react', () => ({ usePrefs: () => ({ prefs: null, save: () => Promise.resolve(), loading: false, error: null }) }));
vi.mock('../play/live/prefs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../play/live/prefs.ts')>()),
  getPlayPrefsClient: () => ({}),
}));

import { SettingsGear } from './Settings.tsx';
import { resetSiteTrimForTests, useTrim } from './siteTrim.ts';
import { TrimScreen } from './TrimScreen.tsx';
import { DEFAULT_TRIM } from './trim.ts';

let answer: { status: number; body: unknown } | 'never';
let putOk = true;
const puts: unknown[] = [];

beforeEach(() => {
  resetSiteTrimForTests();
  went.length = 0;
  puts.length = 0;
  putOk = true;
  answer = { status: 200, body: { trim: null, canEdit: false } };
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    expect(url).toMatch(/api\/trim$/);
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(putOk ? String(init.body) : '{"error":"admin tier required"}', { status: putOk ? 200 : 403 }));
    }
    if (answer === 'never') return new Promise(() => undefined);
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Page({ root }: { root: HTMLElement }) {
  useTrim(() => root);
  return createElement(TrimScreen);
}

describe('#/ui', () => {
  it('an admin sets the one look: each choice is saved for everyone, None takes its family out, and the page redraws', async () => {
    answer = { status: 200, body: { trim: { frame: 'scoop', ground: 'triangles' }, canEdit: true } };
    const root = document.createElement('main');
    render(createElement(Page, { root }));
    await screen.findByTestId('trim-screen');
    expect((screen.getByTestId('trim-frame') as HTMLSelectElement).value).toBe('scoop');
    expect(root.getAttribute('data-trim-ground')).toBe('triangles');
    await act(async () => {
      fireEvent.change(screen.getByTestId('trim-corner'), { target: { value: 'gems' } });
    });
    expect(root.getAttribute('data-trim-corner'), 'drawn at once').toBe('gems');
    await act(async () => {
      fireEvent.change(screen.getByTestId('trim-frame'), { target: { value: '' } });
    });
    expect(puts).toEqual([{ trim: { frame: 'scoop', ground: 'triangles', corner: 'gems' } }, { trim: { ground: 'triangles', corner: 'gems' } }]);
    expect(root.hasAttribute('data-trim-frame')).toBe(false);
    expect(went).toEqual([]);
  });

  it('a save the server refuses puts the look back', async () => {
    answer = { status: 200, body: { trim: { frame: 'scoop' }, canEdit: true } };
    putOk = false;
    render(createElement(TrimScreen));
    await screen.findByTestId('trim-screen');
    await act(async () => {
      fireEvent.change(screen.getByTestId('trim-frame'), { target: { value: 'hud' } });
    });
    await waitFor(() => expect((screen.getByTestId('trim-frame') as HTMLSelectElement).value).toBe('scoop'));
  });

  it('anyone the server does not let edit is sent to the lobby and sees nothing of it', async () => {
    render(createElement(TrimScreen));
    await waitFor(() => expect(went).toEqual([{ kind: 'lobby' }]));
    expect(screen.queryByTestId('trim-screen')).toBeNull();
  });

  it('draws nothing and sends nobody anywhere until the server answers', () => {
    answer = 'never';
    render(createElement(TrimScreen));
    expect(screen.queryByTestId('trim-screen')).toBeNull();
    expect(went).toEqual([]);
  });

  it('the Settings popover carries no trim', () => {
    render(createElement(SettingsGear));
    fireEvent.click(screen.getByTestId('settings-gear'));
    expect([...screen.getByTestId('settings').querySelectorAll('legend')].map((l) => l.textContent)).not.toContain('Trim');
    expect(screen.queryByTestId('trim-frame')).toBeNull();
  });
});

describe('every screen', () => {
  function Screen({ root }: { root: HTMLElement }) {
    useTrim(() => root);
    return null;
  }
  const attrs = (el: HTMLElement): string[] => [...el.attributes].map((a) => `${a.name}=${a.value}`).sort();

  it('draws the site’s trim, and nothing before the server answers', async () => {
    answer = { status: 200, body: { trim: { frame: 'hud', texture: 'linen' }, canEdit: false } };
    const root = document.createElement('main');
    render(createElement(Screen, { root }));
    expect(attrs(root)).toEqual([]);
    await waitFor(() => expect(attrs(root)).toEqual(['data-trim-frame=hud', 'data-trim-texture=linen']));
  });

  it('a site nobody has set, or a read that fails, draws the default', async () => {
    for (const a of [{ status: 200, body: { trim: null, canEdit: false } }, { status: 500, body: {} }]) {
      resetSiteTrimForTests();
      answer = a;
      const root = document.createElement('main');
      render(createElement(Screen, { root }));
      await waitFor(() => expect(attrs(root)).toEqual(Object.entries(DEFAULT_TRIM).map(([f, v]) => `data-trim-${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${v}`).sort()));
      cleanup();
    }
  });

  it('a name the catalogue does not know is never drawn', async () => {
    answer = { status: 200, body: { trim: { frame: 'sparkles', sparkle: 'on', ground: 'dots' }, canEdit: false } };
    const root = document.createElement('main');
    render(createElement(Screen, { root }));
    await waitFor(() => expect(attrs(root)).toEqual(['data-trim-ground=dots']));
  });
});
