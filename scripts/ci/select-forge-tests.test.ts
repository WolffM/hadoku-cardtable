/**
 * scripts/ci/select-forge-tests.ts, two ways: small in-memory repos that pin
 * each rule, and real landed ranges from main (`fixtures/*.json`, the compare
 * API's `files` shape, built with `git diff`) read against this checkout.
 * The real ranges read the tree without its history (a CI checkout is
 * shallow), except the historical misses, which bring the land they shipped in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type Change,
  GUARDS,
  type Guard,
  type Land,
  PUSH_BUDGET,
  Repo,
  SMOKE,
  beforePatch,
  changedLines,
  changedSelectors,
  code,
  declarations,
  outputs,
  select,
  universe,
  versionBumpOnly,
} from './select-forge-tests.ts';
import { fixtureSha, snapshotPath } from './snapshot-fixtures.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** History held in memory: lands newest first, and the names each commit edited, by `sha:file`. */
interface History {
  lands: Land[];
  touched: Record<string, string[]>;
}
const NO_HISTORY: History = { lands: [], touched: {} };

/** A repository held in memory: path → content, and its history. */
class MemRepo extends Repo {
  private readonly files: Record<string, string>;
  private readonly history: History;
  constructor(files: Record<string, string>, history: History = NO_HISTORY) {
    super('/nonexistent');
    this.files = files;
    this.history = history;
  }
  override read(path: string): string | null {
    return this.files[path] ?? null;
  }
  override list(dir: string): string[] {
    return Object.keys(this.files)
      .filter((f) => f.startsWith(`${dir}/`))
      .sort();
  }
  override lands(): Land[] {
    return this.history.lands;
  }
  override touchedAt(sha: string, file: string): string[] {
    return this.history.touched[`${sha}:${file}`] ?? [];
  }
}

/**
 * This checkout's tree with the given history in place of git's: the same on every machine. Given a
 * commit, the files a fixture carries for it (`fixtures/at/<sha>/`) are read as they stood there, so a
 * historical diff is replayed against the file it was cut from, not today's.
 */
class Tree extends Repo {
  private readonly history: History;
  private readonly at: string | undefined;
  constructor(history: History = NO_HISTORY, at?: string) {
    super(ROOT);
    this.history = history;
    this.at = at;
  }
  /** The snapshot files, read once each, as `Repo` reads the tree: a select reads the same file many times. */
  private readonly snaps = new Map<string, string | null>();
  override read(path: string): string | null {
    if (this.at === undefined) return super.read(path);
    if (!this.snaps.has(path)) {
      const snap = snapshotPath(this.at, path);
      this.snaps.set(path, snap !== null && existsSync(snap) ? readFileSync(snap, 'utf8') : null);
    }
    return this.snaps.get(path) ?? super.read(path);
  }
  override lands(): Land[] {
    return this.history.lands;
  }
  override touchedAt(sha: string, file: string): string[] {
    return this.history.touched[`${sha}:${file}`] ?? [];
  }
}

const FORGE_SPEC = (body: string): string => `import { startPlayStack } from './play/harness.ts';\nconst forge = { ok: true };\n${body}\n`;

/** The fixture repo's one hot path. */
const FIXTURE_GUARDS: Guard[] = [{ name: 'the match', paths: /^apps\/server\/src\/play\/match\.ts$/, specs: ['coin.spec.ts'], jvm: ['apps/server/src/play/bolt.jvm.test.ts'] }];

