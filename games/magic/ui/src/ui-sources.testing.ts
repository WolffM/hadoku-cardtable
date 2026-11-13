/**
 * The UI's source, wherever it lives: Magic's UI (this package's `src`), the site that composes it
 * (`apps/ui/src`) and the platform UI packages the site bundles (`packages/ui-shell/src`,
 * `packages/game-ui/src`). A guard that reads every sheet or module of the UI walks all of them, so a
 * file moved from one to another does not leave its view.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// From the module's own path string: under jsdom, `URL` is jsdom's, which `fileURLToPath` refuses.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The roots, repo-relative. */
export const UI_ROOTS: readonly string[] = ['games/magic/ui/src', 'apps/ui/src', 'packages/ui-shell/src', 'packages/game-ui/src'];

/** Every file under the UI's roots whose name `keep` takes, as an absolute path; directories named in `skip` are not entered. */
export function uiFiles(keep: (name: string) => boolean, skip: readonly string[] = []): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return skip.includes(e.name) ? [] : walk(path);
      return keep(e.name) ? [path] : [];
    });
  return UI_ROOTS.flatMap((root) => walk(join(REPO, root)));
}

/** Every stylesheet the UI owns. */
export const uiSheets = (skip: readonly string[] = []): string[] => uiFiles((name) => name.endsWith('.css'), skip);

/** A file's path from the repo root, for a failure message. */
export const uiPath = (abs: string): string => relative(REPO, abs);
