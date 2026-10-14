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
import { EMPTY_LOOKUP } from './lookup.ts';
import { SelectionPrompt } from './SelectionPrompt.tsx';

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

  it('keeps the problems row in the layout, empty and hidden, while an OK sheet has no problem — the rows do not move when the last one goes', () => {
    const { container } = render(createElement(PromptShell, { method: 'getChoices', title: 'Choose a mode', onSubmit: () => {}, problems: [] }, createElement('ul', null)));
    const problems = container.querySelector<HTMLElement>('[data-testid="prompt-problems"]')!;
    expect(problems.dataset.empty).toBe('true');
    expect(problems.textContent).toBe('\u00a0');
    expect(/\.prompt__problems\[data-empty\] \{([^}]*)\}/.exec(PROMPTS_CSS)?.[1]).toMatch(/visibility:\s*hidden/);
  });

  it('a dialog with no children (confirm, showConfirmDialog) still renders an empty body harmlessly', () => {
    const { container } = render(
      createElement(PromptShell, { method: 'confirm', title: 'Question', actions: createElement('button', null, 'Yes') }),
    );
    expect(container.querySelector('.prompt__body')).not.toBeNull();
  });

  it('.prompt__body shrinks and scrolls, and the buttons never shrink, in CSS', () => {
    const rule = /\.prompt__body \{([^}]*)\}/.exec(PROMPTS_CSS);
    expect(rule, '.prompt__body has its own rule').not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*0/);
    expect(rule![1]).toMatch(/flex:\s*1 1 auto/);
    expect(rule![1]).toMatch(/overflow-y:\s*auto/);
    const foot = /\.prompt__actions,\s*\.prompt__problems \{([^}]*)\}/.exec(PROMPTS_CSS);
    expect(foot, 'the buttons and the problems list have a rule').not.toBeNull();
    expect(foot![1]).toMatch(/flex-shrink:\s*0/);
  });

  it('the selection sheet draws in the same shell: its grid in the body, its OK and Cancel outside it', () => {
    const { container, getByTestId } = render(
      createElement(SelectionPrompt, {
        message: 'Scapeshift - Sacrifice any number of lands.\n\nSelect up to 10 land(s) to sacrifice',
        cards: [1, 2, 3],
        lookup: EMPTY_LOOKUP,
        picked: new Set<number>(),
        onPick: () => {},
        done: { label: 'OK', enabled: true, onClick: () => {} },
        cancel: { label: 'Cancel', enabled: true, onClick: () => {} },
      }),
    );
    const body = container.querySelector('.prompt__body')!;
    expect(body.contains(getByTestId('prompt-cards'))).toBe(true);
    const actions = container.querySelector('.prompt__actions')!;
    expect(body.contains(actions)).toBe(false);
    expect(actions.contains(getByTestId('selection-done'))).toBe(true);
    expect(actions.contains(getByTestId('selection-cancel'))).toBe(true);
  });
});

/*
 * Wave 34 §G item 1 — OK was "faint" at X=0 in w33's Choose-X screenshot, and
 * not because it was disabled: `.prompt__submit` had NO rule of its own, so it
 * fell through to the browser's native button face under `button { color:
 * inherit }` (`styles.css`) — pale theme ink on a light native grey, in every
 * theme, at every value, disabled or not. "Readable" is a contrast number, not
 * `disabled === false`, so this measures it the way `screens/tokens.test.ts`
 * measures `--accent-ink`: read the real `@wolffm/themes` stylesheet, resolve
 * the two tokens the rule actually uses, and compute WCAG contrast per theme.
 */
describe('OK is styled for real contrast, not just enabled (wave 34 §G item 1)', () => {
  type Rgb = [number, number, number];

  function hex(v: string | undefined): Rgb | null {
    if (v === undefined) return null;
    const t = v.trim();
    if (t === 'white') return [255, 255, 255];
    if (t === 'black') return [0, 0, 0];
    const m = /^#([0-9a-f]{6})$/i.exec(t);
    if (m === null) return null;
    const h = m[1]!;
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const channel = (x: number): number => (x / 255 <= 0.03928 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c: Rgb): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const contrast = (a: Rgb, b: Rgb): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const themeCssPath = resolve(import.meta.dirname ?? 'apps/ui/src/play/prompts', '../../../node_modules/@wolffm/themes/src/style.css');
  const themeCss = readFileSync(themeCssPath, 'utf8').replaceAll('\r\n', '\n');
  const themes: { name: string; primary: Rgb; onPrimary: Rgb }[] = [];
  for (const m of themeCss.matchAll(/^([^\n{}/]+(?:,\n[^\n{}/]+)*)\{\n([\s\S]*?)^\}/gm)) {
    const v = Object.fromEntries([...m[2].matchAll(/--color-([a-z-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2]]));
    const [primary, onPrimary] = [hex(v.primary), hex(v['on-primary'])];
    if (primary === null || onPrimary === null) continue;
    const name = /data-theme='([a-z-]+)'/.exec(m[1]!)?.[1] ?? 'light';
    themes.push({ name, primary, onPrimary });
  }

  it('.prompt__submit fills with the accent and sets an explicit text colour — never left to the browser default', () => {
    const rule = /\.prompt__submit \{([^}]*)\}/.exec(PROMPTS_CSS);
    expect(rule, '.prompt__submit has its own rule').not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*var\(--accent\)/);
    // --on-accent, not --ink or --accent-ink: those are text colours FOR a
    // page/card background, not for text drawn on the accent itself as a fill.
    expect(rule![1]).toMatch(/color:\s*var\(--on-accent\)/);
  });

  it('reads at least 16 real themes from the package', () => {
    expect(themes.length).toBeGreaterThanOrEqual(16);
  });

  it('--accent/--on-accent clears 4.5:1 in every theme the package ships', () => {
    const worst: string[] = [];
    for (const t of themes) {
      const c = contrast(t.onPrimary, t.primary);
      if (c < 4.5) worst.push(`${t.name}: ${c.toFixed(2)}`);
    }
    expect(worst).toEqual([]);
  });

  it('the fallback pair (no theme loaded) also clears 4.5:1', () => {
    // styles.css: --accent: var(--color-primary, #7bb0ff); --on-accent: var(--color-on-primary, #10131a);
    const accent = hex('#7bb0ff')!;
    const onAccent = hex('#10131a')!;
    expect(contrast(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
  });
});
