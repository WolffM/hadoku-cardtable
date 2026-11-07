/**
 * A forge-e2e shard's one re-run of its failed tests, and the verdict.
 *
 *   node scripts/ci/e2e-rerun.ts <report.json> [--flaky-out <file>]
 *
 * `forge.yml` calls this when a shard's Playwright report is not clean. The
 * suite runs with `retries: 0` (`e2e/playwright.config.ts`), so one timing
 * flake in ~600 tests turned main red; this gives each failed test ONE more
 * run, in a pass of its own, and reports what that shows:
 *
 *   passes on the re-run   flaky: a `::warning` annotation and a line in
 *                          `--flaky-out`, and the shard is not red for it
 *   fails again            red
 *
 * A serial file (`describe.configure({ mode: 'serial' })`) is re-run whole: its
 * tests after a red do not run, and Playwright reports them skipped with no
 * `skip` annotation. Those are not red on their own; the failed test is flaky
 * only when the whole file passes on its re-run.
 *
 * Never re-run, so red at once:
 *   - a report that is missing, unreadable, or has run-level errors (a server
 *     that never started, a config error);
 *   - a report with a skipped test (a skip is not a pass), other than one that
 *     did not run after a red in its serial file, or none failed (an empty run);
 *   - more than `MAX_RERUN` failed tests (many reds is a regression, not luck);
 *   - a test in an isolation spec — one whose imports reach an e2e
 *     `isolation.ts` (the hidden-information verdict), or tagged `@isolation`
 *     or `@no-retry`. A leak that shows one time in two is a leak.
 * A shard cut off by its timeout or cancelled never gets here: the step is
 * killed with the job, and the job is red.
 *
 * The re-run writes its own report per project, and its own test results
 * (`e2e/.run/test-results-rerun-<project>/`), so the first run's screenshots
 * are still there for the evidence upload; the first run's harness logs are
 * copied to `e2e/.run/first-run/` before the re-run starts.
 *
 * Writes `flaky=<n>` to the step's `GITHUB_OUTPUT` when any test was flaky, so
 * the job keeps that first failure's evidence. Exit 0 when every failed test
 * passed on its re-run, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { Repo, importsOf } from './select-forge-tests.ts';

/** More failed tests than this in one shard is a regression: none is re-run. */
export const MAX_RERUN = 5;

/** A title or spec tag that keeps a test out of the re-run. */
const NO_RETRY_TAGS = ['@isolation', '@no-retry'];

