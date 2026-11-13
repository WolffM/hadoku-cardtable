import { describe, expect, it } from 'vitest';

import { runPool } from './pool.ts';

/** Yields to the other workers, so their tasks overlap this one's. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('runPool', () => {
  it('runs every task, never more than `concurrency` at once, and keeps task order', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      return i;
    });
    const out = await runPool(tasks, 3, () => null);
    expect(out).toEqual({ results: [0, 1, 2, 3, 4, 5, 6], stopped: null, outOfTime: false });
    expect(peak).toBe(3);
  });

  it('takes no new task once one says stop: the ones already running finish, the rest never start', async () => {
    const started: number[] = [];
    const tasks = Array.from({ length: 50 }, (_, i) => async () => {
      started.push(i);
      await tick();
      return i === 4 ? 'refused' : 'played';
    });
    const out = await runPool(tasks, 3, (r) => (r === 'refused' ? 'the server is full' : null));
    expect(out.stopped).toBe('the server is full');
    // Tasks 0..4 had started when 4 answered, plus at most the two workers' next picks before it did.
    expect(started.length).toBeLessThanOrEqual(7);
    expect(out.results).toHaveLength(started.length);
    expect(out.results).toContain('refused');
  });

  it('takes no new task once its time is spent: the ones already running finish and the report says so', async () => {
    let spent = false;
    const started: number[] = [];
    const tasks = Array.from({ length: 50 }, (_, i) => async () => {
      started.push(i);
      await tick();
      if (i === 4) spent = true;
      return i;
    });
    const out = await runPool(tasks, 3, () => null, () => spent);
    expect(out.outOfTime).toBe(true);
    expect(out.stopped).toBeNull();
    expect(started.length).toBeLessThanOrEqual(7);
    expect(out.results).toEqual(started.slice().sort((a, b) => a - b));
  });
});
