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
 * Every pick has a tier:
 *   0  what changed itself: a spec, a jvm suite, the specs and suites a
 *      changed scenario starts                                   always runs
 *   1  the guard family of a hot-path module (`GUARDS`)          always runs
 *   2  a spec the change is relevant to, scored                  a dispatch runs them all; a push
 *                                                                runs the best until `PUSH_BUDGET`
 * and the smoke set runs whenever app code changed.
 *
 * Tier 2's score adds up the evidence, per changed file:
 *   history  the specs that landed with an earlier edit to the same declaration
 *            (a top-level TS declaration, a CSS rule) — the spec a fix was proven
 *            by guards the code it fixed — and, weaker, with any earlier edit to
 *            the file. A land is the run of commits `land.sh` closes with its
 *            version bump; one carrying many specs says little about each.
 *   renders  the test ids and `data-*` attributes near the lines the diff
 *            touches, or (weighing less) near where what uses them names them,
 *            each weighted by how few specs touch it; a spec counts its rarest
 *            key once. A key more than a quarter of the specs touch tells
 *            nothing about any of them and is left to the smoke set.
 *   uses     the specs and jvm suites that use a declaration the diff touches,
 *            by name; a server module's route callers.
 *
 * The rules, in order, per changed file:
 *   a package.json whose only edit is "version"         nothing
 *   an edit to comments or whitespace only              nothing
 *   docs, *.md, .claude, scripts/sfx, other workflows   nothing
 *   a unit test                                         nothing (`check` runs it)
 *   the engine pin, a package manifest, dependencies, workspace config, forge.yml, this
 *   script, card data                                   every spec + every jvm suite (a push: the
 *                                                       smoke set, and the engine's guards for the pin)
 *   an e2e spec, a jvm suite                            itself
 *   an e2e helper                                       the specs that use what it touched
 *   a scenario (`*.state`)                              the specs + jvm suites that name it
 *   a hot-path module, or a server play module one
 *   import below one                                    its guard family (the bridge's Java: and, like the
 *                                                       engine pin, everything on a dispatch)
 *   apps/server                                         history, route callers, the jvm suites using it
 *   apps/ui source, a package's source                  history, what it renders, the specs and jvm suites
 *                                                       using it (a package: and the guards of a hot path using it)
 *   anything else                                       every spec + every jvm suite
 *
 * "What it renders" is mechanical: the test ids and `data-*` attributes near
 * the lines the diff touches, in the declarations holding them. A declaration
 * that renders none passes the question to the declarations that use it — in
 * its own file or one that imports it — until each path reaches one that
 * renders, which names the keys near where it is used; `interface` and `type`
 * declarations lead nowhere. "Uses" follows the same chains to the end: a spec
 * or jvm suite is picked for naming what the diff touched, not for importing a
 * file that some other part of the chain reaches. A stylesheet's edited rules name classes,
 * and the components that use those classes render the ids near each use. A
 * spec "touches" a key when the key appears in the spec or in the e2e helper
 * functions the spec actually calls.
 */

import { execFileSync } from 'node:child_process';
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
  /** Something needed was left to the batched full run. */
  deferred: boolean;
  /** One line per decision, for the job log. */
  reasons: string[];
}

/** Always run when any app code changes: one whole match, and the layout check. */
export const SMOKE = ['play.spec.ts', 'table-fit.spec.ts'];

/** On a push to main, scored specs are added, best first, until this many specs run in all (one shard). */
export const PUSH_BUDGET = 10;

/** A tier-2 spec runs only on this much evidence: one key a handful of specs touch, or one land with an edit to the same declaration. */
export const MIN_SCORE = 3;

/** On a push to main, the jvm suites importing a changed file directly that run beyond tiers 0 and 1. */
export const PUSH_JVM_BUDGET = 2;

/** A key more than this share of specs touch tells nothing about any one of them. */
const UBIQUITOUS = 0.25;

/** Past this share of every Forge-gated spec, a narrowed run saves too little to be worth the risk. */
export const FULL_SHARE = 0.6;

/** A land carrying more specs than this (a whole wave at once) says nothing about which spec guards what. */
const LAND_SPECS_MAX = 6;

/** A declaration longer than this (a class holding a whole module) names no narrower part of the file than the file does. */
const DECL_MAX_LINES = 300;

/** How far back the history signal reads (first-parent commits). */
const HISTORY = 2000;

export interface Guard {
  name: string;
  /** The hot-path modules, by repo path. */
  paths: RegExp;
  /** Spec basenames. */
  specs: string[];
  /** jvm suite repo paths. */
  jvm: string[];
}

/**
 * The hot paths: modules every match runs through, whose regressions surface far
 * from anything they render. A change to one always runs its guard family — the
 * specs and suites that pin its behaviour — on a push as on a dispatch. A server
 * play module one import below a hot module inherits its family. Names are
 * checked against the tree by the selector's test, so a renamed or merged spec
 * reds `check` until this table follows it.
 */
