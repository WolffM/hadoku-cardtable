/*
 * TEST SUPPORT — a player's hands on the live board's prompt. Never imported by
 * the app.
 *
 * Given the container a `LiveBoard` is rendered into, `answerOpenPrompt` does
 * what a person would do with the prompt that is showing: tick, place, press
 * Auto, then press the button. It touches the DOM only — never `answerAsk`
 * directly — so what reaches the server is whatever the COMPONENT built and
 * checked, through the one seam.
 *
 * The choices are deliberately plain (the first option, Forge's default, the
 * component's own Auto): the point is that the answer round-trips, not that it
 * is good play.
 */

import { fireEvent } from '@testing-library/react';

import { ANSWER_KIND, ANSWER_TESTID } from '../prompts/answer-table.ts';

function click(el: Element | null | undefined, what: string): void {
  if (el === null || el === undefined) throw new Error(`no ${what} to click`);
  fireEvent.click(el);
}

function all(root: Element, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

export interface PromptPreferences {
  /** Press the button Forge did NOT make the default — so a result can only have come from the click. */
  confirmAgainstDefault?: boolean;
}

/**
 * Answer the prompt `LiveBoard` is showing in `root`. Returns the method it
 * answered, or null when nothing is showing (or the showing prompt answers
 * itself, like the zone prompts).
 */
export function answerOpenPrompt(root: Element, prefs: PromptPreferences = {}): string | null {
  const sheet = root.querySelector<HTMLElement>('[data-testid="live-prompt"]');
  if (sheet === null) return null;
  const method = sheet.dataset.method ?? '';
  const submit = () => click(sheet.querySelector(`[data-testid="${ANSWER_TESTID.submit}"]`), `${method} submit`);
  const kind = ANSWER_KIND[method];
  if (kind === undefined || kind === 'self-answering') return null;

  switch (kind) {
    case 'bar-default':
      click(
        sheet.querySelector(prefs.confirmAgainstDefault === true ? '.confirm__button:not([data-default])' : '.confirm__button[data-default]'),
        'confirm button',
      );
      return method;
    case 'default-option': {
      const options = all(sheet, `[data-testid="${ANSWER_TESTID.option}"]`);
      click(options.find((o) => o.dataset.default !== undefined) ?? options[0], `${method} option`);
      return method;
    }
    case 'input': {
      const input = sheet.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-testid="${ANSWER_TESTID.input}"]`);
      if (input instanceof HTMLInputElement) fireEvent.change(input, { target: { value: '1' } });
      submit();
      return method;
    }
    case 'choice-or-cancel':
      // Forge can offer an empty list; "None" is then the only answer.
      click(
        sheet.querySelector(`[data-testid="${ANSWER_TESTID.choice}"], [data-testid="${ANSWER_TESTID.face}"]`) ??
          sheet.querySelector(`[data-testid="${ANSWER_TESTID.cancel}"]`),
        'ability or None',
      );
      return method;
    case 'tick-until-submittable': {
      const submitButton = sheet.querySelector<HTMLButtonElement>(`[data-testid="${ANSWER_TESTID.submit}"]`);
      const choices = all(sheet, `input[data-testid="${ANSWER_TESTID.choice}"]`);
      // Tick options in order until the answer is sendable.
      for (const choice of choices) {
        if (submitButton !== null && !submitButton.disabled) break;
        if (!(choice as HTMLInputElement).checked) fireEvent.click(choice);
      }
      submit();
      return method;
    }
    case 'auto-then-submit':
      click(sheet.querySelector(`[data-testid="${ANSWER_TESTID.auto}"]`), 'Auto');
      submit();
      return method;
    case 'increment-until-submittable': {
      const combo = sheet.querySelector(`[data-testid="${ANSWER_TESTID.combo}"]`);
      if (combo !== null) {
        click(combo, 'mana combination');
        return method;
      }
      // No Auto here: press "+" on the first row that takes more, until the
      // whole amount is placed and the answer is sendable.
      const submitButton = sheet.querySelector<HTMLButtonElement>(`[data-testid="${ANSWER_TESTID.submit}"]`);
      for (let guard = 0; guard < 100 && submitButton?.disabled === true; guard += 1) {
        const more = all(sheet, 'button[aria-label^="more to"]').find((b) => !(b as HTMLButtonElement).disabled);
        if (more === undefined) break;
        fireEvent.click(more);
      }
      submit();
      return method;
    }
    case 'order-until-submittable': {
      // An unplaced row is placed by clicking the row itself (`OrderPrompt.tsx`: drag, or click
      // as the short form — there is no Place button since 2026-10-06). Read afresh after each
      // click: placing one re-renders the list.
      const submitButton = sheet.querySelector<HTMLButtonElement>(`[data-testid="${ANSWER_TESTID.submit}"]`);
      for (let guard = 0; guard < 100 && submitButton?.disabled === true; guard += 1) {
        const row = sheet.querySelector<HTMLElement>(`[data-testid="${ANSWER_TESTID.orderSource}"] > li`);
        if (row === null) break;
        fireEvent.click(row);
      }
      submit();
      return method;
    }
    case 'submit-only':
      submit();
      return method;
  }
}
