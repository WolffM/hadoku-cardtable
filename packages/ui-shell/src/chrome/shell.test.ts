// @vitest-environment jsdom
/*
 * The page frame says what it holds as attributes (`shell.ts`), which `chrome.css` keys on in place of
 * the page-wide `:has()` that restyled every element whenever the board changed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { cleanup, render } from '@testing-library/react';

import { useChromeShell, useRoomFrame, type ChromeShell } from './shell.ts';

afterEach(cleanup);

function Shell({ kind }: { kind: ChromeShell }) {
  return createElement('div', { ref: useChromeShell(kind) });
}

function Frame() {
  return createElement('span', { hidden: true, ref: useRoomFrame() });
}

/** `children` inside the app's own frame. */
function inFrame(children: unknown) {
  const frame = document.createElement('main');
  frame.className = 'cardtable-chrome';
  document.body.append(frame);
  const view = render(createElement(Fragment, null, children as never), { container: frame });
  return { frame, view };
}

describe('the page frame’s own marks', () => {
  it('names the drawn screen’s shell while it is drawn, and drops it as it goes', () => {
    const { frame, view } = inFrame(createElement(Shell, { kind: 'match' }));
    expect(frame.getAttribute('data-shell')).toBe('match');
    view.rerender(createElement(Shell, { kind: 'match' }));
    expect(frame.getAttribute('data-shell'), 'a redraw keeps it').toBe('match');
    view.rerender(createElement(Fragment));
    expect(frame.hasAttribute('data-shell')).toBe(false);
  });

  it('keeps the mark while any screen holding it is drawn, through one screen giving way to the next', () => {
    const { frame, view } = inFrame(createElement(Fragment, null, createElement(Shell, { kind: 'fit', key: 'a' }), createElement(Shell, { kind: 'fit', key: 'b' })));
    view.rerender(createElement(Shell, { kind: 'fit', key: 'b' }));
    expect(frame.getAttribute('data-shell'), 'one still drawn').toBe('fit');
    view.rerender(createElement(Fragment));
    expect(frame.hasAttribute('data-shell')).toBe(false);
  });

  it('says watchparty’s room frame is drawn, apart from the shell', () => {
    const { frame, view } = inFrame(createElement(Fragment, null, createElement(Frame), createElement(Shell, { kind: 'fit' })));
    expect(frame.hasAttribute('data-room-frame')).toBe(true);
    expect(frame.getAttribute('data-shell')).toBe('fit');
    view.rerender(createElement(Shell, { kind: 'fit' }));
    expect(frame.hasAttribute('data-room-frame')).toBe(false);
  });
});
