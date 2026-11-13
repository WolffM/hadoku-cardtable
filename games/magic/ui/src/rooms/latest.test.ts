import { describe, expect, it } from 'vitest';

import { latestReads } from './latest.ts';

describe('latestReads', () => {
  it('keeps the latest read, and drops an older one that answers after it', () => {
    const reads = latestReads();
    const older = reads.read();
    const newer = reads.read();
    expect(newer()).toBe('keep');
    expect(older()).toBe('drop');
  });

  it('keeps a read that answers before a newer one is sent', () => {
    const reads = latestReads();
    expect(reads.read()()).toBe('keep');
    expect(reads.read()()).toBe('keep');
  });

  it('asks again for a read sent before a write landed, which may hold the state from before it', () => {
    const reads = latestReads();
    const landed = reads.read();
    reads.wrote();
    expect(landed()).toBe('reread');
    const again = reads.read();
    expect(again()).toBe('keep');
    expect(landed(), 'the read asked again supersedes it').toBe('drop');
  });
});
