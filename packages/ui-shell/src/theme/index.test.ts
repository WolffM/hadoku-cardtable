// @vitest-environment jsdom
/*
 * The pre-paint theme script (../theme-init.ts), run as the browser runs it:
 * whatever it puts on <html> is what the first paint resolves against.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { themeInitScript } from '../theme-init.ts';

function paint(stored: { session?: string; local?: string }, prefersDark: boolean): string | null {
  sessionStorage.clear();
  localStorage.clear();
  if (stored.session !== undefined) sessionStorage.setItem('hadoku-theme', stored.session);
  if (stored.local !== undefined) localStorage.setItem('hadoku-theme', stored.local);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: prefersDark && query === '(prefers-color-scheme: dark)' }));
  document.documentElement.removeAttribute('data-theme');
  new Function(themeInitScript())();
  return document.documentElement.getAttribute('data-theme');
}

describe('the theme is on <html> before the first paint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('this tab’s choice, then this browser’s, then the system preference', () => {
    expect(paint({ session: 'ocean-dark', local: 'coffee-light' }, false)).toBe('ocean-dark');
    expect(paint({ local: 'coffee-light' }, true)).toBe('coffee-light');
    expect(paint({}, true)).toBe('dark');
    expect(paint({}, false)).toBe('light');
  });

  it('a bare family name takes the variant the system preference picks', () => {
    expect(paint({ local: 'coffee' }, true)).toBe('coffee-dark');
    expect(paint({ local: 'coffee' }, false)).toBe('coffee-light');
  });

  it('a stored name that is no theme is ignored, not painted', () => {
    expect(paint({ session: 'nonsense', local: 'izakaya-dark' }, false)).toBe('izakaya-dark');
    expect(paint({ local: 'nonsense' }, true)).toBe('dark');
  });
});
