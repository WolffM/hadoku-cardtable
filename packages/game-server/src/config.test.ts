/*
 * `CONFIG.testNoRateLimits`/`testPeopleStandIn` — the platform's own e2e escape hatches (w119 §C:
 * Magic's own, `testUncheckedPools`/`catalogRefresh`/`tournamentsFile`/`draftsDir` and the rest,
 * moved to `games/magic/server/src/config.test.ts` alongside `MAGIC_CONFIG`).
 */

import { describe, expect, it, vi } from 'vitest';

describe('CONFIG.dataDir', () => {
  const VARS = ['CARDTABLE_LOG_DIR', 'CARDTABLE_ROOMS_DIR'] as const;

  it('sits beside the log directory, and each store under it unless its own variable says otherwise', async () => {
    const saved = VARS.map((name) => process.env[name]);
    process.env.CARDTABLE_LOG_DIR = '/srv/ct/logs';
    process.env.CARDTABLE_ROOMS_DIR = '/elsewhere/rooms';
    vi.resetModules();
    try {
      const { CONFIG } = await import('./config.ts');
      expect(CONFIG.dataDir).toBe('/srv/ct/data');
      expect(CONFIG.roomsDir).toBe('/elsewhere/rooms');
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

describe('CONFIG.testPeopleStandIn', () => {
  it('is false from a bare environment and true only from the exact flag', async () => {
    const saved = process.env.CARDTABLE_E2E_PEOPLE_STAND_IN;
    try {
      for (const [value, expected] of [[undefined, false], ['true', false], ['1', true]] as const) {
        vi.resetModules();
        if (value === undefined) delete process.env.CARDTABLE_E2E_PEOPLE_STAND_IN;
        else process.env.CARDTABLE_E2E_PEOPLE_STAND_IN = value;
        const { CONFIG } = await import('./config.ts');
        expect(CONFIG.testPeopleStandIn, String(value)).toBe(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.CARDTABLE_E2E_PEOPLE_STAND_IN;
      else process.env.CARDTABLE_E2E_PEOPLE_STAND_IN = saved;
    }
  });
});

/*
 * `createConfig` is a factory (w119 §C): two configs, different prefixes, in one process, each
 * reading its OWN env var namespace. This is what lets a second game on `@hadoku/game-server`
 * (bomberman) set `BOMBERMAN_*` variables without cardtable's `CARDTABLE_*` ones colliding with
 * them, and without either one touching the other's `process.env` keys.
 */
describe('createConfig: two configs, two prefixes, one process', () => {
  it('builds independent configs from independent env objects with no module-level caching', async () => {
    const { createConfig } = await import('./config.ts');
    const alpha = createConfig({ envPrefix: 'ALPHA', env: { ALPHA_PORT: '7001', ALPHA_MIN_TIER: 'member' } });
    const beta = createConfig({ envPrefix: 'BETA', env: { BETA_PORT: '7002', BETA_MIN_TIER: 'friend' } });
    expect(alpha.port).toBe(7001);
    expect(alpha.minTier).toBe('member');
    expect(beta.port).toBe(7002);
    expect(beta.minTier).toBe('friend');
    // Neither config read the other's env object at all: a BETA_* value set alongside ALPHA's own
    // env has no effect on `alpha`, and vice versa.
    const alphaAgain = createConfig({ envPrefix: 'ALPHA', env: { ALPHA_PORT: '7001', ALPHA_MIN_TIER: 'member', BETA_PORT: '9999' } });
    expect(alphaAgain.port).toBe(7001);
  });

  it('fails closed on a floor this build does not know, independent of any other config in the process', async () => {
    const { createConfig } = await import('./config.ts');
    expect(() => createConfig({ envPrefix: 'ALPHA', env: { ALPHA_MIN_TIER: 'visitor' } })).toThrow('ALPHA_MIN_TIER=visitor is not a tier floor this build knows');
    // A sibling config with a valid floor still builds fine in the same process.
    expect(createConfig({ envPrefix: 'BETA', env: { BETA_MIN_TIER: 'friend' } }).minTier).toBe('friend');
  });
});

describe('createConfig: a game’s own root, defaults and floor', () => {
  it('reads a game’s defaults for what the env leaves unset, resolving its dirs under its own root', async () => {
    const { createConfig } = await import('./config.ts');
    const config = createConfig({ envPrefix: 'GAME', root: '/srv/game/apps/server', defaults: { PORT: '9123', BASE_PREFIX: '/game', STATE_DIR: 'state' }, env: { GAME_PORT: '9200' } });
    expect(config.port).toBe(9200);
    expect(config.basePrefix).toBe('/game');
    expect(config.roomsDir).toBe('/srv/game/apps/server/state/rooms');
    expect(config.callersSeenFile).toBe('/srv/game/apps/server/state/callers-seen.json');
  });

  it('refuses a public floor unless the game says it is public', async () => {
    const { createConfig } = await import('./config.ts');
    expect(() => createConfig({ envPrefix: 'GAME', env: { GAME_MIN_TIER: 'public' } })).toThrow('GAME_MIN_TIER=public');
    expect(createConfig({ envPrefix: 'GAME', allowPublic: true, env: { GAME_MIN_TIER: 'public' } }).minTier).toBe('public');
  });
});
