/*
 * The one stylesheet's order (`../stylesheet.ts`): a module's imports where they are written, a lazy
 * `import()` counted at its place, so splitting a screen into its own chunk moves none of its sheets.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { importsInOrder, sheetsInSourceOrder } from '../stylesheet.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Relative imports to files, a package's sheet by its name; any other package is not entered. */
async function resolveForTest(spec: string, importer: string): Promise<string | null> {
  if (!spec.startsWith('.')) return spec.endsWith('.css') ? `npm:${spec}` : null;
  const path = resolve(dirname(importer), spec);
  return [path, `${path}.ts`, `${path}.tsx`].find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

describe('importsInOrder', () => {
  it('lists static, re-exported and lazy imports where they are written, and leaves out what only types', async () => {
    const code = [
      "import { a } from './first.ts';",
      "import type { T } from './types-only.ts';",
      "import { type U } from './also-types-only.ts';",
      "import { type V, w } from './mixed.ts';",
      "const later = () => import('./lazy.tsx');",
      "import './sheet.css';",
      "export { x } from './re-exported.ts';",
      "export type { Y } from './re-exported-types.ts';",
      "export * from './star.ts';",
      'export function f(): unknown { return import(`./template.ts`); }',
    ].join('\n');
    expect(await importsInOrder(code, 'module.tsx')).toEqual(['./first.ts', './mixed.ts', './lazy.tsx', './sheet.css', './re-exported.ts', './star.ts']);
  });
});

describe('the app, walked from its entry', () => {
  // It parses every module the entry reaches: 1–3 s alone, past vitest's 5 s on a loaded host.
  it('keeps every screen’s sheets ahead of the router’s and the chrome’s, the lazy screens’ included', async () => {
    const sheets = (await sheetsInSourceOrder(join(SRC, 'main.tsx'), resolveForTest)).map((s) => s.replace(`${SRC}/`, ''));
    const at = (sheet: string): number => {
      const i = sheets.indexOf(sheet);
      expect(i, sheet).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Lazily imported, every one: the room, the board, the deck screen, the sound tools, the stats.
    for (const lazy of ['screens/PodScreen.css', 'play/board.css', 'deck/deckEditor.css', 'screens/SoundBuilder.css', 'stats/stats.css']) {
      expect(at(lazy), `${lazy} before the router's sheet`).toBeLessThan(at('screens/screens.css'));
    }
    expect(at('screens/screens.css')).toBeLessThan(at('chrome/chrome.css'));
    expect(at('chrome/chrome.css')).toBeLessThan(at('chrome/trim.css'));
    expect(sheets.slice(0, 2), 'the fleet’s tokens first').toEqual(['npm:@wolffm/themes/style.css', 'npm:@wolffm/themes/icons.css']);
  }, 30_000);
});
