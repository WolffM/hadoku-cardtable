/**
 * Underground River — the operator's repeated report (Z10, Y23, AD6,
 * 2026-10-08, the fourth time): *"still dont see the mana symbol icons in
 * 'underground river'. why is it still showing 'black/blue'?"*
 *
 * `Produced$ Combo U B` is an exactly-TWO-colour mana ability.
 * `PlayerControllerHuman.chooseColor`'s `chooseColorCommon` (forge-gui)
 * checks `getGui().isLibgdxPort()` first — false for this bridge
 * (`RemoteClientGuiGame.isLibgdxPort()`), so it takes `InputConfirm`'s OTHER
 * branch: a plain `InputConfirm`, `showAndWait()`ed, which answers through
 * the ordinary bar (`showMessage`/`updateButtons`) — never
 * `getGui().confirm()`, never `confirm`/`getChoices` on the wire. The two
 * colour NAMES land as Forge's own `label1`/`label2`, and `LiveBoard.tsx`
 * mounts `ConfirmPrompt.tsx` for them (`isConfirmPrompt(bar)`) — THE
 * surface this measures. This measures BOTH places the choice can be
 * reached (tapping the land directly outside a payment, and tapping it to
 * pay a spell's cost) and prints every prompt surface's method, message and
 * option text/aria-label as `[river] method=… label="…"`, then asserts no
 * colour WORD survives in the VISIBLE text anywhere a `ManaPip` should be
 * drawn instead.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one this SKIPs and its title says why. Serves the prebuilt `apps/ui/dist`
 * — rebuild before running.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickHandCard, makeTitled, pressOffered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const card = (page: Page, id: number) => page.locator(`[data-board-card="${id}"]`);
const isTapped = (page: Page, id: number) => card(page, id).evaluate((e) => e.hasAttribute('data-tapped'));

async function ownNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} on the battlefield`);
  return ids[0];
}

async function handNamed(page: Page, name: string): Promise<number> {
  const ids = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
  if (ids[0] === undefined) throw new Error(`no ${name} in hand`);
  return ids[0];
}

/** A colour word, bare, as its own text run — never the accessible name (that one is the pip's own hover/aria-label, still a word on purpose). */
const COLOUR_WORD = /\b(black|blue|white|red|green|colou?rless)\b/i;

/**
 * Every row of whatever prompt surface is showing — `live-prompt`'s own
 * `[data-testid="prompt-option"/"prompt-choice"]` rows (the generic ask
 * machinery), OR, when that sheet is not up, `ConfirmPrompt.tsx`'s own bar
 * (`.confirm__button` — `InputConfirm`'s non-libgdx branch takes THIS one,
 * never `live-prompt`, for an exactly-two-colour choice: this module's own
 * header has the citation chain). Measured and printed — method, the row's
 * VISIBLE text, its aria-label, and whether a `ManaPip` (`.pip` / `.ms-`
 * glyph) is inside it. Returns the rows so the caller can click one.
 */
/** Every prompt row measured with a colour WORD as its visible text and no pip — the operator's "black/blue", while it is showing. */
const wordRows: string[] = [];

async function measurePrompt(page: Page, where: string): Promise<{ rows: Locator[]; method: string }> {
  const sheet = page.getByTestId('live-prompt');
  const viaPrompt = (await sheet.count()) > 0;
  const rows = viaPrompt
    ? await sheet.locator('[data-testid="prompt-option"], [data-testid="prompt-choice"]').all()
    : await page.locator('.confirm__button').all();
  if (rows.length === 0) return { rows: [], method: '' };
  const method = viaPrompt ? ((await sheet.first().getAttribute('data-method')) ?? '') : 'showConfirmDialog/bar';
  const message = await page.locator('.prompt__title, .prompt__message, .confirm__message').allTextContents();
  for (const row of rows) {
    const text = ((await row.textContent()) ?? '').trim();
    const ariaLabel = (await row.getAttribute('aria-label')) ?? '';
    const hasPip = (await row.locator('.pip, [class*="ms-"]').count()) > 0;
    console.log(`[river] where=${where} method=${method} message=${JSON.stringify(message.join(' | '))} label="${text}" aria="${ariaLabel}" pip=${hasPip}`);
    if (COLOUR_WORD.test(text) && !hasPip) wordRows.push(`${where} ${method}: "${text}"`);
  }
  return { rows, method };
}

/** Answer the prompt showing, preferring a row whose VISIBLE text or aria-label names a colour; returns whether anything was clicked. */
async function answerAndSubmit(page: Page, where: string): Promise<boolean> {
  const { rows } = await measurePrompt(page, where);
  if (rows.length === 0) return false;
  let chosen = rows[0]!;
  for (const row of rows) {
    const text = `${(await row.textContent()) ?? ''} ${(await row.getAttribute('aria-label')) ?? ''}`;
    if (COLOUR_WORD.test(text) || /damage|\{U\}|\{B\}/.test(text)) {
      chosen = row;
      break;
    }
  }
  await chosen.click();
  const submit = page.getByTestId('prompt-submit');
  if (await submit.isVisible({ timeout: 500 }).catch(() => false)) await submit.click();
  return true;
}


