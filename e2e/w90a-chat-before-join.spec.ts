/**
 * Item 1, desktop. See `./w90a-chat-before-join.ts` for the scenario and why "no websocket
 * opened" is not one of the assertions in this harness.
 */
import { test } from '@playwright/test';

import { chatBeforeJoinScenario } from './w90a-chat-before-join.ts';

test('a password room shows no chat to a non-member who opens it directly; the right password reveals it; a member’s reload keeps it', async ({ browser }) => {
  test.setTimeout(60_000);
  await chatBeforeJoinScenario(browser);
});