interface PwResult {
  status: string;
  error?: { message?: string };
}
interface PwTest {
  projectName: string;
  status: string;
  /** `test.skip()` adds `{ type: 'skip' }`; a serial file's test that did not run has none. */
  annotations?: { type: string }[];
  results: PwResult[];
}
interface PwSpec {
  title: string;
  file: string;
  line: number;
  tags?: string[];
  tests: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PwReport {
  suites?: PwSuite[];
  errors?: { message?: string }[];
  stats?: { expected: number; unexpected: number; skipped: number; flaky: number };
}

/** One test in one project: what a re-run is asked for, and how its result is found again. */
export interface Target {
  file: string;
  line: number;
  project: string;
  title: string;
  /** The first line of the first run's error. */
  error: string;
}

/** A serial file with a red, re-run whole in one project. */
export interface FileRerun {
  file: string;
  project: string;
  failed: Target[];
  /** Its tests after a red that did not run. */
  dependents: Target[];
}

export interface Plan {
  rerun: Target[];
  files: FileRerun[];
  /** Red without a re-run, each with why. */
  red: { target: Target | null; why: string }[];
}

export interface Verdict {
  flaky: Target[];
  red: { target: Target | null; why: string }[];
}

/** Every (spec, test) pair in a report, with the describe titles above the spec. */
function* tests(report: PwReport): Generator<{ spec: PwSpec; test: PwTest; path: string[] }> {
  const walk = function* (s: PwSuite, path: string[]): Generator<{ spec: PwSpec; test: PwTest; path: string[] }> {
    const here = s.title && !/\.spec\.ts$/.test(s.title) ? [...path, s.title] : path;
    for (const spec of s.specs ?? []) for (const test of spec.tests) yield { spec, test, path: here };
    for (const child of s.suites ?? []) yield* walk(child, here);
  };
  for (const s of report.suites ?? []) yield* walk(s, []);
}

const firstLine = (s: string | undefined): string =>
  stripVTControlCharacters(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? '';

const targetOf = (spec: PwSpec, test: PwTest, path: string[]): Target => ({
  file: spec.file,
  line: spec.line,
  project: test.projectName,
  title: [...path, spec.title].join(' › '),
  error: firstLine(test.results.find((r) => r.error)?.error?.message),
});

export const describeTarget = (t: Target): string => `${t.file}:${t.line} › ${t.title} [${t.project}]`;

/**
 * The specs whose imports reach an e2e `isolation.ts`, at any depth: each runs
 * the hidden-information verdict over what a browser was sent.
 */
export function isolationSpecs(repo: Repo): string[] {
  const out: string[] = [];
  for (const f of repo.list('e2e').filter((p) => /\.spec\.ts$/.test(p))) {
    const seen = new Set<string>([f]);
    const queue = [f];
    let hit = false;
    for (let g = queue.shift(); g !== undefined && !hit; g = queue.shift()) {
      for (const dep of importsOf(repo, g)) {
        if (/^e2e\/(.*\/)?isolation\.ts$/.test(dep)) hit = true;
        if (!seen.has(dep) && dep.startsWith('e2e/')) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    if (hit) out.push(f.slice('e2e/'.length));
  }
  return out;
}

/** The specs, relative to `e2e/`, whose tests run in order and stop at the first red. */
export function serialSpecs(repo: Repo): string[] {
  return repo
    .list('e2e')
    .filter((p) => /\.spec\.ts$/.test(p) && /describe\.configure\(\s*\{[^}]*mode:\s*['"]serial['"]|describe\.serial\(/.test(repo.read(p) ?? ''))
    .map((p) => p.slice('e2e/'.length));
}

/**
 * What to re-run from a shard's first report. `isolation` and `serial` hold spec paths relative to `e2e/`.
 */
export function plan(report: PwReport | null, isolation: string[], serial: string[] = []): Plan {
  const out: Plan = { rerun: [], files: [], red: [] };
  if (report === null || !report.stats) return { rerun: [], files: [], red: [{ target: null, why: 'no Playwright report: the run died before it wrote one' }] };
  if (report.errors?.length) return { rerun: [], files: [], red: [{ target: null, why: `the run itself failed: ${firstLine(report.errors[0].message)}` }] };
  const all = [...tests(report)];
  const failed = all.filter(({ test }) => test.status === 'unexpected');
  // A serial file's test after a red, with no `test.skip()` of its own, did not run: it is the red's, not a skip.
  const dependsOnRed = ({ spec, test }: { spec: PwSpec; test: PwTest }): boolean =>
    serial.includes(spec.file) &&
    !(test.annotations ?? []).some((a) => a.type === 'skip') &&
    failed.some((f) => f.spec.file === spec.file && f.test.projectName === test.projectName && f.spec.line < spec.line);
  const skipped = all.filter((x) => x.test.status === 'skipped');
  const notRun = skipped.filter(dependsOnRed);
  const skips = skipped.filter((x) => !dependsOnRed(x));
  if (skips.length) {
    return { rerun: [], files: [], red: skips.map(({ spec, test, path }) => ({ target: targetOf(spec, test, path), why: 'skipped — a skip is not a pass' })) };
  }
  if (failed.length === 0) return { rerun: [], files: [], red: [{ target: null, why: `the report is not clean but names no failed test: ${JSON.stringify(report.stats)}` }] };
  if (failed.length > MAX_RERUN) {
    return {
      rerun: [],
      files: [],
      red: failed.map(({ spec, test, path }) => ({ target: targetOf(spec, test, path), why: `one of ${failed.length} failed tests — past ${MAX_RERUN}, none is re-run` })),
    };
  }
  for (const { spec, test, path } of failed) {
    const t = targetOf(spec, test, path);
    const tag = NO_RETRY_TAGS.find((x) => spec.tags?.includes(x.slice(1)) || spec.tags?.includes(x) || spec.title.includes(x));
    if (isolation.includes(spec.file)) out.red.push({ target: t, why: 'an isolation spec — never re-run' });
    else if (tag) out.red.push({ target: t, why: `tagged ${tag} — never re-run` });
    else if (serial.includes(spec.file)) {
      let f = out.files.find((x) => x.file === spec.file && x.project === t.project);
      if (f === undefined) out.files.push((f = { file: spec.file, project: t.project, failed: [], dependents: [] }));
      f.failed.push(t);
    } else out.rerun.push(t);
  }
  for (const { spec, test, path } of notRun) {
    const f = out.files.find((x) => x.file === spec.file && x.project === test.projectName);
    // Its red is never re-run (isolation, a tag): what did not run after it is red with it.
    if (f === undefined) out.red.push({ target: targetOf(spec, test, path), why: 'did not run after a red that is not re-run' });
    else f.dependents.push(targetOf(spec, test, path));
  }
  return out;
}

/** The verdict once the re-run reports are in. */
export function judge(p: Plan, reruns: PwReport[]): Verdict {
  const v: Verdict = { flaky: [], red: [...p.red] };
  const found = reruns.flatMap((r) => [...tests(r)]);
  const againOf = (t: Target) => found.find(({ spec, test }) => spec.file === t.file && spec.line === t.line && test.projectName === t.project);
  const errorOf = (test: PwTest): string => firstLine(test.results.find((r) => r.error)?.error?.message);
  /** Each failed test: flaky when it passed on the re-run, red otherwise. */
  const flakyUnlessRed = (ts: Target[]): void => {
    for (const t of ts) {
      const again = againOf(t);
      if (again === undefined) v.red.push({ target: t, why: 'failed, and did not run on the re-run' });
      else if (again.test.status === 'expected') v.flaky.push(t);
      else v.red.push({ target: t, why: `failed again on the re-run (${again.test.status}): ${errorOf(again.test)}` });
    }
  };
  flakyUnlessRed(p.rerun);
  for (const f of p.files) {
    flakyUnlessRed(f.failed);
    for (const t of f.dependents) {
      const again = againOf(t);
      if (again === undefined) v.red.push({ target: t, why: 'did not run after a red in its serial file, and did not run on the re-run' });
      else if (again.test.status === 'unexpected') v.red.push({ target: t, why: `did not run after a red in its serial file, and failed on the re-run (unexpected): ${errorOf(again.test)}` });
      else if (again.test.status !== 'expected') v.red.push({ target: t, why: `did not run after a red in its serial file, and did not pass on the re-run (${again.test.status})` });
    }
  }
  return v;
}

/** Playwright's location filter is a case-insensitive regex over the absolute path: anchor the file name, or `play.spec.ts` also matches `replay.spec.ts`. */
export const locationArg = (t: Target): string => `/\\/${t.file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/:${t.line}`;

/** The whole of one spec file, anchored as `locationArg` is. */
export const fileArg = (file: string): string => `/\\/${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`;

const readReport = (f: string): PwReport | null => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as PwReport;
  } catch {
    return null;
  }
};

const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'flaky-out': { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('usage: e2e-rerun.ts <report.json> [--flaky-out <file>]');
  const root = join(import.meta.dirname, '..', '..');
  const isolation = isolationSpecs(new Repo(root));
  console.log(`isolation specs, never re-run (${isolation.length}): ${isolation.join(' ')}`);
  const serial = serialSpecs(new Repo(root));
  const p = plan(readReport(positionals[0]), isolation, serial);

  const reruns: PwReport[] = [];
  if (p.rerun.length || p.files.length) {
    const run = join(root, 'e2e', '.run');
    mkdirSync(join(run, 'first-run'), { recursive: true });
    for (const f of existsSync(run) ? readdirSync(run) : []) if (/\.(log|jsonl|json)$/.test(f)) copyFileSync(join(run, f), join(run, 'first-run', f));
    for (const project of [...new Set([...p.rerun, ...p.files].map((t) => t.project))]) {
      const mine = p.rerun.filter((t) => t.project === project);
      const files = p.files.filter((f) => f.project === project);
      const out = `${positionals[0].replace(/\.json$/, '')}-rerun-${project}.json`;
      console.log(
        `re-running ${mine.length} failed test(s) and ${files.length} serial file(s) whole, once, ${project}:\n${[
          ...mine.map((t) => `  ${describeTarget(t)}`),
          ...files.map((f) => `  ${f.file} (serial: ${f.failed.length} red, ${f.dependents.length} that did not run)`),
        ].join('\n')}`,
      );
      try {
        execFileSync(
          'pnpm',
          ['--filter', '@hadoku/e2e', 'run', 'test:browser', `--project=${project}`, `--output=.run/test-results-rerun-${project}`, ...mine.map(locationArg), ...files.map((f) => fileArg(f.file))],
          { cwd: root, stdio: 'inherit', env: { ...process.env, PW_TEST_REPORTER: 'json', PLAYWRIGHT_JSON_OUTPUT_FILE: out } },
        );
      } catch (e) {
        console.log(`the re-run exited ${(e as { status?: number }).status ?? 'abnormally'} — judged from its report`);
      }
      const r = readReport(out);
      if (r) reruns.push(r);
      else console.log(`::error::the re-run for ${project} wrote no report`);
    }
  }

  const v = judge(p, reruns);
  const summary: string[] = [];
  for (const t of v.flaky) {
    const line = `${describeTarget(t)} — failed (${t.error}), then passed on a re-run`;
    console.log(`::warning title=Flaky e2e test::${escapeData(line)}`);
    console.log(`flaky: ${line}`);
    summary.push(`- ⚠️ flaky: ${line}`);
    if (values['flaky-out']) appendFileSync(values['flaky-out'], `${describeTarget(t)}\t${t.error}\n`);
  }
  for (const { target, why } of v.red) {
    const line = target ? `${describeTarget(target)} — ${why}${target.error && !why.includes(target.error) ? ` (${target.error})` : ''}` : why;
    console.log(`::error title=Red e2e test::${escapeData(line)}`);
    console.log(`red: ${line}`);
    summary.push(`- ❌ red: ${line}`);
  }
  if (process.env.GITHUB_OUTPUT && v.flaky.length) appendFileSync(process.env.GITHUB_OUTPUT, `flaky=${v.flaky.length}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && summary.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### forge-e2e re-run\n${summary.join('\n')}\n`);
  console.log(`e2e re-run verdict: ${v.flaky.length} flaky, ${v.red.length} red`);
  return v.red.length ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = main(process.argv.slice(2));
