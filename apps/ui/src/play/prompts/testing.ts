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
import { EMPTY_LOOKUP, type PromptLookup } from './lookup.ts';
import type { AskOf, PromptMethod, ReplyOf } from './types.ts';
import poolData from '../../draft/pool.json' with { type: 'json' };

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

/**
 * Three real pool cards — the art-id table knows every one of them — and a
 * lookup that names them at `POOL_ID_BASE + i`.
 *
 * The committed match fixtures' cards have no rows in the art-id table, so a
 * test that wants to assert a tile resolved ART has to mount the prompt over
 * cards that do. Shared by `choices.test.ts` and `order.test.ts`, which both
 * need it for wave 25 §F: an ask whose labels are Forge's
 * `CardView.toString()` must still resolve the same art the board resolves.
 */
export const POOL_ID_BASE = 901;

export const POOL: readonly { name: string; setCode: string; scryfallId: string }[] = (() => {
  const seen = new Set<string>();
  const unique: { name: string; setCode: string; scryfallId: string }[] = [];
  for (const c of (poolData as { cards: { name: string; setCode: string; scryfallId?: string }[] }).cards) {
    // First occurrence per name: that is the row the art-id index keeps, so
    // the tile's art is this printing's art, not a duplicate's.
    if (c.scryfallId === undefined || c.scryfallId === '' || seen.has(c.name)) continue;
    seen.add(c.name);
    unique.push({ name: c.name, setCode: c.setCode, scryfallId: c.scryfallId });
    if (unique.length === 3) break;
  }
  return unique;
})();

/** A lookup that knows the three pool cards, so their tiles resolve real art. */
export const poolLookup: PromptLookup = {
  ...EMPTY_LOOKUP,
  card: (id) => {
    const hit = POOL[id - POOL_ID_BASE];
    return hit === undefined
      ? undefined
      : { name: hit.name, setCode: hit.setCode, lethalDamage: null, loyalty: null, keywords: [], isPlaneswalker: false };
  },
};

/**
 * Exactly the label `PlayBridge` sends for a card option of `getChoices` or
 * `order`: neither passes a display function (`PlayBridge.java:947-964`,
 * `:977-978`), so each option is `String.valueOf(item)` — `CardView.toString()`,
 * `zoneText + name + " (" + id + ")"` (`CardView.java:1214-1232`). For a card in
 * a library the zone text is empty, so it is literally `Mox Opal (130)`.
 */
export function forgeCardLabel(name: string, forgeId: number): string {
  return `${name} (${forgeId})`;
}
