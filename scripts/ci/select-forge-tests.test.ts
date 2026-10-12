/**
 * scripts/ci/select-forge-tests.ts, two ways: small in-memory repos that pin
 * each rule, and real landed ranges from main (`fixtures/*.json`, the compare
 * API's `files` shape, built with `git diff`) read against this checkout.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type Change,
  PUSH_MAPPED,
  Repo,
  SMOKE,
  beforePatch,
  changedLines,
  changedSelectors,
  code,
  declarations,
  outputs,
  select,
  versionBumpOnly,
} from './select-forge-tests.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A repository held in memory: path → content. */
class MemRepo extends Repo {
  private readonly files: Record<string, string>;
  constructor(files: Record<string, string>) {
    super('/nonexistent');
    this.files = files;
  }
  override read(path: string): string | null {
    return this.files[path] ?? null;
  }
  override list(dir: string): string[] {
    return Object.keys(this.files)
      .filter((f) => f.startsWith(`${dir}/`))
      .sort();
  }
}

const FORGE_SPEC = (body: string): string => `import { startPlayStack } from './play/harness.ts';\nconst forge = { ok: true };\n${body}\n`;

/** Two smoke specs, three narrow ones, a helper, a scenario, a component tree, a server, a jvm suite. */
function fixtureRepo(extra: Record<string, string> = {}): MemRepo {
  return new MemRepo({
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
    'apps/server/src/play/match.ts': "export const m = 1;\n",
    'apps/server/src/play/host.ts': "import { m } from './match.ts';\nexport const h = m;\n",
    'apps/server/src/http/sounds.ts': "export const routes = ['/api/sounds/catalogue'];\n",
    'apps/server/src/play/bolt.jvm.test.ts': "import { h } from './host.ts';\nstartScenario('bolt-player');\n",
    'apps/ui/src/play/live/CoinToss.tsx':
      "import { flip } from './coin.ts';\nimport './coin.css';\nexport function CoinToss() {\n  return <div data-testid=\"coin-toss\" className=\"coin\">{flip()}</div>;\n}\n",
    'apps/ui/src/play/live/coin.ts': 'export interface Coin {\n  side: string;\n}\nexport function flip(): string {\n  return "heads";\n}\n',
    'apps/ui/src/play/live/coin.css': '/* the coin */\n.coin {\n  width: 10px;\n}\n.other {\n  color: red;\n}\n',
    'apps/ui/src/play/live/Pile.tsx': 'export function Pile() {\n  return <div data-pile="1" />;\n}\n',
    'apps/ui/src/play/live/Bars.tsx': 'export function Bars() {\n  return <div className="mana-bar" data-testid="bars" />;\n}\n',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`e2e/other-${i}.spec.ts`, FORGE_SPEC('')])),
    ...extra,
  });
}

const modified = (filename: string, patch?: string): Change => ({ filename, status: 'modified', patch });
const diff = (start: number, minus: string[], plus: string[], context: string[] = []): string =>
  [`@@ -${start},${minus.length + context.length} +${start},${plus.length + context.length} @@`, ...context.map((l) => ` ${l}`), ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join('\n');

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

  it('the bridge, match.ts, the engine pin and packages run everything', () => {
    for (const f of ['apps/server/src/play/bridge/PlayBridge.java', 'apps/server/src/play/match.ts', 'forge', 'packages/forge-wire/src/tier-a.ts']) {
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

  it('server code in the match runtime runs every spec and the jvm suites importing it', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/play/host.ts')]);
    expect(sel).toMatchObject({ specs: null, jvmFiles: ['apps/server/src/play/bolt.jvm.test.ts'] });
  });

  it('server scaffolding runs the smoke set and the specs that call its routes', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/http/sounds.ts')]);
    expect(sel.specs).toEqual(['bars.spec.ts', ...SMOKE].sort());
  });

  it('a component runs the specs that name its test id, and the smoke set', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/CoinToss.tsx')]);
    expect(sel.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
    expect(sel.reasons).toContain('e2e: coin.spec.ts — apps/ui/src/play/live/CoinToss.tsx: testid coin-toss');
  });

  it('a helper module acts through the component that calls it', () => {
    const sel = select(fixtureRepo(), [modified('apps/ui/src/play/live/coin.ts', diff(5, ['  return "tails";'], ['  return "heads";']))]);
    expect(sel.specs).toEqual(['coin.spec.ts', ...SMOKE].sort());
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

  it('a removed UI file, and anything unclassified, runs everything', () => {
    expect(select(fixtureRepo(), [{ filename: 'apps/ui/src/play/live/Gone.tsx', status: 'removed' }]).specs).toBeNull();
    expect(select(fixtureRepo(), [modified('somewhere/new.txt')]).specs).toBeNull();
  });

  it('a key most specs touch is run by the smoke set, not by every spec', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 18; i++) many[`e2e/says-${i}.spec.ts`] = FORGE_SPEC("page.getByTestId('live-says');");
    const repo = fixtureRepo({ ...many, 'apps/ui/src/play/live/Says.tsx': 'export function Says() {\n  return <p data-testid="live-says" />;\n}\n' });
    const sel = select(repo, [modified('apps/ui/src/play/live/Says.tsx')]);
    expect(sel.specs).toEqual([...SMOKE].sort());
    expect(sel.reasons.some((r) => r.includes('testid live-says is in 20 specs — sampled by play.spec.ts'))).toBe(true);
  });
});

