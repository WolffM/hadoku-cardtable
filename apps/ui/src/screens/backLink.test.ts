// @vitest-environment jsdom
/* The site's one way back (`BackLink.tsx`): every page head draws it, and nothing else draws an arrow. */

// @reads apps/ui/src/*.tsx packages/ui-shell/src/*.tsx packages/game-ui/src/*.tsx
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { uiFiles, uiPath } from '../ui-sources.testing.ts';
import { BackLink } from './BackLink.tsx';
import { currentRoute } from '@hadoku/game-ui/screens/route.ts';

afterEach(cleanup);

describe('BackLink', () => {
  it('is the arrow alone, named for where it goes, and goes there', () => {
    globalThis.location.hash = '#/inventory';
    render(createElement(BackLink, { to: { kind: 'decks' }, label: 'Decks', testId: 'back' }));
    const back = screen.getByRole('link', { name: 'Decks' });
    expect(back.textContent).toBe('←');
    fireEvent.click(back);
    expect(currentRoute()).toEqual({ kind: 'decks' });
  });

  it('is never underlined', () => {
    const css = readFileSync('apps/ui/src/screens/screens.css', 'utf8');
    expect(css).toMatch(/\.back-link,\s*\.back-link:visited \{[^}]*text-decoration: none;/);
    expect(css).not.toMatch(/\.back-link:[a-z-]+[^{]*\{[^}]*text-decoration: underline/);
  });

  it('is the only arrow a page draws', () => {
    const drawn = uiFiles((name) => name.endsWith('.tsx')).filter((file) => readFileSync(file, 'utf8').includes('←'));
    expect(drawn.map(uiPath)).toEqual(['apps/ui/src/screens/BackLink.tsx']);
  });
});