/** Two smoke specs, three narrow ones, a helper, a scenario, a component tree, a server, a jvm suite, and filler specs. */
function fixtureRepo(extra: Record<string, string> = {}, history: History = NO_HISTORY): MemRepo {
  return new MemRepo(
    {
      'e2e/play/harness.ts': 'export function startPlayStack() {}\n',
      'e2e/play/board.ts':
        "export const coinToss = (page) => page.getByTestId('coin-toss');\nexport const pile = (page) => page.locator('[data-pile]');\n",
      'e2e/play.spec.ts': FORGE_SPEC("page.getByTestId('live-says');"),
      'e2e/table-fit.spec.ts': FORGE_SPEC("page.getByTestId('live-says');"),
      'e2e/coin.spec.ts': FORGE_SPEC("import { coinToss } from './play/board.ts';\ncoinToss(page);"),
      'e2e/pile.spec.ts': FORGE_SPEC("import { pile } from './play/board.ts';\npile(page); startScenarioMatch(browser, { scenario: 'bolt-player' });"),
      'e2e/bars.spec.ts': FORGE_SPEC("page.locator('.mana-bar'); fetch('/api/sounds/catalogue');"),
      'e2e/draft.spec.ts': "test('draft', () => {});\n",
      'apps/server/src/play/scenarios/bolt-player.state': '[state]\n',
      'apps/server/src/play/match.ts': "import { rule } from './rules.ts';\nexport const m = rule;\n",
      'apps/server/src/play/rules.ts': 'export const rule = 1;\n',
      'apps/server/src/play/host.ts': "import { m } from './match.ts';\nexport const h = m;\n",
      'apps/server/src/http/sounds.ts':
        "export function catalogue(router) {\n  router.get('/api/sounds/catalogue', list);\n}\nexport function upload(router) {\n  router.post('/api/sounds/upload', put);\n}\n",
      'apps/server/src/play/bolt.jvm.test.ts': "import { h } from './host.ts';\nstartScenario('bolt-player', h);\n",
      'apps/ui/src/play/live/CoinToss.tsx':
        "import { flip } from './coin.ts';\nimport './coin.css';\nexport function CoinToss() {\n  return <div data-testid=\"coin-toss\" className=\"coin\">{flip()}</div>;\n}\n",
      'apps/ui/src/play/live/coin.ts': 'export interface Coin {\n  side: string;\n}\nexport function flip(): string {\n  return "heads";\n}\n',
      'apps/ui/src/play/live/coin.css': '/* the coin */\n.coin {\n  width: 10px;\n}\n.other {\n  color: red;\n}\n',
      'apps/ui/src/play/live/Pile.tsx': 'export function Pile() {\n  return <div data-pile="1" />;\n}\n',
      'apps/ui/src/play/live/Bars.tsx': 'export function Bars() {\n  return <div className="mana-bar" data-testid="bars" />;\n}\n',
      ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`e2e/other-${i}.spec.ts`, FORGE_SPEC('')])),
      ...extra,
    },
    history,
  );
}

