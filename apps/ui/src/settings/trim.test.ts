// @vitest-environment jsdom
/*
 * Trim's catalogue and its stylesheet are one list in two languages: every option the composer
 * offers has its rule in `chrome/trim.css`, and the sheet styles no option the composer cannot
 * choose. The attributes are written and removed as the saved trim changes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { applyTrim, TRIM_FAMILIES, TRIM_FAMILY_IDS, trimAttribute } from './trim.ts';

const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../chrome/trim.css'), 'utf8');

describe('trim', () => {
  it('names each family’s attribute in kebab case', () => {
    expect(trimAttribute('frame')).toBe('data-trim-frame');
    expect(trimAttribute('groundCorner')).toBe('data-trim-ground-corner');
  });

  it('has a rule for every option and no rule for an option the composer cannot choose', () => {
    const offered = TRIM_FAMILY_IDS.flatMap((f) => Object.keys(TRIM_FAMILIES[f].options).map((o) => `${trimAttribute(f)}='${o}'`)).sort();
    const styled = [...new Set([...SHEET.matchAll(/\[(data-trim-[a-z-]+='[a-z-]+')\]/g)].map((m) => m[1]!))].sort();
    expect(styled).toEqual(offered);
  });

  it('never cuts a panel that holds a popover: a cut clips everything inside it, a dialog included', () => {
    for (const shape of ['chamfer', 'hud', 'step', 'scoop']) {
      expect(SHEET, shape).toContain(`[data-trim-frame='${shape}'] .ct-panel:not(:has(.ct-surface)) {`);
      expect(SHEET, shape).not.toContain(`[data-trim-frame='${shape}'] .ct-panel {`);
    }
  });

  it('writes one attribute per chosen family and removes the rest', () => {
    const el = document.createElement('main');
    applyTrim(el, { frame: 'hud', groundCorner: 'gems' });
    expect([el.getAttribute('data-trim-frame'), el.getAttribute('data-trim-ground-corner')]).toEqual(['hud', 'gems']);
    applyTrim(el, { texture: 'linen' });
    expect([...el.attributes].map((a) => `${a.name}=${a.value}`)).toEqual(['data-trim-texture=linen']);
  });
});
