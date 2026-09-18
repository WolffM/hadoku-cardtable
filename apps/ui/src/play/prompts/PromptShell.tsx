/*
 * The frame every prompt draws in: a title, Forge's message, the body, the
 * reasons the current answer cannot be sent yet, and the buttons.
 *
 * The submit button is disabled while `problems` is non-empty, and `problems`
 * always comes from `rules.ts`. That is the whole enforcement story: the rules
 * are pure and tested on their own, and the shell makes them the only way out.
 */

import type { ReactNode } from 'react';

import './prompts.css';
import type { PromptMethod } from './types.ts';

export interface PromptShellProps {
  method: PromptMethod;
  title: string;
  message?: string;
  problems?: readonly string[];
  submitLabel?: string;
  /** Omit for a prompt that answers without a button (the zone prompts). */
  onSubmit?: () => void;
  /** Buttons beside submit, e.g. "Decline" on an optional choice. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function PromptShell({
  method,
  title,
  message,
  problems = [],
  submitLabel = 'OK',
  onSubmit,
  actions,
  children,
}: PromptShellProps) {
  return (
    <section className="prompt" data-prompt={method} role="dialog" aria-label={title}>
      <h3 className="prompt__title">{title}</h3>
      {message !== undefined && message !== '' && <p className="prompt__message">{message}</p>}
      {children}
      {problems.length > 0 && (
        <ul className="prompt__problems" data-testid="prompt-problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {(onSubmit !== undefined || actions !== undefined) && (
        <div className="prompt__actions">
          {actions}
          {onSubmit !== undefined && (
            <button
              type="button"
              className="prompt__submit"
              data-testid="prompt-submit"
              disabled={problems.length > 0}
              onClick={onSubmit}
            >
              {submitLabel}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
