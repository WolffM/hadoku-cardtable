/*
 * The sheets' motion, answering to the player's switches (`./index.ts`) as well as the system's. A build
 * pass, both builds' (`vite.config.ts`, `vite.embed.config.ts`), over the app's own sheets only:
 *
 *   - `@media (prefers-reduced-motion: reduce) { R }` keeps its media query, for a page whose script has
 *     not written the switches yet, but each rule in it is gated on `data-motion` not being `full`; and a
 *     copy of R, outside the query, applies under `data-motion='reduce'`. Its `@keyframes` are hoisted beside
 *     it (a name defined twice at the top is a build error: hoisting it would redefine the other).
 *   - `@media (prefers-reduced-motion: no-preference) { R }` likewise: gated on `data-motion` not being
 *     `reduce`, and copied for `data-motion='full'`.
 *   - Every rule whose `animation` (or `animation-iteration-count`) runs `infinite` gets a sibling that, under
 *     `data-ambient='off'`, pauses exactly its infinite entries: the loop stands on its first frame, and a
 *     one-shot beside it in the same list (an entrance) still plays. Where a reduce query has a rule for the
 *     same selector, that rule is the loop's still look, and it is copied for `data-ambient='off'` as well.
 *
 * Every gate is a `:where()`, so no rewritten rule weighs more than the rule it came from. The attribute is
 * an ANCESTOR's (the document root standalone, the embed's top element inside its shadow tree); a
 * selector that starts at `:root` or `html` takes the gate on that compound instead.
 */

interface CssNode {
  type: string;
  parent?: CssContainer;
  clone(overrides?: Record<string, unknown>): CssNode;
  remove(): void;
  source?: { input: { file?: string } };
}
interface CssContainer extends CssNode {
  nodes?: CssNode[];
  each(fn: (child: CssNode) => void): void;
  append(...nodes: CssNode[]): void;
  after(node: CssNode | CssNode[]): void;
  removeAll(): void;
  walkRules(fn: (rule: CssRule) => void): void;
  walkAtRules(name: string, fn: (rule: CssAtRule) => void): void;
  walkDecls(fn: (decl: CssDecl) => void): void;
}
interface CssRule extends CssContainer {
  type: 'rule';
  selectors: string[];
}
interface CssAtRule extends CssContainer {
  type: 'atrule';
  name: string;
  params: string;
}
interface CssDecl extends CssNode {
  prop: string;
  value: string;
}

const REDUCE = /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/;
const NO_PREFERENCE = /^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/;

/** A selector gated on `test` holding at an ancestor (or at its own leading `:root`/`html`). */
export function gateSelector(selector: string, test: string): string {
  const s = selector.trim();
  const lead = /^(:root|html)((?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*)/.exec(s);
  if (lead !== null) return `${lead[0]}:where(${test})${s.slice(lead[0].length)}`;
  return `:where(${test}) ${s}`;
}

/** At an ancestor, or here: the attribute test a gate is built from. */
const is = (attr: string, value: string): string => `[${attr}='${value}']`;
/** No ancestor carries it: true of the root when the root does not, and of nothing below a root that does. */
const isNot = (attr: string, value: string): string => `:not(${is(attr, value)}, ${is(attr, value)} *)`;

/** Splits a comma list at the top level, never inside parentheses. */
function topLevelList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim());
}

const INFINITE = /(?<![\w-])infinite(?![\w-])/;

/**
 * The play states that pause `decl`'s infinite entries, or null when it runs none. `looping`: the custom
 * properties the sheet defines as an infinite animation, for an entry that is only `var(--x)` (card.css's
 * flyers keep their path in one).
 */
export function ambientPlayState(prop: string, value: string, looping: ReadonlySet<string> = new Set()): string | null {
  if (prop !== 'animation' && prop !== 'animation-iteration-count') return null;
  const entries = topLevelList(value);
  const loops = (e: string): boolean => INFINITE.test(e) || [...e.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => looping.has(m[1]!));
  if (!entries.some(loops)) return null;
  return entries.map((e) => (loops(e) ? 'paused' : 'running')).join(', ');
}

function inside(node: CssNode, names: readonly string[]): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) if (p.type === 'atrule' && names.includes((p as CssAtRule).name.toLowerCase())) return true;
  return false;
}

const OWN_SRC = /[\\/](?:apps[\\/][^\\/]+|packages[\\/][^\\/]+|games[\\/][^\\/]+[\\/](?:ui|packages[\\/][^\\/]+))[\\/]src[\\/]/;
function ownSheet(file: string | undefined): boolean {
  return file !== undefined && OWN_SRC.test(file) && !/[\\/]node_modules[\\/]/.test(file);
}

