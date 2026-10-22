/*
 * Every stylesheet in this app is global: nothing scopes a class name, so a rule
 * one screen writes for its own `.seat` lands on every other `.seat` too. The
 * draft pod's circle did exactly that to the match board (2026-10-21). This
 * suite is what stands in for scoping.
 *
 * A block is a class name before its `__` or `--`. A rule claims the block of its
 * leftmost class, so `.board .card` claims `board`, not `card`.
 *
 * Each sheet belongs to the component tree that imports it. A component's tree
 * takes in what it imports from the directories below its own, and the plain
 * modules beside it, when those draw with a sheet: `play/Board.tsx` and the
 * `play/live/` behaviours it installs are one tree. A component beside it is its
 * own tree (each prompt, each screen), and so is anything a router imports. The
 * source root holds no tree, since `App.tsx` imports every screen.
 *
 *   A  two trees' sheets claim the same block
 *   B  a block is drawn by two trees, and one of them neither styles it nor
 *      imports the tree that does (any string literal counts: SeatBar built
 *      `['seat', …]`)
 *   C  a class is styled and rendered nowhere
 *
 * `styles.css`, `chrome/chrome.css` and `chrome/trim.css` are the global sheets, one owner between them.
 */
// @reads apps/ui/src/ scripts/ci/select-forge-tests.ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GUARDS } from '../../../scripts/ci/select-forge-tests.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

const GLOBAL_SHEETS = ['styles.css', 'chrome/chrome.css', 'chrome/trim.css'];

/** Blocks more than one tree draws or styles by design, with why. */
const SHARED: Record<string, string> = {
  button: 'the app’s one plain button, drawn wherever a screen has a press',
  'ct-surface': 'the chrome’s raised card, under every popover and menu',
  'ct-panel': 'the trim hook: every panel that takes the decoration chosen in Settings → Trim (`chrome/trim.css`)',
  'cardtable-chrome': 'the chrome root: the app and the embed mount the same one, and the embed adds its modifier',
  'sound-builder': 'the sound tools (builder, sandbox, music review, queue) are one sheet’s screens',
};

/** Blocks (rules A, B) and classes (rule C) whose fix is in a sheet another lane holds. Each must still fail, or its entry goes. */
const PENDING: Record<string, string> = {
  card: 'card.css styles CardTile’s `.card` for the board without scoping it',
};

/** Classes other packages draw, which our sheets restyle. */
const EXTERNAL = /^(wp-|gs-|app-header|theme-|ms$|ms-|ss$|ss-)/;

// ── the modules ─────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'symbols' ? [] : walk(p);
    return [relative(SRC, p)];
  });
}

const files = walk(SRC);
const sheets = files.filter((f) => f.endsWith('.css'));
const modules = files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$|\.d\.ts$|^test-setup\.ts$/.test(f));
const source = new Map([...sheets, ...modules].map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));
const read = (f: string): string => source.get(f) ?? '';

/** Blank out text, keeping every newline so line numbers hold. */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
const lineAt = (src: string, index: number): number => src.slice(0, index).split('\n').length;

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** A module's value imports, resolved to source paths: a type import draws nothing. */
function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const m of read(file).matchAll(IMPORT)) {
    const spec = m[2] ?? m[3];
    if (m[1] || spec === undefined || !spec.startsWith('.')) continue;
    out.push(relative(SRC, resolve(SRC, dirname(file), spec)));
  }
  return out;
}
const imports = new Map(modules.map((m) => [m, importsOf(m)]));
const importers = new Map<string, string[]>();
for (const [m, targets] of imports) for (const t of targets) (importers.get(t) ?? importers.set(t, []).get(t)!).push(m);

// ── the trees ───────────────────────────────────────────────────────────────

const parent = new Map<string, string>();
const find = (m: string): string => {
  const p = parent.get(m) ?? m;
  if (p === m) return m;
  const r = find(p);
  parent.set(m, r);
  return r;
};
/** A tree is named after its top-most module. */
const depth = (f: string): number => f.split('/').length;
const union = (a: string, b: string): void => {
  const [ra, rb] = [find(a), find(b)];
  if (ra === rb) return;
  if (depth(ra) < depth(rb) || (depth(ra) === depth(rb) && ra < rb)) parent.set(rb, ra);
  else parent.set(ra, rb);
};

