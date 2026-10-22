/*
 * A choice of one, drawn as a row of cards: the room's type and mode in the
 * create form, the mode in the room, and each mode's own options.
 *
 * Native radio inputs, one per card, laid over the whole card and transparent:
 * the keyboard (Tab to the group, arrows between cards), `disabled` and
 * `checked` are the browser's own, and a press anywhere on a card lands on its
 * input. The checked card wears the format tabs' look (`.lobby__format-tabs`),
 * which is this app's one signal for "the one chosen".
 *
 * `value` may be null: nothing chosen yet is a state of its own (a room whose
 * mode the leader has not picked), not a default the reader cannot see.
 *
 * `size="large"` draws each card as a tile with its `icon` over its label, for a
 * choice that is the whole screen until it is made; `morph` names each card for
 * a view transition (`<morph>-<value>`), so the same choice drawn at another size
 * can grow or shrink into it (`constructed-mode/ModeRow.tsx`).
 */

import type { ReactNode } from 'react';

import './RadioCards.css';

export interface RadioCard<T extends string> {
  value: T;
  label: string;
  /** Drawn above the label on a large card; decoration, the label names the card. */
  icon?: ReactNode;
}

export function RadioCards<T extends string>({
  name,
  label,
  options,
  value,
  disabled = false,
  onChange,
  testId,
  size = 'small',
  morph,
}: {
  /** The inputs' shared `name`: unique on the page, so two groups never join. */
  name: string;
  /** The group's accessible name. Not drawn: the cards say what they are. */
  label: string;
  options: readonly RadioCard<T>[];
  value: T | null;
  disabled?: boolean;
  onChange: (value: T) => void;
  /** The group's test id; each card's input is `<testId>-<value>`. */
  testId: string;
  size?: 'small' | 'large';
  /** Each card's view-transition name is `<morph>-<value>`. */
  morph?: string;
}) {
  const large = size === 'large';
  return (
    <div
      className={large ? 'radio-cards radio-cards--large' : 'radio-cards'}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? 'true' : undefined}
      data-testid={testId}
    >
      {options.map((option) => (
        <label key={option.value} className="radio-cards__card" style={morph === undefined ? undefined : { viewTransitionName: `${morph}-${option.value}` }}>
          <input
            className="radio-cards__input"
            type="radio"
            name={name}
            value={option.value}
            data-testid={`${testId}-${option.value}`}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          {large && option.icon !== undefined && <span className="radio-cards__icon">{option.icon}</span>}
          <span className="radio-cards__label">{option.label}</span>
        </label>
      ))}
    </div>
  );
}
