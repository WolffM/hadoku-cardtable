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

/*
 * `CONFIG.catalogRefresh` — on by default (production needs no cross-repo
 * change), off only at `'0'`. Every non-production server (CI's forge-e2e,
 * a dev/e2e boot, a lane's manual smoke-boot) sets `CARDTABLE_CATALOG_REFRESH=0`
 * so it never starts `createCatalogRefresh` against the shared Scryfall cache.
 */
describe('CONFIG.catalogRefresh', () => {
  it('is true from a bare environment — production sets nothing and still gets the job', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_CATALOG_REFRESH;
    delete process.env.CARDTABLE_CATALOG_REFRESH;
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.catalogRefresh).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_CATALOG_REFRESH;
      else process.env.CARDTABLE_CATALOG_REFRESH = saved;
    }
  });

  it('is false only at the exact value \'0\' — a near-miss leaves it on', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_CATALOG_REFRESH;
    process.env.CARDTABLE_CATALOG_REFRESH = 'false';
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.catalogRefresh).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_CATALOG_REFRESH;
      else process.env.CARDTABLE_CATALOG_REFRESH = saved;
    }

    vi.resetModules();
    process.env.CARDTABLE_CATALOG_REFRESH = '0';
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.catalogRefresh).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_CATALOG_REFRESH;
      else process.env.CARDTABLE_CATALOG_REFRESH = saved;
    }
  });
});

describe('CONFIG.dataDir', () => {
  const VARS = ['CARDTABLE_LOG_DIR', 'CARDTABLE_ROOMS_DIR', 'CARDTABLE_DRAFTS_DIR'] as const;

  it('sits beside the log directory, and each store under it unless its own variable says otherwise', async () => {
    const saved = VARS.map((name) => process.env[name]);
    process.env.CARDTABLE_LOG_DIR = '/srv/ct/logs';
    process.env.CARDTABLE_ROOMS_DIR = '/elsewhere/rooms';
    delete process.env.CARDTABLE_DRAFTS_DIR;
    vi.resetModules();
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.dataDir).toBe('/srv/ct/data');
      expect(CONFIG.roomsDir).toBe('/elsewhere/rooms');
      expect(CONFIG.draftsDir).toBe('/srv/ct/data/drafts');
      expect(CONFIG.tournamentsFile).toBe('/srv/ct/data/tournaments.json');
    } finally {
      VARS.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });
});

describe('CONFIG.testNoRateLimits', () => {
  it('is false from a bare environment and true only from the exact flag', async () => {
    const saved = process.env.CARDTABLE_E2E_NO_RATE_LIMITS;
    try {
      for (const [value, expected] of [[undefined, false], ['true', false], ['1', true]] as const) {
        vi.resetModules();
        if (value === undefined) delete process.env.CARDTABLE_E2E_NO_RATE_LIMITS;
        else process.env.CARDTABLE_E2E_NO_RATE_LIMITS = value;
        const { CONFIG } = await import('./config.ts');
        expect(CONFIG.testNoRateLimits, String(value)).toBe(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_NO_RATE_LIMITS;
      else process.env.CARDTABLE_E2E_NO_RATE_LIMITS = saved;
    }
  });
});
