// @vitest-environment jsdom
/*
 * The UI scale: one number, written on the root our stylesheet's tokens resolve on, that every
 * length the app's own CSS authors is a multiple of.
 */
import { describe, expect, it } from 'vitest';

import { PlayPrefsSchema } from '../play/live/prefs.ts';
import { applyUiScale, clampUiScale, scaleCssValue, scaleRootOf, UI_SCALE, uiScaleCss } from './ui-scale.ts';

/** What a rewritten value draws at `scale`: each scaled length resolved to px, everything else as it was. */
function at(value: string, scale: number): string {
  return value.replace(/calc\((-?[\d.]+) \* var\(--ui-(px|rem)\)\)/g, (_, n: string, unit: string) => `${+(Number(n) * scale * (unit === 'rem' ? 16 : 1)).toFixed(4)}px`);
}

describe('scaleCssValue', () => {
  it('makes every px and rem length a multiple of the scale', () => {
    expect(at(scaleCssValue('4px'), 1.25)).toBe('5px');
    expect(at(scaleCssValue('4px auto'), 0.8)).toBe('3.2px auto');
    expect(at(scaleCssValue('-0.5rem'), 1.25)).toBe('-10px');
    expect(at(scaleCssValue('0 1px 2px .5px'), 1.2)).toBe('0 1.2px 2.4px 0.6px');
    expect(at(scaleCssValue('4px'), 1)).toBe('4px');
    expect(at(scaleCssValue('min(100% - 2.25rem, 30px)'), 2)).toBe('min(100% - 72px, 60px)');
  });

  it('leaves everything else alone: zero, other units, names, strings and urls', () => {
    for (const v of ['0', '0px', '50%', '2em', '10vh', '100cqh', 'var(--gap-4px)', '"10px"', "url('a-4px.png')", 'url(b4px.svg)', '1.3934', '#a4px']) {
      expect(scaleCssValue(v), v).toBe(v);
    }
  });

  it('is idempotent: a rewritten value has nothing left to rewrite', () => {
    const once = scaleCssValue('1px solid var(--line) 2rem');
    expect(scaleCssValue(once)).toBe(once);
  });
});

interface FakeDecl {
  prop: string;
  value: string;
  parent?: { type: string; name?: string; parent?: unknown };
  source?: { input: { file?: string } };
}

function run(decl: FakeDecl): string {
  uiScaleCss.Declaration(decl);
  return decl.value;
}

const OURS = { input: { file: '/repo/apps/ui/src/play/board.css' } };

describe('uiScaleCss', () => {
  it('rewrites a declaration in the app’s own stylesheet', () => {
    expect(at(run({ prop: 'gap', value: '4px', source: OURS }), 1.5)).toBe('6px');
  });

  it('never rewrites the units themselves, an @property, an @font-face, or a sheet that is not ours', () => {
    const unit = 'calc(1px * var(--ui-scale))';
    expect(run({ prop: '--ui-px', value: unit, source: OURS })).toBe(unit);
    expect(run({ prop: 'initial-value', value: '0px', parent: { type: 'atrule', name: 'property' }, source: OURS })).toBe('0px');
    expect(run({ prop: 'initial-value', value: '2px', parent: { type: 'atrule', name: 'property' }, source: OURS })).toBe('2px');
    expect(run({ prop: 'size-adjust', value: '2px', parent: { type: 'rule', parent: { type: 'atrule', name: 'font-face' } }, source: OURS })).toBe('2px');
    expect(run({ prop: 'gap', value: '4px', source: { input: { file: '/repo/node_modules/@wolffm/themes/dist/style.css' } } })).toBe('4px');
  });
});

describe('the scale itself', () => {
  it('is clamped to its range and snapped to its step', () => {
    expect(clampUiScale(UI_SCALE.min - 1)).toBe(UI_SCALE.min);
    expect(clampUiScale(UI_SCALE.max + 1)).toBe(UI_SCALE.max);
    expect(clampUiScale(1.0499)).toBe(1.05);
    expect(clampUiScale(Number.NaN)).toBe(1);
    expect(UI_SCALE.min).toBeLessThan(1);
    expect(UI_SCALE.max).toBeGreaterThan(1);
  });

  it('is written on the document’s root, or on the shadow host when embedded, and removed at 1', () => {
    const inPage = document.createElement('div');
    document.body.append(inPage);
    expect(scaleRootOf(inPage)).toBe(document.documentElement);

    const host = document.createElement('div');
    document.body.append(host);
    const inside = document.createElement('div');
    host.attachShadow({ mode: 'open' }).append(inside);
    expect(scaleRootOf(inside)).toBe(host);

    applyUiScale(host, 1.2);
    expect(host.style.getPropertyValue('--ui-scale')).toBe('1.2');
    applyUiScale(host, 1);
    expect(host.style.getPropertyValue('--ui-scale')).toBe('');
  });

  it('is a saved preference within its range', () => {
    expect(PlayPrefsSchema.safeParse({ uiScale: 1.15 }).success).toBe(true);
    expect(PlayPrefsSchema.safeParse({ uiScale: UI_SCALE.max + 0.5 }).success).toBe(false);
    expect(PlayPrefsSchema.safeParse({ uiScale: 'big' }).success).toBe(false);
  });
});
