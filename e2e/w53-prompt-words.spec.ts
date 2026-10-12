/**
 * Wave 53 §P — Y18, against a real Forge match. The operator, 2026-10-06:
 * *"i played vensor and the decision box has this as the title: 'Select
 * target permanent or Card.inZoneStack' thats a bit ugly, can we give that
 * friendly words? it also has an ugly '<-- CARDS ON THE BATTLEFIELD -->'
 * slot at the beginning. maybe instead of doing that just use a vertical
 * line seperator?"*
 *
 * Venser, Shaper Savant (`forge/forge-gui/res/cardsfolder/v/
 * venser_shaper_savant.txt:7`: `ValidTgts$ Permanent,Card.inZoneStack`) is
 * the one card in the whole cardsfolder with exactly this shape and NEITHER
 * a `TgtPrompt$` nor a `ValidTgtsDesc$` override (confirmed by grep — see
 * `docs/planning/wave53-evidence/P/README.md`), so it is the only card that
 * reaches a real client with Forge's raw, untranslated builder output.
 * `TargetSelection.chooseCardFromList` (`TargetSelection.java:182-250`) is
 * reached whenever `TgtZone$` names more than one zone including the stack,
 * which is exactly Venser's shape — so this ask arrives as `getChoices`
 * (`AbstractGuiGame.java:771-779`: `one`/`oneOrNone` are both `getChoices`),
 * its `message` is `tgt.getVTSelection()` with no card-name prefix at all
 * (`TargetSelection.java:265-266`), and its `choices` carry the zone-group
 * marker strings the SAME method splices in (`:228-250`) as ordinary
 * `{label, ref: null}` entries (`PlayBridge.java`'s own `choices()`,
 * `:1403-1425`).
 *
 * ## The scenario
 *
 * No existing `apps/server/src/play/scenarios/*.state` deals Venser to
 * either hand — only this exact card hits the bug (this file's own module
 * header), and lane P does not own a new `.state` file (`docs/planning/
 * wave53-2026-10-06.md` §P). `w53-p-venser.state` was written by the wave
 * manager, verbatim to the content proposed in `docs/planning/
 * wave53-evidence/P/README.md` §6: bob (ai) holds a cheap instant (`Opt`)
 * and an Island; alice (human) holds Venser and 2UU of Islands, enough to
 * cast it (Flash) in response.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPs and its title says why. Serves the prebuilt
 * `apps/ui/dist`.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, enabledOk, makeTitled, promptMethod, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SCENARIO = 'w53-p-venser';

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const ids = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
  return ids[0];
}

/**
 * Answer a lone `getAbilityToPlay` offer (`ChoicePrompts.tsx`'s
 * `GetAbilityToPlayPrompt`, one `[data-testid="prompt-choice"]` button) by
 * clicking it — the ask `@hadoku/shared`'s `selfAnswer` would otherwise settle on
 * its own, EXCEPT while full control is on (`LiveBoard.tsx`: full control
 * suppresses every auto-answer, not only the stack-target one —
 * `e2e/w49-counterspell.spec.ts`'s own `answerLoneAbility`, same shape,
 * because Venser's own cast opens exactly this ask first, before Forge ever
 * asks for its target). Diagnosed against a real run: alice's `says` line
 * read "Priority: Alice … Stack: 2 to Resolve" with `promptMethod ===
 * 'getAbilityToPlay'` for the full 20s this helper used to not handle it —
 * not a selection, not silence; an unanswered ask, per the memory note.
 */
async function answerLoneAbility(page: Page): Promise<boolean> {
  const choice = page.locator('section[data-prompt="getAbilityToPlay"] [data-testid="prompt-choice"]');
  if ((await choice.count()) !== 1) return false;
  await choice.click().catch(() => undefined);
  return true;
}

/**
 * Click whichever page currently shows an enabled bar OK and nothing more
 * urgent asked of it, until EITHER page opens a `getChoices` ask — the
 * ordinary "both pass, the stack resolves" rhythm, driven on both seats at
 * once because nothing here knows in advance which one Forge will ask next.
 */
