// @vitest-environment jsdom
/*
 * The operator, 2026-10-21: *"a question with yes/no must put yes/no on
 * opposite ends of the decision box. anchor one bottom left, the other bottom
 * right."*
 *
 * Every decision box's answers are one row (`AnswerRow`). When it holds exactly
 * two answers the row is a pair: the affirmative (Forge's button one, the
 * sheet's OK) is its first child, anchored bottom-left, and the other answer is
 * its last child, anchored bottom-right; anything else in the row (the
 * "Always" box) sits between them. jsdom has no layout, so the anchoring is
 * pinned the way `PromptShell.test.ts` pins the scrolling body: the markup's
 * order plus the CSS rule that turns that order into the two corners.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { ConfirmPrompt, DRAW_LABEL, PLAY_LABEL } from './ConfirmPrompt.tsx';
import { askFor } from './fixtures.ts';
import { EMPTY_LOOKUP } from './lookup.ts';
import { PromptShell } from './PromptShell.tsx';
import { SelectionPrompt } from './SelectionPrompt.tsx';
import { mountPrompt } from './testing.ts';

afterEach(cleanup);

const PROMPTS_CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/prompts', 'prompts.css'), 'utf8');

function answerRow(root: ParentNode): HTMLElement {
  const rows = root.querySelectorAll<HTMLElement>('.answers');
  expect(rows, 'one answer row').toHaveLength(1);
  return rows[0]!;
}

/** The row is a pair, and `left`/`right` are its first and last children. */
function expectPair(root: ParentNode, left: string, right: string): void {
  const row = answerRow(root);
  expect(row.dataset.pair, 'two answers make a pair').toBe('true');
  const first = row.firstElementChild!;
  const last = row.lastElementChild!;
  expect(first.matches(left) || first.querySelector(left) !== null, `bottom-left is ${left}`).toBe(true);
  expect(last.matches(right) || last.querySelector(right) !== null, `bottom-right is ${right}`).toBe(true);
}

const noop = () => {};

describe('a two-answer decision anchors its answers bottom-left and bottom-right', () => {
  it('the bar yes/no: Yes left, No right, with the Always box between them', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Pay 2 life?',
        button1: { label: 'Yes', enabled: true, testId: 'prompt-confirm-yes', onClick: noop },
        button2: { label: 'No', enabled: true, testId: 'prompt-confirm-no', onClick: noop },
        check: { label: 'Always', testId: 'live-confirm-always', checked: false, onChange: noop },
      }),
    );
    expectPair(container, '[data-testid="prompt-confirm-yes"]', '[data-testid="prompt-confirm-no"]');
    const row = answerRow(container);
    const aside = row.children[1]!;
    expect(aside.classList.contains('answers__aside')).toBe(true);
    expect(aside.querySelector('.confirm__check')).not.toBeNull();
  });

  it("the mulligan's Keep/Mulligan: Keep left, Mulligan right", () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Keep this hand?',
        button1: { label: 'Keep', enabled: true, testId: 'prompt-confirm-yes', onClick: noop },
        button2: { label: 'Mulligan', enabled: true, testId: 'prompt-confirm-no', onClick: noop },
      }),
    );
    expectPair(container, '[data-testid="prompt-confirm-yes"]', '[data-testid="prompt-confirm-no"]');
  });

  it('the coin toss: Play left, Draw right', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'You won the toss',
        button1: { label: PLAY_LABEL, enabled: true, testId: 'live-play-or-draw-play', onClick: noop },
        button2: { label: DRAW_LABEL, enabled: true, testId: 'live-play-or-draw-draw', onClick: noop },
      }),
    );
    expectPair(container, '[data-testid="live-play-or-draw-play"]', '[data-testid="live-play-or-draw-draw"]');
  });

  it("showConfirmDialog: its yes left, its no right, whichever one Forge's default focuses", () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'confirm-dialog',
        title: 'A question',
        message: 'Proceed?',
        button1: { label: 'Yes', enabled: true, answer: 'yes', onClick: noop },
        button2: { label: 'No', enabled: true, answer: 'no', isDefault: true, onClick: noop },
      }),
    );
    expectPair(container, '[data-answer="yes"]', '[data-answer="no"]');
  });

  it("the confirm ask: Forge's first option left, its second right", () => {
    const { container } = mountPrompt('confirm', { ...askFor('confirm'), options: ['Blue', 'Black'] });
    expectPair(container, '[data-answer="true"]', '[data-answer="false"]');
  });

  it('a two-option showOptionDialog: option one left, option two right', () => {
    const ask = { ...askFor('showOptionDialog'), options: ['Play first', 'Draw first'] };
    const { container, getAllByTestId } = mountPrompt('showOptionDialog', ask);
    const [one, two] = getAllByTestId('prompt-option');
    const row = answerRow(container);
    expect(row.dataset.pair).toBe('true');
    expect(row.firstElementChild).toBe(one);
    expect(row.lastElementChild).toBe(two);
  });

  it('showInputDialog: OK left, Cancel right', () => {
    const { container } = mountPrompt('showInputDialog', askFor('showInputDialog'));
    expectPair(container, '[data-testid="prompt-submit"]', '[data-testid="prompt-cancel"]');
  });

  it('sideboarding: Done left, Keep deck right', () => {
    const { container } = mountPrompt('sideboard', askFor('sideboard'));
    expectPair(container, '[data-testid="prompt-submit"]', '[data-testid="prompt-cancel"]');
  });

  it('combat damage: OK left, Auto right', () => {
    const { container } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expectPair(container, '[data-testid="prompt-submit"]', '[data-testid="prompt-auto"]');
  });

  it("a selection sheet's OK/Cancel: OK left, Cancel right", () => {
    const { container } = render(
      createElement(SelectionPrompt, {
        message: 'Select up to 2 lands to sacrifice',
        cards: [1, 2],
        lookup: EMPTY_LOOKUP,
        picked: new Set<number>(),
        onPick: noop,
        done: { label: 'OK', enabled: true, onClick: noop },
        cancel: { label: 'Cancel', enabled: true, onClick: noop },
      }),
    );
    expectPair(container, '[data-testid="selection-done"]', '[data-testid="selection-cancel"]');
  });
});

