/*
 * `MAGIC_CONFIG.testUncheckedPools` — CI fix-forward (run 39715510788): the
 * jar-less e2e stack's own escape hatch from `room/plan.ts`'s "no jar never
 * passes by default" rule. Pinned here, at the config boundary, the same
 * place the platform's `allowUnverifiedEdge` dev hatch is read (w119 §C:
 * moved out of `packages/game-server/src/config.test.ts` with the rest of
 * Magic's own settings).
 */

import { describe, expect, it, vi } from 'vitest';

describe('MAGIC_CONFIG.testUncheckedPools', () => {
  it('is false from a bare environment — nothing in this repo\'s own deploy path ever sets it', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
    delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.testUncheckedPools).toBe(false);
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
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.testUncheckedPools).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
      else process.env.CARDTABLE_E2E_UNCHECKED_POOLS = saved;
    }

    vi.resetModules();
    process.env.CARDTABLE_E2E_UNCHECKED_POOLS = '1';
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.testUncheckedPools).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_UNCHECKED_POOLS;
      else process.env.CARDTABLE_E2E_UNCHECKED_POOLS = saved;
    }
  });
});

/*
 * `MAGIC_CONFIG.catalogRefresh` — on by default (production needs no cross-repo
 * change), off only at `'0'`. Every non-production server (CI's forge-e2e,
 * a dev/e2e boot, a lane's manual smoke-boot) sets `CARDTABLE_CATALOG_REFRESH=0`
 * so it never starts `createCatalogRefresh` against the shared Scryfall cache.
 */
describe('MAGIC_CONFIG.catalogRefresh', () => {
  it('is true from a bare environment — production sets nothing and still gets the job', async () => {
    vi.resetModules();
    const saved = process.env.CARDTABLE_CATALOG_REFRESH;
    delete process.env.CARDTABLE_CATALOG_REFRESH;
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.catalogRefresh).toBe(true);
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
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.catalogRefresh).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_CATALOG_REFRESH;
      else process.env.CARDTABLE_CATALOG_REFRESH = saved;
    }

    vi.resetModules();
    process.env.CARDTABLE_CATALOG_REFRESH = '0';
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.catalogRefresh).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_CATALOG_REFRESH;
      else process.env.CARDTABLE_CATALOG_REFRESH = saved;
    }
  });
});

/*
 * Every Magic-only directory sits under the PLATFORM data dir — `createMagicConfig`'s default
 * `dataDir` comes from the platform `createConfig`'s own `dataDir` for the same env/prefix, so
 * `CARDTABLE_STATE_DIR` still moves `draftsDir`/`tournamentsFile`/`recordingsDir` along with
 * `roomsDir` (proved on the platform side, `packages/game-server/src/kernel.test.ts`).
 */
describe('MAGIC_CONFIG.dataDir-derived paths', () => {
  it('sit under CARDTABLE_STATE_DIR when it is set, and each under dataDir otherwise', async () => {
    const saved = { state: process.env.CARDTABLE_STATE_DIR, drafts: process.env.CARDTABLE_DRAFTS_DIR };
    process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
    delete process.env.CARDTABLE_DRAFTS_DIR;
    vi.resetModules();
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.draftsDir).toBe('/srv-data/cardtable/drafts');
      expect(MAGIC_CONFIG.tournamentsFile).toBe('/srv-data/cardtable/tournaments.json');
      expect(MAGIC_CONFIG.recordingsDir).toBe('/srv-data/cardtable/recordings');
    } finally {
      if (saved.state === undefined) delete process.env.CARDTABLE_STATE_DIR;
      else process.env.CARDTABLE_STATE_DIR = saved.state;
      if (saved.drafts === undefined) delete process.env.CARDTABLE_DRAFTS_DIR;
      else process.env.CARDTABLE_DRAFTS_DIR = saved.drafts;
    }
  });

  it('an explicit CARDTABLE_DRAFTS_DIR still wins over the state dir', async () => {
    const saved = { state: process.env.CARDTABLE_STATE_DIR, drafts: process.env.CARDTABLE_DRAFTS_DIR };
    process.env.CARDTABLE_STATE_DIR = '/srv-data/cardtable';
    process.env.CARDTABLE_DRAFTS_DIR = '/elsewhere/drafts';
    vi.resetModules();
    try {
      const { MAGIC_CONFIG } = await import('./config.ts');
      expect(MAGIC_CONFIG.draftsDir).toBe('/elsewhere/drafts');
    } finally {
      if (saved.state === undefined) delete process.env.CARDTABLE_STATE_DIR;
      else process.env.CARDTABLE_STATE_DIR = saved.state;
      if (saved.drafts === undefined) delete process.env.CARDTABLE_DRAFTS_DIR;
      else process.env.CARDTABLE_DRAFTS_DIR = saved.drafts;
    }
  });
});

describe('createMagicConfig: two configs, two prefixes, one process', () => {
  it('builds independent configs — bomberman never reads a CARDTABLE_* name', async () => {
    const { createMagicConfig } = await import('./config.ts');
    const cardtable = createMagicConfig({ envPrefix: 'CARDTABLE', env: { CARDTABLE_DRAFT_BOT_PICK_MS: '1500' }, dataDir: '/ct-data' });
    const other = createMagicConfig({ envPrefix: 'OTHERGAME', env: { OTHERGAME_DRAFT_BOT_PICK_MS: '400' }, dataDir: '/other-data' });
    expect(cardtable.draftBotPickMs).toBe(1500);
    expect(cardtable.draftsDir).toBe('/ct-data/drafts');
    expect(other.draftBotPickMs).toBe(400);
    expect(other.draftsDir).toBe('/other-data/drafts');
  });
});

/*
 * The two match graces a test stack may shorten (the card sweep sets the second) (`CARDTABLE_PLAY_REJOIN_GRACE_MS`,
 * `CARDTABLE_PLAY_OVER_GRACE_MS`). Unset leaves play's own defaults, which is all production gets.
 */
describe('createMagicConfig: the match graces', () => {
  it('leaves both to play when unset, and reads each in milliseconds when set', async () => {
    const { createMagicConfig } = await import('./config.ts');
    const bare = createMagicConfig({ env: {}, dataDir: '/d' });
    expect(bare.playRejoinGraceMs).toBeUndefined();
    expect(bare.playOverGraceMs).toBeUndefined();
    const short = createMagicConfig({ env: { CARDTABLE_PLAY_REJOIN_GRACE_MS: '2000', CARDTABLE_PLAY_OVER_GRACE_MS: '1500' }, dataDir: '/d' });
    expect(short.playRejoinGraceMs).toBe(2000);
    expect(short.playOverGraceMs).toBe(1500);
  });
});
