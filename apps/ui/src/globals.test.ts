/**
 * Every build-time global the source declares is defined by every build that
 * ships it. The embed build once lacked `__HADOKU_UI_VERSION__`: the bare name
 * reached watchparty's page, LiveBoard's mount effect threw a ReferenceError,
 * and the match screen unmounted 100 ms after joining. Unit tests could not see
 * it — they run under the root vitest config, which did define it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import appConfig from '../vite.config.ts';
import embedConfig from '../vite.embed.config.ts';
import { BUILD_DEFINES } from '../build-defines.ts';

const declared = [...readFileSync(new URL('./globals.d.ts', import.meta.url), 'utf8').matchAll(/^declare const (\w+)\b/gm)].map((m) => m[1]).sort();

describe('build-time globals', () => {
  it('globals.d.ts declares exactly the names build-defines.ts defines', () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(BUILD_DEFINES).sort()).toEqual(declared);
  });

  it.each([
    ['the app build', appConfig],
    ['the embed build', embedConfig],
  ])('%s defines every declared global', (_name, config) => {
    expect(Object.keys(config.define ?? {}).sort()).toEqual(declared);
  });

  it('each define is a JSON string literal', () => {
    for (const value of Object.values(BUILD_DEFINES)) expect(typeof JSON.parse(value)).toBe('string');
  });
});
