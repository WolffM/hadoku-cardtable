/**
 * The operator, 2026-10-11, casting Nissa, Vastwood Seer (when she enters, search your library for a
 * basic Forest card, reveal it, put it into your hand):
 *
 *   - *"i dont need to see 'not offered' text in this list, it makes the list much longer than it needs
 *     to be."*
 *   - *"the text is showing: 'Nissa, Vastwood Seer - Looking at cards in from Bella's Library' this is a
 *     bit ugly, also 'from Bella's Library' is in a different font."*
 *   - *"a hangerback walker appeared on my board suddenly when i did this. i guess because it was my top
 *     card? … it doesn't make sense that it would happen here, i'm just searching my library."*
 *
 * Scenario `w70-nissa`: alice drags Nissa from her hand onto her battlefield and pays with her three
 * Forests; her library has a creature (Serra Angel) on top and two Forests among eight cards. When the search
 * opens on her screen, its list holds only the Forests she may choose, its caption is one sentence in one
 * font, and neither screen draws a library card on the board — not while she searches, and not after
 * she takes a Forest.
 */
import { expect, test, type Page } from '@playwright/test';

import { castByDrag, enabledOk, handCardNamed, livePrompt, makeTitled, passOverStack, says } from './play/board.ts';
import { confirmOpen, confirmYes } from './play/confirm.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const SEARCH_METHODS = ['chooseSingleEntityForEffect', 'chooseEntitiesForEffect'];
const search = (page: Page) => page.locator(SEARCH_METHODS.map((m) => `[data-testid="live-prompt"][data-method="${m}"]`).join(', '));

/** Every library card a screen draws on the table, by name. */
const libraryOnBoard = (page: Page): Promise<string[]> =>
  page.locator('.seat [data-library-top] .card__name').allTextContents().then((t) => t.map((s) => s.trim()));

const handNames = (page: Page): Promise<string[]> =>
  page.locator('[data-zone="hand"][data-owner="you"] .card__name').allTextContents().then((t) => t.map((s) => s.trim()));

