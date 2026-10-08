/*
 * The three plain dialogs: `showOptionDialog`, `showInputDialog`, `confirm`.
 *
 * Each is a question with buttons, and the buttons are the answers — there is
 * no button that could send an answer the rules in `rules.ts` refuse.
 *
 * `showOptionDialog`'s `icon` names a desktop skin asset (`FSkinProp`) and is
 * deliberately not drawn: `@hadoku/forge-wire`'s `refs.ts` records why, and the
 * trademark rule is the short version.
 */

import { useState } from 'react';

import { ManaPip } from '../../components/ManaPip.tsx';
import { PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { confirmButtons, confirmProblems, inputDialogProblems, optionDialogProblems } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

/**
 * Forge's colour question ("Select Mana to Produce": Black / Red) names the
 * colours in words; the seat reads the mana symbol (the operator, 2026-10-08,
 * after Z10 and Y23: "i said to use the black and red mana symbols"). The
 * word stays as the button's accessible name.
 */
const COLOUR_TOKENS: Readonly<Record<string, string>> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: 'C', colourless: 'C' };
function colourToken(label: string): string | null {
  return COLOUR_TOKENS[label.trim().toLowerCase()] ?? null;
}

export function ShowOptionDialogPrompt({ ask, onAnswer }: PromptProps<'showOptionDialog'>) {
  const choose = (index: number) => {
    assertAnswerable('showOptionDialog', optionDialogProblems(ask, index));
    onAnswer(checkedReply('showOptionDialog', index));
  };
  return (
    <PromptShell
      method="showOptionDialog"
      title={ask.title}
      message={ask.message}
      actions={ask.options.map((label, i) => (
        <button
          key={`${i}:${label}`}
          type="button"
          data-testid="prompt-option"
          data-default={i === ask.defaultOption || undefined}
          aria-label={label}
          autoFocus={i === ask.defaultOption}
          onClick={() => choose(i)}
        >
          {colourToken(label) === null ? label : <ManaPip token={colourToken(label)!} />}
        </button>
      ))}
    />
  );
}

export function ShowInputDialogPrompt({ ask, onAnswer }: PromptProps<'showInputDialog'>) {
  const [value, setValue] = useState(
    ask.inputOptions.length > 0 && !ask.inputOptions.includes(ask.initialInput)
      ? (ask.inputOptions[0] ?? '')
      : ask.initialInput,
  );
  const problems = inputDialogProblems(ask, value);
  const submit = () => {
    assertAnswerable('showInputDialog', problems);
    onAnswer(checkedReply('showInputDialog', ask.isNumeric ? value.trim() : value));
  };

  return (
    <PromptShell
      method="showInputDialog"
      title={ask.title}
      message={ask.message}
      problems={problems}
      onSubmit={submit}
      actions={
        <button type="button" data-testid="prompt-cancel" onClick={() => onAnswer(checkedReply('showInputDialog', null))}>
          Cancel
        </button>
      }
    >
      {ask.inputOptions.length > 0 ? (
        <select
          className="prompt__input"
          data-testid="prompt-input"
          aria-label={ask.message}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          {ask.inputOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="prompt__input"
          data-testid="prompt-input"
          aria-label={ask.message}
          inputMode={ask.isNumeric ? 'numeric' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </PromptShell>
  );
}

export function ConfirmAskPrompt({ ask, onAnswer, lookup }: PromptProps<'confirm'>) {
  const buttons = confirmButtons(ask);
  const answer = (reply: boolean) => {
    assertAnswerable('confirm', confirmProblems(ask, reply));
    onAnswer(checkedReply('confirm', reply));
  };
  // Forge's own title for this dialog (GuiDialog.java:26).
  const title = ask.card === null ? 'Question' : `${refName(lookup, ask.card)} — ability`;

  return (
    <PromptShell
      method="confirm"
      title={title}
      message={ask.question}
      actions={buttons.map((label, i) => (
        <button
          key={`${i}:${label}`}
          type="button"
          data-testid="prompt-option"
          data-answer={String(i === 0)}
          autoFocus={(i === 0) === ask.defaultIsYes}
          onClick={() => answer(i === 0)}
        >
          {label}
        </button>
      ))}
    />
  );
}
