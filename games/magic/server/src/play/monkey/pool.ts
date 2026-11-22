/*
 * The monkey's run queue: at most `concurrency` tasks at once, taken in order, and no new one
 * taken once a finished task says the run must stop, or once `timeUp` says the run's time is
 * spent — the matches already playing finish, and the rest are never started.
 */

/**
 * How long a finished game stays on its JVM, for the monkey's and the sweep's stacks alike. Play's
 * own ten minutes is a returning player's window to see how the game ended; a run that finishes a
 * match every few seconds and never looks back kept dozens of finished games live, a new JVM opened
 * every 25 of them, and the job outgrew its runner: the sweep at hokon's 8 GB cap, the monkey at a
 * claw's 6.2 GiB after 34 matches (2026-11-22, three JVMs of 0.8, 2.6 and 1.3 GB).
 */
export const RUN_STACK_ENV: Readonly<Record<string, string>> = { CARDTABLE_PLAY_OVER_GRACE_MS: '10000' };

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
