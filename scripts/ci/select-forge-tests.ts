/**
 * Which Forge e2e specs and which jar-gated vitest suites a change needs.
 *
 * `forge.yml`'s `changes` job feeds this the files a push (or a dispatch's
 * branch) changed, and the jobs after it run only what it picks, with one
 * printed reason per decision. On a push to main (`--defer-full`) it never
 * picks the full set: the schedule runs that, so whatever a push skipped is
 * still run within the schedule's window.
 *
 *   node scripts/ci/select-forge-tests.ts <changes.json> [--defer-full] [--github-output <file>]
 *
 * `changes.json` is the `files` array of GitHub's compare API (or the same
 * shape built from `git diff`): `[{ "filename", "status", "patch"? }]`.
 *
 * The rules, in order, per changed file:
 *   a package.json whose only edit is "version"         nothing
 *   an edit to comments or whitespace only              nothing
 *   docs, *.md, .claude, scripts/sfx, other workflows   nothing
 *   a unit test                                         nothing (`check` runs it)
 *   the engine pin, the bridge, match.ts / auto.ts, packages, dependencies,
 *   workspace config, forge.yml, this script, card data
 *                                                       every spec + every jvm suite
 *   an e2e spec                                         that spec
 *   a jvm suite                                         that suite
 *   an e2e helper                                       the specs that import it
 *   a scenario (`*.state`)                              the specs + jvm suites that name it
 *   apps/server, in the match runtime (play/ and what it imports)
 *                                                       every spec + the jvm suites that import it
 *   other apps/server (rooms, HTTP, stats)              the specs that call one of its routes,
 *                                                       the smoke set, the jvm suites that import it
 *   apps/ui source                                      the specs that touch what it renders,
 *                                                       the smoke set, the jvm suites that import it
 *   anything else                                       every spec + every jvm suite
 *
 * "What it renders" is mechanical: the test ids and `data-*` attributes in
 * the declarations the diff touches. A declaration that renders none passes
 * the question to the declarations that use it — in its own file or one that
 * imports it — until each path reaches one that renders; `interface` and
 * `type` declarations lead nowhere. A stylesheet's edited rules name classes,
 * and the components that use those classes render the ids near each use. A
 * spec "touches" a key when the key appears in the spec or in the e2e helper
 * functions the spec actually calls. A key most specs touch (the OK button) is
 * run by the smoke set or one sample spec rather than by all of them.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parseArgs } from 'node:util';

export interface Change {
  filename: string;
  status: string;
  previous_filename?: string;
  /** The unified diff, as the compare API gives it; absent for binaries and huge files. */
  patch?: string;
}

export interface Selection {
  /** Whether forge-e2e runs at all. */
  e2e: boolean;
  /** `null` = every Forge-gated spec; otherwise exactly these (basenames). */
  specs: string[] | null;
  /** Whether forge-jvm runs at all. */
  jvm: boolean;
  /** `null` = every jvm suite; otherwise exactly these (repo paths). */
  jvmFiles: string[] | null;
  /** Everything was needed, and left to the batched full run. */
  deferred: boolean;
  /** One line per decision, for the job log. */
  reasons: string[];
}

/** Always run when any UI file changes: one whole match, and the layout check. */
export const SMOKE = ['play.spec.ts', 'table-fit.spec.ts'];

/** On a push to main, the mapped specs that run beyond what changed itself and the smoke set. */
export const PUSH_MAPPED = 6;

/** A key more than this share of specs touch is sampled, not run everywhere. */
const UBIQUITOUS = 0.25;

/** Past this share of every Forge-gated spec, a narrowed run saves too little to be worth the risk. */
export const FULL_SHARE = 0.6;

const NOTHING: RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^\.claude\//,
  /^scripts\/sfx\//,
  /^scripts\/spike\//,
  /^\.github\/workflows\/(ci|redeploy|update-wolffm)\.yml$/,
  /^(LICENSE|\.gitignore|\.gitattributes|\.devvault\.json)$/,
  /^scripts\/land\.sh$/,
  /^scripts\/(art|stream)\//,
  /^scripts\/ci\/fixtures\//,
];

