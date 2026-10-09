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

import { ANSWER_KIND, ANSWER_TESTID, SELF_ANSWERING } from '../../apps/ui/src/play/prompts/answer-table.ts';

export { SELF_ANSWERING };

/**
 * Answer the prompt showing on `page`, if any. Returns its method and callId,
 * or null when nothing is showing, it answers itself, or its method is one the
 * caller asked to `leave` open. `leave` is decided from the same read the
 * answer is scoped to, so an ask that opens between a caller's own check and
 * this call can never be answered by mistake.
 */
export async function answerPrompt(
  page: Page,
  opts: { leave?: readonly string[] } = {},
): Promise<{ method: string; callId: string } | null> {
  // Read both attributes in one step: a self-answering prompt can vanish
  // between two separate reads.
  const showing = await page
    .getByTestId('live-prompt')
    .evaluateAll((els) => els.map((e) => ({ method: e.getAttribute('data-method') ?? '', callId: e.getAttribute('data-call-id') ?? '' })));
  const top = showing[0];
  if (top === undefined || SELF_ANSWERING.has(top.method)) return null;
  if (opts.leave?.includes(top.method)) return null;
  const { method, callId } = top;
  const sheet = page.locator(`[data-testid="live-prompt"][data-call-id="${callId}"]`);
  const submit = sheet.getByTestId(ANSWER_TESTID.submit);
  const submittable = async () => (await submit.count()) > 0 && (await submit.isEnabled());
  const kind = ANSWER_KIND[method];
  if (kind === undefined) throw new Error(`no hands for a ${method} prompt`);

  switch (kind) {
    case 'bar-default':
      await sheet.locator('.confirm__button[data-default]').click();
      break;
    case 'default-option': {
      const preferred = sheet.locator(`[data-testid="${ANSWER_TESTID.option}"][data-default]`);
      await ((await preferred.count()) > 0 ? preferred.first() : sheet.getByTestId(ANSWER_TESTID.option).first()).click();
      break;
    }
    case 'input': {
      const input = sheet.locator(`input[data-testid="${ANSWER_TESTID.input}"]`);
      if ((await input.count()) > 0) await input.fill('1');
      await submit.click();
      break;
    }
    case 'choice-or-cancel': {
      const choice = sheet.getByTestId(ANSWER_TESTID.choice);
      await ((await choice.count()) > 0 ? choice.first() : sheet.getByTestId(ANSWER_TESTID.cancel)).click();
      break;
    }
    case 'tick-until-submittable': {
      const choices = sheet.locator(`input[data-testid="${ANSWER_TESTID.choice}"]`);
      const count = await choices.count();
      // The file's own header: "the default, the first option" — not
      // "decline, because declining is already a legal answer." An ask whose
      // bounds allow zero (`ask.min === 0`, e.g. an "Up to 1" single-target
      // choice) is submittable with nothing ticked from the start, so the old
      // loop below (which only ticks while NOT YET submittable) never ran at
      // all and silently answered "none" — observed against a real match
      // (wave 34 §E1, Full Control): Mana Leak's own lone legal target is
      // asked as optional on the wire, and answering "no target" is accepted
      // by Forge but leaves the spell with nothing to do, so the cast never
      // reaches the stack. Ticking the first offered, choosable option
      // (`UnofferedRow` renders no `prompt-choice` input, so this never picks
      // something not actually offered) before the submittable-loop makes
      // the driver's OWN stated default real for every ask shape that has at
      // least one real choice, optional or not.
      //
      // `{ force: true }`: a CARD choice's input sits under its own
      // `ChoiceTile` inside the same `<label>` (`PromptShell.tsx`'s
      // `promptCardTile`), which Playwright's actionability check sees as
      // intercepting pointer events on the raw input even though a real
      // click anywhere in the label toggles it natively — measured against
      // this exact ask (a single card target). `force` still clicks the
      // INPUT itself, not a different element; a plain-text choice (no
      // card tile) has nothing to intercept it and behaves identically
      // either way.
      if (count > 0 && !(await choices.first().isChecked())) await choices.first().click({ force: true });
      for (let i = 1; i < count && !(await submittable()); i++) {
        if (!(await choices.nth(i).isChecked())) await choices.nth(i).click({ force: true });
      }
      await submit.click();
      break;
    }
    case 'auto-then-submit':
      await sheet.getByTestId(ANSWER_TESTID.auto).click();
      await submit.click();
      break;
    case 'increment-until-submittable':
      for (let guard = 0; guard < 100 && !(await submittable()); guard++) {
        const more = sheet.locator('button[aria-label^="more to"]:enabled');
        if ((await more.count()) === 0) break;
        await more.first().click();
      }
      await submit.click();
      break;
    case 'order-until-submittable': {
      const places = sheet.locator(`[data-testid="${ANSWER_TESTID.orderSource}"] > li`);
      for (let guard = 0; guard < 100 && !(await submittable()) && (await places.count()) > 0; guard++) {
        await places.first().click();
      }
      await submit.click();
      break;
    }
    case 'submit-only':
      await submit.click();
      break;
    case 'self-answering':
      // Excluded above (`SELF_ANSWERING`); unreachable, kept so the switch is exhaustive.
      throw new Error(`no hands for a ${method} prompt`);
  }
  return { method, callId };
}

/**
 * Answer a lone `getAbilityToPlay` offer (`ChoicePrompts.tsx`'s
 * `GetAbilityToPlayPrompt`, one `[data-testid="prompt-choice"]` button) by
 * clicking it — the one ask `rules.ts`'s `autoAnswer` would otherwise settle
 * on its own, EXCEPT while full control is on (`LiveBoard.tsx`: `const auto
 * = pending === null || match.fullControl || spectator ? null :
 * autoAnswer(pending)` — full control suppresses every auto-answer, not only
 * the stack-target one). Every cast goes through exactly this ask (one
 * ability, "Counter target spell.") before Forge ever opens a target choice;
 * a full-control seat has to click through it by hand. `false`, nothing
 * touched, when it is not showing — so a cast loop can call it every tick.
 */
export async function answerLoneAbility(page: Page): Promise<boolean> {
  // Scoped to `GetAbilityToPlayPrompt`'s own `data-prompt` (`PromptShell`'s
  // `method` prop): `[data-testid="prompt-choice"]` is shared with OTHER
  // prompt types (a checkbox-based `getChoices` list among them), whose
  // choices need a SEPARATE submit click, not one click to answer — measured
  // directly: an unscoped click here landed on a `getChoices` checkbox by the
  // time Playwright's actionability wait resolved, which only toggles a box.
  const choice = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]');
  if ((await choice.count()) !== 1) return false;
  await choice.click().catch(() => undefined);
  return true;
}
