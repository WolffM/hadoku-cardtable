/**
 * `grindPriority` stops pressing the moment its condition holds — against stand-in pages, no browser.
 *
 *   node --test grind.test.ts
 *
 * One page's press can be the one that meets the condition; a press on the next page after that lands
 * past the point the caller stops at. In turn-edge (run 39752707376) alice's OK began Bob's turn and
 * Bob's press 123 ms later ended it, so the spec measured turn 2 on a table already in turn 3.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Page } from '@playwright/test';

import { grindPriority } from './play/board.ts';

/** A page with no prompt open and an empty stack, which is all `answerPrompt` reads. */
const page = (name: string): Page =>
  ({ name, evaluate: async () => ({ stack: 0, top: undefined }), waitForTimeout: async () => undefined }) as unknown as Page;

test('no page is pressed once an earlier page’s press has met the condition', async () => {
  const alice = page('alice');
  const bob = page('bob');
  let met = false;
  const late: Page[] = [];
  await grindPriority([alice, bob], async () => met, {
    press: async (p) => {
      if (met) late.push(p);
      if (p === alice) met = true;
    },
  });
  assert.deepEqual(late, []);
});
