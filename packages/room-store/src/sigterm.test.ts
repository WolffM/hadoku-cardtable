/*
 * P6 §5.5 / §4.4 — a deploy must flush.
 *
 * > On `SIGTERM`, the server flushes every dirty room synchronously before
 * > exiting, and the process does not exit until the flush completes or a
 * > bounded deadline passes.
 *
 * Testable directly, and tested directly: a real child process, a real
 * `kill -TERM`, and the snapshot on disk afterwards carrying the same `seq` the
 * room had in memory when the signal arrived. The debounce in the child is ten
 * minutes, so anything on disk is there because of the signal and nothing else.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRoomStore } from './fileStore.ts';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'sigtermChild.ts');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Ready {
  ready: true;
  seq: number;
  picks: number;
}

function runChild(dir: string, roomId: string) {
  return new Promise<{ ready: Ready; signal: NodeJS.Signals | null; code: number | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [CHILD, dir, roomId], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let ready: Ready | null = null;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child timed out. stdout=${out} stderr=${err}`));
      }, 20_000);

      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (ready === null && out.includes('\n')) {
          ready = JSON.parse(out.split('\n')[0] as string) as Ready;
          // Nothing has been written yet: the debounce is ten minutes out.
          expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);
          child.kill('SIGTERM');
        }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (ready === null) {
          reject(new Error(`child exited before it was ready. stdout=${out} stderr=${err}`));
          return;
        }
        resolve({ ready, signal, code });
      });
    },
  );
}

describe('§5.5 — SIGTERM flushes', () => {
  it('the persisted seq equals the in-memory seq at signal time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigterm-'));
    dirs.push(dir);

    const { ready, signal } = await runChild(dir, 'pod-1');
    expect(ready.seq).toBe(25);
    expect(ready.picks).toBe(25);
    // The handler re-raises rather than calling `process.exit`, so the process
    // still dies of the signal it was sent — a host with its own shutdown
    // sequence keeps it.
    expect(signal).toBe('SIGTERM');

    const snapshot = await new FileRoomStore(dir).load('pod-1');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.lastEventSeq).toBe(ready.seq);
    expect((snapshot?.app as { picks: string[] }).picks).toHaveLength(ready.picks);
  }, 30_000);

  it('the flushed snapshot is what the next boot restores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sigterm-'));
    dirs.push(dir);

    await runChild(dir, 'pod-2');
    const store = new FileRoomStore(dir);
    expect(await store.list()).toEqual(['pod-2']);
    const snapshot = await store.load('pod-2');
    expect((snapshot?.app as { picks: string[] }).picks[24]).toBe('pick-24');
  }, 30_000);
});
