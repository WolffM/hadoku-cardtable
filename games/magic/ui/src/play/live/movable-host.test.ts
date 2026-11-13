// @vitest-environment jsdom
/*
 * A question's host reads its boxes before it writes its offset, and reads nothing at all when it stands
 * at its default spot: every box read is a layout (cut 3, 2026-11-01: 17–36 ms forced per resize).
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDialogMover, OffersHandContext, pointerAt, QuestionHost, SPOT_KEY } from './movable.tsx';

/** `createElement` (unlike JSX) has no special-cased allowance for `data-*` on an intrinsic-shaped component's props. */
const hostProps = (testId: string): ComponentProps<typeof QuestionHost> => ({ 'data-testid': testId }) as unknown as ComponentProps<typeof QuestionHost>;

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** jsdom has no `ResizeObserver`: this one hands its callback to the test. */
let grown: (() => void) | null = null;
class Resizes {
  constructor(report: ResizeObserverCallback) {
    grown = () => report([], this as unknown as ResizeObserver);
  }
  observe(): void {}
  disconnect(): void {}
}

/**
 * `QuestionHost` now reads A's own `usePortraitLayout` (`../portrait.ts`), which reads
 * `window.matchMedia` — jsdom has never implemented it (that file's own test has the same note) — not
 * the `<html>` attribute directly. A static stand-in is enough here: nothing in this file needs the
 * query to CHANGE mid-test, only to already match (or not) when `QuestionHost` mounts.
 */
function stubPortraitMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      media: '(max-width: 600px) and (orientation: portrait)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
  delete document.documentElement.dataset.layout;
  grown = null;
});

/** Box reads, with what the host's own offset was at each: a sheet drawn at its default (600, 300) plus that offset. */
function stubBoxes(): { reads: string[] } {
  const reads: string[] = [];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('live')) return rect(0, 0, 1000, 800);
    const host = this.closest<HTMLElement>('.live__prompt');
    const [x = '0', y = '0'] = (host?.style.translate ?? '').split(/\s+/);
    reads.push(host?.style.translate ?? '');
    return rect(600 + (Number.parseFloat(x) || 0), 300 + (Number.parseFloat(y) || 0), 160, 100);
  });
  return { reads };
}

function draw(spot: string) {
  return createElement('div', { className: 'live' }, createElement(QuestionHost, { spot, children: createElement('div', { className: 'sheet' }, 'a question') }));
}

describe('QuestionHost', () => {
  it('a question at its default spot reads no box when its sheet grows', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const { reads } = stubBoxes();
    render(draw('a'));
    reads.length = 0;
    grown!();
    expect(reads).toEqual([]);
  });

  it('opens again at the remembered spot reading where it is drawn first — its offset still on — and lands in the same place', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    localStorage.setItem(SPOT_KEY, JSON.stringify({ x: 0.2, y: 0.5 }));
    const { reads } = stubBoxes();
    const { container, rerender } = render(draw('a'));
    const host = container.querySelector<HTMLElement>('.live__prompt')!;
    expect(host.style.translate).toBe('-400px 100px');
    reads.length = 0;
    rerender(draw('b'));
    expect(reads, 'every read with the offset it had').toEqual(['-400px 100px']);
    expect(host.style.translate, 'the same spot').toBe('-400px 100px');
  });
});

/*
 * Wave 89 §C: the decision dock (Settled 6). `hasOverflow`'s own `ResizeObserver` is the same fake every
 * test above already hands `QuestionHost`'s desktop effect; in portrait only the dock's observer is built
 * (the desktop positioning effect no-ops), so `grown!()` here always re-runs the dock's own measurement.
 *
 * The manager, after the first version of this file: "keep every existing test ID" — so the host
 * (`.live__prompt`) keeps whatever testid its caller gave it, in portrait exactly as on desktop; the
 * Test-ID contract's own `decision-dock`/`data-mode` live on a NEW wrapper around it, `.dock`.
 */
