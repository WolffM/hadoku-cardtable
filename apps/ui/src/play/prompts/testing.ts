/*
 * Test helpers for the prompt components — imported by the `*.test.ts` files
 * here and by nothing that ships.
 *
 * `mountPrompt` renders one component from a fixture and records every answer
 * it gives. `expectWireReply` is the done-when check, applied twice: the answer
 * must pass `REPLY_SCHEMAS[method]` on its own, and it must pass
 * `parseClientFrame` wrapped in the reply frame lane B will send — so a value
 * that only survives the per-method schema but not the envelope still fails.
 */

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { parseClientFrame, REPLY_SCHEMAS } from '@hadoku/forge-wire';
import { expect } from 'vitest';

import { PROMPT_COMPONENTS } from './index.ts';
import { fixtureLookup } from './fixtures.ts';
import type { PromptLookup } from './lookup.ts';
import type { AskOf, PromptMethod, ReplyOf } from './types.ts';

export function mountPrompt<M extends PromptMethod>(method: M, ask: AskOf<M>, lookup: PromptLookup = fixtureLookup()) {
  const answers: ReplyOf<M>[] = [];
  const component = PROMPT_COMPONENTS[method];
  const utils = render(createElement(component, { ask, lookup, onAnswer: (r: ReplyOf<M>) => answers.push(r) }));
  const submit = () => utils.getByTestId('prompt-submit') as HTMLButtonElement;
  return { ...utils, answers, submit };
}

export function expectWireReply(method: PromptMethod, result: unknown): void {
  const alone = REPLY_SCHEMAS[method].safeParse(result);
  expect(alone.success, JSON.stringify(alone.error?.issues)).toBe(true);
  const frame = parseClientFrame({ kind: 'reply', callId: `test-${method}`, method, result });
  expect(frame.kind).toBe('reply');
}
