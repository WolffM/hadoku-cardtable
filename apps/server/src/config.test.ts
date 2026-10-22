/*
 * `CONFIG.testUncheckedPools` — CI fix-forward (run 39715510788): the
 * jar-less e2e stack's own escape hatch from `room/plan.ts`'s "no jar never
 * passes by default" rule. Pinned here, at the config boundary, the same
 * place `allowUnverifiedEdge`'s own dev hatch is read.
 */

import { describe, expect, it, vi } from 'vitest';

describe('CONFIG.testUncheckedPools', () => {
  it('is false from a bare environment — nothing in this repo\'s own deploy path ever sets it', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
    delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.testUncheckedPools).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
      else process.env.CARDTABLE_E2E_UNCHECKED_POOLS = saved;
    }
  });

  it('is true only when the exact flag is set, never from a near-miss value', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
    process.env.CARDTABLE_E2E_UNCHECKED_POOLS = 'true';
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.testUncheckedPools).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
      else process.env.CARDTABLE_E2E_UNCHECKED_POOLS = saved;
    }

    vi.resetModules();
    process.env.CARDTABLE_E2E_UNCHECKED_POOLS = '1';
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.testUncheckedPools).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
      else process.env.CARDTABLE_E2E_UNCHECKED_POOLS = saved;
    }
  });
});