describe('a row that is not two answers is not a pair', () => {
  it('a lone OK', () => {
    const { container } = render(createElement(PromptShell, { method: 'getChoices', title: 'Choose a mode', onSubmit: noop }));
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('a three-option showOptionDialog', () => {
    const { container } = mountPrompt('showOptionDialog', { ...askFor('showOptionDialog'), options: ['a', 'b', 'c'] });
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('a bar decision with only one button Forge enabled, beside the Same-target box', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-decision',
        message: 'Choose a target',
        button2: { label: 'Cancel', enabled: true, testId: 'live-decision-cancel', onClick: noop },
        check: { label: 'Same target for all', testId: 'live-same-target', checked: false, onChange: noop },
      }),
    );
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });
});

/*
 * The operator, 2026-10-21: *"sometimes i get cancel and ok and they look
 * weirdly formated. the cancel button will not be vertically aligned on the row
 * as the ok button and it won't have a button outline?"* The selection sheet's
 * Cancel (Forge's button two on a sacrifice or discard cost) was `.prompt__link`
 * — no border, `align-self: flex-start` — beside a filled OK, and every other
 * unstyled answer drew the browser's own button face.
 */
describe('every answer is the same kind of button', () => {
  it("a selection sheet's Cancel is a button, not a text link", () => {
    const { getByTestId } = render(
      createElement(SelectionPrompt, {
        message: 'Sacrifice a creature',
        cards: [1],
        lookup: EMPTY_LOOKUP,
        picked: new Set<number>(),
        onPick: noop,
        done: { label: 'OK', enabled: true, onClick: noop },
        cancel: { label: 'Cancel', enabled: true, onClick: noop },
      }),
    );
    expect(getByTestId('selection-cancel').classList.contains('prompt__link')).toBe(false);
  });

  it('an answer with no class of its own gets the outlined button look, under any class that sets one', () => {
    const rule = /:where\(\.answers\) button \{([^}]*)\}/.exec(PROMPTS_CSS)?.[1];
    expect(rule, 'the row styles its own answers').toBeDefined();
    expect(rule).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(rule).toMatch(/background:\s*var\(--bg-card\)/);
  });
});

describe('the CSS turns a pair into the two bottom corners', () => {
  const decl = (selector: string) => {
    const escaped = selector.replace(/[[\]().*+?^$|\\]/g, '\\$&');
    return new RegExp(`${escaped} \\{([^}]*)\\}`).exec(PROMPTS_CSS)?.[1];
  };

  it('the first answer takes all the free space to its right, the last all the space to its left', () => {
    expect(decl('.answers[data-pair] > :first-child')).toMatch(/margin-right:\s*auto/);
    expect(decl('.answers[data-pair] > :last-child')).toMatch(/margin-left:\s*auto/);
  });

  it('the row is a flex row along the bottom of the box', () => {
    expect(decl('.answers')).toMatch(/display:\s*flex/);
  });
});
