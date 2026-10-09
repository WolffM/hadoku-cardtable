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

import { colorWordToken, ManaPip } from '../../components/ManaPip.tsx';
import { OptionButton, PromptShell } from './PromptShell.tsx';
import { refName } from './lookup.ts';
import { confirmButtons, confirmProblems, inputDialogProblems, optionDialogProblems } from './rules.ts';
import { assertAnswerable, checkedReply, type PromptProps } from './types.ts';

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
        <OptionButton
          key={`${i}:${label}`}
          testId="prompt-option"
          dataDefault={i === ask.defaultOption}
          autoFocus={i === ask.defaultOption}
          ariaLabel={label}
          onClick={() => choose(i)}
        >
          {colorWordToken(label) === null ? label : <ManaPip token={colorWordToken(label)!} />}
        </OptionButton>
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
        <OptionButton
          key={`${i}:${label}`}
          testId="prompt-option"
          dataAnswer={String(i === 0)}
          autoFocus={(i === 0) === ask.defaultIsYes}
          ariaLabel={label}
          onClick={() => answer(i === 0)}
        >
          {colorWordToken(label) === null ? label : <ManaPip token={colorWordToken(label)!} />}
        </OptionButton>
      ))}
    />
  );
}
