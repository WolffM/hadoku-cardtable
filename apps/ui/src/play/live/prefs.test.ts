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

import { describe, expect, it } from 'vitest';

import { PLAY_PREFS_DEFAULTS, PlayPrefsSchema } from './prefs.ts';

describe('PlayPrefsSchema', () => {
  it('accepts a full, valid blob', () => {
    const result = PlayPrefsSchema.safeParse({ boardLayout: 'single', stopAtEndStep: true });
    expect(result.success).toBe(true);
  });

  it('accepts the other board layout too', () => {
    expect(PlayPrefsSchema.safeParse({ boardLayout: 'type-separated', stopAtEndStep: false }).success).toBe(true);
  });

  it('accepts an empty blob — both fields are optional, a fresh viewer has neither', () => {
    expect(PlayPrefsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a boardLayout that is not one of the two layouts', () => {
    const result = PlayPrefsSchema.safeParse({ boardLayout: 'three-column' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean stopAtEndStep', () => {
    expect(PlayPrefsSchema.safeParse({ stopAtEndStep: 'on' }).success).toBe(false);
  });

  it('rejects an unknown field — .strict(), like every other schema in this lane', () => {
    expect(PlayPrefsSchema.safeParse({ boardLayout: 'single', theme: 'dark' }).success).toBe(false);
  });
});

describe('PLAY_PREFS_DEFAULTS', () => {
  it('matches Board’s own default (item 11: single) and item 2/6’s default (off)', () => {
    expect(PLAY_PREFS_DEFAULTS).toEqual({ boardLayout: 'single', stopAtEndStep: false });
  });

  it('parses through its own schema — the defaults are themselves valid prefs', () => {
    expect(PlayPrefsSchema.safeParse(PLAY_PREFS_DEFAULTS).success).toBe(true);
  });
});