describe('on a push to main (--defer-full)', () => {
  it('never runs the full set: everything becomes the smoke set, and says it was deferred', () => {
    const sel = select(fixtureRepo(), [modified('apps/server/src/play/match.ts'), modified('e2e/coin.spec.ts')], { deferFull: true });
    expect(sel).toMatchObject({ specs: ['coin.spec.ts', ...SMOKE].sort(), jvm: false, jvmFiles: [], deferred: true });
    expect(sel.reasons.some((r) => r.startsWith('every spec needed (apps/server/src/play/match.ts'))).toBe(true);
  });

  it(`keeps what changed itself and the ${PUSH_MAPPED} most specific mapped specs, and defers import-mapped jvm suites`, () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 9; i++) many[`e2e/pill-${i}.spec.ts`] = FORGE_SPEC("page.getByTestId('pill');");
    for (let i = 0; i < 20; i++) many[`e2e/filler-${i}.spec.ts`] = FORGE_SPEC('');
    const repo = fixtureRepo({ ...many, 'apps/ui/src/play/live/Pill.tsx': 'export function Pill() {\n  return <i data-testid="pill" />;\n}\n' });
    const sel = select(repo, [modified('apps/ui/src/play/live/Pill.tsx'), modified('e2e/coin.spec.ts'), modified('apps/server/src/play/host.ts')], { deferFull: true });
    expect(sel.specs).toEqual(['coin.spec.ts', 'pill-0.spec.ts', 'pill-1.spec.ts', 'pill-2.spec.ts', 'pill-3.spec.ts', 'pill-4.spec.ts', 'pill-5.spec.ts', ...SMOKE].sort());
    expect(sel.jvmFiles).toEqual([]);
    expect(sel.deferred).toBe(true);
  });
});

describe('diff helpers', () => {
  const after = ['a', 'B', 'c', 'd', 'E', 'f'].join('\n');
  const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -4,3 +4,3 @@', ' d', '-e', '+E', ' f'].join('\n');

  it('changedLines reads new-side line numbers from hunks', () => {
    expect(changedLines(patch)).toEqual([2, 5]);
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

/** Real ranges landed on main, read against this checkout. */
describe('real landed ranges', () => {
  const repo = new Repo(ROOT);
  const fixture = (name: string): Change[] => (JSON.parse(readFileSync(join(ROOT, 'scripts/ci/fixtures', `${name}.json`), 'utf8')) as { files: Change[] }).files;

  it('sound pipeline only (4a011ffb): no Forge run', () => {
    expect(select(repo, fixture('sfx-round5'))).toMatchObject({ e2e: false, jvm: false });
  });

  it('the @wolffm auto-update (4f6fd3af): the lockfile moves, everything runs', () => {
    expect(select(repo, fixture('auto-update-wolffm'))).toMatchObject({ specs: null, jvmFiles: null });
  });

  it("modal spell arrows through PlayBridge (da8026aa): everything; on a push, the smoke set, the new spec and the new scenarios' suite", () => {
    expect(select(repo, fixture('modal-arrows-bridge'))).toMatchObject({ specs: null, jvmFiles: null });
    const push = select(repo, fixture('modal-arrows-bridge'), { deferFull: true });
    expect(push.specs).toEqual(expect.arrayContaining(['modal-arrows.spec.ts', ...SMOKE]));
    expect(push.jvmFiles).toEqual(['apps/server/src/play/modal-targets.jvm.test.ts']);
    expect(push.deferred).toBe(true);
  });

  it('the prompt sheet as one column (da8026aa..ff959d3f): the prompt specs, not every spec; the version bumps and comment edit are ignored', () => {
    const sel = select(repo, fixture('prompt-sheet'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining(['prompt-bar.spec.ts', ...SMOKE]));
    expect(sel.reasons).toEqual(expect.arrayContaining(['apps/ui/package.json: a version bump', 'apps/ui/src/play/live/live.css: comments only']));
  });

  it('the chat divider in chrome.css (124b096b): the smoke set and the specs drawn through the chrome', () => {
    const sel = select(repo, fixture('chrome-divider-css'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining([...SMOKE]));
    expect(sel.jvm).toBe(false);
  });

  it('flashback picked up from the graveyard (6a7cf395..e0eb075b): its own spec and scenario, not every spec', () => {
    const sel = select(repo, fixture('flashback-gestures'));
    expect(sel.specs).not.toBeNull();
    expect(sel.specs).toEqual(expect.arrayContaining(['w69-flashback.spec.ts', ...SMOKE]));
  });
});