export const GUARDS: Guard[] = [
  {
    name: 'the engine',
    paths: /^(forge|apps\/server\/src\/play\/bridge\/.*)$/,
    specs: ['play.spec.ts', 'w68-untap.spec.ts', 'modal-arrows.spec.ts', 'w70-valakut.spec.ts', 'tt-cryptic.spec.ts', 'ee-thicket.spec.ts'],
    jvm: ['apps/server/src/play/match-frames.jvm.test.ts', 'apps/server/src/play/mana-sources.jvm.test.ts'],
  },
  {
    name: 'the server match',
    paths: /^apps\/server\/src\/play\/match\.ts$/,
    specs: ['w68-untap.spec.ts', 'dead-bar.spec.ts', 'waiting.spec.ts', 'lg-gamelog.spec.ts', 'w62-bounce.spec.ts', 'played-card.spec.ts'],
    jvm: ['apps/server/src/play/mana-sources.jvm.test.ts', 'apps/server/src/play/priority.jvm.test.ts'],
  },
  {
    name: 'auto-pass and auto-pay',
    paths: /^apps\/server\/src\/play\/auto\.ts$/,
    specs: ['w68-untap.spec.ts', 'w52-mana.spec.ts', 'unless-cost.spec.ts', 'w67-reveal.spec.ts', 'land-abilities.spec.ts'],
    jvm: ['apps/server/src/play/auto.jvm.test.ts', 'apps/server/src/play/auto-pass-land.jvm.test.ts', 'apps/server/src/play/mana-sources.jvm.test.ts'],
  },
  {
    name: 'pacing',
    paths: /^apps\/ui\/src\/play\/live\/pace\.ts$/,
    specs: ['w47-pace.spec.ts', 'w71-tap-reveal.spec.ts', 'dead-bar.spec.ts', 'lg-gamelog.spec.ts', 'w67-shaman.spec.ts'],
    jvm: [],
  },
  {
    name: 'the client match state',
    paths: /^apps\/ui\/src\/play\/live\/match\.ts$/,
    specs: ['dead-bar.spec.ts', 'w60-waiting.spec.ts', 'w55-withheld.spec.ts', 'w32.spec.ts', 'w54-blockers.spec.ts'],
    jvm: [],
  },
  {
    name: 'placement and gestures',
    paths: /^apps\/ui\/src\/play\/live\/((presence|placed)\.ts|gestures\/.*)$/,
    specs: ['presence.spec.ts', 'played-card.spec.ts', 'w62-parked.spec.ts', 'w67-shaman.spec.ts', 'w70-tapped-drag.spec.ts', 'w71-tap-reveal.spec.ts'],
    jvm: [],
  },
];

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