/** Whether `m` takes `t` into its tree: a module below its directory, or a plain module beside it. */
function takesIn(m: string, t: string): boolean {
  const [dm, dt] = [dirname(m), dirname(t)];
  if (dm === '.') return false;
  return dt.startsWith(`${dm}/`) || (dt === dm && !t.endsWith('.tsx'));
}
const drawing = new Map<string, boolean>();
/** Whether a module draws with a sheet: it imports one, or takes in a module that does. A plain helper joins no tree. */
function draws(m: string): boolean {
  if (!drawing.has(m)) {
    drawing.set(m, false);
    drawing.set(m, (imports.get(m) ?? []).some((t) => t.endsWith('.css') || (takesIn(m, t) && draws(t))));
  }
  return drawing.get(m)!;
}
for (const [m, targets] of imports) for (const t of targets) if (!t.endsWith('.css') && takesIn(m, t) && draws(t)) union(m, t);

const GLOBAL = 'the global sheets';
/** The trees a sheet belongs to. */
function ownersOf(sheet: string): Set<string> {
  if (GLOBAL_SHEETS.includes(sheet)) return new Set([GLOBAL]);
  return new Set((importers.get(sheet) ?? []).map(find));
}
const disjoint = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => !b.has(x));

/** Every tree a module reaches through its imports, its own included. */
const reaching = new Map<string, Set<string>>();
function reach(m: string): Set<string> {
  let out = reaching.get(m);
  if (out === undefined) {
    out = new Set([find(m)]);
    reaching.set(m, out);
    for (const t of imports.get(m) ?? []) if (!t.endsWith('.css')) for (const r of reach(t)) out.add(r);
  }
  return out;
}

// ── what the sheets style ───────────────────────────────────────────────────

interface Site {
  file: string;
  line: number;
  text: string;
}
const at = (s: Site): string => `${s.file}:${s.line} \`${s.text}\``;
const blockOf = (cls: string): string => cls.split(/__|--/)[0]!;

