/*
 * The exit watch in a real Node process: it never holds the process itself (unref'd), and a run
 * something else holds open is named and failed, never exited.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WATCH = fileURLToPath(new URL('./exit-watch.ts', import.meta.url));

/** Runs `body` in a fresh Node with `watchExit` imported; resolves with its exit code and stderr, killing it after `killMs`. */
function run(body: string, killMs: number): Promise<{ code: number | null; killed: boolean; stderr: string }> {
  const script = `import { watchExit } from ${JSON.stringify(WATCH)};\n${body}`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, GITHUB_ACTIONS: '' },
      timeout: killMs,
      killSignal: 'SIGKILL',
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code, signal) => resolve({ code, killed: signal === 'SIGKILL', stderr }));
  });
}

describe('watchExit', { timeout: 30_000 }, () => {
  it('holds nothing: a run with nothing left open exits at once, well before the watch is due', async () => {
    const t0 = Date.now();
    const r = await run('watchExit(30_000);', 20_000);
    expect(r.killed, r.stderr).toBe(false);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('names what holds a run open and fails it, without exiting it', async () => {
    const r = await run("new BroadcastChannel('held');\nwatchExit(300);", 2_000);
    expect(r.stderr).toMatch(/\[monkey\] still running 0 s after the stack stopped; open: .*MessagePort/);
    expect(r.killed, 'the watch never exits the process itself').toBe(true);
  });

  it('sets exit code 2 when it fires', async () => {
    const r = await run("const bc = new BroadcastChannel('held');\nwatchExit(200);\nsetTimeout(() => { bc.close(); }, 600);", 5_000);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('still running');
  });
});
