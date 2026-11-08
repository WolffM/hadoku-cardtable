/**
 * What a finished monkey run does if its process does not exit: names what holds it.
 *
 * A run that has written its report and stopped its stack should leave nothing behind. Run
 * 42473988206 left a BroadcastChannel open (the page's tab id, `tab-id.ts`) and sat out the job's
 * 30 min timeout with no line saying why. This waits `ms`, unref'd so it never holds the process
 * itself, then logs the resources still open and fails the run (exit code 2). It never exits the
 * process: a forced exit would hide the leak it is there to name.
 */
export function watchExit(ms: number, log: (line: string) => void = (line) => console.error(line)): NodeJS.Timeout {
  const timer = setTimeout(() => {
    log(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}[monkey] still running ${Math.round(ms / 1000)} s after the stack stopped; open: ${process.getActiveResourcesInfo().join(', ')}`);
    process.exitCode = 2;
  }, ms);
  timer.unref();
  return timer;
}