const norm = (selector: string): string => selector.trim().replace(/\s+/g, ' ');

/**
 * `stills`: the selectors of the sheet's looping rules. A reduce query's rule for one of them is the still look
 * its author drew for that loop (the clock's grace ring steady at full, not paused on its first, empty frame),
 * so it is copied for `data-ambient='off'` too, after the pause it then overrides.
 */
function mirrorMedia(media: CssAtRule, attr: string, keep: string, copy: string, topKeyframes: Set<string>, stills: ReadonlySet<string> = new Set()): void {
  const copies: CssNode[] = [];
  media.each((child) => {
    if (child.type === 'rule') {
      const rule = child as CssRule;
      const still = rule.selectors.filter((sel) => stills.has(norm(sel)));
      if (still.length > 0) {
        const calm = rule.clone() as CssRule;
        calm.selectors = still.map((sel) => gateSelector(sel, is('data-ambient', 'off')));
        copies.push(calm);
      }
      const forced = rule.clone() as CssRule;
      forced.selectors = rule.selectors.map((s) => gateSelector(s, is(attr, copy)));
      rule.selectors = rule.selectors.map((s) => gateSelector(s, isNot(attr, keep)));
      copies.push(forced);
    } else if (child.type === 'atrule' && (child as CssAtRule).name.toLowerCase() === 'keyframes') {
      const name = (child as CssAtRule).params.trim();
      if (topKeyframes.has(name)) throw new Error(`${child.source?.input.file ?? 'a stylesheet'}: @keyframes ${name} is defined inside a prefers-reduced-motion query and outside it; give the query's its own name`);
      copies.push(child.clone());
    } else if (child.type === 'atrule') {
      throw new Error(`${child.source?.input.file ?? 'a stylesheet'}: @${(child as CssAtRule).name} inside a prefers-reduced-motion query is not mirrored by motionCss; move it out or teach the pass`);
    }
  });
  if (copies.length > 0) media.after(copies);
}

/** The PostCSS plugin. */
export const motionCss = {
  postcssPlugin: 'hadoku-motion',
  // `unknown`, read as the few node methods this uses: postcss is not this package's dependency, and its own
  // types are not structurally the slice declared above.
  Once(sheet: unknown): void {
    const root = sheet as CssContainer;
    if (!ownSheet(root.source?.input.file)) return;
    const topKeyframes = new Set<string>();
    root.each((n) => {
      if (n.type === 'atrule' && (n as CssAtRule).name.toLowerCase() === 'keyframes') topKeyframes.add((n as CssAtRule).params.trim());
    });
    // Ambient first, so a looping rule inside a motion query is mirrored with its calm sibling. Once runs once per
    // sheet: the rules inserted here are visited by the walk, and carry nothing it rewrites.
    const looping = new Set<string>();
    const stills = new Set<string>();
    root.walkDecls((decl) => {
      if (decl.prop.startsWith('--') && topLevelList(decl.value).some((e) => INFINITE.test(e))) looping.add(decl.prop);
    });
    root.walkRules((rule) => {
      if (inside(rule, ['keyframes'])) return;
      const states: string[] = [];
      rule.walkDecls((decl) => {
        const state = ambientPlayState(decl.prop.toLowerCase(), decl.value, looping);
        if (state !== null) states.push(state);
      });
      if (states.length === 0) return;
      for (const sel of rule.selectors) stills.add(norm(sel));
      const calm = rule.clone() as CssRule;
      calm.removeAll();
      calm.selectors = rule.selectors.map((s) => gateSelector(s, is('data-ambient', 'off')));
      // The last declaration wins in the authored rule, so it does here.
      const decl = (rule.nodes ?? []).find((n) => n.type === 'decl')!.clone({ prop: 'animation-play-state', value: states[states.length - 1]! });
      calm.append(decl);
      rule.after(calm);
    });
    root.walkAtRules('media', (media) => {
      const params = media.params.trim();
      if (REDUCE.test(params)) mirrorMedia(media, 'data-motion', 'full', 'reduce', topKeyframes, stills);
      else if (NO_PREFERENCE.test(params)) mirrorMedia(media, 'data-motion', 'reduce', 'full', topKeyframes);
      else if (/prefers-reduced-motion/.test(params)) throw new Error(`${media.source?.input.file ?? 'a stylesheet'}: @media ${params} combines prefers-reduced-motion with another query; motionCss mirrors only the plain one`);
    });
  },
};