async function passUntilGetChoices(pages: readonly Page[], label: string): Promise<Page> {
  let opened: Page | null = null;
  try {
    await expect
      .poll(
        async () => {
          for (const p of pages) {
            if ((await promptMethod(p)) === 'getChoices') {
              opened = p;
              return true;
            }
          }
          for (const p of pages) {
            if (await answerLoneAbility(p)) continue;
            const ok = enabledOk(p);
            if ((await ok.count()) > 0) await ok.click().catch(() => undefined);
          }
          return false;
        },
        { timeout: 20_000, message: label },
      )
      .toBe(true);
  } catch (err) {
    // The memory note, verbatim: "a frozen status line is usually an
    // unhandled ask, not a dropped press" — dump what each page shows
    // rather than guess.
    const dump = async (p: Page, name: string) => {
      const method = await promptMethod(p);
      const text = await says(p);
      const okCount = await enabledOk(p).count();
      console.log(`[w53-P diag] ${name}: says="${text}" promptMethod=${String(method)} enabledOkCount=${okCount}`);
    };
    await dump(pages[0]!, 'alice');
    await dump(pages[1]!, 'bob');
    throw err;
  }
  if (opened === null) throw new Error(`${label}: no page ever opened a getChoices ask`);
  return opened;
}

test.describe(titled('Y18 — Venser’s own target ask reads as words, and its zone groups are a line'), () => {
  test('Select target permanent or Card.inZoneStack reads as "Select target permanent or spell", and the battlefield/stack groups are split by a drawn line, not a choice', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, SCENARIO);
      const { alice, bob } = seated;

      // Full control so nothing on alice's own side auto-answers ahead of
      // this test reading the prompt — `selfAnswer`'s lone stack target never
      // fires here regardless (Venser's own ask always offers more than one
      // option, a permanent AND a spell), but every other spec in this
      // directory does this before inspecting a prompt by hand, and it costs
      // nothing to match that.
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      // Bob casts his cheap spell first — it needs to still be ON THE STACK
      // when Venser's own trigger asks for its target.
      const bobSpell = await handCardNamed(bob.page, 'Opt');
      expect(bobSpell, 'Opt is in bob’s hand, as the scenario scripts').not.toBeUndefined();
      await castCard(bob.page, bobSpell!);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob’s Opt reached the stack' }).toBe(1);

      // Alice casts Venser (Flash) in response — the stack now holds both.
      const venser = await handCardNamed(alice.page, 'Venser, Shaper Savant');
      expect(venser, 'Venser, Shaper Savant is in alice’s hand, as the scenario scripts').not.toBeUndefined();
      await castCard(alice.page, venser!);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'alice’s Venser reached the stack' }).toBe(2);

      // Both pass; Venser resolves, enters, and its own ETB trigger asks for
      // a target while bob's Opt is still on the stack — the exact repro.
      const opened = await passUntilGetChoices([alice.page, bob.page], 'Venser’s own target ask opened');

      const prompt = opened.locator('section[data-prompt="getChoices"]').first();
      await expect(prompt, 'the getChoices prompt is up').toHaveCount(1);

      // The title: Forge's raw `Card.inZoneStack` read as "spell" — the
      // operator's own exact complaint, fixed.
      const title = prompt.locator('.prompt__title');
      await expect(title, 'the title reads as words, not Card.inZoneStack').toHaveText('Select target permanent or spell');
      await expect(prompt, 'the raw expression never reaches the DOM').not.toContainText('Card.inZoneStack');
      await expect(prompt, 'the raw expression never reaches the DOM').not.toContainText('inZoneStack');

      // The zone header: a drawn line, never a choice, never counted, never
      // focusable (Y18's second half).
      await expect(prompt, 'no literal zone-header text reaches the DOM').not.toContainText('CARDS ON');
      await expect(prompt, 'no literal zone-header text reaches the DOM').not.toContainText('CARDS IN');
      const divider = prompt.locator('li.prompt__divider');
      await expect(divider, 'the groups are split by at least one drawn line').not.toHaveCount(0);
      await expect(divider.locator('input'), 'a divider line carries no tick').toHaveCount(0);
      const dividerTabIndex = await divider.first().evaluate((el) => (el as HTMLElement).tabIndex);
      expect(dividerTabIndex, 'a divider line is not in the tab order').toBe(-1);

      // Not counted as an option: every REAL choice (a battlefield permanent
      // or bob's spell on the stack) still has its own tick, and the number
      // of ticks equals the number of real choices Forge offered — the
      // divider rows contribute zero.
      const ticks = await prompt.locator('input[data-testid="prompt-choice"]').count();
      const cardRows = await prompt.locator('li[data-card-id]').count();
      expect(ticks, 'one tick per real offered card, the dividers excluded').toBe(cardRows);
      expect(ticks, 'at least the permanent and the stacked spell are offered').toBeGreaterThanOrEqual(2);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });
});