/** A component long enough that its two test ids sit far apart, and a helper it uses beside one of them. */
const BIG: Record<string, string> = {
  'e2e/far.spec.ts': FORGE_SPEC("page.getByTestId('far-away');"),
  'apps/ui/src/play/live/far.ts': "export function farLabel(): string {\n  return 'b';\n}\n",
  'apps/ui/src/play/live/Big.tsx': [
    "import { farLabel } from './far.ts';",
    'export function Big() {',
    '  return (',
    '    <div data-testid="coin-toss">',
    ...Array.from({ length: 25 }, (_, i) => `      {'filler ${i}'}`),
    "      {'new'}",
    '      <p data-testid="far-away">{farLabel()}</p>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/** A workspace package, imported by its name: one export a component renders, one nothing uses. */
const WIRE: Record<string, string> = {
  'packages/wire/package.json': '{ "name": "@hadoku/wire", "exports": { ".": "./src/index.ts" } }\n',
  'packages/wire/src/index.ts': "export * from './coin.ts';\n",
  'packages/wire/src/coin.ts': "export function coinFace(): string {\n  return 'h';\n}\nexport function other(): number {\n  return 1;\n}\n",
  'apps/ui/src/play/live/CoinToss.tsx': "import { coinFace } from '@hadoku/wire';\nexport function CoinToss() {\n  return <div data-testid=\"coin-toss\">{coinFace()}</div>;\n}\n",
};

/** A server module with one export the jvm suite's chain uses and one nothing uses. */
const UTIL: Record<string, string> = {
  'apps/server/src/play/util.ts': 'export const used = 1;\nexport const unused = 2;\n',
  'apps/server/src/play/host.ts': "import { m } from './match.ts';\nimport { used } from './util.ts';\nexport const h = m + used;\n",
};

const modified = (filename: string, patch?: string): Change => ({ filename, status: 'modified', patch });
const diff = (start: number, minus: string[], plus: string[], context: string[] = []): string =>
  [`@@ -${start},${minus.length + context.length} +${start},${plus.length + context.length} @@`, ...context.map((l) => ` ${l}`), ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join('\n');
const guarded = { guards: FIXTURE_GUARDS };

describe('the per-file rules', () => {
  it('a version bump, docs, a unit test and a sound script select nothing', () => {
    const sel = select(fixtureRepo(), [
      modified('apps/ui/package.json', diff(3, ['  "version": "0.32.1",'], ['  "version": "0.32.2",'])),
      modified('docs/planning/playtest-ledger.md'),
      modified('apps/ui/src/play/live/coin.test.ts'),
      modified('scripts/sfx/finish.py'),
    ]);
    expect(sel).toMatchObject({ e2e: false, jvm: false, specs: [], jvmFiles: [] });
  });

  it('a dependency edit in package.json is not a version bump', () => {
    expect(versionBumpOnly(modified('apps/ui/package.json', diff(9, ['    "@wolffm/themes": "1.0.0",'], ['    "@wolffm/themes": "1.0.1",'])))).toBe(false);
    expect(select(fixtureRepo(), [modified('apps/ui/package.json', diff(9, ['  "x": "1"'], ['  "x": "2"']))]).specs).toBeNull();
  });

  it("the engine pin and a package's manifest run everything", () => {
    for (const f of ['forge', 'packages/forge-wire/package.json']) {
      const sel = select(fixtureRepo(), [modified(f)]);
      expect(sel, f).toMatchObject({ e2e: true, specs: null, jvm: true, jvmFiles: null });
    }
  });

  it('a spec runs itself; a non-Forge spec runs nothing here; a jvm suite runs itself', () => {
    expect(select(fixtureRepo(), [modified('e2e/coin.spec.ts')]).specs).toEqual(['coin.spec.ts']);
    expect(select(fixtureRepo(), [modified('e2e/draft.spec.ts')])).toMatchObject({ e2e: false });
    expect(select(fixtureRepo(), [modified('apps/server/src/play/bolt.jvm.test.ts')])).toMatchObject({ e2e: false, jvmFiles: ['apps/server/src/play/bolt.jvm.test.ts'] });
  });

  it('an e2e helper runs the specs that import it', () => {
    expect(select(fixtureRepo(), [modified('e2e/play/board.ts')]).specs).toEqual(['coin.spec.ts', 'pile.spec.ts']);
  });

  it('a scenario runs the specs and suites that name it', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/play/scenarios/bolt-player.state')]);
    expect(sel).toMatchObject({ specs: ['pile.spec.ts'], jvmFiles: ['apps/server/src/play/bolt.jvm.test.ts'] });
  });

  it('a hot-path module runs its guard family and the smoke set, on a dispatch and on a push alike', () => {
    for (const deferFull of [false, true]) {
      const sel = select(fixtureRepo(), [modified('apps/server/src/play/match.ts')], { ...guarded, deferFull });
      expect(sel.specs, String(deferFull)).toEqual(['coin.spec.ts', ...SMOKE].sort());
      expect(sel.jvmFiles, String(deferFull)).toEqual(['apps/server/src/play/bolt.jvm.test.ts']);
      expect(sel.reasons).toContain('e2e: coin.spec.ts — guards the match (apps/server/src/play/match.ts)');
    }
  });

  it('a bridge change runs everything on a dispatch, like the engine pin, and the engine guards on a push', () => {
    const f = 'apps/server/src/play/bridge/PlayBridge.java';
    const dispatch = select(fixtureRepo(), [modified(f)]);
    expect(dispatch).toMatchObject({ specs: null, jvmFiles: null });
    expect(dispatch.reasons).toContain(`jvm: every suite — ${f}: the engine's own layer, which every match runs through`);
    const push = select(fixtureRepo({ 'apps/server/src/play/match-frames.jvm.test.ts': '' }), [modified(f)], { deferFull: true });
    expect(push.jvmFiles).toEqual(['apps/server/src/play/match-frames.jvm.test.ts']);
  });

  it('a server play module one import below a hot module inherits its guard family; one above it does not', () => {
    const below = select(fixtureRepo(), [modified('apps/server/src/play/rules.ts')], guarded);
    expect(below.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
    expect(below.reasons).toContain('e2e: coin.spec.ts — guards the match (apps/server/src/play/rules.ts, imported by apps/server/src/play/match.ts)');
    const above = select(fixtureRepo(), [modified('apps/server/src/play/host.ts')], guarded);
    expect(above).toMatchObject({ specs: [...SMOKE].sort(), jvmFiles: ['apps/server/src/play/bolt.jvm.test.ts'] });
  });

  it('server scaffolding runs the smoke set and the specs that call its routes', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/http/sounds.ts')]);
    expect(sel.specs).toEqual(['bars.spec.ts', ...SMOKE].sort());
  });

  it('server scaffolding runs the specs calling a route the diff registers, not every path the module names', () => {
    const other = select(fixtureRepo(), [modified('apps/server/src/http/sounds.ts', diff(5, ["  router.post('/api/sounds/put', put);"], ["  router.post('/api/sounds/upload', put);"]))]);
    expect(other.specs).toEqual([...SMOKE].sort());
    const named = select(fixtureRepo({ 'apps/server/src/play/log.ts': "export function where(): string {\n  return '/api/sounds/catalogue';\n}\n" }), [
      modified('apps/server/src/play/log.ts', diff(2, ["  return '/api/sounds';"], ["  return '/api/sounds/catalogue';"])),
    ]);
    expect(named.specs).toEqual([...SMOKE].sort());
  });

  it('a component runs the specs that name its test id, and the smoke set', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/CoinToss.tsx')]);
    expect(sel.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
    expect(sel.reasons.some((r) => r.startsWith('e2e: coin.spec.ts — apps/ui/src/play/live/CoinToss.tsx: testid coin-toss; score'))).toBe(true);
  });

  it('a helper module acts through the component that calls it', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.ts', diff(5, ['  return "tails";'], ['  return "heads";']))]);
    expect(sel.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
  });

  it('an edit inside a component runs the specs naming the keys near the edit, not every key it renders', () => {
    const sel = select(fixtureRepo(BIG), [modified('apps/ui/src/play/live/Big.tsx', diff(30, ["      {'old'}"], ["      {'new'}"]))]);
    expect(sel.specs).toEqual(['far.spec.ts', ...SMOKE].sort());
  });

  it('a module reached through a component runs the specs naming the keys near where it is used', () => {
    const sel = select(fixtureRepo(BIG), [modified('apps/ui/src/play/live/far.ts', diff(2, ["  return 'a';"], ["  return 'b';"]))]);
    expect(sel.specs).toEqual(['far.spec.ts', ...SMOKE].sort());
  });

  it('an e2e helper edit runs the specs that call the edited function, not every importer', () => {
    expect(select(fixtureRepo(), [modified('e2e/play/board.ts', diff(2, ["export const pile = (page) => page.locator('[data-pile]' );"], ["export const pile = (page) => page.locator('[data-pile]');"]))]).specs).toEqual(['pile.spec.ts']);
  });

  it('a jvm suite runs when it uses what the diff touched, not because it imports the file', () => {
    const repo = fixtureRepo(UTIL);
    const unused = select(repo, [modified('apps/server/src/play/util.ts', diff(2, ['export const unused = 3;'], ['export const unused = 2;']))]);
    expect(unused.jvmFiles).toEqual([]);
    const used = select(repo, [modified('apps/server/src/play/util.ts', diff(1, ['export const used = 0;'], ['export const used = 1;']))]);
    expect(used.jvmFiles).toEqual(['apps/server/src/play/bolt.jvm.test.ts']);
  });

  it('a jvm suite reaches a module through a re-export', () => {
    const repo = fixtureRepo({
      ...UTIL,
      'apps/server/src/play/index.ts': "export { used as usedHere } from './util.ts';\n",
      'apps/server/src/play/host.ts': "import { usedHere } from './index.ts';\nexport const h = usedHere;\n",
    });
    const used = select(repo, [modified('apps/server/src/play/util.ts', diff(1, ['export const used = 0;'], ['export const used = 1;']))]);
    expect(used.jvmFiles).toEqual(['apps/server/src/play/bolt.jvm.test.ts']);
  });

  it('a workspace package edit runs what uses the edited export, through the package name', () => {
    const repo = fixtureRepo(WIRE);
    const used = select(repo, [modified('packages/wire/src/coin.ts', diff(2, ["  return 't';"], ["  return 'h';"]))]);
    expect(used.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
    const unused = select(repo, [modified('packages/wire/src/coin.ts', diff(5, ['  return 2;'], ['  return 1;']))]);
    expect(unused.specs).toEqual([...SMOKE].sort());
  });

  it("an edit to a barrel's re-exports alone selects nothing — what uses a new export changed with it", () => {
    const repo = fixtureRepo({ ...WIRE, 'packages/wire/src/index.ts': "export * from './coin.ts';\nexport * from './more.ts';\n", 'packages/wire/src/more.ts': 'export const more = 1;\n' });
    const sel = select(repo, [modified('packages/wire/src/index.ts', diff(1, [], ["export * from './more.ts';"], ["export * from './coin.ts';"]))]);
    expect(sel).toMatchObject({ e2e: false, jvm: false });
    expect(sel.reasons).toContain('packages/wire/src/index.ts: re-exports only');
  });

  it('an edit to an interface alone selects nothing — tsc covers it', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.ts', diff(2, ['  side: number;'], ['  side: string;']))]);
    expect(sel).toMatchObject({ e2e: false });
    expect(sel.reasons).toContain('apps/ui/src/play/live/coin.ts: type declarations only — tsc covers them');
  });

  it('an edit to comments alone selects nothing', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.css', diff(1, ['/* the old coin */'], ['/* the coin */']))]);
    expect(sel).toMatchObject({ e2e: false });
    expect(sel.reasons).toContain('apps/ui/src/play/live/coin.css: comments only');
  });

  it('a stylesheet runs what renders the classes of the rules it edits, not the whole sheet', () => {
    const coin = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.css', diff(3, ['  width: 9px;'], ['  width: 10px;']))]);
    expect(coin.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
    const other = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.css', diff(6, ['  color: blue;'], ['  color: red;']))]);
    expect(other.specs).toEqual([...SMOKE].sort());
  });

  it('a shared stylesheet runs its guard whatever its rules name, and is still scored by the classes they do', () => {
    const sheet = { name: 'the shared stylesheets', paths: /^apps\/ui\/src\/play\/live\/coin\.css$/, specs: ['table-fit.spec.ts'], jvm: [] };
    const root = { 'apps/ui/src/play/live/coin.css': ':root {\n  --coin: 10px;\n}\n.coin {\n  width: var(--coin);\n}\n' };
    const token = select(fixtureRepo(root), [modified('apps/ui/src/play/live/coin.css', diff(2, ['  --coin: 9px;'], ['  --coin: 10px;']))], { guards: [sheet] });
    expect(token.specs).toEqual(['table-fit.spec.ts']);
    expect(token.reasons).toContain('e2e: table-fit.spec.ts — guards the shared stylesheets (apps/ui/src/play/live/coin.css)');
    const rule = select(fixtureRepo(root), [modified('apps/ui/src/play/live/coin.css', diff(5, ['  width: 9px;'], ['  width: var(--coin);']))], { guards: [sheet] });
    expect(rule.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
  });

  it('a removed UI file, and anything unclassified, runs everything', () => {
    expect(select(fixtureRepo(), [{ filename: 'apps/ui/src/play/live/Gone.tsx', status: 'removed' }]).specs).toBeNull();
    expect(select(fixtureRepo(), [modified('somewhere/new.txt')]).specs).toBeNull();
  });

  it('a key most specs touch tells nothing: the smoke set covers it, and no spec is run for it', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 30; i++) many[`e2e/says-${i}.spec.ts`] = FORGE_SPEC("page.getByTestId('live-says');");
    const repo = fixtureRepo({ ...many, 'apps/ui/src/play/live/Says.tsx': 'export function Says() {\n  return <p data-testid="live-says" />;\n}\n' });
    const sel = select(repo, [modified('apps/ui/src/play/live/Says.tsx')]);
    expect(sel.specs).toEqual([...SMOKE].sort());
    expect(sel.reasons).toContain('apps/ui/src/play/live/Says.tsx: testid live-says is in 32 specs — the smoke set covers it');
  });

  it('weak evidence runs nothing: a key a fifth of the specs touch, alone', () => {
    const some: Record<string, string> = {};
    for (let i = 0; i < 16; i++) some[`e2e/pill-${i}.spec.ts`] = FORGE_SPEC("page.getByTestId('pill');");
    const repo = fixtureRepo({ ...some, 'apps/ui/src/play/live/Pill.tsx': 'export function Pill() {\n  return <i data-testid="pill" />;\n}\n' });
    const sel = select(repo, [modified('apps/ui/src/play/live/Pill.tsx')]);
    expect(sel.specs).toEqual([...SMOKE].sort());
    expect(sel.reasons.some((r) => r.startsWith('pill-0.spec.ts: not run — too little evidence'))).toBe(true);
  });
});

describe('history: the specs that landed with earlier edits', () => {
  const css = '.coin {\n  width: 10px;\n}\n.other {\n  color: red;\n}\n';
  // coin.css's `.other` rule has no test id near it, so only history can name a spec for it.
  const land = (specs: string[], rule: string): History => ({
    lands: [{ commits: [{ sha: 'fix', files: ['apps/ui/src/play/live/coin.css'] }, { sha: 'spec', files: specs.map((s) => `e2e/${s}`) }] }],
    touched: { 'fix:apps/ui/src/play/live/coin.css': [rule] },
  });
  const edit = modified('apps/ui/src/play/live/coin.css', diff(5, ['  color: blue;'], ['  color: red;']));

  it("an edit to a rule a fix's spec landed with runs that spec", () => {
    const sel = select(fixtureRepo({ 'apps/ui/src/play/live/coin.css': css }, land(['pile.spec.ts'], '.other')), [edit], { deferFull: true });
    expect(sel.specs).toEqual(['pile.spec.ts', ...SMOKE].sort());
    expect(sel.reasons.some((r) => r.startsWith('e2e: pile.spec.ts — apps/ui/src/play/live/coin.css: landed with an edit to .other (fix)'))).toBe(true);
  });

  it('a land that edited another rule of the file is weaker evidence, not enough alone', () => {
    const sel = select(fixtureRepo({ 'apps/ui/src/play/live/coin.css': css }, land(['pile.spec.ts'], '.coin')), [edit]);
    expect(sel.specs).toEqual([...SMOKE].sort());
  });

  it('a land carrying a whole wave of specs says nothing about any one', () => {
    const wave = ['pile.spec.ts', 'bars.spec.ts', ...Array.from({ length: 6 }, (_, i) => `other-${i}.spec.ts`)];
    const sel = select(fixtureRepo({ 'apps/ui/src/play/live/coin.css': css }, land(wave, '.other')), [edit]);
    expect(sel.specs).toEqual([...SMOKE].sort());
  });
});

describe('on a push to main (--defer-full)', () => {
  it('never runs the full set: everything becomes the smoke set, and says it was deferred', () => {
    const sel = select(fixtureRepo(), [modified('pnpm-lock.yaml'), modified('e2e/coin.spec.ts')], { deferFull: true });
    expect(sel).toMatchObject({ specs: ['coin.spec.ts', ...SMOKE].sort(), jvm: false, jvmFiles: [], deferred: true });
    expect(sel.reasons.some((r) => r.startsWith('every spec needed (pnpm-lock.yaml'))).toBe(true);
  });

  it(`keeps what changed itself and the guards whatever their number, and fills to ${PUSH_BUDGET} with the best-scored rest`, () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 9; i++) many[`e2e/pill-${i}.spec.ts`] = FORGE_SPEC(`page.getByTestId('pill-${i}');${i < 3 ? " page.getByTestId('pill-top');" : ''}`);
    for (let i = 0; i < 20; i++) many[`e2e/filler-${i}.spec.ts`] = FORGE_SPEC('');
    const ids = Array.from({ length: 9 }, (_, i) => `<b data-testid="pill-${i}" />`).join('');
    const pill = `export function Pill() {\n  return <i data-testid="pill-top">${ids}</i>;\n}\n`;
    const repo = fixtureRepo({ ...many, 'apps/ui/src/play/live/Pill.tsx': pill });
    const sel = select(repo, [modified('apps/ui/src/play/live/Pill.tsx'), modified('e2e/pile.spec.ts'), modified('apps/server/src/play/match.ts')], { ...guarded, deferFull: true });
    // pile (itself), coin (guard), the smoke set: 4; then the three pills with a second key, then the rest by name.
    expect(sel.specs).toEqual(['coin.spec.ts', 'pile.spec.ts', 'pill-0.spec.ts', 'pill-1.spec.ts', 'pill-2.spec.ts', 'pill-3.spec.ts', 'pill-4.spec.ts', 'pill-5.spec.ts', ...SMOKE].sort());
    expect(sel.specs).toHaveLength(PUSH_BUDGET);
    expect(sel.reasons.some((r) => r.startsWith('pill-8.spec.ts: deferred to the batched full run (apps/ui/src/play/live/Pill.tsx: testid pill-8; score'))).toBe(true);
    expect(sel.deferred).toBe(true);
  });

  it('runs a jvm suite that uses a changed module directly, not one that uses it from afar', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/play/host.ts')], { deferFull: true });
    expect(sel.jvmFiles).toEqual(['apps/server/src/play/bolt.jvm.test.ts']);
    const far = select(fixtureRepo(), [modified('apps/server/src/play/rules.ts')], { deferFull: true });
    expect(far.jvmFiles).toEqual([]);
    expect(far.reasons).toContain('apps/server/src/play/bolt.jvm.test.ts: deferred to the batched full run (uses apps/server/src/play/rules.ts (3 deep); score 0.3)');
  });
});