test(titled("Nissa's Forest search lists only the Forests, says so in one clean sentence, and draws no library card on the board"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w70-nissa');
    const pages = [alice.page, bob.page];
    const seen: string[] = [];
    const watchBoards = async (when: string) => {
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const names = await libraryOnBoard(page);
        if (names.length > 0) {
          const line = `${when}: ${who}'s board draws library card(s) [${names.join(', ')}]`;
          if (!seen.includes(line)) {
            seen.push(line);
            console.log(`[w70-nissa] ${line}`);
          }
        }
      }
    };

    const nissa = await handCardNamed(alice.page, 'Nissa, Vastwood Seer');
    expect(nissa, 'Nissa is in alice’s hand').toBeDefined();
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await castByDrag(alice.page, stack, nissa!, { x: field.x + field.width / 2, y: field.y + field.height / 2 });
    console.log(`[w70-nissa] Nissa is on the stack; alice says: "${await says(alice.page)}"`);

    // Both pass until Nissa resolves and her trigger searches; alice says yes to the optional trigger.
    const deadline = Date.now() + 90_000;
    while ((await search(alice.page).count()) === 0 && Date.now() < deadline) {
      await watchBoards('before the search');
      if (await confirmOpen(alice.page)) {
        console.log(`[w70-nissa] alice is asked: "${await says(alice.page)}" — she presses Yes`);
        await confirmYes(alice.page).click({ timeout: 1_000 }).catch(() => undefined);
        await alice.page.waitForTimeout(150);
        continue;
      }
      for (const p of pages) await answerPrompt(p, { leave: SEARCH_METHODS });
      if ((await search(alice.page).count()) > 0) break;
      for (const p of pages) {
        const ok = enabledOk(p).first();
        if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
      }
      await alice.page.waitForTimeout(60);
    }
    const sheet = search(alice.page).first();
    await expect(sheet, 'the Forest search opens on alice’s screen').toHaveCount(1);
    // Let any state frame that rides with the ask land before reading the boards.
    await alice.page.waitForTimeout(1_500);
    await watchBoards('during the search');

    // 1. The list is only what she may choose.
    // The search's own rows: the sheet's other lists (its problems row, which keeps a placeholder line) are not choices.
    const rows = await sheet.locator(':is(.prompt__cards, .prompt__list) > li').evaluateAll((els) =>
      els.map((e) => `${e.querySelector('.card__name')?.textContent?.trim() ?? e.textContent?.trim() ?? '?'}${e.getAttribute('data-choosable') === 'false' ? ' (not offered)' : ''}`),
    );
    console.log(`[w70-nissa] search rows: [${rows.join(', ')}]`);
    expect.soft(await sheet.getByText('not offered').count(), 'no row says "not offered"').toBe(0);
    expect.soft(rows, 'the list holds exactly the two Forests she may choose').toEqual(['Forest', 'Forest']);

    // 2. The caption is one sentence, in one font.
    const caption = sheet.getByTestId('prompt-reveal');
    const text = ((await caption.count()) > 0 ? await caption.textContent() : '')?.replace(/\s+/g, ' ').trim() ?? '';
    const fonts = (await caption.count()) > 0
      ? await caption.evaluate((el) => [el, ...Array.from(el.querySelectorAll('*'))].map((e) => { const s = getComputedStyle(e); return `${s.fontFamily} ${s.fontSize} ${s.color}`; }))
      : [];
    console.log(`[w70-nissa] caption: "${text}" fonts: [${[...new Set(fonts)].join(' | ')}]`);
    expect.soft(text, 'the caption is a clean sentence naming Nissa and the library').toMatch(/^Nissa, Vastwood Seer: searching \S+ library$/);
    expect.soft(new Set(fonts).size, 'the caption is drawn in one font').toBe(1);

    // 3. No library card on either board while she searches.
    expect.soft(await libraryOnBoard(alice.page), 'alice’s board draws no library card while she searches').toEqual([]);
    expect.soft(await libraryOnBoard(bob.page), 'bob’s board draws no library card while alice searches').toEqual([]);

    // She takes a Forest; it goes to her hand, and still no library card shows on the board.
    const handBefore = (await handNames(alice.page)).filter((n) => n === 'Forest').length;
    const answered = await answerPrompt(alice.page);
    console.log(`[w70-nissa] alice answered the search: ${answered?.method ?? 'nothing'}`);
    const after = Date.now() + 30_000;
    while (Date.now() < after) {
      await watchBoards('after the search');
      if ((await handNames(alice.page)).filter((n) => n === 'Forest').length > handBefore) break;
      if (await confirmOpen(alice.page)) await confirmYes(alice.page).click({ timeout: 1_000 }).catch(() => undefined);
      for (const p of pages) await answerPrompt(p);
      await alice.page.waitForTimeout(60);
    }
    console.log(`[w70-nissa] alice's hand after the search: [${(await handNames(alice.page)).join(', ')}]; prompts open: ${await livePrompt(alice.page).count()}`);
    expect((await handNames(alice.page)).filter((n) => n === 'Forest').length, 'the Forest reached alice’s hand').toBeGreaterThan(handBefore);
    for (let i = 0; i < 20; i++) {
      await watchBoards('after the search');
      await alice.page.waitForTimeout(100);
    }
    console.log(`[w70-nissa] library cards ever drawn on a board: [${seen.join(' | ')}]`);
    expect(seen, 'no library card was ever drawn on a board').toEqual([]);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-11, on a scry 1: *"it placed the scry'd card directly on the board. that's ugly, we
 * should have a proper decision card for this"*. Scenario `w70-scry-one`: alice casts Opt twice by dragging
 * it from her hand. Each time Forge asks Top or Bottom of one card on its button bar
 * (`PlayerControllerHuman.willPutCardOnTop`): her decision window draws that card, neither board ever
 * draws it, and both answers do what they say — Top keeps Serra Angel on top for Opt to draw, Bottom sends
 * Grizzly Bears away so Opt draws Swamp.
 */
test(titled('a scry 1 shows its card in the decision window, never on the board, and Top and Bottom both work'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w70-scry-one');
    const pages = [alice.page, bob.page];
    const seen: string[] = [];
    const watchBoards = async (when: string) => {
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const names = await libraryOnBoard(page);
        const line = `${when}: ${who}'s board draws library card(s) [${names.join(', ')}]`;
        if (names.length > 0 && !seen.includes(line)) {
          seen.push(line);
          console.log(`[w70-scry-one] ${line}`);
        }
      }
    };
    /** Answer what Forge asks and pass priority while a spell waits — never the empty-stack Next Phase. */
    const pump = async () => {
      for (const p of pages) await answerPrompt(p);
      for (const p of pages) await passOverStack(p);
      await alice.page.waitForTimeout(60);
    };
    const confirm = alice.page.getByTestId('live-confirm');
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;

    for (const [answer, scried, drawn] of [['Top', 'Serra Angel', 'Serra Angel'], ['Bottom', 'Grizzly Bears', 'Swamp']] as const) {
      const opt = await handCardNamed(alice.page, 'Opt');
      expect(opt, 'an Opt is in alice’s hand').toBeDefined();
      await castByDrag(alice.page, stack, opt!, { x: field.x + field.width / 2, y: field.y + field.height / 2 });
      console.log(`[w70-scry-one] Opt is on the stack; alice says: "${await says(alice.page)}"`);

      const deadline = Date.now() + 60_000;
      while ((await confirm.count()) === 0 && Date.now() < deadline) {
        await watchBoards(`before the ${answer} scry`);
        await pump();
      }
      await expect(confirm, `the ${answer} scry opens a decision on alice’s screen`).toHaveCount(1);
      await alice.page.waitForTimeout(1_000);
      await watchBoards(`during the ${answer} scry`);
      const message = (await confirm.locator('.confirm__message').textContent())?.trim() ?? '';
      const labels = (await confirm.locator('.confirm__button').allTextContents()).map((s) => s.trim());
      const shown = (await confirm.getByTestId('confirm-card').locator('.card__name').allTextContents()).map((s) => s.trim());
      console.log(`[w70-scry-one] decision: "${message}" buttons [${labels.join(', ')}] card [${shown.join(', ')}]`);
      // Top is Forge's yes (`willPutCardOnTop`), and the yes is always bottom right (`AnswerRow`).
      expect.soft(labels, 'Bottom, then Top: the yes last').toEqual(['Bottom', 'Top']);
      expect.soft(shown, 'the decision window draws the scried card').toEqual([scried]);
      expect.soft(await libraryOnBoard(alice.page), 'alice’s board draws no library card during the scry').toEqual([]);
      expect.soft(await libraryOnBoard(bob.page), 'bob’s board draws no library card during the scry').toEqual([]);

      await confirm.getByRole('button', { name: answer, exact: true }).click();
      const until = Date.now() + 30_000;
      while (Date.now() < until && !(await handNames(alice.page)).includes(drawn)) {
        await watchBoards(`after the ${answer} scry`);
        await pump();
      }
      const hand = await handNames(alice.page);
      console.log(`[w70-scry-one] after ${answer}: alice's hand [${hand.join(', ')}]`);
      expect(hand, `${answer}: Opt draws ${drawn}`).toContain(drawn);
      for (let i = 0; i < 10; i++) {
        await watchBoards(`after the ${answer} scry`);
        await alice.page.waitForTimeout(100);
      }
    }
    console.log(`[w70-scry-one] library cards ever drawn on a board: [${seen.join(' | ')}]`);
    expect(seen, 'no scried card was ever drawn on a board').toEqual([]);
  } finally {
    await stack.stop();
  }
});
