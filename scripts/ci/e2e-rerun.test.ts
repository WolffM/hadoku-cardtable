import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_RERUN, type PwReport, describeTarget, isolationSpecs, judge, locationArg, plan } from './e2e-rerun.ts';
import { Repo } from './select-forge-tests.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Status = 'expected' | 'unexpected' | 'skipped';
const spec = (file: string, line: number, status: Status, opts: { title?: string; tags?: string[]; project?: string; error?: string } = {}) => ({
  title: opts.title ?? `test at ${line}`,
  file,
  line,
  tags: opts.tags ?? [],
  tests: [
    {
      projectName: opts.project ?? 'chromium',
      status,
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
    expect(plan(null, [])).toEqual({ rerun: [], red: [{ target: null, why: expect.stringContaining('no Playwright report') }] });
    expect(plan({ ...report(spec('a.spec.ts', 1, 'expected')), errors: [{ message: 'Error: Timed out waiting 60000ms from config.webServer.' }] }, []).red[0].why).toContain('the run itself failed');
    const skip = plan(report(spec('a.spec.ts', 1, 'expected'), spec('a.spec.ts', 2, 'skipped'), spec('a.spec.ts', 3, 'unexpected')), []);
    expect(skip).toMatchObject({ rerun: [], red: [{ why: 'skipped — a skip is not a pass' }] });
    expect(plan(report(), [])).toMatchObject({ rerun: [], red: [{ why: expect.stringContaining('names no failed test') }] });
    // One test, failed: still re-run (a one-spec dispatch).
    expect(plan(report(spec('a.spec.ts', 3, 'unexpected')), []).rerun).toHaveLength(1);
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