describe('diff helpers', () => {
  const after = ['a', 'B', 'c', 'd', 'E', 'f'].join('\n');
  const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -4,3 +4,3 @@', ' d', '-e', '+E', ' f'].join('\n');

  it('changedLines reads new-side line numbers from hunks', () => {
    expect(changedLines(patch)).toEqual([2, 5]);
  });

  it('changedLines reads each hunk where its text sits in a later file', () => {
    const later = ['new 1', 'new 2', 'a', 'B', 'c', 'd', 'E', 'f'].join('\n');
    expect(changedLines(patch, later)).toEqual([4, 7]);
    expect(changedLines(patch, after)).toEqual([2, 5]);
    expect(changedLines(patch, 'nothing of it')).toEqual([2, 5]);
  });

  it('changedLines finds a run of added lines whose context was edited since', () => {
    const run = ['@@ -3,2 +3,4 @@', ' ctx', '+.long-enough-selector {', '+  margin: 0;', ' }'].join('\n');
    const later = ['x', 'x', 'x', 'x', 'x', 'edited ctx', '.long-enough-selector {', '  margin: 0;', '}'].join('\n');
    expect(changedLines(run, later)).toEqual([7, 8]);
  });

  it('beforePatch rebuilds the old file', () => {
    expect(beforePatch(after, patch)).toBe(['a', 'b', 'c', 'd', 'e', 'f'].join('\n'));
  });

  it('code() drops comments and whitespace but keeps strings', () => {
    expect(code('const a = 1; // one\n/* two */ const b = "// not a comment";', false)).toBe('const a = 1; const b = "// not a comment";');
  });

  it('changedSelectors names the rules holding the changed lines', () => {
    const css = '.a {\n  x: 1;\n}\n@media (min-width: 1px) {\n  .b > .c {\n    y: 2;\n  }\n}\n';
    expect(changedSelectors(css, [2])).toEqual(['.a']);
    expect(changedSelectors(css, [6])).toEqual(['.b > .c', '@media (min-width: 1px)']);
  });

  it('declarations split a module at its top-level declarations', () => {
    const d = declarations('import x from "y";\nexport interface A {\n  a: 1;\n}\nexport default function B() {\n  return 1;\n}\n');
    expect(d.map((x) => [x.name, x.start, x.end, x.isType, x.isDefault])).toEqual([
      ['A', 2, 4, true, false],
      ['B', 5, 8, false, true],
    ]);
  });
});

