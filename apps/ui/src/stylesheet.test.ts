/*
 * The one stylesheet's order (`../stylesheet.ts`): a module's imports where they are written, a lazy
 * `import()` counted at its place, so splitting a screen into its own chunk moves none of its sheets.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { importsInOrder, sheetsInSourceOrder } from '../stylesheet.ts';

const SRC = dirname(fileURLToPath(import.meta.url));
// `@hadoku/ui-shell`'s files (chrome, trim, embed today; more as other lanes move theirs) resolve
// here, same as the real build's workspace link (wave 92 §A) — this stub resolver has to enter the
// package the same way, or a sheet moved there (chrome.css, trim.css) silently drops out of the walk.
// Read from the package's own `exports` map rather than assumed, so a new subpath (`./chrome/shell`,
// a file, not a directory's `index.ts`) needs no matching change here.
const PKG_ROOT = resolve(SRC, '../../../packages/ui-shell');
const PKG_SRC = join(PKG_ROOT, 'src');
const PKG_EXPORTS: Record<string, string> = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).exports;

/**
 * Relative imports to files (under either root), a bare `@hadoku/ui-shell/<name>` to that subpath's
 * own entry module (as the package's own `exports` map says), a package's sheet by its name; any
 * other package is not entered.
 */
async function resolveForTest(spec: string, importer: string): Promise<string | null> {
  if (spec.startsWith('.')) {
    const path = resolve(dirname(importer), spec);
    return [path, `${path}.ts`, `${path}.tsx`].find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
  }
  if (spec.startsWith('@hadoku/ui-shell/')) {
    const rel = PKG_EXPORTS[`.${spec.slice('@hadoku/ui-shell'.length)}`];
    return rel === undefined ? null : resolve(PKG_ROOT, rel);
  }
  return spec.endsWith('.css') ? `npm:${spec}` : null;
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
    const sheets = (await sheetsInSourceOrder(join(SRC, 'main.tsx'), resolveForTest)).map((s) =>
      s.startsWith(`${PKG_SRC}/`) ? `@ui-shell/${s.slice(PKG_SRC.length + 1)}` : s.replace(`${SRC}/`, ''),
    );
    const at = (sheet: string): number => {
      const i = sheets.indexOf(sheet);
      expect(i, sheet).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Lazily imported, every one: the room, the board, the deck screen, the sound tools, the stats.
    for (const lazy of ['screens/PodScreen.css', 'play/board.css', 'deck/deckEditor.css', 'screens/SoundBuilder.css', 'stats/stats.css']) {
      expect(at(lazy), `${lazy} before the router's sheet`).toBeLessThan(at('screens/screens.css'));
    }
    /*
     * `chrome.css`/`trim.css` moved into `@hadoku/ui-shell/chrome` (wave 92 §A): still reached only
     * through `App.tsx`'s own `AppChrome` import, which is why this holds unchanged. `useChromeShell`
     * (several lazy screens' own need) moved to its OWN subpath, `@hadoku/ui-shell/chrome/shell` — a
     * file with no sheet of its own — specifically so reading it does not also reach `AppChrome.tsx`
     * and pull `chrome.css` in early. Confirmed byte-for-byte against the base build, not asserted on
     * faith: `cmp` of the built stylesheet (standalone and embed) against a build from before this
     * lane's move printed nothing.
     */
    expect(at('screens/screens.css')).toBeLessThan(at('@ui-shell/chrome/chrome.css'));
    expect(at('@ui-shell/chrome/chrome.css')).toBeLessThan(at('@ui-shell/chrome/trim.css'));
    expect(sheets.slice(0, 2), 'the fleet’s tokens first').toEqual(['npm:@wolffm/themes/style.css', 'npm:@wolffm/themes/icons.css']);
  }, 30_000);
});
