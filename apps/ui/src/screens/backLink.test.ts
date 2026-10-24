// @vitest-environment jsdom
/* The site's one way back (`BackLink.tsx`): every page head draws it, and nothing else draws an arrow. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BackLink } from './BackLink.tsx';
import { parseRoute } from './route.ts';

afterEach(cleanup);

describe('BackLink', () => {
  it('is the arrow alone, named for where it goes, and goes there', () => {
    globalThis.location.hash = '#/inventory';
    render(createElement(BackLink, { to: { kind: 'decks' }, label: 'Decks', testId: 'back' }));
    const back = screen.getByRole('link', { name: 'Decks' });
    expect(back.textContent).toBe('←');
    fireEvent.click(back);
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'decks' });
  });

  it('is never underlined', () => {
    const css = readFileSync('apps/ui/src/screens/screens.css', 'utf8');
    expect(css).toMatch(/\.back-link \{[^}]*text-decoration: none;/);
    expect(css).not.toMatch(/\.back-link:[a-z-]+[^{]*\{[^}]*text-decoration: underline/);
  });

  it('is the only arrow a page draws', () => {
    const drawn = readdirSync('apps/ui/src', { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx') && readFileSync(join('apps/ui/src', file), 'utf8').includes('←'));
    expect(drawn).toEqual([join('screens', 'BackLink.tsx')]);
  });
});
