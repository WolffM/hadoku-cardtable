/**
 * Wave 36 T4, shape 1: every Forge yes/no that is a QUESTION (not a priority
 * pass) now renders in the decision area, not the control bar
 * (`apps/ui/src/play/prompts/ConfirmPrompt.tsx`, lane G;
 * `docs/planning/wave36-evidence/g-shape1.md` is the wiring note this file
 * follows). The two buttons carry fixed testids regardless of which
 * question is open — `prompt-confirm-yes` is Forge's own button 1
 * (`InputConfirm`'s `result = true` side: Keep, Yes, Heads, Top, …),
 * `prompt-confirm-no` is button 2 (Mulligan, No, Tails, Bottom, …).
 *
 * This is the ONE place every e2e caller that used to answer a yes/no
 * through `live-button-ok`/`live-button-cancel` now goes through — see each
 * spec file's own history for which call sites moved and which (priority
 * passes, mana payment, targeting, selections) did not.
 */

import type { Locator, Page } from '@playwright/test';

export const confirmYes = (page: Page): Locator => page.getByTestId('prompt-confirm-yes');
export const confirmNo = (page: Page): Locator => page.getByTestId('prompt-confirm-no');

/** True while a `ConfirmPrompt` is showing, on this page, right now. */
export async function confirmOpen(page: Page): Promise<boolean> {
  return (await confirmYes(page).count()) > 0;
}

/**
 * Answer the confirm pop-up showing on `page`: `'yes'` clicks Forge's own
 * button 1 (`prompt-confirm-yes`), `'no'` clicks button 2
 * (`prompt-confirm-no`). The button's TEXT is whichever label Forge sent
 * (Keep/Mulligan, Yes/No, Heads/Tails, …) — this clicks by testid, never by
 * text, so it answers any of them the same way.
 */
export async function answerConfirm(page: Page, answer: 'yes' | 'no'): Promise<void> {
  const button = answer === 'yes' ? confirmYes(page) : confirmNo(page);
  await button.click({ timeout: 2_000 });
}
