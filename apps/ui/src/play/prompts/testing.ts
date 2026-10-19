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
import { fireEvent, render } from '@testing-library/react';
import { parseClientFrame, REPLY_SCHEMAS } from '@hadoku/forge-wire';
import { expect, vi } from 'vitest';

import { PROMPT_COMPONENTS } from './index.ts';
import { PILE_ATTR } from './row-drag.ts';
import { fixtureLookup } from './fixtures.ts';
import { EMPTY_LOOKUP, type PromptLookup } from './lookup.ts';
import type { AskOf, PromptMethod, ReplyOf } from './types.ts';
import poolData from '../../draft/pool.json' with { type: 'json' };

export function mountPrompt<M extends PromptMethod>(
  method: M,
  ask: AskOf<M>,
  lookup: PromptLookup = fixtureLookup(),
  onPreview?: (amounts: ReadonlyMap<number, number>) => void,
) {
  const answers: ReplyOf<M>[] = [];
  const component = PROMPT_COMPONENTS[method];
  const utils = render(createElement(component, { ask, lookup, onAnswer: (r: ReplyOf<M>) => answers.push(r), onPreview }));
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

/** Every ordering prompt's drop targets, in the column order `dragRow` lays them out in. */
const DROP_TARGETS = ['zone-source', 'zone-dest'];
const COLUMN_PX = 200;
const ROW_PX = 44;

/**
 * A real press-drag of `row` onto `onto` (`./row-drag.ts`): onto another row it
 * lands just before it; onto a list or a zone, at its end. jsdom has no
 * layout, and the drag reads where the pointer is among the rows, so for the
 * length of the gesture every drop target is a column (`DROP_TARGETS`' order)
 * and its rows a stack down it — up it, first row lowest, for a pile
 * (`PILE_ATTR`), where "just before" a row is the half of it nearer the foot.
 * `press` is where on the row the press lands — a child, say, the way a seat
 * presses the card panel. The click a browser leaves behind a release is fired
 * too, so a test sees what it would.
 */
export function dragRow(row: Element, onto: Element, press: Element = row): void {
  const rowsIn = (list: Element) => [...list.querySelectorAll(':scope > li[data-card-id]')];
  const column = (el: Element | null) => (el === null ? -1 : DROP_TARGETS.indexOf(el.getAttribute('data-testid') ?? ''));
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const own = column(this);
    if (own !== -1) return new DOMRect(own * COLUMN_PX, 0, COLUMN_PX / 2, Math.max(rowsIn(this).length, 1) * ROW_PX);
    if (this.matches('li[data-card-id]') && column(this.parentElement) !== -1) {
      const rows = rowsIn(this.parentElement!);
      const at = rows.indexOf(this);
      const down = this.parentElement!.hasAttribute(PILE_ATTR) ? rows.length - 1 - at : at;
      return new DOMRect(column(this.parentElement) * COLUMN_PX, down * ROW_PX, COLUMN_PX / 2, ROW_PX - 4);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  try {
    const from = row.getBoundingClientRect();
    const start = { clientX: from.left + from.width / 2, clientY: from.top + from.height / 2 };
    const box = onto.getBoundingClientRect();
    // Onto a row: the quarter of it nearer the list's start, so before it. Onto a list or a zone: past its last row.
    const pile = onto.parentElement?.hasAttribute(PILE_ATTR) === true;
    const end = onto.hasAttribute(PILE_ATTR) ? -100_000 : 100_000;
    const at = onto.matches('li') ? { clientX: box.left + 10, clientY: box.top + (box.height * (pile ? 3 : 1)) / 4 } : { clientX: box.left + 10, clientY: end };
    // A browser follows the release with a click on what the press and the release share — found
    // now, since the release can re-render the pressed row into the other list.
    let shared: Element | null = press;
    while (shared !== null && !shared.contains(onto)) shared = shared.parentElement;
    fireEvent.pointerDown(press, { button: 0, ...start });
    fireEvent.pointerMove(onto, at);
    fireEvent.pointerUp(onto, at);
    if (shared !== null) fireEvent.click(shared, at);
  } finally {
    spy.mockRestore();
  }
}
