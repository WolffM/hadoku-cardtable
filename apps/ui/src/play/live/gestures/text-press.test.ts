// @vitest-environment jsdom
/*
 * `./text-press.ts`: a selection may start only from a press on text. jsdom
 * has no caret hit-testing, so `caretRangeFromPoint` is stubbed with what a
 * browser answers; the real selection is `e2e/seat-marks.spec.ts`'s.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { guardTextSelection } from './text-press.ts';

type CaretDoc = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };

const rects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

function setup(): { canvas: HTMLElement; name: Text; field: HTMLElement; input: HTMLInputElement; undo: () => void } {
  document.body.innerHTML = '<div class="live"><div class="field"></div><h3 class="name">Alice</h3><input /></div>';
  const canvas = document.querySelector<HTMLElement>('.live')!;
  const name = document.querySelector('.name')!.firstChild as Text;
  // The name's glyphs occupy x 100–140; the browser's caret lands in that text node from anywhere nearby.
  (document as CaretDoc).caretRangeFromPoint = () => {
    const r = document.createRange();
    r.setStart(name, 0);
    return r;
  };
  Range.prototype.getClientRects = function (this: Range) {
    return [new DOMRect(100, 0, 40, 12)] as unknown as DOMRectList;
  };
  const undo = guardTextSelection(canvas);
  return { canvas, name, field: document.querySelector<HTMLElement>('.field')!, input: document.querySelector('input')!, undo };
}

const press = (target: Element, x: number, y = 6) => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
const selectStart = (target: Node): boolean => target.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }));

afterEach(() => {
  Reflect.deleteProperty(document, 'caretRangeFromPoint');
  if (rects === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects');
  else Object.defineProperty(Range.prototype, 'getClientRects', rects);
  document.body.innerHTML = '';
});

describe('a press on the board selects text only when it lands on text', () => {
  it('a press on empty board, nearest to the name, starts no selection', () => {
    const { field, name, undo } = setup();
    press(field, 300);
    expect(selectStart(name), 'refused').toBe(false);
    undo();
  });

  it('a press on the name’s own text does', () => {
    const { name, undo } = setup();
    press(name.parentElement!, 120);
    expect(selectStart(name)).toBe(true);
    undo();
  });

  it('a press in a text field does', () => {
    const { input, undo } = setup();
    press(input, 300);
    expect(selectStart(input)).toBe(true);
    undo();
  });

  it('with no press held (a keyboard selection), and after the release, nothing is refused', () => {
    const { field, name, undo } = setup();
    expect(selectStart(name)).toBe(true);
    press(field, 300);
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(selectStart(name)).toBe(true);
    undo();
  });

  it('teardown removes the rule', () => {
    const { field, name, undo } = setup();
    undo();
    press(field, 300);
    expect(selectStart(name)).toBe(true);
  });
});
