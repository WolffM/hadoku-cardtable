/**
 * Item 1, at phone width (390×844). Same scenario as the desktop spec — see
 * `./w90a-chat-before-join.ts` — because the gate lives in `App.tsx`, which does not branch on
 * viewport; this file exists so the brief's "red first, phone and desktop" is literally two runs,
 * not one asserted to stand in for both.
 */
import { test } from '@playwright/test';

import { PHONE } from './play/phone.ts';
import { chatBeforeJoinScenario } from './w90a-chat-before-join.ts';

test.use(PHONE);

test('a password room shows no chat to a non-member who opens it directly; the right password reveals it; a member’s reload keeps it — phone', async ({ browser }) => {
  test.setTimeout(60_000);
  await chatBeforeJoinScenario(browser);
});
