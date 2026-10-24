// @vitest-environment jsdom
/*
 * The operator, 2026-10-21: *"a question with yes/no must put yes/no on
 * opposite ends of the decision box. anchor one bottom left, the other bottom
 * right."*
 *
 * Every decision box's answers are one row (`AnswerRow`). When it holds exactly
 * two answers AND the caller says `yesNo` (never from the count
 * alone — Forge's `InputConfirm` puts a colour pick, Keep/Mulligan, Top/Bottom,
 * … on the SAME two-button bar a real yes/no uses, and the new player pressed
 * Stirring Wildwood's White/Blue 16 times because the old rule split it like
 * one; operator, 2026-10-24: *"let's keep the left/right decisions only for
 * yes/no"*) the row is a
 * pair: the affirmative (Forge's button one, the sheet's OK) is its LAST
 * child, anchored bottom-right (the operator, 2026-10-22: *"yes always bottom
 * right."*), and the other answer is its first child, anchored bottom-left;
 * anything else in the row (the "Always" box) sits between them. jsdom has no
 * layout, so the anchoring is pinned the way `PromptShell.test.ts` pins the
 * scrolling body: the markup's order plus the CSS rule that turns that order
 * into the two corners.
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

/** The row is a pair: the affirmative is its LAST child (bottom right), the other answer its first (bottom left). */
function expectPair(root: ParentNode, affirmative: string, other: string): void {
  const left = other;
  const right = affirmative;
  const row = answerRow(root);
  expect(row.dataset.pair, 'two answers make a pair').toBe('true');
  const first = row.firstElementChild!;
  const last = row.lastElementChild!;
  expect(first.matches(left) || first.querySelector(left) !== null, `bottom-left is ${left}`).toBe(true);
  expect(last.matches(right) || last.querySelector(right) !== null, `bottom-right is ${right}`).toBe(true);
}

const noop = () => {};

describe('a real yes/no anchors its answers bottom-left and bottom-right', () => {
  it('the bar yes/no: No left, Yes right, with the Always box between them', () => {
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

  it("showConfirmDialog: its no left, its yes right, whichever one Forge's default focuses", () => {
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

  it('showConfirmDialog still splits with its own custom text (the mana-floating check’s OK/Cancel) — the `answer` tag is the signal, not the words', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'confirm-dialog',
        title: 'Mana Floating',
        message: 'You have mana floating…',
        button1: { label: 'OK', enabled: true, answer: 'yes', onClick: noop },
        button2: { label: 'Cancel', enabled: true, answer: 'no', isDefault: true, onClick: noop },
      }),
    );
    expectPair(container, '[data-answer="yes"]', '[data-answer="no"]');
  });
});

/*
 * Forge's bar (`InputConfirm`/`InputConfirmMulligan`) has no boolean of its
 * own — only the two words on the buttons — so Wildwood's colour pick and a
 * real "Pay 2 life?" arrive through the exact same mechanism
 * (`ConfirmPrompt`'s own header). The one signal left is whether those words
 * ARE Forge's own default pair (`lblYes`/`lblNo`) or a custom one a card
 * script chose instead. None of the cases below is that default pair, so
 * none is a yes/no, and the operator's 2026-10-24 ruling keeps the row
 * together rather than splitting it like one.
 */
describe('a two-button bar that is not Forge’s own default pair is not a yes/no, and sits together', () => {
  it('a two-colour confirm — Stirring Wildwood’s White/Blue — renders its answers together, not split', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Add {W} or {U}.',
        button1: { label: 'White', enabled: true, testId: 'prompt-confirm-yes', onClick: noop },
        button2: { label: 'Blue', enabled: true, testId: 'prompt-confirm-no', onClick: noop },
      }),
    );
    const row = answerRow(container);
    expect(row.dataset.pair, 'a colour pick is not a yes/no').toBeUndefined();
    // Not swapped either: Forge's own order survives since nothing anchors a corner.
    expect(row.firstElementChild).toBe(container.querySelector('[data-testid="prompt-confirm-yes"]'));
    expect(row.lastElementChild).toBe(container.querySelector('[data-testid="prompt-confirm-no"]'));
  });

  it("the mulligan's Keep/Mulligan is not Forge's Yes/No, and sits together", () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-confirm',
        message: 'Keep this hand?',
        button1: { label: 'Keep', enabled: true, testId: 'prompt-confirm-yes', onClick: noop },
        button2: { label: 'Mulligan', enabled: true, testId: 'prompt-confirm-no', onClick: noop },
      }),
    );
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('the coin toss (Play/Draw) sits together', () => {
    const { container } = render(
      createElement(ConfirmPrompt, {
        testId: 'live-play-or-draw',
        message: 'You won the toss',
        button1: { label: PLAY_LABEL, enabled: true, testId: 'live-play-or-draw-play', onClick: noop },
        button2: { label: DRAW_LABEL, enabled: true, testId: 'live-play-or-draw-draw', onClick: noop },
      }),
    );
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it("the confirm ask with a card script's own options (Blue/Black) sits together", () => {
    const { container } = mountPrompt('confirm', { ...askFor('confirm'), options: ['Blue', 'Black'] });
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });
});

describe('a row that is not two answers, or not a real yes/no, is not a pair', () => {
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

  /*
   * Every other `PromptShell`-based sheet answers through its generic
   * `actions` row, which never knows whether its two children happen to be a
   * real yes/no — `PromptShell` always passes `yesNo` unset for them
   * (`PromptShell.tsx`'s own `yesNo` prop doc). So a two-option
   * `showOptionDialog`, `showInputDialog`'s OK/Cancel, sideboarding's
   * Keep/Done and a combat-damage sheet's Auto/OK all sit together now,
   * same as the bar's own non-yes/no pairs above.
   */
  it('a two-option showOptionDialog sits together', () => {
    const ask = { ...askFor('showOptionDialog'), options: ['Play first', 'Draw first'] };
    const { container } = mountPrompt('showOptionDialog', ask);
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('showInputDialog’s OK/Cancel sits together', () => {
    const { container } = mountPrompt('showInputDialog', askFor('showInputDialog'));
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('sideboarding’s Keep deck/Done sits together', () => {
    const { container } = mountPrompt('sideboard', askFor('sideboard'));
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it('combat damage’s Auto/OK sits together', () => {
    const { container } = mountPrompt('assignCombatDamage', askFor('assignCombatDamage'));
    expect(answerRow(container).dataset.pair).toBeUndefined();
  });

  it("a selection sheet's OK/Cancel sits together", () => {
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
