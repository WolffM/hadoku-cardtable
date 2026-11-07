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
 * Never re-run, so red at once:
 *   - a report that is missing, unreadable, or has run-level errors (a server
 *     that never started, a config error);
 *   - a report with a skipped test (a skip is not a pass), or none failed (an
 *     empty run);
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

export interface Plan {
  rerun: Target[];
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

/** What to re-run from a shard's first report. `isolation` holds spec paths relative to `e2e/`. */
export function plan(report: PwReport | null, isolation: string[]): Plan {
  const out: Plan = { rerun: [], red: [] };
  if (report === null || !report.stats) return { rerun: [], red: [{ target: null, why: 'no Playwright report: the run died before it wrote one' }] };
  if (report.errors?.length) return { rerun: [], red: [{ target: null, why: `the run itself failed: ${firstLine(report.errors[0].message)}` }] };
  const all = [...tests(report)];
  const skipped = all.filter(({ test }) => test.status === 'skipped');
  if (skipped.length) {
    return { rerun: [], red: skipped.map(({ spec, test, path }) => ({ target: targetOf(spec, test, path), why: 'skipped — a skip is not a pass' })) };
  }
  const failed = all.filter(({ test }) => test.status === 'unexpected');
  if (failed.length === 0) return { rerun: [], red: [{ target: null, why: `the report is not clean but names no failed test: ${JSON.stringify(report.stats)}` }] };
  if (failed.length > MAX_RERUN) {
    return {
      rerun: [],
      red: failed.map(({ spec, test, path }) => ({ target: targetOf(spec, test, path), why: `one of ${failed.length} failed tests — past ${MAX_RERUN}, none is re-run` })),
    };
  }
  for (const { spec, test, path } of failed) {
    const t = targetOf(spec, test, path);
    const tag = NO_RETRY_TAGS.find((x) => spec.tags?.includes(x.slice(1)) || spec.tags?.includes(x) || spec.title.includes(x));
    if (isolation.includes(spec.file)) out.red.push({ target: t, why: 'an isolation spec — never re-run' });
    else if (tag) out.red.push({ target: t, why: `tagged ${tag} — never re-run` });
    else out.rerun.push(t);
  }
  return out;
}

/** The verdict once the re-run reports are in. */
export function judge(p: Plan, reruns: PwReport[]): Verdict {
  const v: Verdict = { flaky: [], red: [...p.red] };
  const found = reruns.flatMap((r) => [...tests(r)]);
  for (const t of p.rerun) {
    const again = found.find(({ spec, test }) => spec.file === t.file && spec.line === t.line && test.projectName === t.project);
    if (again === undefined) v.red.push({ target: t, why: 'failed, and did not run on the re-run' });
    else if (again.test.status === 'expected') v.flaky.push(t);
    else v.red.push({ target: t, why: `failed again on the re-run (${again.test.status}): ${firstLine(again.test.results.find((r) => r.error)?.error?.message)}` });
  }
  return v;
}

/** Playwright's location filter is a case-insensitive regex over the absolute path: anchor the file name, or `play.spec.ts` also matches `replay.spec.ts`. */
export const locationArg = (t: Target): string => `/\\/${t.file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/:${t.line}`;

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
  const p = plan(readReport(positionals[0]), isolation);

  const reruns: PwReport[] = [];
  if (p.rerun.length) {
    const run = join(root, 'e2e', '.run');
    mkdirSync(join(run, 'first-run'), { recursive: true });
    for (const f of existsSync(run) ? readdirSync(run) : []) if (/\.(log|jsonl|json)$/.test(f)) copyFileSync(join(run, f), join(run, 'first-run', f));
    for (const project of [...new Set(p.rerun.map((t) => t.project))]) {
      const mine = p.rerun.filter((t) => t.project === project);
      const out = `${positionals[0].replace(/\.json$/, '')}-rerun-${project}.json`;
      console.log(`re-running ${mine.length} failed test(s) once, ${project}:\n${mine.map((t) => `  ${describeTarget(t)}`).join('\n')}`);
      try {
        execFileSync(
          'pnpm',
          ['--filter', '@hadoku/e2e', 'run', 'test:browser', `--project=${project}`, `--output=.run/test-results-rerun-${project}`, ...mine.map(locationArg)],
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