const EVERYTHING: RegExp[] = [
  /^forge$/,
  /^\.gitmodules$/,
  /^apps\/server\/src\/play\/bridge\//,
  /^apps\/server\/src\/play\/(match|auto)\.ts$/,
  /^packages\//,
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|tsconfig\.base\.json|vitest\.config\.ts|\.npmrc|\.nvmrc)$/,
  /^apps\/(ui|server)\/(package\.json|tsconfig[^/]*\.json|vite\.config\.ts|index\.html)$/,
  /^\.github\/workflows\/forge\.yml$/,
  /^scripts\/ci\/select-forge-tests\.ts$/,
  /^scripts\/forge-bundle\.sh$/,
  /^(decks|cubes|drafts)\//,
  /^e2e\/(package\.json|playwright\.config\.ts|tsconfig\.json)$/,
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUnitTest = (f: string): boolean => /\.test\.tsx?$/.test(f) && !/\.jvm\.test\.ts$/.test(f);
const isSource = (f: string): boolean => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f);

/** A package.json whose only edit is its `"version"` line — what every land adds. */
export function versionBumpOnly(c: Change): boolean {
  if (!/(^|\/)package\.json$/.test(c.filename) || c.status !== 'modified' || !c.patch) return false;
  const edits = c.patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return edits.length > 0 && edits.every((l) => /^[+-]\s*"version"\s*:/.test(l));
}

/** The file before `patch`, rebuilt from the file after it. */
export function beforePatch(after: string, patch: string): string {
  const lines = after.split('\n');
  const hunks: { start: number; len: number; old: string[] }[] = [];
  for (const line of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) hunks.push({ start: Number(h[1]), len: h[2] === undefined ? 1 : Number(h[2]), old: [] });
    else if (hunks.length && (line.startsWith(' ') || line.startsWith('-'))) hunks[hunks.length - 1].old.push(line.slice(1));
    else if (hunks.length && line === '') hunks[hunks.length - 1].old.push('');
  }
  for (const h of hunks.reverse()) lines.splice(h.len === 0 ? h.start : h.start - 1, h.len, ...h.old);
  return lines.join('\n');
}

/** Source with comments and whitespace gone; strings are kept, so a comment marker inside one is not a comment. */
export function code(src: string, css: boolean): string {
  const re = css ? /\/\*[\s\S]*?\*\/|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  return src.replace(re, (_m, str: string | undefined) => str ?? ' ').replace(/\s+/g, ' ').trim();
}

/** A source edit that changes only comments or whitespace. */
export function commentsOnly(repo: Repo, c: Change): boolean {
  if (c.status !== 'modified' || !c.patch || !/\.(tsx?|css)$/.test(c.filename)) return false;
  const after = repo.read(c.filename);
  if (after === null) return false;
  const css = c.filename.endsWith('.css');
  return code(beforePatch(after, c.patch), css) === code(after, css);
}

/* ── the repository, read once ────────────────────────────────────────── */

export class Repo {
  readonly root: string;
  private cache = new Map<string, string | null>();

  constructor(root: string) {
    this.root = root;
  }

  read(path: string): string | null {
    if (!this.cache.has(path)) {
      const abs = join(this.root, path);
      this.cache.set(path, existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null);
    }
    return this.cache.get(path) ?? null;
  }

  /** Every file under `dir` (repo-relative), recursively, skipping node_modules and dot dirs. */
  list(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      const abs = join(this.root, d);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist') continue;
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(dir);
    return out.sort();
  }
}

/* ── imports ──────────────────────────────────────────────────────────── */

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The repo paths `file` imports by relative specifier (packages and npm modules are not followed). */
export function importsOf(repo: Repo, file: string): string[] {
  const src = repo.read(file);
  if (src === null) return [];
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    const target = resolveImport(repo, file, m[1] ?? m[2] ?? m[3]);
    if (target) out.push(target);
  }
  return out;
}

/** The repo path a relative specifier in `from` names (`./x.js` may be `x.ts`), or null. */
export function resolveImport(repo: Repo, from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec));
  const stem = base.replace(/\.(js|ts|tsx|jsx)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => repo.read(c) !== null) ?? null;
}

/** Every file `roots` import, transitively, including the roots. */
function closure(repo: Repo, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = [...roots];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...importsOf(repo, f));
  }
  return seen;
}

/* ── what a UI file renders ───────────────────────────────────────────── */

