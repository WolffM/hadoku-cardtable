/**
 * The app's one stylesheet, in the order its source imports it, however the code is split.
 *
 * Every sheet in the app is global (`src/css-ownership.test.ts`), so where a rule sits in the
 * stylesheet decides ties between sheets: a bundler lays the sheets out in the order the modules
 * that import them run. Splitting the code changes that order. A module only a lazy chunk reaches
 * (`@hadoku/game-ui/lazy.ts`) runs after everything the entry loads, so its sheets would move after the
 * entry's: after `screens/screens.css` and `chrome/chrome.css`, which used to follow them. A
 * screen's own rule would then win ties it used to lose — the deck screen's `overflow: hidden`
 * over `.shell--fit`'s scrolling, for one.
 *
 * So the entry's first import is {@link STYLESHEET_MODULE} (`src/main.tsx`, `src/embed/index.tsx`),
 * which imports every sheet the app reaches, lazily or not, in the order the source imports them:
 * depth first from the entry, each module's imports where they are written, and a lazy `import()`
 * counted at its place as a static import would be. Every sheet then runs first, in that order, and
 * {@link STYLESHEET_GROUP} keeps them in one chunk, in which they stay in the order they run: the
 * one stylesheet is that chunk's, and a lazy chunk carries none.
 *
 * Checks fail the build rather than ship a different cascade: a sheet the walk did not list
 * (imported from a package's JavaScript, which the walk does not enter), a sheet it listed that
 * nothing else imports, and sheets that did not end up in one chunk in exactly the listed order.
 */

import { readFile } from 'node:fs/promises';
import { parseAstAsync, type Plugin } from 'vite';

export const STYLESHEET_MODULE = 'virtual:cardtable-stylesheet';
const RESOLVED = `\0${STYLESHEET_MODULE}`;

const SHEET = /\.css$/;

/** Every sheet in one chunk (`chunks.ts`), not wherever the modules sharing it landed. */
export const STYLESHEET_GROUP = { name: 'stylesheet', test: SHEET };
const SOURCE = /\.([cm]?[jt]sx?)$/;

type Node = Record<string, unknown> & { type?: string; start?: number };

/** What a declaration imports, unless only types: TypeScript erases those. */
const valueImport = (n: Node, kind: 'importKind' | 'exportKind'): boolean => {
  if (n[kind] === 'type') return false;
  const specifiers = (n.specifiers ?? []) as Node[];
  return specifiers.length === 0 || specifiers.some((s) => s[kind] !== 'type');
};

/** A module's imports in the order they are written: static, re-exported and lazy alike. */
export async function importsInOrder(code: string, file: string): Promise<string[]> {
  const ext = SOURCE.exec(file)?.[1] ?? 'js';
  const lang = ext.includes('ts') ? (ext.endsWith('x') ? 'tsx' : 'ts') : ext.endsWith('x') ? 'jsx' : 'js';
  const found: { at: number; spec: string }[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    const n = value as Node;
    const source = n.source as Node | null | undefined;
    const literal = typeof source?.value === 'string' ? source.value : null;
    if (n.type === 'ImportDeclaration') {
      if (literal !== null && valueImport(n, 'importKind')) found.push({ at: n.start ?? 0, spec: literal });
      return;
    }
    if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && literal !== null) {
      if (valueImport(n, 'exportKind')) found.push({ at: n.start ?? 0, spec: literal });
      return;
    }
    if (n.type === 'ImportExpression' && literal !== null) found.push({ at: n.start ?? 0, spec: literal });
    for (const key of Object.keys(n)) if (key !== 'type') walk(n[key]);
  };
  walk(await parseAstAsync(code, { lang, sourceType: 'module' }, file));
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

/** Resolves an import as the build does: the module's id, or null for one it does not load. */
export type ResolveImport = (spec: string, importer: string) => Promise<string | null>;

/**
 * Every sheet `entry` reaches, in source order: depth first, each module's imports where they are
 * written (`importsInOrder`), a module's sheets placed when it is first reached. The app's own
 * modules are walked; a package is not entered, and its sheets are the ones imported by name.
 */
export async function sheetsInSourceOrder(entry: string, resolve: ResolveImport): Promise<string[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    if (SHEET.test(file)) {
      found.push(file);
      return;
    }
    if (!SOURCE.test(file) || file.includes('/node_modules/')) return;
    for (const spec of await importsInOrder(await readFile(file, 'utf8'), file)) {
      const id = await resolve(spec, file);
      if (id !== null) await visit(id);
    }
  };
  await visit(entry);
  return found;
}

export function stylesheetInSourceOrder(): Plugin {
  let entry: string | null = null;
  let sheets: string[] = [];
  return {
    name: 'cardtable-stylesheet-in-source-order',
    resolveId(source, importer) {
      if (source !== STYLESHEET_MODULE) return null;
      // The dev server resolves it again for the browser's request, with no importer.
      if (importer !== undefined) {
        if (entry !== null && entry !== importer) this.error(`${STYLESHEET_MODULE} is the entry's import alone; ${importer} imports it too`);
        entry = importer;
      }
      return RESOLVED;
    },
    async load(id) {
      if (id !== RESOLVED || entry === null) return null;
      sheets = await sheetsInSourceOrder(entry, async (spec, importer) => {
        const resolved = await this.resolve(spec, importer);
        return resolved === null || resolved.id === RESOLVED || resolved.external ? null : resolved.id;
      });
      return sheets.map((sheet) => `import ${JSON.stringify(sheet)};`).join('\n');
    },
    generateBundle(_options, bundle) {
      // A build whose entry does not import STYLESHEET_MODULE is a page of its own (`src/fit/*.html`,
      // built by `e2e/wperf3-draft-open.spec.ts`): it splits nothing lazily, so the bundler already
      // lays its sheets out in the order its source imports them, and there is no cascade to keep.
      if (entry === null) return;
      const listed = new Set(sheets);
      const stray = [...this.getModuleIds()].filter((id) => SHEET.test(id) && !listed.has(id));
      if (stray.length > 0) this.error(`stylesheets the source walk did not list, so their place in the cascade is unknown: ${stray.join(', ')}`);
      const unused = sheets.filter((id) => (this.getModuleInfo(id)?.importers ?? []).every((importer) => importer === RESOLVED));
      if (unused.length > 0) this.error(`stylesheets the source walk listed that nothing imports (a type-only path?): ${unused.join(', ')}`);
      const holders = Object.values(bundle).flatMap((out) => (out.type === 'chunk' && Object.keys(out.modules).some((id) => SHEET.test(id)) ? [out] : []));
      const laid = holders.flatMap((chunk) => Object.keys(chunk.modules).filter((id) => SHEET.test(id)));
      if (holders.length !== 1 || laid.join('\n') !== sheets.join('\n')) {
        this.error(`the stylesheet is not in source order: ${holders.length} chunks hold sheets (${holders.map((c) => c.fileName).join(', ')}); is STYLESHEET_GROUP in the build's codeSplitting groups?`);
      }
    },
  };
}