describe('outputs for forge.yml', () => {
  it('one shard for a short list, three for everything', () => {
    expect(outputs({ e2e: true, specs: ['a.spec.ts'], jvm: false, jvmFiles: [], deferred: false, reasons: [] })).toMatchObject({ shards: '[1]', e2e_specs: 'a.spec.ts', jvm: 'false', jvm_full: 'false' });
    expect(outputs({ e2e: true, specs: null, jvm: true, jvmFiles: null, deferred: false, reasons: [] })).toMatchObject({ shards: '[1, 2, 3]', e2e_specs: '', jvm_files: '', jvm_full: 'true' });
  });
});

describe('the hot-path table', () => {
  it('names only specs and suites that exist, so a rename or a merge has to update it', () => {
    const all = universe(new Tree());
    for (const g of GUARDS) {
      for (const s of g.specs) expect(all.specs, `${g.name}: ${s}`).toContain(s);
      for (const j of g.jvm) expect(all.jvm, `${g.name}: ${j}`).toContain(j);
    }
  });
});

/**
 * Real ranges landed on main, read against this checkout. Each replay reads git
 * history and walks the tree's imports, up to 3 s on a quiet host and several
 * times that on a loaded one, so these and the replays below get 20 s rather than
 * the default 5.
 */
describe('real landed ranges', { timeout: 20_000 }, () => {
  const ranges = new Map<string, { range: string; files: Change[] }>();
  const read = (name: string): { range: string; files: Change[] } => {
    if (!ranges.has(name)) ranges.set(name, JSON.parse(readFileSync(join(ROOT, 'scripts/ci/fixtures', `${name}.json`), 'utf8')) as { range: string; files: Change[] });
    return ranges.get(name)!;
  };
  const fixture = (name: string): Change[] => read(name).files;
  /** The tree as it stood at the end of the named range, for the files that range changed. */
  const treeOf = (name: string): Tree => new Tree(NO_HISTORY, fixtureSha(read(name)));

  it('sound pipeline only (4a011ffb): no Forge run', () => {
    expect(select(treeOf('sfx-round5'), fixture('sfx-round5'))).toMatchObject({ e2e: false, jvm: false });
  });

  it('the @wolffm auto-update (4f6fd3af): the lockfile moves, everything runs', () => {
    expect(select(treeOf('auto-update-wolffm'), fixture('auto-update-wolffm'))).toMatchObject({ specs: null, jvmFiles: null });
  });

  it('modal spell arrows through PlayBridge (da8026aa): everything on a dispatch', () => {
    expect(select(treeOf('modal-arrows-bridge'), fixture('modal-arrows-bridge'))).toMatchObject({ specs: null, jvmFiles: null });
  });

  it('modal spell arrows through PlayBridge (da8026aa): the new spec, its scenarios\' suite and the engine guards on a push', () => {
    const sel = select(treeOf('modal-arrows-bridge'), fixture('modal-arrows-bridge'), { deferFull: true });
    expect(sel.specs).toEqual(expect.arrayContaining(['modal-arrows.spec.ts', 'w68-untap.spec.ts', ...SMOKE]));
    expect(sel.jvmFiles).toEqual(expect.arrayContaining(['apps/server/src/play/modal-targets.jvm.test.ts', 'apps/server/src/play/match-frames.jvm.test.ts']));
  });

  it('the prompt sheet as one column (da8026aa..ff959d3f): the prompt specs, not every spec; the version bumps and comment edit are ignored', () => {
    const sel = select(treeOf('prompt-sheet'), fixture('prompt-sheet'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining(['prompt-bar.spec.ts', ...SMOKE]));
    expect(sel.reasons).toEqual(expect.arrayContaining(['apps/ui/package.json: a version bump', 'apps/ui/src/play/live/live.css: comments only']));
  });

  it('the chat divider in chrome.css (124b096b): the smoke set and the specs drawn through the chrome', () => {
    const sel = select(treeOf('chrome-divider-css'), fixture('chrome-divider-css'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining([...SMOKE]));
    expect(sel.jvm).toBe(false);
  });

  it('flashback picked up from the graveyard (6a7cf395..e0eb075b): its own spec and scenario, not every spec', () => {
    const sel = select(treeOf('flashback-gestures'), fixture('flashback-gestures'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining(['w69-flashback.spec.ts', ...SMOKE]));
  });
});

/**
 * Fixes whose push (or a later edit to the same code) did not run the spec that
 * guards them (test audit 2026-10-12 §4.2). Each fixture is the commit's own diff
 * and the land it shipped in, history included; replayed as a push, the guarding
 * spec must be picked.
 */
describe('historical misses, replayed as a push', { timeout: 20_000 }, () => {
  interface Miss {
    commit: string;
    files: Change[];
    land: { commits: { sha: string; files: string[]; touched: Record<string, string[]> }[] } | null;
  }
  const replay = (sha: string): ReturnType<typeof select> => {
    const m = JSON.parse(readFileSync(join(ROOT, 'scripts/ci/fixtures', `miss-${sha}.json`), 'utf8')) as Miss;
    const commits = m.land?.commits ?? [];
    const history: History = {
      lands: m.land ? [{ commits: commits.map(({ sha: s, files }) => ({ sha: s, files })) }] : [],
      touched: Object.fromEntries(commits.flatMap((c) => Object.entries(c.touched).map(([f, names]) => [`${c.sha}:${f}`, names]))),
    };
    return select(new Tree(history, sha), m.files, { deferFull: true });
  };

  it.each([
    ['0bc18c18', 'a turned card claims its row (card.css)', ['w70-tapped-drag.spec.ts']],
    ['e1e12ebd', 'a scry 1 drawn in its decision window', ['w70-nissa.spec.ts']],
    ['fa399cef', 'the stand-in turned over in the gap (presence.ts)', ['w71-tap-reveal.spec.ts']],
    ['44497be5', "the Signet regression (match.ts, auto.ts) — caught later by w68-untap", ['w68-untap.spec.ts']],
    ['3802057e', "the Signet fix (match.ts)", ['w68-untap.spec.ts']],
    ['826021d8', 'a log line waits for its delta (match.ts)', ['lg-gamelog.spec.ts', 'w68-untap.spec.ts']],
    ['922cd08e', 'a log line paced as its own class (pace.ts)', ['w47-pace.spec.ts', 'w71-tap-reveal.spec.ts', 'dead-bar.spec.ts']],
    ['1f49c91c', 'a land is a mana source only for mana (auto.ts, the bridge)', ['play.spec.ts', 'w68-untap.spec.ts', 'land-abilities.spec.ts']],
    ['112836fe', 'the engine pin moves (Nykthos)', ['w68-untap.spec.ts', 'modal-arrows.spec.ts']],
    ['33e3f9dc', "the pod circle's global `.seat` (styles.css), which collapsed every match board", ['table-fit.spec.ts']],
  ])('%s, %s, runs %j', (sha, _what, want) => {
    const sel = replay(sha);
    expect(sel.specs).toEqual(expect.arrayContaining(want));
  });

  it('the Signet regression also runs the jvm suites that pin auto-pay', () => {
    expect(replay('44497be5').jvmFiles).toEqual(expect.arrayContaining(['apps/server/src/play/mana-sources.jvm.test.ts', 'apps/server/src/play/auto.jvm.test.ts']));
  });

  it("the engine pin runs the new scenario's suite and the engine's guard suites, and leaves the rest to the full run", () => {
    const sel = replay('112836fe');
    expect(sel.jvmFiles).toEqual(expect.arrayContaining(['apps/server/src/play/scenario-nykthos.jvm.test.ts', 'apps/server/src/play/match-frames.jvm.test.ts']));
    expect(sel.deferred).toBe(true);
  });
});