export interface Keys {
  testids: Set<string>;
  /** Template-literal test ids, by their static prefix (`room-seat-`). */
  prefixes: Set<string>;
  attrs: Set<string>;
  classes: Set<string>;
}

const emptyKeys = (): Keys => ({ testids: new Set(), prefixes: new Set(), attrs: new Set(), classes: new Set() });
const keyCount = (k: Keys): number => k.testids.size + k.prefixes.size + k.attrs.size + k.classes.size;

export function keysOf(repo: Repo, file: string): Keys {
  const raw = repo.read(file);
  return raw === null ? emptyKeys() : file.endsWith('.css') ? cssKeys(raw) : tsxKeys(raw);
}

const stripCssComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** The classes and `data-*` attributes a stylesheet's selectors name. */
export function cssKeys(css: string): Keys {
  const k = emptyKeys();
  const selectors = stripCssComments(css).replace(/\{[^{}]*\}/g, '{}');
  for (const m of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) k.classes.add(m[1]);
  for (const m of selectors.matchAll(/\[(data-[\w-]+)/g)) k.attrs.add(m[1]);
  return k;
}

/** data-testid="x", data-testid={'x'}, data-testid={`x-${…}`}, a `testId="x"` prop handed down, and `data-*=`. */
export function tsxKeys(src: string): Keys {
  const k = emptyKeys();
  for (const m of src.matchAll(/(?:data-testid|testId)\s*=\s*\{?\s*(['"`])([^'"`]*)\1/g)) {
    const dollar = m[2].indexOf('${');
    if (dollar < 0 && m[2].length >= 2) k.testids.add(m[2]);
    else if (dollar >= 3) k.prefixes.add(m[2].slice(0, dollar));
  }
  for (const m of src.matchAll(/\b(data-[a-z][\w-]*)\s*=/g)) if (m[1] !== 'data-testid') k.attrs.add(m[1]);
  return k;
}

function merge(into: Keys, from: Keys): void {
  for (const t of from.testids) into.testids.add(t);
  for (const t of from.prefixes) into.prefixes.add(t);
  for (const t of from.attrs) into.attrs.add(t);
  for (const t of from.classes) into.classes.add(t);
}

/** New-side line numbers a unified diff touches: added lines, and where a deletion sat. */
export function changedLines(patch: string): number[] {
  const out = new Set<number>();
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (h) n = Number(h[1]);
    else if (line.startsWith('+')) out.add(n++);
    else if (line.startsWith('-')) out.add(n);
    else if (!line.startsWith('\\')) n++;
  }
  return [...out];
}

/** The selector of every rule in a stylesheet whose body holds one of `lines`. */
export function changedSelectors(css: string, lines: number[]): string[] {
  const src = stripCssComments(css);
  const out: string[] = [];
  const open: { selector: string; start: number }[] = [];
  let line = 1;
  let since = '';
  let sinceLine = 1;
  for (const ch of src) {
    if (ch === '{') {
      open.push({ selector: since.trim(), start: sinceLine });
      since = '';
    } else if (ch === '}') {
      const r = open.pop();
      if (r && lines.some((l) => l >= r.start && l <= line)) out.push(r.selector);
      since = '';
    } else if (ch === ';') since = '';
    else {
      if (!since.trim() && ch.trim()) sinceLine = line;
      since += ch;
    }
    if (ch === '\n') line++;
  }
  return out;
}

/**
 * What a stylesheet change can move: the classes and attributes of the rules it
 * edits, and the ids rendered within `RADIUS` lines of each component line that
 * uses one of those classes. With no diff, every rule counts.
 */
const RADIUS = 12;
export function cssChangeKeys(repo: Repo, file: string, patch: string | undefined): { keys: Keys; via: string[] } {
  const css = repo.read(file) ?? '';
  const keys = patch ? cssKeys(changedSelectors(css, changedLines(patch)).map((s) => `${s}{}`).join('\n')) : cssKeys(css);
  const via: string[] = [];
  if (keys.classes.size === 0) return { keys, via };
  const uses = [...keys.classes].map((c) => new RegExp(`['"\`][^'"\`\n]*(?<![\\w-])${escape(c)}(?![\\w-])`));
  for (const f of repo.list('apps/ui')) {
    if (!f.endsWith('.tsx')) continue;
    const lines = (repo.read(f) ?? '').split('\n');
    const hits = lines.flatMap((l, i) => (uses.some((u) => u.test(l)) ? [i] : []));
    if (!hits.length) continue;
    via.push(f);
    for (const i of hits) merge(keys, tsxKeys(lines.slice(Math.max(0, i - RADIUS), i + RADIUS + 1).join('\n')));
  }
  return { keys, via };
}

/* ── what a spec touches ──────────────────────────────────────────────── */

export interface Decl {
  name: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
  isDefault: boolean;
  /** An `interface` or `type`: erased at build, so it changes nothing a browser runs. */
  isType: boolean;
}

const DECL = /^(?:export\s+)?(default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** A module's top-level declarations, each running to the line before the next one. */
export function declarations(src: string): Decl[] {
  const lines = src.split('\n');
  const out: Decl[] = [];
  lines.forEach((line, i) => {
    const m = DECL.exec(line);
    if (!m) return;
    if (out.length) out[out.length - 1].end = i;
    out.push({ name: m[3], start: i + 1, end: lines.length, text: '', isDefault: Boolean(m[1]), isType: m[2] === 'interface' || m[2] === 'type' });
  });
  for (const d of out) d.text = lines.slice(d.start - 1, d.end).join('\n');
  return out;
}

const declsByName = (src: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const d of declarations(src)) out.set(d.name, (out.has(d.name) ? `${out.get(d.name)}\n` : '') + d.text);
  return out;
};

/**
 * The text a spec effectively runs: its own source plus the bodies of the
 * e2e helper declarations it reaches, transitively. A helper file imported by
 * nearly every spec (`play/board.ts`) only counts for the functions a spec
 * calls, not for every test id the file happens to mention.
 */
export function specText(repo: Repo, spec: string): string {
  const parts: string[] = [repo.read(spec) ?? ''];
  const decls = new Map<string, Map<string, string>>();
  const declsOf = (f: string): Map<string, string> => {
    if (!decls.has(f)) decls.set(f, declsByName(repo.read(f) ?? ''));
    return decls.get(f)!;
  };
  const seen = new Set<string>();
  // Work items: a text, the file it lives in. Names it mentions are resolved
  // against that file's own declarations and the e2e helpers it imports.
  const todo: { text: string; file: string }[] = [{ text: parts[0], file: spec }];
  while (todo.length) {
    const { text, file } = todo.pop()!;
    const words = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const scopes = [file, ...importsOf(repo, file).filter((f) => f.startsWith('e2e/'))];
    for (const scope of scopes) {
      for (const [name, body] of declsOf(scope)) {
        const id = `${scope}#${name}`;
        if (seen.has(id) || !words.has(name)) continue;
        seen.add(id);
        parts.push(body);
        todo.push({ text: body, file: scope });
      }
    }
  }
  return parts.join('\n');
}

/** Which of `keys` a spec's text touches, as printable names; empty if none. */
export function touched(text: string, keys: Keys): string[] {
  const hits: string[] = [];
  const quoted = new Set<string>();
  for (const m of text.matchAll(/(['"`])([^'"`\n]{2,80}?)\1/g)) quoted.add(m[2]);
  // A selector's `[data-testid^="live-button"]` names every id it is a prefix of.
  const prefixSelectors = [...text.matchAll(/data-testid[\^*]=\\?["']([^"'\\]+)/g)].map((m) => m[1]);
  for (const id of keys.testids) {
    const re = new RegExp(`(?<![\\w-])${escape(id)}(?![\\w-])`);
    if (re.test(text) || prefixSelectors.some((p) => id.startsWith(p))) hits.push(`testid ${id}`);
  }
  for (const p of keys.prefixes) {
    if ([...quoted].some((q) => q.startsWith(p)) || text.includes(p)) hits.push(`testid ${p}*`);
  }
  for (const a of keys.attrs) if (new RegExp(`(?<![\\w-])${escape(a)}(?![\\w-])`).test(text)) hits.push(`attr ${a}`);
  // A selector's `.name`, never a file name's extension.
  for (const c of keys.classes) if (new RegExp(`(?<=^|[\\s'"\`>,(+~:])\\.${escape(c)}(?![\\w-])`).test(text)) hits.push(`class .${c}`);
  return hits;
}

/* ── the selection ────────────────────────────────────────────────────── */

export interface Universe {
  /** Every Forge-gated spec, by basename. */
  specs: string[];
  /** Every jvm suite, repo path. */
  jvm: string[];
}

export function universe(repo: Repo): Universe {
  const specs = repo
    .list('e2e')
    .filter((f) => /^e2e\/[^/]+\.spec\.ts$/.test(f))
    .filter((f) => /forge\.ok|startPlayStack|startScenarioMatch/.test(repo.read(f) ?? ''))
    .map((f) => f.slice('e2e/'.length));
  const jvm = [...repo.list('apps'), ...repo.list('packages')].filter((f) => f.endsWith('.jvm.test.ts'));
  return { specs, jvm };
}

/** Every file under apps/ui, mapped to the files there that import it. */
function importersIn(repo: Repo, dir: string): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const f of repo.list(dir)) {
    if (!/\.(tsx?)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
    for (const dep of importsOf(repo, f)) {
      if (!rev.has(dep)) rev.set(dep, []);
      rev.get(dep)!.push(f);
    }
  }
  return rev;
}

/** The names `importer` binds from `file`: imported name (`default` for a default import, `*` for a namespace) to local name. */
export function bindings(repo: Repo, importer: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = repo.read(importer) ?? '';
  const re = /(?:^|\n)\s*import\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    if (m[1] || !m[3].startsWith('.')) continue;
    const target = resolveImport(repo, importer, m[3]);
    if (target !== file) continue;
    const clause = m[2];
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def) out.set('default', def[1]);
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) out.set('*', ns[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named ? named[1].split(',') : []) {
      const [orig, local] = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/).map((x) => x.trim());
      if (orig && !/^type\s/.test(part.trim())) out.set(orig, local ?? orig);
    }
  }
  return out;
}

const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(text);

/**
 * What a change to a TS module puts on screen, followed symbol by symbol: the
 * top-level declarations its diff touches; for each one that renders (names a
 * test id or a `data-*` attribute) its keys, and for each one that does not,
 * the declarations that use it — in the same file, or in a file that imports
 * it — until every path reaches something that renders. Edits outside every
 * declaration (the imports) act through the declarations that use them; with
 * no diff, or only such edits, every declaration counts. `interface` and
 * `type` declarations are erased at build and lead nowhere.
 */
export function reachedKeys(
  repo: Repo,
  importers: Map<string, string[]>,
  file: string,
  patch: string | undefined,
): { keys: Keys; via: string[]; typesOnly: boolean } {
  const keys = emptyKeys();
  const via: string[] = [];
  const declCache = new Map<string, Decl[]>();
  const declsOf = (f: string): Decl[] => {
    if (!declCache.has(f)) declCache.set(f, f.endsWith('.json') ? [] : declarations(repo.read(f) ?? ''));
    return declCache.get(f)!;
  };
  type Node = { file: string; decl: Decl | null };
  const own = declsOf(file);
  const lines = patch ? changedLines(patch) : [];
  let touched = own.filter((d) => lines.some((l) => l >= d.start && l <= d.end));
  if (!patch || touched.length === 0) touched = own;
  const start: Node[] = own.length ? touched.filter((d) => !d.isType).map((d) => ({ file, decl: d })) : [{ file, decl: null }];
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length) {
    const n = todo.shift()!;
    const id = `${n.file}#${n.decl?.name ?? '*'}#${n.decl?.start ?? 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (n.decl?.isType) continue;
    if (n.decl) {
      const k = tsxKeys(n.decl.text);
      if (keyCount(k) > 0) {
        merge(keys, k);
        if (!via.includes(n.file)) via.push(n.file);
        continue;
      }
      for (const d of declsOf(n.file)) if (d !== n.decl && mentions(d.text, n.decl.name)) todo.push({ file: n.file, decl: d });
    }
    for (const g of importers.get(n.file) ?? []) {
      const b = bindings(repo, g, n.file);
      const local = n.decl === null ? [...b.values()] : [b.get(n.decl.name), n.decl.isDefault ? b.get('default') : undefined, b.get('*')].filter((x): x is string => Boolean(x));
      if (!local.length) continue;
      for (const d of declsOf(g)) if (local.some((x) => mentions(d.text, x))) todo.push({ file: g, decl: d });
    }
  }
  return { keys, via, typesOnly: own.length > 0 && start.length === 0 };
}

export interface Options {
  /** Run the smoke set instead of everything, and say so (a push to main; the schedule runs the full set). */
  deferFull?: boolean;
  fullShare?: number;
}

export function select(repo: Repo, changes: Change[], { deferFull = false, fullShare = FULL_SHARE }: Options = {}): Selection {
  const all = universe(repo);
  const reasons: string[] = [];
  // Each pick's reason and rank: 0 for what changed itself (a spec, a suite, a scenario) and the
  // smoke set, otherwise how many specs share the key it was picked by — lower is more specific.
  const specs = new Map<string, { why: string; rank: number }>();
  const jvm = new Map<string, { why: string; rank: number }>();
  let allSpecs: string | null = null;
  let allJvm: string | null = null;
  const everything = (why: string): void => {
    allSpecs ??= why;
    allJvm ??= why;
  };
  const addSpec = (s: string, why: string, rank = 0): void => {
    if (all.specs.includes(s) && (specs.get(s)?.rank ?? Infinity) > rank) specs.set(s, { why, rank });
  };
  const addJvm = (f: string, why: string, rank = 0): void => {
    if ((jvm.get(f)?.rank ?? Infinity) > rank) jvm.set(f, { why, rank });
  };

  let jvmClosures: Map<string, Set<string>> | null = null;
  const jvmImporting = (f: string): string[] => {
    jvmClosures ??= new Map(all.jvm.map((s) => [s, closure(repo, [s])]));
    return all.jvm.filter((s) => s !== f && jvmClosures!.get(s)!.has(f));
  };
  const specTexts = new Map<string, string>();
  const textOf = (s: string): string => {
    if (!specTexts.has(s)) specTexts.set(s, specText(repo, `e2e/${s}`));
    return specTexts.get(s)!;
  };
  let specClosures: Map<string, Set<string>> | null = null;
  const specsImporting = (f: string): string[] => {
    specClosures ??= new Map(all.specs.map((s) => [s, closure(repo, [`e2e/${s}`])]));
    return all.specs.filter((s) => specClosures!.get(s)!.has(f));
  };
  let uiImporters: Map<string, string[]> | null = null;
  let playRuntime: Set<string> | null = null;

  for (const c of changes) {
    const f = c.filename;
    if (versionBumpOnly(c)) {
      reasons.push(`${f}: a version bump`);
      continue;
    }
    if (commentsOnly(repo, c)) {
      reasons.push(`${f}: comments only`);
      continue;
    }
    if (NOTHING.some((r) => r.test(f))) {
      reasons.push(`${f}: no Forge test reads it`);
      continue;
    }
    if (isUnitTest(f)) {
      reasons.push(`${f}: unit test, check runs it`);
      continue;
    }
    const paths = c.previous_filename ? [f, c.previous_filename] : [f];
    if (paths.some((p) => EVERYTHING.some((r) => r.test(p)))) {
      everything(`${f}: changes what every match runs on`);
      continue;
    }
    if (/^e2e\/[^/]+\.spec\.ts$/.test(f)) {
      const s = f.slice('e2e/'.length);
      if (c.status === 'removed') reasons.push(`${f}: removed`);
      else if (all.specs.includes(s)) addSpec(s, 'the spec itself changed');
      else reasons.push(`${f}: not Forge-gated (runs in check)`);
      continue;
    }
    if (f.endsWith('.jvm.test.ts')) {
      if (c.status !== 'removed') addJvm(f, 'the suite itself changed');
      continue;
    }
    if (/^e2e\//.test(f)) {
      const users = specsImporting(f);
      if (c.status === 'removed' || users.length === 0) everything(`${f}: an e2e file no spec imports (or a removed one)`);
      for (const s of users) addSpec(s, `imports ${f}`, users.length);
      continue;
    }
    if (/^apps\/server\/src\/play\/scenarios\/[^/]+\.state$/.test(f)) {
      const name = f.replace(/^.*\//, '').replace(/\.state$/, '');
      const re = new RegExp(`['"\`]${escape(name)}(\\.state)?['"\`]`);
      const specUsers = all.specs.filter((s) => re.test(repo.read(`e2e/${s}`) ?? ''));
      const jvmUsers = all.jvm.filter((j) => re.test(repo.read(j) ?? ''));
      for (const s of specUsers) addSpec(s, `starts scenario ${name}`);
      for (const j of jvmUsers) addJvm(j, `starts scenario ${name}`);
      if (specUsers.length + jvmUsers.length === 0) reasons.push(`${f}: no spec or suite names it`);
      continue;
    }
    if (/^apps\/server\//.test(f)) {
      if (!isSource(f) || c.status === 'removed') {
        everything(`${f}: ${c.status === 'removed' ? 'removed' : 'not TypeScript'} — outside the import graph`);
        continue;
      }
      for (const j of jvmImporting(f)) addJvm(j, `imports ${f}`, 1);
      playRuntime ??= closure(repo, repo.list('apps/server/src/play').filter((g) => isSource(g) && !g.includes('/scenarios/')));
      if (playRuntime.has(f)) {
        allSpecs ??= `${f}: part of the match runtime (apps/server/src/play and what it imports)`;
        continue;
      }
      // Room, HTTP and stats scaffolding: the specs that call one of its routes, and the smoke set.
      const routes = new Set<string>();
      for (const m of (repo.read(f) ?? '').matchAll(/['"`](\/[a-z][\w/-]*)/g)) if (m[1].length >= 4) routes.add(m[1].replace(/\/$/, ''));
      for (const s of SMOKE) addSpec(s, `smoke (${f})`);
      const callers = all.specs.flatMap((s) => {
        const hit = [...routes].find((r) => textOf(s).includes(r));
        return hit ? [[s, hit]] : [];
      });
      for (const [s, hit] of callers) addSpec(s, `${f}: route ${hit}`, callers.length);
      continue;
    }
    if (/^apps\/ui\//.test(f)) {
      if (c.status === 'removed') {
        allSpecs ??= `${f}: removed — what it rendered may be gone`;
        allJvm ??= `${f}: removed`;
        continue;
      }
      if (!isSource(f) && !f.endsWith('.json')) {
        reasons.push(`${f}: not part of the bundle`);
        continue;
      }
      for (const j of jvmImporting(f)) addJvm(j, `imports ${f}`, 1);
      const direct = specsImporting(f);
      for (const s of direct) addSpec(s, `imports ${f}`, direct.length);
      uiImporters ??= importersIn(repo, 'apps/ui');
      const { keys, via, typesOnly } = f.endsWith('.css') ? { ...cssChangeKeys(repo, f, c.patch), typesOnly: false } : reachedKeys(repo, uiImporters, f, c.patch);
      if (keyCount(keys) === 0) {
        if (typesOnly) reasons.push(`${f}: type declarations only — tsc covers them`);
        else if (f.endsWith('.css')) reasons.push(`${f}: its edited rules name no class or attribute`);
        else if (f.endsWith('.json') && !uiImporters.has(f)) reasons.push(`${f}: nothing in the bundle imports it`);
        else allSpecs ??= `${f}: renders nothing a spec can name, and nothing that imports it does`;
        continue;
      }
      const label = via.length === 0 || via[0] === f ? f : `${f} via ${via.slice(0, 2).join(', ')}${via.length > 2 ? ', …' : ''}`;
      for (const s of SMOKE) addSpec(s, `smoke (${f})`);
      // Which specs touch each key. A key nearly every spec touches (the OK button, a card) is
      // exercised by the smoke set, or by the smallest spec that touches it, not by all of them.
      const byKey = new Map<string, string[]>();
      for (const s of all.specs) for (const h of touched(textOf(s), keys)) byKey.set(h, [...(byKey.get(h) ?? []), s]);
      for (const [key, users] of byKey) {
        if (users.length <= UBIQUITOUS * all.specs.length) {
          for (const s of users) addSpec(s, `${label}: ${key}`, users.length);
          continue;
        }
        const smoke = users.find((s) => SMOKE.includes(s));
        const sample = smoke ?? [...users].sort((x, y) => (repo.read(`e2e/${x}`)?.length ?? 0) - (repo.read(`e2e/${y}`)?.length ?? 0))[0];
        reasons.push(`${label}: ${key} is in ${users.length} specs — sampled by ${sample}`);
        addSpec(sample, `${label}: ${key} (sample of ${users.length})`);
      }
      continue;
    }
    everything(`${f}: unclassified`);
  }

  if (allSpecs === null && specs.size > 0 && specs.size >= fullShare * all.specs.length) {
    allSpecs = `${specs.size} of ${all.specs.length} specs selected, past ${fullShare * 100}% — running all`;
  }
  // A push to main never runs the full set: it runs what changed, the smoke set and the
  // `PUSH_MAPPED` most specific picks, and the next batched full run (`forge.yml`'s schedule)
  // covers the rest.
  const deferredAll = deferFull && (allSpecs !== null || allJvm !== null);
  if (deferFull && allSpecs !== null) {
    reasons.push(`every spec needed (${allSpecs}) — deferred to the next batched full run`);
    allSpecs = null;
    for (const s of SMOKE) addSpec(s, 'smoke (the full set is deferred)');
  }
  if (deferFull && allJvm !== null) {
    reasons.push(`every jvm suite needed (${allJvm}) — deferred to the next batched full run`);
    allJvm = null;
  }
  let capped = false;
  if (deferFull) {
    const broad = [...specs].filter(([, v]) => v.rank > 0).sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]));
    for (const [s, v] of broad.slice(PUSH_MAPPED)) {
      reasons.push(`${s}: deferred to the batched full run (${v.why}; ${PUSH_MAPPED} more specific picks ran)`);
      specs.delete(s);
      capped = true;
    }
    for (const [f, v] of [...jvm].filter(([, v]) => v.rank > 0)) {
      reasons.push(`${f}: deferred to the batched full run (${v.why})`);
      jvm.delete(f);
      capped = true;
    }
  }

  const e2e = allSpecs !== null || specs.size > 0;
  if (allSpecs !== null) reasons.push(`e2e: every spec — ${allSpecs}`);
  else if (specs.size) for (const [s, v] of [...specs].sort()) reasons.push(`e2e: ${s} — ${v.why}`);
  else reasons.push('e2e: none');
  const jvmOn = allJvm !== null || jvm.size > 0;
  if (allJvm !== null) reasons.push(`jvm: every suite — ${allJvm}`);
  else if (jvm.size) for (const [s, v] of [...jvm].sort()) reasons.push(`jvm: ${s} — ${v.why}`);
  else reasons.push('jvm: none');

  return {
    e2e,
    specs: allSpecs !== null ? null : [...specs.keys()].sort(),
    jvm: jvmOn,
    jvmFiles: allJvm !== null ? null : [...jvm.keys()].sort(),
    deferred: capped || deferredAll,
    reasons,
  };
}

/* ── the CLI `forge.yml` runs ─────────────────────────────────────────── */

/** Specs beyond which a run is split across three claws. */
const ONE_SHARD_MAX = 12;

export function outputs(sel: Selection): Record<string, string> {
  const shards = sel.specs === null || sel.specs.length > ONE_SHARD_MAX ? '[1, 2, 3]' : '[1]';
  return {
    e2e: String(sel.e2e),
    e2e_specs: sel.specs === null ? '' : sel.specs.join(' '),
    shards,
    jvm: String(sel.jvm),
    jvm_files: sel.jvmFiles === null ? '' : sel.jvmFiles.join(' '),
    jvm_full: String(sel.jvm && sel.jvmFiles === null),
    deferred: String(sel.deferred),
  };
}

const USAGE = 'usage: select-forge-tests.ts <changes.json> [--defer-full] [--github-output <file>] [--root <checkout>] [--json]';

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'github-output': { type: 'string' }, root: { type: 'string' }, json: { type: 'boolean' }, 'defer-full': { type: 'boolean' } },
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  const root = values.root ?? join(import.meta.dirname, '..', '..');
  const changes = JSON.parse(readFileSync(positionals[0], 'utf8')) as Change[];
  const sel = select(new Repo(root), changes, { deferFull: values['defer-full'] });
  const o = outputs(sel);
  if (values.json) {
    console.log(JSON.stringify({ ...sel, outputs: o }));
    return;
  }
  for (const r of sel.reasons) console.log(r);
  for (const [k, v] of Object.entries(o)) console.log(`${k}=${v}`);
  if (values['github-output']) appendFileSync(values['github-output'], Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(''));
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));
