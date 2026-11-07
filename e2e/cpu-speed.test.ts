/**
 * The perf specs' clocks, without a browser: the CPU speed from samples bracketing the work, and a trace's tasks on
 * the thread's CPU clock.
 *
 *   node --test cpu-speed.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cpuSpeedOf, REFERENCE_MS, tasksOn } from './cpu-speed.ts';

test('the speed is the mean of the samples either side of the work, against the reference, never below 1', () => {
  assert.deepEqual(cpuSpeedOf([2 * REFERENCE_MS, 4 * REFERENCE_MS]), { factor: 3, workloadMs: 3 * REFERENCE_MS, samplesMs: [2 * REFERENCE_MS, 4 * REFERENCE_MS] });
  assert.equal(cpuSpeedOf([REFERENCE_MS / 2, REFERENCE_MS / 2]).factor, 1);
  assert.throws(() => cpuSpeedOf([]));
});

test("a trace's tasks: one thread's, with each task's CPU split by what ran inside it", () => {
  const pid = 7;
  const tid = 3;
  const task = (ts: number, dur: number, tdur: number, on = tid) => ({ name: 'ThreadControllerImpl::RunTask', ph: 'X', ts, dur, tdur, pid, tid: on });
  const tasks = tasksOn(
    [
      task(0, 120_000, 60_000),
      { name: 'FunctionCall', ph: 'X', ts: 1_000, dur: 50_000, tdur: 40_000, pid, tid },
      { name: 'Layout', ph: 'X', ts: 10_000, dur: 10_000, tdur: 10_000, pid, tid },
      { name: 'Paint', ph: 'X', ts: 60_000, dur: 5_000, tdur: 5_000, pid, tid },
      // Another thread's task, and one under 1 ms: neither is this thread's work.
      task(0, 500_000, 500_000, 9),
      task(200_000, 900, 900),
    ],
    pid,
    tid,
  );
  assert.deepEqual(tasks, [{ startUs: 0, wallMs: 120, cpuMs: 60, parts: { script: 30, style: 0, layout: 10, paint: 5, gc: 0, decode: 0, other: 15 } }]);
});