/** `run-all.txt`'s paths, which every unit suite runs on too (`scripts/land.sh`), and the engine's and the bundle's. */
const EVERYTHING: RegExp[] = [
  ...readFileSync(new URL('./run-all.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => new RegExp(l)),
  /^forge$/,
  /^\.gitmodules$/,
  /^apps\/(ui|server)\/(vite\.config\.ts|index\.html)$/,
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

const EXPORT_FROM = /(?:^|\n)\s*export\s[^'"]*?from\s*['"][^'"]+['"];?/g;

/** An edit to a module's `export … from` statements and nothing else: a new re-export is used by files changed with it, a dropped one fails tsc. */
export function reexportsOnly(repo: Repo, c: Change): boolean {
  if (c.status !== 'modified' || !c.patch || !/\.tsx?$/.test(c.filename)) return false;
  const after = repo.read(c.filename);
  if (after === null) return false;
  const rest = (src: string): string => code(src.replace(EXPORT_FROM, '\n'), false);
  const before = beforePatch(after, c.patch);
  return before !== after && rest(before) === rest(after);
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

  /** The revision history is read from; a replay of an old range reads it at that range's head. */
  protected rev = 'HEAD';
  private landCache: Land[] | null = null;

  /** `git` in this checkout, or null where there is none (a tree without `.git`, an unknown sha). */
  protected git(args: string[]): string | null {
    try {
      return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  }

  /**
   * Main's lands, newest first: first-parent history cut at the version-bump
   * commits `land.sh` closes each land with. A shallow clone has one commit of
   * history and so, honestly, no lands.
   */
  lands(): Land[] {
    if (this.landCache) return this.landCache;
    const lands: Land[] = [];
    const log = this.git(['log', '--first-parent', '--no-renames', '--name-only', '--format=%x00%H %s', '-n', String(HISTORY), this.rev]);
    let cur: Land = { commits: [] };
    for (const chunk of (log ?? '').split('\0').slice(1)) {
      const [head, ...files] = chunk.split('\n').filter(Boolean);
      if (BUMP.test(head.slice(41))) {
        if (cur.commits.length) lands.push(cur);
        cur = { commits: [] };
      } else cur.commits.push({ sha: head.slice(0, 40), files });
    }
    if (cur.commits.length) lands.push(cur);
    this.landCache = lands;
    return lands;
  }

  /** The declarations or rules commit `sha` edited in `file`, by name (`touchedNames`). */
  touchedAt(sha: string, file: string): string[] {
    const show = this.git(['show', '--format=', '-U0', '--no-renames', sha, '--', file]);
    const src = this.git(['show', `${sha}:${file}`]);
    const at = show?.indexOf('\n@@') ?? -1;
    return src === null || at < 0 ? [] : touchedNames(file, src, show!.slice(at + 1));
  }
}

export interface Land {
  commits: { sha: string; files: string[] }[];
}

/** `land.sh`'s closing commit: `ui 0.32.190, server 0.32.121`. */
const BUMP = /^(ui|server) \d+\.\d+\.\d+(, (ui|server) \d+\.\d+\.\d+)?$/;

/** The top-level declarations (TS) or rule selectors (CSS) a diff of `src` touches. */
export function touchedNames(file: string, src: string, patch: string): string[] {
  const lines = changedLines(patch, src);
  if (file.endsWith('.css')) return [...new Set(changedSelectors(src, lines).map((s) => s.replace(/\s+/g, ' ')))];
  if (!/\.tsx?$/.test(file)) return [];
  const decls = declarations(src).filter((d) => d.end - d.start < DECL_MAX_LINES);
  return [...new Set(decls.filter((d) => lines.some((l) => l >= d.start && l <= d.end)).map((d) => d.name))];
}

/* ── imports ──────────────────────────────────────────────────────────── */

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The repo paths `file` imports: by relative specifier, or a workspace package by its name (npm modules are not followed). */
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

/** The repo path a specifier in `from` names (`./x.js` may be `x.ts`; `@hadoku/deck/library` is what that package exports as `./library`), or null. */
export function resolveImport(repo: Repo, from: string, spec: string): string | null {
  const pkg = /^@hadoku\/([\w-]+)(\/.+)?$/.exec(spec);
  if (pkg) {
    const manifest = repo.read(`packages/${pkg[1]}/package.json`);
    const exported = manifest === null ? undefined : (JSON.parse(manifest) as { exports?: Record<string, string> }).exports?.[`.${pkg[2] ?? ''}`];
    return typeof exported === 'string' ? normalize(join(`packages/${pkg[1]}`, exported)) : null;
  }
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec));
  const stem = base.replace(/\.(js|ts|tsx|jsx)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => repo.read(c) !== null) ?? null;
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

interface Hunk {
  /** The new-side line the hunk claims to start at. */
  start: number;
  /** Its new-side text: context and added lines, in order. */
  block: string[];
  /** Offsets into `block` of the lines it touches: added lines, and where a deletion sat. */
  touched: number[];
}

function hunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let h: Hunk | null = null;
  for (const line of patch.split('\n')) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (head) out.push((h = { start: Number(head[1]), block: [], touched: [] }));
    else if (!h || line.startsWith('\\')) continue;
    else if (line.startsWith('-')) h.touched.push(h.block.length);
    else {
      if (line.startsWith('+')) h.touched.push(h.block.length);
      h.block.push(line.slice(1));
    }
  }
  return out;
}

/** The 1-based line in `lines` where `block` occurs nearest to `near`, or null. */
function find(lines: string[], block: string[], near: number): number | null {
  if (block.length === 0) return null;
  let best: number | null = null;
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (!block.every((b, j) => lines[i + j] === b)) continue;
    if (best === null || Math.abs(i + 1 - near) < Math.abs(best - near)) best = i + 1;
  }
  return best;
}

/**
 * New-side line numbers a unified diff touches: added lines, and where a deletion sat.
 *
 * With `src`, each hunk is read where its text sits in `src` rather than where
 * the diff says: a diff is only exact against its own post-image, and the file
 * the selector reads may be a later one (a fixture replayed on today's tree, an
 * edit above it since). A hunk whose text is gone keeps the diff's numbers.
 */
export function changedLines(patch: string, src?: string): number[] {
  const lines = src?.split('\n');
  const out = new Set<number>();
  for (const h of hunks(patch)) {
    for (const at of anchor(h, lines).values()) out.add(at);
  }
  return [...out];
}

/** Too little text to find by itself: a run of added lines shorter than this is placed by its neighbours. */
const ANCHOR_MIN = 16;

/**
 * Where each of a hunk's touched offsets sits in `lines`: the whole hunk where
 * its text still is; else each run of added lines where that run still is (the
 * context around it may have been edited since), and a touch no run places
 * moved with the nearest run that was placed; else where the diff says.
 */
function anchor(h: Hunk, lines: string[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  const place = (delta: number): void => h.touched.forEach((t) => out.set(t, h.start + t + delta));
  if (!lines || h.block.every((b, j) => lines[h.start - 1 + j] === b)) return (place(0), out);
  const whole = find(lines, h.block, h.start);
  if (whole !== null) return (place(whole - h.start), out);
  const deltas: { at: number; delta: number }[] = [];
  const added = new Set(h.touched.filter((t) => t < h.block.length));
  for (let i = 0; i < h.block.length; ) {
    if (!added.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (added.has(j)) j++;
    const run = h.block.slice(i, j);
    const found = run.join('').trim().length >= ANCHOR_MIN ? find(lines, run, h.start + i) : null;
    if (found !== null) deltas.push({ at: i, delta: found - (h.start + i) });
    i = j;
  }
  if (!deltas.length) return (place(0), out);
  for (const t of h.touched) {
    const near = deltas.reduce((a, b) => (Math.abs(b.at - t) < Math.abs(a.at - t) ? b : a));
    out.set(t, h.start + t + near.delta);
  }
  return out;
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
 * edits (direct), and the ids rendered within `RADIUS` lines of each component
 * line that uses one of those classes (reached). With no diff, every rule counts.
 */
const RADIUS = 12;
export function cssChangeKeys(repo: Repo, file: string, patch: string | undefined): Reached {
  const css = repo.read(file) ?? '';
  const direct = patch ? cssKeys(changedSelectors(css, changedLines(patch, css)).map((s) => `${s}{}`).join('\n')) : cssKeys(css);
  const reached = emptyKeys();
  const via: string[] = [];
  if (direct.classes.size === 0) return { direct, reached, via, typesOnly: false };
  const uses = [...direct.classes].map((c) => new RegExp(`['"\`][^'"\`\n]*(?<![\\w-])${escape(c)}(?![\\w-])`));
  for (const f of repo.list('apps/ui')) {
    if (!f.endsWith('.tsx')) continue;
    const lines = (repo.read(f) ?? '').split('\n');
    const hits = lines.flatMap((l, i) => (uses.some((u) => u.test(l)) ? [i] : []));
    if (!hits.length) continue;
    via.push(f);
    for (const i of hits) merge(reached, tsxKeys(lines.slice(Math.max(0, i - RADIUS), i + RADIUS + 1).join('\n')));
  }
  return { direct, reached, via, typesOnly: false };
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

/** What `touched` reads off a spec's text whatever the keys, so a spec is scanned once and not once per key. */
interface SpecScan {
  text: string;
  /** Every short quoted string in it. */
  quoted: string[];
  /** A selector's `[data-testid^="live-button"]` names every id it is a prefix of. */
  prefixSelectors: string[];
}

function scanSpec(text: string): SpecScan {
  return {
    text,
    quoted: [...new Set([...text.matchAll(/(['"`])([^'"`\n]{2,80}?)\1/g)].map((m) => m[2]))],
    prefixSelectors: [...text.matchAll(/data-testid[\^*]=\\?["']([^"'\\]+)/g)].map((m) => m[1]),
  };
}

/** Each pattern `touched` builds, compiled once: the same key is tried against every spec. */
const patterns = new Map<string, RegExp>();
const pattern = (source: string): RegExp => {
  let re = patterns.get(source);
  if (re === undefined) patterns.set(source, (re = new RegExp(source)));
  return re;
};

/** Which of `keys` a spec touches, as printable names; empty if none. */
export function touched({ text, quoted, prefixSelectors }: SpecScan, keys: Keys): string[] {
  const hits: string[] = [];
  for (const id of keys.testids) {
    if (pattern(`(?<![\\w-])${escape(id)}(?![\\w-])`).test(text) || prefixSelectors.some((p) => id.startsWith(p))) hits.push(`testid ${id}`);
  }
  for (const p of keys.prefixes) {
    if (quoted.some((q) => q.startsWith(p)) || text.includes(p)) hits.push(`testid ${p}*`);
  }
  for (const a of keys.attrs) if (pattern(`(?<![\\w-])${escape(a)}(?![\\w-])`).test(text)) hits.push(`attr ${a}`);
  // A selector's `.name`, never a file name's extension.
  for (const c of keys.classes) if (pattern(`(?<=^|[\\s'"\`>,(+~:])\\.${escape(c)}(?![\\w-])`).test(text)) hits.push(`class .${c}`);
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

/** Every TS file under `dirs`, mapped to the files there that import it; unit tests import nothing that matters here, jvm suites do. */
function importersIn(repo: Repo, ...dirs: string[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const f of dirs.flatMap((d) => repo.list(d))) {
    if (!/\.(tsx?)$/.test(f) || isUnitTest(f)) continue;
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
    if (m[1] || resolveImport(repo, importer, m[3]) !== file) continue;
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

/** The names `importer` re-exports from `file` (`export { a as b } from`, `export * from`): original name to exported name, `*` for all. */
export function reexports(repo: Repo, importer: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = repo.read(importer) ?? '';
  for (const m of src.matchAll(/(?:^|\n)\s*export\s+(type\s+)?(\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1] || resolveImport(repo, importer, m[3]) !== file) continue;
    if (m[2] === '*') out.set('*', '*');
    for (const part of m[2] === '*' ? [] : m[2].slice(1, -1).split(',')) {
      const [orig, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
      if (orig && !/^type\s/.test(orig)) out.set(orig, alias ?? orig);
    }
  }
  return out;
}

const mentions = (text: string, name: string): boolean => new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`).test(text);

export interface Reached {
  /** Rendered by what the diff touched itself. */
  direct: Keys;
  /** Rendered only by what uses it. */
  reached: Keys;
  via: string[];
  typesOnly: boolean;
}

/** An `import … from '…'` or `export … from '…'` statement, however many lines it spans. */
const STATEMENT_FROM = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"][^'"]+['"];?/g;

/** A step of a use chain: a declaration (null: a file's top-level code), the lines in it that touch or name what led here (null: all of it), and how many imports from the changed file. */
interface Use {
  file: string;
  decl: Decl | null;
  lines: number[] | null;
  depth: number;
}

/**
 * Walks from the top-level declarations a diff of `file` touches to whatever
 * uses them, by name: the declarations naming one in its own file, and in each
 * file importing (or re-exporting) it the declarations naming its binding, and
 * so on. `visit` sees each use once and returns true to end that path there.
 * Edits outside every declaration (the imports) act through the declarations
 * that use them; with no diff, or only such edits, every declaration counts.
 * `interface` and `type` declarations are erased at build and lead nowhere.
 */
function walkUses(repo: Repo, importers: Map<string, string[]>, file: string, patch: string | undefined, visit: (u: Use, start: boolean) => boolean): { typesOnly: boolean } {
  const declCache = new Map<string, Decl[]>();
  const declsOf = (f: string): Decl[] => {
    if (!declCache.has(f)) declCache.set(f, f.endsWith('.json') ? [] : declarations(repo.read(f) ?? ''));
    return declCache.get(f)!;
  };
  const mentionLines = (d: Decl, name: string): number[] => d.text.split('\n').flatMap((l, i) => (mentions(l, name) ? [d.start + i] : []));
  const own = declsOf(file);
  const lines = patch ? changedLines(patch, repo.read(file) ?? undefined) : [];
  const hit = own.filter((d) => lines.some((l) => l >= d.start && l <= d.end));
  const start: Use[] = !own.length
    ? [{ file, decl: null, lines: null, depth: 0 }]
    : (hit.length && patch ? hit : own).filter((d) => !d.isType).map((d) => ({ file, decl: d, lines: hit.length && patch ? lines.filter((l) => l >= d.start && l <= d.end) : null, depth: 0 }));
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length) {
    const u = todo.shift()!;
    const id = `${u.file}#${u.decl?.name ?? '*'}#${u.decl?.start ?? 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (visit(u, start.includes(u))) continue;
    const name = u.decl?.name;
    if (u.decl) for (const d of declsOf(u.file)) if (d !== u.decl && d.start > 0 && mentions(d.text, name!)) todo.push({ file: u.file, decl: d, lines: mentionLines(d, name!), depth: u.depth });
    for (const g of importers.get(u.file) ?? []) {
      const b = bindings(repo, g, u.file);
      const local = u.decl === null ? [...b.values()] : [b.get(name!), u.decl.isDefault ? b.get('default') : undefined, b.get('*')].filter((x): x is string => Boolean(x));
      const users = declsOf(g).filter((d) => local.some((x) => mentions(d.text, x)));
      for (const d of users) todo.push({ file: g, decl: d, lines: local.flatMap((x) => mentionLines(d, x)), depth: u.depth + 1 });
      // Top-level code before any declaration: a test file's `describe`, an entry's render.
      const body = (repo.read(g) ?? '').split('\n').slice(0, (declsOf(g)[0]?.start ?? Infinity) - 1).join('\n').replace(STATEMENT_FROM, '');
      if (!users.length && local.some((x) => mentions(body, x))) todo.push({ file: g, decl: null, lines: null, depth: u.depth + 1 });
      const rx = reexports(repo, g, u.file);
      const out = u.decl === null ? [...rx.values()] : [rx.get(name!) ?? (rx.has('*') ? name! : undefined)].filter((x): x is string => Boolean(x));
      for (const x of out) todo.push({ file: g, decl: x === '*' ? null : { name: x, start: 0, end: 0, text: '', isDefault: false, isType: false }, lines: [], depth: u.depth + 1 });
    }
  }
  return { typesOnly: own.length > 0 && start.length === 0 };
}

/**
 * The keys a declaration renders near `lines` (all of them for null): within
 * `RADIUS` lines of each, or else the nearest above and below. A component
 * drawing half the board names, near any one edit, the few ids that edit moves.
 */
export function keysNear(d: Decl, lines: number[] | null): Keys {
  if (lines === null) return tsxKeys(d.text);
  const text = d.text.split('\n');
  const rel = lines.map((l) => l - d.start).filter((r) => r >= 0 && r < text.length);
  const window = (from: number, to: number): Keys => tsxKeys(text.slice(Math.max(0, from), to + 1).join('\n'));
  const k = emptyKeys();
  for (const r of rel) merge(k, window(r - RADIUS, r + RADIUS));
  if (keyCount(k) > 0) return k;
  const keyed = text.flatMap((l, i) => (keyCount(tsxKeys(l)) > 0 ? [i] : []));
  for (const r of rel) {
    const below = keyed.find((i) => i > r);
    const above = keyed.findLast((i) => i < r);
    for (const i of [above, below]) if (i !== undefined) merge(k, window(i, i));
  }
  return k;
}

/**
 * What a change to a TS module puts on screen, followed symbol by symbol
 * (`walkUses`): a declaration the diff touches that renders (names a test id
 * or a `data-*` attribute) gives the keys near the edit (`direct`); one that
 * does not passes the question to what uses it, which gives the keys near where
 * it is named (`reached`), and so on until every path reaches something that
 * renders.
 */
export function reachedKeys(repo: Repo, importers: Map<string, string[]>, file: string, patch: string | undefined): Reached {
  const direct = emptyKeys();
  const reached = emptyKeys();
  const via: string[] = [];
  const { typesOnly } = walkUses(repo, importers, file, patch, (u, start) => {
    if (!u.decl) return false;
    const k = keysNear(u.decl, u.lines);
    if (keyCount(k) === 0) return false;
    merge(start ? direct : reached, k);
    if (!via.includes(u.file)) via.push(u.file);
    return true;
  });
  return { direct, reached, via, typesOnly };
}

/** The files that use what a diff of `file` touched (`walkUses`), each with how many imports away. */
export function usersOf(repo: Repo, importers: Map<string, string[]>, file: string, patch: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  walkUses(repo, importers, file, patch, (u) => {
    const d = out.get(u.file);
    if (u.file !== file && (d === undefined || u.depth < d)) out.set(u.file, u.depth);
    return false;
  });
  return out;
}

export interface Options {
  /** A push to main: never the full set, and tier 2 only up to `PUSH_BUDGET` (the schedule runs the rest). */
  deferFull?: boolean;
  fullShare?: number;
  /** The hot-path table; `GUARDS` unless a test brings its own. */
  guards?: Guard[];
}

/** Each key alone, with the name `touched` prints for it. */
function singleKeys(k: Keys): [string, Keys][] {
  return [
    ...[...k.testids].map((t): [string, Keys] => [`testid ${t}`, { ...emptyKeys(), testids: new Set([t]) }]),
    ...[...k.prefixes].map((t): [string, Keys] => [`testid ${t}*`, { ...emptyKeys(), prefixes: new Set([t]) }]),
    ...[...k.attrs].map((t): [string, Keys] => [`attr ${t}`, { ...emptyKeys(), attrs: new Set([t]) }]),
    ...[...k.classes].map((t): [string, Keys] => [`class .${t}`, { ...emptyKeys(), classes: new Set([t]) }]),
  ];
}

/** One candidate: its tier (lower runs first and is never cut), its tier-2 score, and the evidence. */
interface Pick {
  tier: number;
  score: number;
  why: { text: string; score: number }[];
}

/** The strongest piece of evidence, for the job log. */
const reason = (p: Pick): string => {
  const top = [...p.why].sort((a, b) => b.score - a.score)[0];
  return p.tier < 2 ? top.text : `${top.text}${p.why.length > 1 ? ` (+${p.why.length - 1} more)` : ''}; score ${p.score.toFixed(1)}`;
};

/** A router registration: `router.get('/api/x', …)`, `app.use('/rooms', …)`. */
const ROUTE = /\.(?:get|post|put|patch|delete|all|use)\(\s*['"`](\/[^'"`]*)['"`]/g;

/**
 * The static parts of the routes a server change registers, in the
 * declarations its diff touches (all of them, without a diff): `/:id/join`
 * is called as `/rooms/abc/join`, so `/join` is what a spec's text holds.
 */
export function registeredRoutes(repo: Repo, c: Change): string[] {
  const src = repo.read(c.filename) ?? '';
  const lines = c.patch ? changedLines(c.patch, src) : [];
  const hit = declarations(src).filter((d) => lines.some((l) => l >= d.start && l <= d.end));
  const text = c.patch && hit.length ? hit.map((d) => d.text).join('\n') : src;
  const out = new Set<string>();
  for (const m of text.matchAll(ROUTE)) for (const part of m[1].split(/\/:[^/]+/)) if (part.replace(/\/$/, '').length >= 4) out.add(part.replace(/\/$/, ''));
  return [...out];
}

/** Score weights: a key's is log(specs / specs touching it); history weighs a one-spec land like a rare key; a use or a route call is enough alone. */
const W = { reachedKey: 0.75, landDecl: 4, landFile: 1.5, importer: 3 };

export function select(repo: Repo, changes: Change[], { deferFull = false, fullShare = FULL_SHARE, guards = GUARDS }: Options = {}): Selection {
  const all = universe(repo);
  const reasons: string[] = [];
  const specs = new Map<string, Pick>();
  const jvm = new Map<string, Pick>();
  let allSpecs: string | null = null;
  let allJvm: string | null = null;
  const everything = (why: string): void => {
    allSpecs ??= why;
    allJvm ??= why;
  };
  const add = (into: Map<string, Pick>, key: string, tier: number, text: string, score = 0): void => {
    const p = into.get(key);
    if (!p || tier < p.tier) into.set(key, { tier, score, why: [{ text, score }] });
    else if (tier === p.tier) {
      p.score += score;
      p.why.push({ text, score });
    }
  };
  const addSpec = (s: string, tier: number, text: string, score = 0): void => {
    if (all.specs.includes(s)) add(specs, s, tier, text, score);
  };
  const addJvm = (f: string, tier: number, text: string, score = 0): void => {
    if (all.jvm.includes(f)) add(jvm, f, tier, text, score);
  };
  const smoke = (f: string): void => {
    for (const s of SMOKE) addSpec(s, 0, `smoke (${f})`);
  };
  const guard = (g: Guard, why: string): void => {
    for (const s of g.specs) addSpec(s, 1, `guards ${g.name} (${why})`);
    for (const j of g.jvm) addJvm(j, 1, `guards ${g.name} (${why})`);
  };

  let allImporters: Map<string, string[]> | null = null;
  const users = new Map<Change, Map<string, number>>();
  /** The files using what change `c` touched, by name (`usersOf`). */
  const usersOfChange = (c: Change): Map<string, number> => {
    allImporters ??= importersIn(repo, 'apps', 'packages', 'e2e');
    if (!users.has(c)) users.set(c, usersOf(repo, allImporters, c.filename, c.patch));
    return users.get(c)!;
  };
  /** The jvm suites using what `c` touched, each scored by how directly. */
  const jvmUsing = (c: Change): void => {
    for (const [s, d] of usersOfChange(c)) if (all.jvm.includes(s)) addJvm(s, 2, `uses ${c.filename}${d > 1 ? ` (${d} deep)` : ''}`, 1 / d);
  };
  const specScans = new Map<string, SpecScan>();
  const scanOf = (s: string): SpecScan => {
    if (!specScans.has(s)) specScans.set(s, scanSpec(specText(repo, `e2e/${s}`)));
    return specScans.get(s)!;
  };
  /** The specs using what `c` touched. */
  const specsUsing = (c: Change): string[] => all.specs.filter((s) => usersOfChange(c).has(`e2e/${s}`));
  let uiImporters: Map<string, string[]> | null = null;
  /**
   * Score the specs touching a key by how few do, each by its rarest key: ten
   * keys of one component a spec happens to read are one piece of evidence,
   * not ten. A key most specs touch is left to the smoke set.
   */
  const byKeys = (label: string, keys: Keys, weight: number): void => {
    const best = new Map<string, { name: string; score: number }>();
    for (const [name, one] of singleKeys(keys)) {
      const users = all.specs.filter((s) => touched(scanOf(s), one).length > 0);
      if (users.length === 0) continue;
      if (users.length > UBIQUITOUS * all.specs.length) {
        reasons.push(`${label}: ${name} is in ${users.length} specs — the smoke set covers it`);
        continue;
      }
      const score = weight * Math.log(all.specs.length / users.length);
      for (const s of users) if ((best.get(s)?.score ?? -1) < score) best.set(s, { name, score });
    }
    for (const [s, { name, score }] of best) addSpec(s, 2, `${label}: ${name}`, score);
  };
  /** The specs that landed with earlier edits to `f`: to the same declarations, or to the file at all. */
  let historyRead = false;
  const history = (f: string, names: string[]): void => {
    historyRead = true;
    const fileOnly = new Map<string, { sha: string; score: number }>();
    for (const land of repo.lands()) {
      const landed = [...new Set(land.commits.flatMap((c) => c.files).filter((g) => /^e2e\/[^/]+\.spec\.ts$/.test(g)).map((g) => g.slice('e2e/'.length)))].filter((s) =>
        all.specs.includes(s),
      );
      if (landed.length === 0 || landed.length > LAND_SPECS_MAX) continue;
      const edits = land.commits.filter((c) => c.files.includes(f));
      if (edits.length === 0) continue;
      const same = names.length > 0 ? edits.flatMap((c) => repo.touchedAt(c.sha, f)).find((n) => names.includes(n)) : undefined;
      for (const s of landed) {
        if (same) addSpec(s, 2, `${f}: landed with an edit to ${same.length > 60 ? `${same.slice(0, 57)}…` : same} (${edits[0].sha.slice(0, 8)})`, W.landDecl / landed.length);
        else if (!fileOnly.has(s) || fileOnly.get(s)!.score < W.landFile / landed.length) fileOnly.set(s, { sha: edits[0].sha, score: W.landFile / landed.length });
      }
    }
    // Landing beside another edit to a file many lands edit is one hint, however often it happened.
    for (const [s, { sha, score }] of fileOnly) addSpec(s, 2, `${f}: landed with an edit to it (${sha.slice(0, 8)})`, score);
  };
  /** The current diff's own touched names, for `history`. */
  const namesOf = (c: Change): string[] => {
    const src = repo.read(c.filename);
    return src === null || !c.patch ? [] : touchedNames(c.filename, src, c.patch);
  };

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
    if (reexportsOnly(repo, c)) {
      reasons.push(`${f}: re-exports only`);
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
    for (const g of guards) if (paths.some((p) => g.paths.test(p))) guard(g, f);
    if (paths.some((p) => EVERYTHING.some((r) => r.test(p)))) {
      everything(`${f}: changes what every match runs on`);
      continue;
    }
    if (/^e2e\/[^/]+\.spec\.ts$/.test(f)) {
      const s = f.slice('e2e/'.length);
      if (c.status === 'removed') reasons.push(`${f}: removed`);
      else if (all.specs.includes(s)) addSpec(s, 0, 'the spec itself changed');
      else reasons.push(`${f}: not Forge-gated (runs in check)`);
      continue;
    }
    if (f.endsWith('.jvm.test.ts')) {
      if (c.status !== 'removed') addJvm(f, 0, 'the suite itself changed');
      continue;
    }
    if (/^e2e\//.test(f)) {
      if (c.status === 'removed') everything(`${f}: a removed e2e file`);
      const users = specsUsing(c);
      if (users.length === 0) reasons.push(`${f}: no spec uses what it touched`);
      for (const s of users) addSpec(s, 2, `uses ${f}`, W.importer);
      continue;
    }
    if (/^apps\/server\/src\/play\/scenarios\/[^/]+\.state$/.test(f)) {
      const name = f.replace(/^.*\//, '').replace(/\.state$/, '');
      const re = new RegExp(`['"\`]${escape(name)}(\\.state)?['"\`]`);
      const specUsers = all.specs.filter((s) => re.test(repo.read(`e2e/${s}`) ?? ''));
      const jvmUsers = all.jvm.filter((j) => re.test(repo.read(j) ?? ''));
      for (const s of specUsers) addSpec(s, 0, `starts scenario ${name}`);
      for (const j of jvmUsers) addJvm(j, 0, `starts scenario ${name}`);
      if (specUsers.length + jvmUsers.length === 0) reasons.push(`${f}: no spec or suite names it`);
      continue;
    }
    if (guards.some((g) => paths.some((p) => g.paths.test(p)))) {
      // A hot path: its family above, and what history adds.
      smoke(f);
      if (/^apps\/server\/src\/play\/bridge\/.*\.java$/.test(f)) everything(`${f}: the engine's own layer, which every match runs through`);
      history(f, namesOf(c));
      if (isSource(f)) jvmUsing(c);
      continue;
    }
    if (/^apps\/server\//.test(f)) {
      if (!isSource(f) || c.status === 'removed') {
        everything(`${f}: ${c.status === 'removed' ? 'removed' : 'not TypeScript'} — outside the import graph`);
        continue;
      }
      smoke(f);
      jvmUsing(c);
      history(f, namesOf(c));
      // One import below a hot module: what guards that module guards this.
      for (const g of guards) {
        const hot = repo.list('apps/server/src/play').filter((h) => g.paths.test(h) && importsOf(repo, h).includes(f));
        if (hot.length) guard(g, `${f}, imported by ${hot[0]}`);
      }
      // Room, HTTP and stats scaffolding: the specs that call a route the diff registers.
      const routes = registeredRoutes(repo, c);
      const callers = all.specs.flatMap((s) => {
        const hit = routes.find((r) => scanOf(s).text.includes(r));
        return hit ? [[s, hit]] : [];
      });
      for (const [s, hit] of callers) addSpec(s, 2, `${f}: route ${hit}`, W.importer);
      continue;
    }
    if (/^(apps\/ui|packages)\//.test(f)) {
      if (c.status === 'removed') {
        allSpecs ??= `${f}: removed — what it rendered may be gone`;
        allJvm ??= `${f}: removed`;
        continue;
      }
      if (!isSource(f) && !f.endsWith('.json')) {
        reasons.push(`${f}: not part of the bundle`);
        continue;
      }
      jvmUsing(c);
      history(f, namesOf(c));
      // A package the server runs a hot path through: what guards that path guards this.
      if (/^packages\//.test(f)) for (const g of guards) for (const [u] of usersOfChange(c)) if (g.paths.test(u)) guard(g, `${f}, used by ${u}`);
      if (f.endsWith('.json')) {
        smoke(f);
        // Data: the components importing it render it, but every key they render is theirs, not its.
        reasons.push(`${f}: data — the smoke set, and what landed with it`);
        continue;
      }
      for (const s of specsUsing(c)) addSpec(s, 2, `uses ${f}`, W.importer);
      uiImporters ??= importersIn(repo, 'apps/ui', 'packages');
      const r = f.endsWith('.css') ? cssChangeKeys(repo, f, c.patch) : reachedKeys(repo, uiImporters, f, c.patch);
      if (keyCount(r.direct) + keyCount(r.reached) === 0) {
        if (r.typesOnly) reasons.push(`${f}: type declarations only — tsc covers them`);
        else if (f.endsWith('.css')) reasons.push(`${f}: its edited rules name no class or attribute`);
        else {
          reasons.push(`${f}: renders nothing a spec can name — the smoke set, and what landed with it`);
          smoke(f);
        }
        continue;
      }
      smoke(f);
      const label = r.via.length === 0 || r.via[0] === f ? f : `${f} via ${r.via.slice(0, 2).join(', ')}${r.via.length > 2 ? ', …' : ''}`;
      byKeys(f, r.direct, 1);
      byKeys(label, r.reached, W.reachedKey);
      continue;
    }
    everything(`${f}: unclassified`);
  }

  const best = (m: Map<string, Pick>): [string, Pick][] => [...m].filter(([, p]) => p.tier === 2).sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  for (const [s, p] of best(specs).filter(([, p]) => p.score < MIN_SCORE)) {
    reasons.push(`${s}: not run — too little evidence (${reason(p)})`);
    specs.delete(s);
  }
  if (allSpecs === null && specs.size > 0 && specs.size >= fullShare * all.specs.length && !deferFull) {
    allSpecs = `${specs.size} of ${all.specs.length} specs selected, past ${fullShare * 100}% — running all`;
  }
  // A push to main never runs the full set: tiers 0 and 1, then the best of tier 2 up to
  // `PUSH_BUDGET`; the next batched full run (`forge.yml`'s schedule) covers the rest.
  let deferred = false;
  if (deferFull && allSpecs !== null) {
    reasons.push(`every spec needed (${allSpecs}) — deferred to the next batched full run`);
    allSpecs = null;
    for (const s of SMOKE) addSpec(s, 0, 'smoke (the full set is deferred)');
    deferred = true;
  }
  if (deferFull && allJvm !== null) {
    reasons.push(`every jvm suite needed (${allJvm}) — deferred to the next batched full run`);
    allJvm = null;
    deferred = true;
  }
  if (deferFull) {
    const room = Math.max(0, PUSH_BUDGET - [...specs.values()].filter((p) => p.tier < 2).length);
    for (const [s, p] of best(specs).slice(room)) {
      reasons.push(`${s}: deferred to the batched full run (${reason(p)})`);
      specs.delete(s);
      deferred = true;
    }
    const ranked = best(jvm);
    const kept = ranked.filter(([, p]) => p.score >= 1).slice(0, PUSH_JVM_BUDGET);
    for (const [f, p] of ranked.filter((e) => !kept.includes(e))) {
      reasons.push(`${f}: deferred to the batched full run (${reason(p)})`);
      jvm.delete(f);
      deferred = true;
    }
  }

  if (historyRead) reasons.push(`history: ${repo.lands().length} lands read${repo.lands().length ? '' : ' — no history here (a shallow checkout?), so no spec was picked for landing with this code'}`);
  const e2e = allSpecs !== null || specs.size > 0;
  const list = (m: Map<string, Pick>): string[] => [...m].sort((a, b) => a[1].tier - b[1].tier || b[1].score - a[1].score || a[0].localeCompare(b[0])).map(([k, p]) => `${k} — ${reason(p)}`);
  if (allSpecs !== null) reasons.push(`e2e: every spec — ${allSpecs}`);
  else if (specs.size) for (const l of list(specs)) reasons.push(`e2e: ${l}`);
  else reasons.push('e2e: none');
  const jvmOn = allJvm !== null || jvm.size > 0;
  if (allJvm !== null) reasons.push(`jvm: every suite — ${allJvm}`);
  else if (jvm.size) for (const l of list(jvm)) reasons.push(`jvm: ${l}`);
  else reasons.push('jvm: none');

  return {
    e2e,
    specs: allSpecs !== null ? null : [...specs.keys()].sort(),
    jvm: jvmOn,
    jvmFiles: allJvm !== null ? null : [...jvm.keys()].sort(),
    deferred,
    reasons,
  };
}

/* ── the CLI `forge.yml` runs ─────────────────────────────────────────── */

/** Specs beyond which a run is split across three CI runners. */
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
