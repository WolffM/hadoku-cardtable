// @vitest-environment jsdom
/*
 * The shell every prompt renders in (first list item 3). *"i have to scroll
 * all the way to the bottom to click 'ok'."*
 *
 * These are about STRUCTURE, not any one ask: whatever a prompt puts in
 * `children`, it lands inside `.prompt__body`, and OK/Clear (and the problems
 * list) never do. `prompts.css`'s own rule — only `.prompt__body` may shrink
 * below its content — is pinned alongside it, because the markup alone proves
 * nothing without the CSS that makes it scroll instead of the whole sheet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { PromptShell } from './PromptShell.tsx';

afterEach(cleanup);

const PROMPTS_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/prompts', 'prompts.css'), 'utf8');

describe('PromptShell — OK and Clear sit outside the scroll, always visible', () => {
  it('puts children in .prompt__body, and OK is a SIBLING of it, not a descendant', () => {
    const { container, getByTestId } = render(
      createElement(
        PromptShell,
        { method: 'getChoices', title: 'Choose a mode', onSubmit: () => {} },
        createElement('ul', { 'data-testid': 'the-list' }, createElement('li', null, 'one')),
      ),
    );
    const body = container.querySelector('.prompt__body')!;
    expect(body.contains(getByTestId('the-list'))).toBe(true);
    const submit = getByTestId('prompt-submit');
    expect(body.contains(submit)).toBe(false);
    // Order in the DOM: the body comes before the actions row that holds OK.
    const actions = container.querySelector('.prompt__actions')!;
    expect(body.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the problems list outside .prompt__body too', () => {
    const { container } = render(
      createElement(
        PromptShell,
        { method: 'getChoices', title: 'Choose a mode', onSubmit: () => {}, problems: ['choose at least 1'] },
        createElement('ul', null),
      ),
    );
    const body = container.querySelector('.prompt__body')!;
    const problems = container.querySelector('[data-testid="prompt-problems"]')!;
    expect(body.contains(problems)).toBe(false);
  });

  it('a dialog with no children (confirm, showConfirmDialog) still renders an empty body harmlessly', () => {
    const { container } = render(
      createElement(PromptShell, { method: 'confirm', title: 'Question', actions: createElement('button', null, 'Yes') }),
    );
    expect(container.querySelector('.prompt__body')).not.toBeNull();
  });

  it('.prompt__body is the only child allowed to shrink below its content, in CSS', () => {
    const rule = /\.prompt__body \{([^}]*)\}/.exec(PROMPTS_CSS);
    expect(rule, '.prompt__body has its own rule').not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*0/);
    expect(rule![1]).toMatch(/flex:\s*1 1 auto/);
    expect(rule![1]).toMatch(/overflow-y:\s*auto/);
  });
});
