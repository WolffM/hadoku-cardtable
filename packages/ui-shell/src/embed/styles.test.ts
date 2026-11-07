// @vitest-environment jsdom
/*
 * `adoptStyles`/`fetchStyles`, moved out of cardtable's own `embed/` with no change (wave 92 §A).
 * Neither had a unit test before this move; `embed.test.ts` (kept in the app) covers `EmbedApp`, not
 * these two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adoptStyles, fetchStyles } from './styles.ts';

// jsdom's `document.adoptedStyleSheets` reads `undefined` until something has set it once — a real
// browser's starts at `[]` (the spec's default) — so a fresh jsdom document needs the same seed
// `adoptStyles` itself would get in production, before its own `[...document.adoptedStyleSheets]` runs.
beforeEach(() => {
  document.adoptedStyleSheets ??= [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStyles', () => {
  it('reads the sheet text from the given href, same-origin', async () => {
    const requested: [string, RequestInit | undefined][] = [];
    vi.stubGlobal('fetch', (href: string, init?: RequestInit) => {
      requested.push([href, init]);
      return Promise.resolve(new Response('.a { color: red; }', { status: 200 }));
    });
    const css = await fetchStyles('/g/embed/g-embed.css');
    expect(css).toBe('.a { color: red; }');
    expect(requested).toEqual([['/g/embed/g-embed.css', { credentials: 'same-origin' }]]);
  });

  it('fails loudly: a table with no styles is not a table', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    await expect(fetchStyles('/g/embed/g-embed.css')).rejects.toThrow('/g/embed/g-embed.css');
  });
});

describe('adoptStyles', () => {
  afterEach(() => {
    document.adoptedStyleSheets = [];
  });

  it('adopts an ordinary rule on the shadow root alone', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const before = document.adoptedStyleSheets.length;
    const undo = adoptStyles(shadow, '.a { color: red; }');
    expect(shadow.adoptedStyleSheets).toHaveLength(1);
    expect(shadow.adoptedStyleSheets[0]!.cssRules[0]!.cssText).toContain('.a');
    // One more document sheet either way (always appended, `styles.ts`'s own doc), but empty: nothing
    // of an ordinary rule reaches the document.
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    expect(document.adoptedStyleSheets.at(-1)!.cssRules).toHaveLength(0);
    undo();
    expect(shadow.adoptedStyleSheets).toEqual([]);
  });

  it('lifts @font-face and @property onto the document, since a shadow-scoped sheet does not register them', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const css = `@font-face { font-family: 'X'; src: url(x.woff2); }\n.a { color: blue; }`;
    const undo = adoptStyles(shadow, css);
    const shadowRules = [...shadow.adoptedStyleSheets[0]!.cssRules].map((r) => r.cssText);
    expect(shadowRules.some((r) => r.startsWith('@font-face'))).toBe(false);
    expect(shadowRules.some((r) => r.includes('.a'))).toBe(true);
    const pageRules = document.adoptedStyleSheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText));
    expect(pageRules.some((r) => r.startsWith('@font-face'))).toBe(true);
    undo();
    expect(document.adoptedStyleSheets).toEqual([]);
  });

  it('removes only its own document sheet on undo, leaving another mount’s alone', () => {
    const hostA = document.createElement('div');
    const shadowA = hostA.attachShadow({ mode: 'open' });
    const hostB = document.createElement('div');
    const shadowB = hostB.attachShadow({ mode: 'open' });
    const undoA = adoptStyles(shadowA, `@font-face { font-family: 'A'; src: url(a.woff2); }`);
    adoptStyles(shadowB, `@font-face { font-family: 'B'; src: url(b.woff2); }`);
    expect(document.adoptedStyleSheets).toHaveLength(2);
    undoA();
    expect(document.adoptedStyleSheets).toHaveLength(1);
  });
});
