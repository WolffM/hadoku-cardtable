/**
 * A person's hands on the prompt the board is showing, in a real browser.
 *
 * The Playwright twin of `apps/ui/src/play/live/prompt-driver.ts` (which drives
 * the same components under jsdom with `fireEvent`): real clicks on the
 * rendered prompt, and nothing else — never `answerAsk`, never the socket. What
 * reaches the server is whatever the COMPONENT built and checked.
 *
 * The choices are deliberately plain (the default, the first option, the
 * component's own Auto). The point is that the answer round-trips.
 */

import type { Page } from '@playwright/test';

/** Asks the board answers on its own, on mount (`ZonePrompts.tsx`): nobody clicks them. */
export const SELF_ANSWERING = new Set(['tempShowZones', 'openZones']);

/**
 * Answer the prompt showing on `page`, if any. Returns its method and callId,
 * or null when nothing is showing or it answers itself.
 */
export async function answerPrompt(page: Page): Promise<{ method: string; callId: string } | null> {
  // Read both attributes in one step: a self-answering prompt can vanish
  // between two separate reads.
  const showing = await page
    .getByTestId('live-prompt')
    .evaluateAll((els) => els.map((e) => ({ method: e.getAttribute('data-method') ?? '', callId: e.getAttribute('data-call-id') ?? '' })));
  const top = showing[0];
  if (top === undefined || SELF_ANSWERING.has(top.method)) return null;
  const { method, callId } = top;
  const sheet = page.locator(`[data-testid="live-prompt"][data-call-id="${callId}"]`);
  const submit = sheet.getByTestId('prompt-submit');
  const submittable = async () => (await submit.count()) > 0 && (await submit.isEnabled());

  switch (method) {
    case 'showConfirmDialog':
      await sheet.locator('.confirm__button[data-default]').click();
      break;
    case 'confirm':
    case 'showOptionDialog': {
      const preferred = sheet.locator('[data-testid="prompt-option"][data-default]');
      await ((await preferred.count()) > 0 ? preferred.first() : sheet.getByTestId('prompt-option').first()).click();
      break;
    }
    case 'showInputDialog': {
      const input = sheet.locator('input[data-testid="prompt-input"]');
      if ((await input.count()) > 0) await input.fill('1');
      await submit.click();
      break;
    }
    case 'getAbilityToPlay': {
      const choice = sheet.getByTestId('prompt-choice');
      await ((await choice.count()) > 0 ? choice.first() : sheet.getByTestId('prompt-cancel')).click();
      break;
    }
    case 'getChoices':
    case 'chooseSingleEntityForEffect':
    case 'chooseEntitiesForEffect': {
      const choices = sheet.locator('input[data-testid="prompt-choice"]');
      for (let i = 0; i < (await choices.count()) && !(await submittable()); i++) {
        if (!(await choices.nth(i).isChecked())) await choices.nth(i).click();
      }
      await submit.click();
      break;
    }
    case 'assignCombatDamage':
      await sheet.getByTestId('prompt-auto').click();
      await submit.click();
      break;
    case 'assignGenericAmount':
      for (let guard = 0; guard < 100 && !(await submittable()); guard++) {
        const more = sheet.locator('button[aria-label^="more to"]:enabled');
        if ((await more.count()) === 0) break;
        await more.first().click();
      }
      await submit.click();
      break;
    case 'order': {
      const places = sheet.locator('[data-testid="order-source"] button');
      for (let guard = 0; guard < 100 && !(await submittable()) && (await places.count()) > 0; guard++) {
        await places.first().click();
      }
      await submit.click();
      break;
    }
    case 'manipulateCardList':
    case 'sideboard':
      await submit.click();
      break;
    default:
      throw new Error(`no hands for a ${method} prompt`);
  }
  return { method, callId };
}
