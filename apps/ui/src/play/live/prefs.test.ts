/*
 * The settings panel's persisted shape (item 6, wave 30) — proved without a
 * `PrefsClient` involved at all, because the cross-zod-instance cast
 * `getPlayPrefsClient` needs (see that function's own doc comment) puts the
 * SCHEMA itself, not the client, in the one place a test can still say
 * something real: `PlayPrefsSchema` is a genuine zod v4 object built from
 * `@hadoku/forge-wire` / `@hadoku/shared`'s own schema instances, and it
 * parses and rejects exactly what it should — the cast that follows only
 * changes what TYPESCRIPT believes about the same running values.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FAST_MODE_DEFAULT_GLOBAL, PLAY_PREFS_DEFAULTS, PlayPrefsSchema, dropPersonalTrim, dropRetiredStopAtEndStep } from './prefs.ts';

describe('PlayPrefsSchema', () => {
  it('accepts a full, valid blob', () => {
    const result = PlayPrefsSchema.safeParse({ boardLayout: 'single', endStepStop: true, fastMode: true });
    expect(result.success).toBe(true);
  });

  it('accepts the other board layout too', () => {
    expect(PlayPrefsSchema.safeParse({ boardLayout: 'type-separated', endStepStop: false }).success).toBe(true);
  });

  it('accepts an empty blob — every field is optional, a fresh viewer has none', () => {
    expect(PlayPrefsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a boardLayout that is not one of the two layouts', () => {
    const result = PlayPrefsSchema.safeParse({ boardLayout: 'three-column' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean endStepStop', () => {
    expect(PlayPrefsSchema.safeParse({ endStepStop: 'on' }).success).toBe(false);
  });

  it('a blob saved with the retired stopAtEndStep parses once migrated, its other fields kept and the End step stop at its default', () => {
    const saved = { boardLayout: 'type-separated', stopAtEndStep: false, fastMode: true };
    expect(PlayPrefsSchema.safeParse(saved).success).toBe(false);
    const migrated = PlayPrefsSchema.safeParse({ ...PLAY_PREFS_DEFAULTS, ...dropRetiredStopAtEndStep(saved) });
    expect(migrated.success && migrated.data).toEqual({ boardLayout: 'type-separated', endStepStop: true, fastMode: true, uiScale: 1, packLayout: 'fan' });
  });

  it('holds a draft pack’s fan or grid, and nothing else', () => {
    expect(PlayPrefsSchema.safeParse({ packLayout: 'grid' }).success).toBe(true);
    expect(PlayPrefsSchema.safeParse({ packLayout: 'fan' }).success).toBe(true);
    expect(PlayPrefsSchema.safeParse({ packLayout: 'list' }).success).toBe(false);
  });

  it('rejects a non-boolean fastMode', () => {
    expect(PlayPrefsSchema.safeParse({ fastMode: 'on' }).success).toBe(false);
  });

  it('a blob saved with the retired personal trim parses once migrated, everything else kept', () => {
    const saved = { fastMode: true, trim: { frame: 'scoop' } };
    expect(PlayPrefsSchema.safeParse(saved).success, 'strict: the old field alone fails the parse').toBe(false);
    expect(PlayPrefsSchema.safeParse(dropPersonalTrim(saved))).toEqual({ success: true, data: { fastMode: true } });
  });

  it('rejects an unknown field — .strict(), like every other schema in this lane', () => {
    expect(PlayPrefsSchema.safeParse({ boardLayout: 'single', theme: 'dark' }).success).toBe(false);
  });
});

describe('PLAY_PREFS_DEFAULTS', () => {
  it('matches Board’s own default (item 11: single), the End step stop’s (on), Fast Mode’s (off — paced), and a draft pack fanned', () => {
    expect(PLAY_PREFS_DEFAULTS).toEqual({ boardLayout: 'single', endStepStop: true, fastMode: false, uiScale: 1, packLayout: 'fan' });
  });

  it('parses through its own schema — the defaults are themselves valid prefs', () => {
    expect(PlayPrefsSchema.safeParse(PLAY_PREFS_DEFAULTS).success).toBe(true);
  });
});

describe('FAST_MODE_DEFAULT_GLOBAL — the e2e override seam', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[FAST_MODE_DEFAULT_GLOBAL];
    vi.resetModules();
  });

  it('is the exact key e2e/play/browser.ts sets', () => {
    expect(FAST_MODE_DEFAULT_GLOBAL).toBe('__CARDTABLE_FAST_MODE_DEFAULT__');
  });

  it('flips PLAY_PREFS_DEFAULTS.fastMode to true when set before the module evaluates — a FRESH module, the way a bundle loaded after an init script sees it, not this already-loaded one', async () => {
    (globalThis as Record<string, unknown>)[FAST_MODE_DEFAULT_GLOBAL] = true;
    vi.resetModules();
    const fresh = await import('./prefs.ts');
    expect(fresh.PLAY_PREFS_DEFAULTS.fastMode).toBe(true);
  });

  it('a non-true value (string "true", 1, …) does not count — only the literal boolean', async () => {
    (globalThis as Record<string, unknown>)[FAST_MODE_DEFAULT_GLOBAL] = 'true';
    vi.resetModules();
    const fresh = await import('./prefs.ts');
    expect(fresh.PLAY_PREFS_DEFAULTS.fastMode).toBe(false);
  });
});
