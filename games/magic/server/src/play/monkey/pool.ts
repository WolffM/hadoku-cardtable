/*
 * The monkey's run queue: at most `concurrency` tasks at once, taken in order, and no new one
 * taken once a finished task says the run must stop, or once `timeUp` says the run's time is
 * spent — the matches already playing finish, and the rest are never started.
 */

export interface PoolOutcome<T> {
  /** Every task that ran, in task order. */
  results: T[];
  /** Why the run stopped early, or null when every task ran. */
  stopped: string | null;
  /** Whether tasks were left unstarted because `timeUp` said the run's time was spent. */
  outOfTime: boolean;
}

export async function runPool<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
  stopFor: (result: T) => string | null,
  timeUp: () => boolean = () => false,
): Promise<PoolOutcome<T>> {
  const results: { index: number; result: T }[] = [];
  let next = 0;
  let stopped: string | null = null;
  let outOfTime = false;
  async function worker(): Promise<void> {
    while (stopped === null && next < tasks.length) {
      if (timeUp()) {
        outOfTime = true;
        return;
      }
      const index = next;
      next += 1;
      const result = await tasks[index]!();
      results.push({ index, result });
      stopped ??= stopFor(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, worker));
  return { results: results.sort((a, b) => a.index - b.index).map((r) => r.result), stopped, outOfTime };
}
