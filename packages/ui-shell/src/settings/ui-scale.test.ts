// @vitest-environment jsdom
/*
 * The UI scale: one number, written on the root our stylesheet's tokens resolve on, that every
 * length the app's own CSS authors is a multiple of.
 */
import { describe, expect, it } from 'vitest';

import { applyUiScale, clampUiScale, rememberedUiScale, rememberUiScale, scaleCssValue, scaleRootOf, UI_SCALE, uiScaleCss } from './ui-scale.ts';

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

/** A game's UI package's own sheet (`games/<game>/ui/src`). */
const OURS = { input: { file: '/repo/games/magic/ui/src/play/board.css' } };
/** A moved stylesheet, in a workspace package's own src/, not under apps/ui at all. */
const SHELL_OURS = { input: { file: '/repo/packages/ui-shell/src/chrome/chrome.css' } };
/** The site's own sheet. */
const SITE_OURS = { input: { file: '/repo/apps/ui/src/embed/embed.css' } };

describe('uiScaleCss', () => {
  it('rewrites a declaration in the app’s own stylesheet', () => {
    expect(at(run({ prop: 'gap', value: '4px', source: OURS }), 1.5)).toBe('6px');
  });

  it('rewrites a declaration moved into a workspace package’s own src/, same as an app’s own', () => {
    expect(at(run({ prop: 'gap', value: '4px', source: SHELL_OURS }), 1.5)).toBe('6px');
    expect(at(run({ prop: 'gap', value: '4px', source: SITE_OURS }), 1.5)).toBe('6px');
  });

  it('never rewrites the units themselves, an @property, an @font-face, or a sheet that is not ours', () => {
    const unit = 'calc(1px * var(--ui-scale))';
    expect(run({ prop: '--ui-px', value: unit, source: OURS })).toBe(unit);
    expect(run({ prop: 'initial-value', value: '0px', parent: { type: 'atrule', name: 'property' }, source: OURS })).toBe('0px');
    expect(run({ prop: 'initial-value', value: '2px', parent: { type: 'atrule', name: 'property' }, source: OURS })).toBe('2px');
    expect(run({ prop: 'size-adjust', value: '2px', parent: { type: 'rule', parent: { type: 'atrule', name: 'font-face' } }, source: OURS })).toBe('2px');
    expect(run({ prop: 'gap', value: '4px', source: { input: { file: '/repo/node_modules/@wolffm/themes/dist/style.css' } } })).toBe('4px');
    // A workspace package's own CSS resolved THROUGH node_modules (the symlink) still reads as vendor.
    expect(run({ prop: 'gap', value: '4px', source: { input: { file: '/repo/apps/ui/node_modules/@wolffm/themes/dist/style.css' } } })).toBe('4px');
  });

  // The operator, 2026-10-23: a flyer "repositions in a random direction" every 1.4 s in Firefox.
  it('refuses a keyframe that animates a custom property as a length, which Firefox would snap', () => {
    const keyframe = { type: 'rule', parent: { type: 'atrule', name: 'keyframes' } };
    expect(() => run({ prop: '--fly-x', value: '3.5px', parent: keyframe, source: OURS })).toThrow(/animate a number/);
    expect(run({ prop: '--fly-x', value: '3.5', parent: keyframe, source: OURS }), 'a number is left as it is').toBe('3.5');
    expect(at(run({ prop: 'translate', value: '3.5px 0', parent: keyframe, source: OURS }), 2), 'a property that is not custom still scales').toBe('7px 0');
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

  it('is remembered per browser under appId:ui-scale — the unit setup configures appId "cardtable",'
    + ' so the literal key written is byte-identical to before this moved', () => {
    localStorage.clear();
    expect(rememberedUiScale()).toBeNull();
    rememberUiScale(1.1);
    // The literal storage key, pinned: a player's saved scale must not be lost on this move.
    expect(localStorage.getItem('cardtable:ui-scale')).toBe('1.1');
    expect(rememberedUiScale()).toBe(1.1);
    rememberUiScale(UI_SCALE.max + 1);
    expect(rememberedUiScale()).toBe(UI_SCALE.max);
    localStorage.setItem('cardtable:ui-scale', 'big');
    expect(rememberedUiScale()).toBeNull();
    localStorage.clear();
  });
});