/**
 * Drive whatever prompt is open to completion (measuring each one as
 * `answerAndSubmit` goes), up to `rounds` prompts — a colour-choice tap opens
 * at most two in a row (the ability pick, then the colour).
 */
async function drainPrompts(page: Page, where: string, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    // Each prompt is Forge's own ask, a round trip after the press that opens it: wait for it to
    // be drawn before reading it, or a fast board reads the page before it arrives.
    const showing = await page
      .locator('.confirm__button, [data-testid="live-prompt"]')
      .first()
      .waitFor({ timeout: 3_000 })
      .then(() => true, () => false);
    if (!showing) return;
    const opened = await answerAndSubmit(page, where);
    if (!opened) return;
    await page.waitForTimeout(150);
  }
}

test(titled('measuring: tapping Underground River directly prints every prompt surface, and none shows a bare colour word'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'underground-river');
    const river = await ownNamed(alice.page, 'Underground River');
    await expect
      .poll(() => card(alice.page, river).evaluate((e) => e.hasAttribute('data-selectable')), { timeout: 45_000, message: 'the River is offered at priority' })
      .toBe(true);

    expect(await pressOffered(card(alice.page, river)), 'the River pressed').toBe(true);
    wordRows.length = 0;
    await drainPrompts(alice.page, 'direct-tap');
    expect(wordRows, 'every colour on a prompt row is drawn as a pip while the prompt shows').toEqual([]);

    await expect.poll(() => isTapped(alice.page, river), { timeout: 10_000, message: 'the River tapped for its coloured ability' }).toBe(true);

    // The one assertion this whole measurement exists to make: no surface
    // anywhere on the page shows a bare colour word as its VISIBLE text.
    const bareWords = await alice.page
      .locator('body *')
      .evaluateAll((els) =>
        els
          .filter((e) => e.children.length === 0 && /\b(black|blue)\b/i.test(e.textContent ?? ''))
          .map((e) => `${e.tagName}.${e.className || '(no class)'}: "${e.textContent}"`),
      );
    expect(bareWords, 'no leaf element\'s visible text is a bare colour word').toEqual([]);
  } finally {
    await stack.stop();
  }
});

test(titled('measuring: tapping Underground River to PAY for Dark Ritual prints every prompt surface, and none shows a bare colour word'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'underground-river');
    const river = await ownNamed(alice.page, 'Underground River');
    const ritual = await handNamed(alice.page, 'Dark Ritual');
    await expect
      .poll(() => card(alice.page, river).evaluate((e) => e.hasAttribute('data-selectable')), { timeout: 45_000, message: 'the River is offered at priority' })
      .toBe(true);

    // Lift Dark Ritual out of the hand and release it on the viewer's own battlefield — the one
    // cast gesture every spec uses (`board.ts`'s own header, Arena model). No target (`A:SP$ Mana`,
    // no `ValidTgts$`), so whatever Forge needs next is the cost alone: either the payment window
    // (manual tap), or — with only the one untapped source able to pay — `InputPayMana`'s own
    // auto-pay completing it without a window at all, still through the SAME colour-choice bar.
    expect(await clickHandCard(alice.page, ritual), 'Dark Ritual armed the cast gesture').toBe(true);
    const next = await Promise.race([
      alice.page.getByTestId('live-payment').waitFor({ timeout: 15_000 }).then(() => 'payment' as const),
      alice.page.locator('.confirm__button, [data-testid="live-prompt"]').first().waitFor({ timeout: 15_000 }).then(() => 'bar' as const),
    ]).catch(() => 'none' as const);
    console.log(`[river] where=pay-tap next=${next} says="${await says(alice.page)}"`);

    if (next === 'payment') {
      // Tap the River itself to pay — the same board button, mid-payment.
      expect(await pressOffered(card(alice.page, river)), 'the River pressed to pay').toBe(true);
    }
    wordRows.length = 0;
    await drainPrompts(alice.page, 'pay-tap');
    expect(wordRows, 'every colour on a prompt row is drawn as a pip while the prompt shows').toEqual([]);

    await expect.poll(() => isTapped(alice.page, river), { timeout: 10_000, message: 'the River tapped to pay' }).toBe(true);

    const bareWords = await alice.page
      .locator('body *')
      .evaluateAll((els) =>
        els
          .filter((e) => e.children.length === 0 && /\b(black|blue)\b/i.test(e.textContent ?? ''))
          .map((e) => `${e.tagName}.${e.className || '(no class)'}: "${e.textContent}"`),
      );
    expect(bareWords, 'no leaf element\'s visible text is a bare colour word, mid-payment either').toEqual([]);
  } finally {
    await stack.stop();
  }
});