describe('QuestionHost in portrait', () => {
  function drawPortrait(testId = 'live-decision-host', extra: Record<string, unknown> = {}) {
    stubPortraitMatchMedia(true);
    return createElement(
      'div',
      { className: 'live' },
      createElement(
        QuestionHost,
        { ...hostProps(testId), ...extra },
        createElement('section', { className: 'confirm' }, createElement('p', { className: 'confirm__message' }, 'Declare attackers')),
      ),
    );
  }

  const wrapper = () => document.querySelector('.dock')!;

  /** The sheet holds more than it shows, and scrolls it: `live.css`'s own `overflow-y: auto` on it, which jsdom does not load. */
  function overflowSheet(): void {
    const sheet = document.querySelector<HTMLElement>('.confirm')!;
    sheet.style.overflowY = 'auto';
    Object.defineProperty(sheet, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(sheet, 'clientHeight', { value: 300, configurable: true });
  }

  it('docks inside a NEW wrapper carrying the Test-ID contract — the host keeps its own testid, unchanged', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    const host = document.querySelector('.live__prompt')!;
    expect(host.getAttribute('data-testid'), "the caller's own id, untouched").toBe('live-decision-host');
    expect(host.getAttribute('data-mode'), 'data-mode lives on the wrapper, not the host').toBeNull();
    expect(wrapper().getAttribute('data-testid')).toBe('decision-dock');
    expect(wrapper().getAttribute('data-mode')).toBe('dock');
    expect(wrapper().contains(host), 'the host is nested inside the wrapper').toBe(true);
  });

  it('has no expand control while the sheet fits the docked height', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    expect(document.querySelector('[data-testid="decision-expand"]')).toBeNull();
  });

  /*
   * The operator's reshoot would show it on the Bolt's target question: a card tile in the sheet clips
   * its own caption (`overflow: hidden`), and that is not something more room would reveal.
   */
  it('has no expand control for a sheet that fits, however much a tile inside it clips on purpose', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    const tile = document.createElement('article');
    tile.className = 'card';
    tile.style.overflow = 'hidden';
    Object.defineProperty(tile, 'scrollHeight', { value: 70, configurable: true });
    Object.defineProperty(tile, 'clientHeight', { value: 65, configurable: true });
    act(() => {
      document.querySelector('.confirm')!.append(tile);
      grown!();
    });
    expect(document.querySelector('[data-testid="decision-expand"]')).toBeNull();
    expect(wrapper().getAttribute('data-mode')).toBe('dock');
  });

  it('opens straight to full, with no expand control, when the sheet already overflows the moment it mounts (Scapeshift\'s library search)', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    render(drawPortrait());
    expect(wrapper().getAttribute('data-mode'), 'opened full outright, never flashed docked').toBe('full');
    expect(document.querySelector('[data-testid="decision-expand"]'), 'nothing left to expand into').toBeNull();
  });

  it('shows the expand control once the sheet overflows the docked height, and it opens the full sheet — then removes it, nothing is left to expand into', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    overflowSheet();
    act(() => grown!());
    const expand = document.querySelector<HTMLButtonElement>('[data-testid="decision-expand"]');
    expect(expand).not.toBeNull();
    fireEvent.click(expand!);
    expect(wrapper().getAttribute('data-mode')).toBe('full');
    expect(document.querySelector('[data-testid="decision-expand"]')).toBeNull();
  });

  it('minimizes to a pill carrying the sheet\'s own words, and the pill restores the dock', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    fireEvent.click(document.querySelector('[data-testid="decision-minimize"]')!);
    expect(wrapper().getAttribute('data-mode')).toBe('min');
    const pill = document.querySelector<HTMLButtonElement>('[data-testid="decision-pill"]');
    expect(pill?.textContent).toContain('Declare attackers');
    fireEvent.click(pill!);
    expect(wrapper().getAttribute('data-mode')).toBe('dock');
  });

  it('a swipe up on the handle opens the full sheet only once the sheet overflows', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    const handle = document.querySelector<HTMLElement>('[data-testid="decision-dock-handle"]')!;
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 460, pointerId: 1 });
    expect(wrapper().getAttribute('data-mode'), 'nothing overflows yet').toBe('dock');

    overflowSheet();
    act(() => grown!());
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 2 });
    fireEvent.pointerUp(window, { clientY: 460, pointerId: 2 });
    expect(wrapper().getAttribute('data-mode')).toBe('full');
  });

  it('a swipe down steps the dock down one size at a time: full → dock → min', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    overflowSheet();
    act(() => grown!());
    fireEvent.click(document.querySelector('[data-testid="decision-expand"]')!);
    expect(wrapper().getAttribute('data-mode')).toBe('full');

    const handle = document.querySelector<HTMLElement>('[data-testid="decision-dock-handle"]')!;
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 3 });
    fireEvent.pointerUp(window, { clientY: 540, pointerId: 3 });
    expect(wrapper().getAttribute('data-mode'), 'full → dock, not straight to min').toBe('dock');

    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 4 });
    fireEvent.pointerUp(window, { clientY: 540, pointerId: 4 });
    expect(wrapper().getAttribute('data-mode')).toBe('min');
  });

  it('a desktop host (no portrait attribute) keeps its own testid, no wrapper, and no dock chrome at all', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(
      createElement(
        'div',
        { className: 'live' },
        createElement(QuestionHost, hostProps('live-decision-host'), createElement('section', { className: 'confirm' }, 'Declare attackers')),
      ),
    );
    const host = document.querySelector('.live__prompt')!;
    expect(host.getAttribute('data-testid')).toBe('live-decision-host');
    expect(document.querySelector('.dock'), 'no wrapper on desktop').toBeNull();
    expect(document.querySelector('[data-testid="decision-dock-handle"]')).toBeNull();
  });

  it('a question that offers hand cards stands on the hand (`data-clear="hand"`); any other docks over it', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    const { unmount } = render(createElement(OffersHandContext.Provider, { value: true }, drawPortrait()));
    expect(wrapper().getAttribute('data-clear'), 'a London mulligan’s bottom pick').toBe('hand');
    unmount();
    render(drawPortrait());
    expect(wrapper().hasAttribute('data-clear'), 'declare attackers offers nothing in the hand').toBe(false);
  });

  it('a real decision with no `data-pass` still docks normally (declare blockers, no expand, same as before)', () => {
    vi.stubGlobal('ResizeObserver', Resizes);
    render(drawPortrait());
    expect(wrapper().getAttribute('data-testid')).toBe('decision-dock');
    expect(document.querySelector('[data-testid="decision-expand"]')).toBeNull();
  });
});

describe('pointerAt: a dialog opens at the press', () => {
  it('reads the last press or move over the board, a finger as a finger, and forgets it when the mover goes', () => {
    const board = document.createElement('div');
    board.className = 'live';
    const button = document.createElement('button');
    board.append(button);
    document.body.append(board);
    const uninstall = installDialogMover(board);
    try {
      expect(pointerAt(button)).toBeNull();
      button.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 50, pointerType: 'mouse', bubbles: true }));
      expect(pointerAt(button)).toEqual({ x: 40, y: 50, finger: false });
      button.dispatchEvent(new PointerEvent('pointerdown', { clientX: 120, clientY: 300, pointerType: 'touch', bubbles: true }));
      expect(pointerAt(button)).toEqual({ x: 120, y: 300, finger: true });
      expect(pointerAt(document.body), 'off the board there is no board pointer').toBeNull();
    } finally {
      uninstall();
    }
    expect(pointerAt(button)).toBeNull();
    board.remove();
  });
});
