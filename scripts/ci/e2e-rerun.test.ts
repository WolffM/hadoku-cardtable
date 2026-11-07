import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_RERUN, type PwReport, describeTarget, fileArg, isolationSpecs, judge, locationArg, plan, serialSpecs } from './e2e-rerun.ts';
import { Repo } from './select-forge-tests.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Status = 'expected' | 'unexpected' | 'skipped';
const spec = (file: string, line: number, status: Status, opts: { title?: string; tags?: string[]; project?: string; error?: string; skipAnnotation?: boolean } = {}) => ({
  title: opts.title ?? `test at ${line}`,
  file,
  line,
  tags: opts.tags ?? [],
  tests: [
    {
      projectName: opts.project ?? 'chromium',
      status,
      // `test.skip()` annotates the test; a serial file's tests after a failure carry none (they did not run).
      annotations: status === 'skipped' && (opts.skipAnnotation ?? true) ? [{ type: 'skip' }] : [],
      results: [{ status: status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed', ...(status === 'unexpected' ? { error: { message: opts.error ?? 'Error: expected 1\n  at x' } } : {}) }],
    },
  ],
});
type Spec = ReturnType<typeof spec>;
const report = (...specs: Spec[]): PwReport => ({
  suites: [{ title: 'a.spec.ts', specs: [], suites: [{ title: 'a describe', specs }] }],
  errors: [],
  stats: {
    expected: specs.filter((s) => s.tests[0].status === 'expected').length,
    unexpected: specs.filter((s) => s.tests[0].status === 'unexpected').length,
    skipped: specs.filter((s) => s.tests[0].status === 'skipped').length,
    flaky: 0,
  },
});

describe('which specs are isolation specs', () => {
  it('every spec whose imports reach an e2e isolation.ts, at any depth, and no other', () => {
    const iso = isolationSpecs(new Repo(ROOT));
    // Direct (`play.spec.ts`, `draft.spec.ts`) and through a helper (`watcher.spec.ts`).
    expect(iso).toEqual(expect.arrayContaining(['play.spec.ts', 'draft.spec.ts', 'watcher.spec.ts']));
    expect(iso).not.toContain('w59-stack.spec.ts');
    expect(iso).not.toContain('table-fit.spec.ts');
  });
});

describe('the re-run plan', () => {
  it('re-runs each failed test once, by file, line and project', () => {
    const p = plan(report(spec('a.spec.ts', 3, 'expected'), spec('a.spec.ts', 9, 'unexpected', { project: 'firefox' })), []);
    expect(p.red).toEqual([]);
    expect(p.rerun).toEqual([{ file: 'a.spec.ts', line: 9, project: 'firefox', title: 'a describe › test at 9', error: 'Error: expected 1' }]);
  });

  it('never re-runs an isolation spec or a test tagged @isolation / @no-retry: those are red', () => {
    const p = plan(
      report(
        spec('a.spec.ts', 3, 'expected'),
        spec('play.spec.ts', 5, 'unexpected'),
        spec('b.spec.ts', 7, 'unexpected', { tags: ['@no-retry'] }),
        spec('b.spec.ts', 8, 'unexpected', { title: 'leaks nothing @isolation' }),
        spec('b.spec.ts', 9, 'unexpected'),
      ),
      ['play.spec.ts'],
    );
    expect(p.rerun.map((t) => t.line)).toEqual([9]);
    expect(p.red.map((r) => [r.target?.line, r.why])).toEqual([
      [5, 'an isolation spec — never re-run'],
      [7, 'tagged @no-retry — never re-run'],
      [8, 'tagged @isolation — never re-run'],
    ]);
  });

  it(`re-runs nothing past ${MAX_RERUN} failed tests: many reds is a regression`, () => {
    const p = plan(report(spec('a.spec.ts', 1, 'expected'), ...Array.from({ length: MAX_RERUN + 1 }, (_, i) => spec('a.spec.ts', 10 + i, 'unexpected'))), []);
    expect(p.rerun).toEqual([]);
    expect(p.red).toHaveLength(MAX_RERUN + 1);
  });

  it('a missing report, a run-level error, a skip or an empty run is red with no re-run', () => {
    expect(plan(null, [])).toEqual({ rerun: [], files: [], red: [{ target: null, why: expect.stringContaining('no Playwright report') }] });
    expect(plan({ ...report(spec('a.spec.ts', 1, 'expected')), errors: [{ message: 'Error: Timed out waiting 60000ms from config.webServer.' }] }, []).red[0].why).toContain('the run itself failed');
    const skip = plan(report(spec('a.spec.ts', 1, 'expected'), spec('a.spec.ts', 2, 'skipped'), spec('a.spec.ts', 3, 'unexpected')), []);
    expect(skip).toMatchObject({ rerun: [], red: [{ why: 'skipped — a skip is not a pass' }] });
    expect(plan(report(), [])).toMatchObject({ rerun: [], red: [{ why: expect.stringContaining('names no failed test') }] });
    // One test, failed: still re-run (a one-spec dispatch).
    expect(plan(report(spec('a.spec.ts', 3, 'unexpected')), []).rerun).toHaveLength(1);
  });
});

describe('a serial file (`describe.configure({ mode: \'serial\' })`)', () => {
  // Closing run 42354601891, shard 2: prompts-offboard.spec.ts is serial; W18 at 162 failed, so W16 at 192 did not
  // run. The skip was called red on its own and nothing was re-run.
  const first = report(
    spec('prompts-offboard.spec.ts', 111, 'expected'),
    spec('prompts-offboard.spec.ts', 162, 'unexpected'),
    spec('prompts-offboard.spec.ts', 192, 'skipped', { skipAnnotation: false }),
    spec('a.spec.ts', 5, 'unexpected'),
  );
  const p = plan(first, [], ['prompts-offboard.spec.ts']);

  it('knows the serial specs from their source', () => {
    expect(serialSpecs(new Repo(ROOT))).toContain('prompts-offboard.spec.ts');
    expect(serialSpecs(new Repo(ROOT))).not.toContain('w59-stack.spec.ts');
  });

  it('a test that did not run after a red in its serial file is not red on its own: the whole file is re-run', () => {
    expect(p.red).toEqual([]);
    expect(p.rerun.map((t) => `${t.file}:${t.line}`)).toEqual(['a.spec.ts:5']);
    expect(p.files).toEqual([
      {
        file: 'prompts-offboard.spec.ts',
        project: 'chromium',
        failed: [expect.objectContaining({ line: 162 })],
        dependents: [expect.objectContaining({ line: 192 })],
      },
    ]);
  });

  it('a test.skip() in a serial file is still a skip, and a skip is still red', () => {
    const skipped = plan(
      report(spec('prompts-offboard.spec.ts', 162, 'unexpected'), spec('prompts-offboard.spec.ts', 192, 'skipped', { skipAnnotation: true })),
      [],
      ['prompts-offboard.spec.ts'],
    );
    expect(skipped.red.map((r) => [r.target?.line, r.why])).toEqual([[192, 'skipped — a skip is not a pass']]);
    // A test before the red that did not run is no dependent of it.
    const before = plan(
      report(spec('prompts-offboard.spec.ts', 111, 'skipped', { skipAnnotation: false }), spec('prompts-offboard.spec.ts', 162, 'unexpected')),
      [],
      ['prompts-offboard.spec.ts'],
    );
    expect(before.red.map((r) => r.target?.line)).toEqual([111]);
    // Not a serial file: a test that did not run is red, as before.
    expect(plan(first, []).red.map((r) => r.target?.line)).toEqual([192]);
  });

  it('the file passing whole on its re-run makes the failed test flaky; any of it failing or not running again is red', () => {
    const green = judge(p, [
      report(spec('prompts-offboard.spec.ts', 111, 'expected'), spec('prompts-offboard.spec.ts', 162, 'expected'), spec('prompts-offboard.spec.ts', 192, 'expected'), spec('a.spec.ts', 5, 'expected')),
    ]);
    expect(green.flaky.map((t) => `${t.file}:${t.line}`)).toEqual(['a.spec.ts:5', 'prompts-offboard.spec.ts:162']);
    expect(green.red).toEqual([]);

    const dependentRed = judge(p, [
      report(spec('prompts-offboard.spec.ts', 162, 'expected'), spec('prompts-offboard.spec.ts', 192, 'unexpected', { error: 'Error: W16' }), spec('a.spec.ts', 5, 'expected')),
    ]);
    expect(dependentRed.flaky.map((t) => t.line)).toEqual([5, 162]);
    expect(dependentRed.red).toEqual([{ target: expect.objectContaining({ line: 192 }), why: 'did not run after a red in its serial file, and failed on the re-run (unexpected): Error: W16' }]);

    const again = judge(p, [
      report(spec('prompts-offboard.spec.ts', 162, 'unexpected', { error: 'Error: still' }), spec('prompts-offboard.spec.ts', 192, 'skipped', { skipAnnotation: false }), spec('a.spec.ts', 5, 'expected')),
    ]);
    expect(again.flaky.map((t) => t.line)).toEqual([5]);
    expect(again.red.map((r) => [r.target?.line, r.why])).toEqual([
      [162, 'failed again on the re-run (unexpected): Error: still'],
      [192, 'did not run after a red in its serial file, and did not pass on the re-run (skipped)'],
    ]);

    expect(judge(p, []).red.map((r) => r.target?.line)).toEqual([5, 162, 192]);
  });

  it('counts only failed tests toward the re-run cap, not the tests that did not run after them', () => {
    const many = plan(
      report(
        spec('prompts-offboard.spec.ts', 162, 'unexpected'),
        ...Array.from({ length: MAX_RERUN + 2 }, (_, i) => spec('prompts-offboard.spec.ts', 200 + i, 'skipped', { skipAnnotation: false })),
      ),
      [],
      ['prompts-offboard.spec.ts'],
    );
    expect(many.red).toEqual([]);
    expect(many.files[0]!.dependents).toHaveLength(MAX_RERUN + 2);
  });

  it('names the whole file to Playwright, exactly', () => {
    const arg = fileArg('play.spec.ts');
    const re = new RegExp(/^\/(.*)\/$/.exec(arg)![1]!, 'i');
    expect(re.test('/w/e2e/play.spec.ts')).toBe(true);
    expect(re.test('/w/e2e/w81-replay.spec.ts')).toBe(false);
  });
});

describe('the verdict', () => {
  const p = plan(report(spec('a.spec.ts', 1, 'expected'), spec('a.spec.ts', 5, 'unexpected'), spec('b.spec.ts', 6, 'unexpected')), []);

  it('a test that passes on its re-run is flaky; one that fails again is red', () => {
    const v = judge(p, [report(spec('a.spec.ts', 5, 'expected'), spec('b.spec.ts', 6, 'unexpected', { error: 'Error: still wrong' }))]);
    expect(v.flaky.map(describeTarget)).toEqual(['a.spec.ts:5 › a describe › test at 5 [chromium]']);
    expect(v.red).toEqual([{ target: expect.objectContaining({ file: 'b.spec.ts', line: 6 }), why: 'failed again on the re-run (unexpected): Error: still wrong' }]);
  });

  it('a test the re-run did not run, or a re-run with no report, is red', () => {
    expect(judge(p, [report(spec('a.spec.ts', 5, 'expected'))]).red).toEqual([{ target: expect.objectContaining({ line: 6 }), why: 'failed, and did not run on the re-run' }]);
    expect(judge(p, []).red).toHaveLength(2);
    expect(judge(p, []).flaky).toEqual([]);
  });

  it('a test skipped on the re-run is red, not flaky', () => {
    const v = judge(p, [report(spec('a.spec.ts', 5, 'skipped'), spec('b.spec.ts', 6, 'expected'))]);
    expect(v.red.map((r) => r.target?.line)).toEqual([5]);
  });

  it('what was red without a re-run stays red', () => {
    const iso = plan(report(spec('a.spec.ts', 1, 'expected'), spec('play.spec.ts', 5, 'unexpected')), ['play.spec.ts']);
    expect(judge(iso, []).red).toHaveLength(1);
  });
});

describe('the location filter', () => {
  it('names one file exactly: play.spec.ts is not replay.spec.ts', () => {
    const arg = locationArg({ file: 'play.spec.ts', line: 12, project: 'chromium', title: '', error: '' });
    const m = /^\/(.*)\/:(\d+)$/.exec(arg)!;
    const re = new RegExp(m[1], 'gi');
    expect(m[2]).toBe('12');
    expect(new RegExp(re).test('/w/e2e/play.spec.ts')).toBe(true);
    expect(new RegExp(re).test('/w/e2e/w81-replay.spec.ts')).toBe(false);
    expect(new RegExp(re).test('/w/e2e/playXspec.ts')).toBe(false);
  });
});
