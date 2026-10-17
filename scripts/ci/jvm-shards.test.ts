import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_SHARDS, SHARD_SECONDS, assign, loadSeconds, shardCount } from './jvm-shards.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const tracked = execFileSync('git', ['ls-files', '*.jvm.test.ts'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const seconds = loadSeconds();
const sum = (fs: string[], s: Record<string, number>) => fs.reduce((a, f) => a + s[f], 0);

describe('jvm-shards', () => {
  it('puts every tracked suite in exactly one shard of the full run', () => {
    const n = shardCount(tracked, seconds);
    const split = assign(tracked, seconds, n);
    expect(split.flat().sort()).toEqual([...tracked].sort());
    expect(split.every((s) => s.length > 0)).toBe(true);
  });

  it('keeps each shard of the measured full run within its budget', () => {
    const files = Object.keys(seconds);
    const split = assign(files, seconds, shardCount(files, seconds));
    expect(split).toHaveLength(MAX_SHARDS);
    for (const s of split) expect(sum(s, seconds)).toBeLessThanOrEqual(SHARD_SECONDS);
  });

  it('balances by seconds, not by file count', () => {
    const s = { 'big.jvm.test.ts': 300, 'a.jvm.test.ts': 100, 'b.jvm.test.ts': 100, 'c.jvm.test.ts': 100 };
    expect(assign(Object.keys(s), s, 2)).toEqual([['big.jvm.test.ts'], ['a.jvm.test.ts', 'b.jvm.test.ts', 'c.jvm.test.ts']]);
  });

  it('gives a short selection one shard and never more shards than suites', () => {
    const s = { 'x.jvm.test.ts': 2000, 'y.jvm.test.ts': 10 };
    expect(shardCount(['y.jvm.test.ts'], s)).toBe(1);
    expect(shardCount(['x.jvm.test.ts'], s)).toBe(1);
    expect(shardCount(['x.jvm.test.ts', 'y.jvm.test.ts'], s)).toBe(2);
    expect(() => assign(['y.jvm.test.ts'], s, 2)).toThrow();
  });

  it('weighs a suite missing from the table at the median, and counts a repeated path once', () => {
    const s = { 'a.jvm.test.ts': 10, 'b.jvm.test.ts': 20, 'c.jvm.test.ts': 30 };
    const split = assign(['new.jvm.test.ts', 'a.jvm.test.ts', 'a.jvm.test.ts', 'c.jvm.test.ts'], s, 2);
    expect(split).toEqual([['c.jvm.test.ts'], ['a.jvm.test.ts', 'new.jvm.test.ts']]);
  });

  it('splits the same files the same way whatever order they arrive in', () => {
    const n = shardCount(tracked, seconds);
    expect(assign([...tracked].reverse(), seconds, n)).toEqual(assign(tracked, seconds, n));
  });
});