/** Every class a sheet styles, and the blocks its rules claim. */
function parseSheet(file: string): { classes: Map<string, Site>; claims: Map<string, Site> } {
  const src = read(file).replace(/\/\*[\s\S]*?\*\//g, blank);
  const classes = new Map<string, Site>();
  const claims = new Map<string, Site>();
  for (const m of src.matchAll(/([^{};]+)\{/g)) {
    const selector = m[1]!.trim();
    if (selector.startsWith('@') || /^(from|to|\d[\d.]*%)\b/.test(selector)) continue;
    const line = lineAt(src, m.index + m[1]!.indexOf(selector));
    for (const part of selector.split(/,(?![^(]*\))/)) {
      const names = [...part.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((x) => x[1]!);
      for (const c of names) if (!classes.has(c)) classes.set(c, { file, line, text: part.trim() });
      const first = names[0];
      if (first !== undefined && !claims.has(blockOf(first))) claims.set(blockOf(first), { file, line, text: part.trim() });
    }
  }
  return { classes, claims };
}
const parsed = new Map(sheets.map((s) => [s, parseSheet(s)]));
const styled = new Set([...parsed.values()].flatMap((p) => [...p.classes.keys()]));
/** The trees whose sheets style each block. */
const stylers = new Map<string, Set<string>>();
for (const [sheet, p] of parsed) for (const c of p.classes.keys()) for (const o of ownersOf(sheet)) (stylers.get(blockOf(c)) ?? stylers.set(blockOf(c), new Set()).get(blockOf(c))!).add(o);

// ── what the code draws ─────────────────────────────────────────────────────

const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
/** A literal that is nothing but class names (a template's holes aside). */
const CLASS_LIST = /^\s*-?[_a-zA-Z][\w-]*(\s+-?[_a-zA-Z][\w-]*)*\s*$/;
/** Where a bare word is a class: an attribute, a class list call, or an open `className={…}`. */
const CLASS_AT = /(?:className|class)\s*=\s*$|classList\.\w+\(\s*$|\.className\s*=\s*$/;

interface Draw extends Site {
  /** Whether the literal is a class for certain: a class context, or a name with `__` or `--`. */
  sure: boolean;
}

/** Every word of every string literal in the app's code that some sheet styles, and the prefixes a template builds. */
function drawn(): { draws: Map<string, Draw[]>; prefixes: Set<string> } {
  const out = new Map<string, Draw[]>();
  const prefixes = new Set<string>();
  for (const file of modules) {
    const raw = read(file);
    let src = '';
    // Comments and import paths are not drawn; a literal's quotes are kept so line numbers hold.
    for (const m of raw.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|[^'"`/]+|\//g)) src += m[1] === undefined && m[0].startsWith('/') && m[0].length > 1 ? blank(m[0]) : m[0];
    src = src.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])[^'"]*\2/g, (s) => blank(s));
    for (const m of src.matchAll(LITERAL)) {
      const template = m[3] !== undefined;
      const text = m[1] ?? m[2] ?? m[3] ?? '';
      for (const p of text.matchAll(/(?:^|\s)([_a-zA-Z][\w-]*?(?:__|--|-))\$\{/g)) prefixes.add(p[1]!);
      const plain = text.replace(/\$\{[^}]*\}/g, ' ');
      // Markup in a string (`'<svg class="…">'`) names its classes in attributes.
      const markup = [...plain.matchAll(/\bclass=(["'])([^"']*)\1/g)].map((x) => x[2]!);
      const listed = CLASS_LIST.test(plain) || (template && /^[\s\w-]*$/.test(plain));
      if (!listed && markup.length === 0) continue;
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const open = before.lastIndexOf('className={');
      const inside = open >= 0 && [...before.slice(open)].reduce((d, ch) => d + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0) > 0;
      const context = markup.length > 0 || CLASS_AT.test(before) || inside;
      const line = lineAt(src, m.index);
      for (const w of (listed ? plain : markup.join(' ')).trim().split(/\s+/)) {
        if (!styled.has(w)) continue;
        const draw = { file, line, text: text.length > 60 ? `${text.slice(0, 57)}…` : text, sure: context || /__|--/.test(w) };
        (out.get(w) ?? out.set(w, []).get(w)!).push(draw);
      }
    }
  }
  return { draws: out, prefixes };
}
const { draws: drawSites, prefixes } = drawn();

// ── the rules ───────────────────────────────────────────────────────────────

/** Rule A: a block two trees' sheets claim. */
function collisions(shared: Record<string, string> = SHARED): Map<string, string> {
  const out = new Map<string, string>();
  const byBlock = new Map<string, Site[]>();
  for (const p of parsed.values()) for (const [b, s] of p.claims) (byBlock.get(b) ?? byBlock.set(b, []).get(b)!).push(s);
  for (const [block, sites] of byBlock) {
    if (shared[block] !== undefined || EXTERNAL.test(block)) continue;
    const pair = sites.flatMap((a, i) => sites.slice(i + 1).map((b) => [a, b] as const)).find(([a, b]) => disjoint(ownersOf(a.file), ownersOf(b.file)));
    if (pair === undefined) continue;
    const [a, b] = pair;
    const who = (s: Site): string => [...ownersOf(s.file)].join(', ');
    out.set(
      block,
      `.${block} is claimed by two trees: ${at(a)} (${who(a)}) and ${at(b)} (${who(b)}). ` +
        `Rename one side's block, scope the rule under its own block (\`.mine .${block}\` claims \`mine\`), or move the rule into the sheet of the tree that draws it.`,
    );
  }
  return out;
}

/** Whether one of two trees imports the other, however deep: a component drawn inside another, or a tree drawing one it imports. */
const treeReach = new Map<string, Set<string>>();
for (const m of modules) for (const r of reach(m)) (treeReach.get(find(m)) ?? treeReach.set(find(m), new Set()).get(find(m))!).add(r);
const related = (x: string, y: string): boolean => x === y || (treeReach.get(x)?.has(y) ?? false) || (treeReach.get(y)?.has(x) ?? false);

/** Rule B: a block drawn by two trees that neither import each other nor reach a common tree styling it. */
function strangers(shared: Record<string, string> = SHARED): Map<string, string> {
  const out = new Map<string, string>();
  const byBlock = new Map<string, Draw[]>();
  for (const [w, sites] of drawSites) for (const s of sites) if (s.sure) (byBlock.get(blockOf(w)) ?? byBlock.set(blockOf(w), []).get(blockOf(w))!).push(s);
  for (const [block, sites] of byBlock) {
    if (shared[block] !== undefined || EXTERNAL.test(block)) continue;
    const trees = new Map<string, Draw>();
    for (const s of sites) if (!trees.has(find(s.file))) trees.set(find(s.file), s);
    if (trees.size < 2) continue;
    // The trees drawing the block and the trees styling it, joined wherever one imports another.
    const owners = [...(stylers.get(block) ?? [])].filter((o) => o !== GLOBAL);
    const nodes = [...new Set([...trees.keys(), ...owners])];
    const family = new Set([nodes[0]!]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (!family.has(n) && [...family].some((f) => related(f, n))) grew = family.add(n).size > 0;
    }
    const apart = [...trees.values()].filter((s) => !family.has(find(s.file)));
    if (apart.length === 0) continue;
    const [a, b] = [[...trees.values()].find((s) => family.has(find(s.file)))!, apart[0]!];
    out.set(
      block,
      `.${block} is drawn by two trees that do not import each other: ${a.file}:${a.line} '${a.text}' (${find(a.file)}) and ${b.file}:${b.line} '${b.text}' (${find(b.file)})` +
        `${trees.size > 2 ? `, of ${trees.size} trees` : ''}; it is styled by ${[...(stylers.get(block) ?? [])].join(', ') || 'nothing'}. ` +
        `Give one side a block of its own, or draw the component that owns .${block} instead of its class.`,
    );
  }
  return out;
}

/** Rule C: a class some sheet styles and no code draws. */
function unrendered(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of parsed.values())
    for (const [c, s] of p.classes) {
      if (out.has(c) || drawSites.has(c) || EXTERNAL.test(c) || [...prefixes].some((x) => c.startsWith(x))) continue;
      out.set(c, `.${c} is styled at ${at(s)} and drawn nowhere. Delete the rule, or draw the class.`);
    }
  return out;
}

describe('css ownership', () => {
  const a = collisions();
  const b = strangers();
  const c = unrendered();
  const open = (found: Map<string, string>): string[] => [...found].filter(([k]) => PENDING[k] === undefined).map(([, why]) => why);

  it('reads the trees: Board and the behaviours it installs are one, each prompt and each screen its own', () => {
    expect(find('play/live/numbers.ts')).toBe(find('play/Board.tsx'));
    expect(find('play/live/gestures/install.ts')).toBe(find('play/live/LiveBoard.tsx'));
    expect(find('play/live/LiveBoard.tsx')).toBe(find('play/Board.tsx'));
    expect(find('play/prompts/PromptShell.tsx')).not.toBe(find('play/Board.tsx'));
    expect(find('screens/DecksScreen.tsx')).not.toBe(find('screens/Screen.tsx'));
    expect(ownersOf('play/board.css')).toEqual(ownersOf('play/card.css'));
    expect(drawSites.get('seat__ident')?.length).toBeGreaterThan(0);
  });

  it('A: no block is claimed by the sheets of two trees', () => {
    expect(open(a)).toEqual([]);
  });

  it('B: no block is drawn by a tree that neither styles it nor imports the one that does', () => {
    expect(open(b)).toEqual([]);
  });

  it('C: every styled class is drawn somewhere', () => {
    expect(open(c)).toEqual([]);
  });

  it('every shared and pending block still needs its entry', () => {
    const [bareA, bareB] = [collisions({}), strangers({})];
    const needed = (block: string): boolean => bareA.has(block) || bareB.has(block);
    expect(Object.keys(SHARED).filter((block) => !needed(block))).toEqual([]);
    expect(Object.keys(PENDING).filter((k) => !a.has(k) && !b.has(k) && !c.has(k))).toEqual([]);
  });

  it('every sheet is imported by some module, or it never reaches the page', () => {
    expect(sheets.filter((s) => !GLOBAL_SHEETS.includes(s) && ownersOf(s).size === 0)).toEqual([]);
  });

  it('a change to a sheet more than one tree reads runs the shared-stylesheet guard', () => {
    const guard = GUARDS.find((g) => g.name === 'the shared stylesheets');
    expect(guard, 'select-forge-tests.ts guards the shared stylesheets').toBeDefined();
    const shared = sheets.filter((s) => GLOBAL_SHEETS.includes(s) || s === 'screens/screens.css' || ownersOf(s).size > 1).map((s) => `apps/ui/src/${s}`);
    expect(shared.filter((s) => !guard!.paths.test(s))).toEqual([]);
    expect(sheets.map((s) => `apps/ui/src/${s}`).filter((s) => guard!.paths.test(s) && !shared.includes(s))).toEqual([]);
  });
});
