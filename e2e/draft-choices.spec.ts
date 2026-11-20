/**
 * The cards that ask several seats, in a real room (`@hadoku/draft`'s
 * `actions/choices.ts`), one test a card:
 *
 * - Paliano, the High City is revealed, then the seat to its drafter's right,
 *   its drafter and the seat to its left each choose a colour on their own
 *   screen, from the ones not yet chosen, and the table is told the three.
 * - Deal Broker runs after the last pick: its holder reveals a card of its
 *   pool, another person offers one of theirs, which only the holder is shown,
 *   the holder accepts, the two cards change pools, and only then does the
 *   room go on to deck building.
 *
 * Half of the seeded cube is the card under test, so the AI seats draft it
 * too, and a card of theirs may ask alice or bob as well. Every such question
 * is answered with its first choice and never mistaken for the one under test,
 * which is told apart by whose card it names.
 *
 * `draftActions.ts` has the seeded cube and the dealt pod every test here starts from.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { dealPod, logLines, PACK_TIMEOUT, packCards, packNames, packOfSize, pickNamed, seedCube, UI_TIMEOUT } from './draftActions.ts';
import { makeTitled } from './play/board.ts';
import { openFriend, type Friend as Player } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const PALIANO = 'Paliano, the High City';
const BROKER = 'Deal Broker';

const asks = (page: Page) => page.getByTestId('draft-ask');
const optionKeys = (ask: Locator) => ask.getByTestId('draft-ask-option').evaluateAll((els) => els.map((el) => el.getAttribute('data-key')));
const askCards = (ask: Locator) => ask.locator('button[data-testid="card"]');
const cardNames = async (cards: Locator) => (await cards.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))).map((l) => l.replace(/^Pick /, ''));

/** What tells the question in front of the viewer from the one that follows it: how many are open, which it is, its words and its choices. */
async function signature(page: Page): Promise<string> {
  // Read in one step: a question may leave the page between two looks at it.
  return asks(page).evaluateAll((els) => {
    const first = els[0];
    if (first === undefined) return 'none';
    const keys = [...first.querySelectorAll('[data-testid="draft-ask-option"]')].map((o) => o.getAttribute('data-key'));
    return [els.length, first.getAttribute('data-ask'), first.querySelector('.draft__ask-title')?.textContent, ...keys].join('|');
  });
}

/**
 * The question in front of the viewer whose words end with `words`. Any other
 * question in front of it first (an AI seat's own card asking) is answered
 * with its first choice: questions are drawn one at a time, oldest first.
 */
async function askEnding(page: Page, words: string, what: string): Promise<Locator> {
  for (;;) {
    const first = asks(page).first();
    await expect(first, what).toBeVisible({ timeout: PACK_TIMEOUT });
    if ((await first.locator('.draft__ask-title').innerText()).endsWith(words)) return first;
    await answerFirst(page);
  }
}

/** Answers the question in front of the viewer with its first choice, and waits for it to give way. */
async function answerFirst(page: Page): Promise<void> {
  const before = await signature(page);
  await asks(page).first().getByTestId('draft-ask-option').first().click();
  await expect.poll(() => signature(page), { timeout: UI_TIMEOUT, message: 'the answered question gives way to the next' }).not.toBe(before);
}

/**
 * Picks `name` as the viewer's pick number `pool`. A seat with a question open
 * picks nothing, and an AI seat's card may ask at any moment, so whatever is
 * asked is answered first and the pick is made again if it was refused.
 */
async function pickPast(page: Page, name: string, pool: number): Promise<void> {
  const count = page.getByTestId('pool-count');
  await expect(async () => {
    while ((await asks(page).count()) > 0) await answerFirst(page);
    if ((await count.innerText()) !== String(pool)) await pickNamed(page, name);
    await expect(count).toHaveText(String(pool), { timeout: 3_000 });
  }).toPass({ timeout: PACK_TIMEOUT });
}

/**
 * The viewer's pack of `size` cards, ready to pick from. An AI seat that
 * drafted the card under test asks its neighbours first, and a seat with a
 * question open picks nothing: whatever is asked is answered on the way.
 */
async function packPast(page: Page, size: number): Promise<string[]> {
  await expect(async () => {
    while ((await asks(page).count()) > 0) await answerFirst(page);
    await expect(packCards(page)).toHaveCount(size, { timeout: 3_000 });
  }).toPass({ timeout: PACK_TIMEOUT });
  return packNames(page);
}

test(
  titled('Paliano, the High City: the seat to the right, its drafter and the seat to the left each choose a colour, and the table is told the three'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(8 * 60_000);

    seedCube(PALIANO);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);
      const mine = 'Choose a color for e2e-alice';

      /* ── alice drafts a Paliano: the table is told she revealed it ── */
      const first = await packPast(alice.page, 15);
      expect(first, 'the first pack holds a Paliano').toContain(PALIANO);
      await packPast(bob.page, 15);
      await pickPast(alice.page, PALIANO, 1);
      for (const p of players) {
        await expect(logLines(p.page).filter({ hasText: `e2e-alice revealed ${PALIANO}` }), `${p.name}: is told she revealed it`).not.toHaveCount(0, { timeout: UI_TIMEOUT });
      }

      /* ── the AI seat to her right has chosen (the first colour offered); she is asked next, for another ── */
      const hers = await askEnding(alice.page, mine, 'alice is asked for a colour');
      await expect(hers).toHaveAttribute('data-source', PALIANO);
      expect(await optionKeys(hers), 'white is taken by the seat to her right').toEqual(['blue', 'black', 'red', 'green']);
      await expect(asks(bob.page).filter({ hasText: mine }), 'bob is not asked before she has chosen').toHaveCount(0);
      await hers.locator('[data-testid="draft-ask-option"][data-key="red"]').click();
      await expect(asks(alice.page).filter({ hasText: mine }), 'her question is answered').toHaveCount(0, { timeout: UI_TIMEOUT });

      /* ── bob, to her left, is asked on his own screen for a third, in the middle of his own pick ── */
      const his = await askEnding(bob.page, mine, 'bob is asked for a colour');
      await expect(his).toHaveAttribute('data-source', PALIANO);
      expect(await optionKeys(his), 'white and red are taken').toEqual(['blue', 'black', 'green']);
      await expect(bob.page.locator('[data-testid="pack"] [data-testid="card"]'), 'his pack is still in front of him, untouched').toHaveCount(15);
      await his.locator('[data-testid="draft-ask-option"][data-key="green"]').click();
      await expect(asks(bob.page).filter({ hasText: mine }), 'his question is answered').toHaveCount(0, { timeout: UI_TIMEOUT });

      /* ── the three colours, in the order chosen, on both screens ── */
      for (const p of players) {
        await expect(logLines(p.page).filter({ hasText: `e2e-alice noted white, red, green for ${PALIANO}` }), `${p.name}: is told the three colours`).toHaveCount(1, { timeout: UI_TIMEOUT });
      }

      /* ── and bob drafts on ── */
      await pickPast(bob.page, (await packNames(bob.page)).find((n) => n !== PALIANO) ?? PALIANO, 1);
    } finally {
      await stack.stop();
    }
  },
);

type Stop = 'done' | 'ask';

/**
 * Picks until a question is in front of the viewer or the room has gone on to
 * the deck builder: a card that is not a Deal Broker whenever the pack holds
 * one, so a person ends the draft with as few Deal Brokers as the packs allow.
 */
async function draftOn(page: Page): Promise<Stop> {
  for (;;) {
    const next = await page.waitForFunction(
      () => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        if (document.querySelector('[data-testid="draft-ask"]') !== null) return 'ask';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      null,
      { timeout: 5 * 60_000, polling: 50 },
    );
    const what = (await next.jsonValue()) as Stop | 'pick';
    if (what !== 'pick') return what;
    const names = await packNames(page);
    const at = names.findIndex((n) => n !== BROKER);
    // The pack may be gone by the time it is pressed (the server took its last card for the seat): the loop looks again.
    const pressed = await packCards(page).nth(Math.max(0, at)).click({ timeout: 3_000 }).then(() => true, () => false);
    if (!pressed) continue;
    // Paced under the server's own pick rate limit (`podSeats.ts`'s `draftUntilDone`).
    await page.waitForTimeout(400);
  }
}

/** Declines every question still put to the viewer until the room has gone on to the deck builder. */
async function declineToTheEnd(page: Page): Promise<void> {
  while ((await draftOn(page)) === 'ask') {
    const before = await signature(page);
    await asks(page).first().locator('[data-testid="draft-ask-option"][data-key="no"]').click();
    await expect.poll(async () => (page.url().includes('#/deck/') ? 'done' : signature(page)), { timeout: UI_TIMEOUT, message: 'the declined question gives way' }).not.toBe(before);
  }
}

test(
  titled('Deal Broker: after the last pick its holder reveals a card, is shown another person’s offer alone, accepts it, and the room then goes on to deck building'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(20 * 60_000);

    seedCube(BROKER);

    const stack = await startPlayStack(forge);
    try {
      const alice: Player = await openFriend(browser, 'alice');
      const bob: Player = await openFriend(browser, 'bob');
      const players = [alice, bob];
      await dealPod(alice, bob, stack.origin);

      /* ── alice drafts a Deal Broker face up; nothing is asked while the draft runs ── */
      const first = await packOfSize(alice.page, 15, "alice's first pack");
      expect(first, 'the first pack holds a Deal Broker').toContain(BROKER);
      await pickNamed(alice.page, BROKER);
      for (const p of players) await expect(p.page.getByTestId('face-up-0'), `${p.name}: sees alice's Deal Broker face up`).toContainText(BROKER, { timeout: UI_TIMEOUT });
      await expect(asks(alice.page), 'it asks nothing yet').toHaveCount(0);
      // Bob drafts one too: his runs after hers, so the draft cannot end before he has answered it.
      await packOfSize(bob.page, 15, "bob's own first pack");
      await pickNamed(bob.page, BROKER);
      for (const p of players) await expect(p.page.getByTestId('face-up-1'), `${p.name}: sees bob's Deal Broker face up`).toContainText(BROKER, { timeout: UI_TIMEOUT });

      /* ── both draft every pick; alice, in the first seat, is asked first, with her whole pool to choose from ── */
      const bobStopped = draftOn(bob.page);
      expect(await draftOn(alice.page), 'alice is asked once the last pick is made').toBe('ask');
      const reveal = asks(alice.page).first();
      await expect(reveal).toHaveAttribute('data-source', BROKER);
      await expect(reveal.locator('.draft__ask-title')).toHaveText(`${BROKER}: Reveal a card?`);
      await expect(askCards(reveal), 'every card of her pool is a choice').toHaveCount(45);
      await expect(alice.page.getByTestId('pool-count'), 'her pool is full and she is still at the draft').toHaveText('45');
      await expect(packCards(alice.page), 'with no pack in front of her').toHaveCount(0);
      // The last card of the pool that is not a Deal Broker: reached by scrolling the question's own cards.
      const hers = await cardNames(askCards(reveal));
      const revealedAt = hers.reduce((at, n, i) => (n !== BROKER ? i : at), -1);
      if (revealedAt < 0) throw new Error('alice drafted nothing but Deal Brokers');
      const revealed = hers[revealedAt]!;
      await askCards(reveal).nth(revealedAt).click();
      for (const p of players) {
        await expect(logLines(p.page).last(), `${p.name}: is told what she revealed`).toHaveText(`e2e-alice revealed ${revealed} for ${BROKER}`, { timeout: UI_TIMEOUT });
      }

      /* ── bob is asked for an offer from his own pool; the AI seats decline ── */
      expect(await bobStopped, 'bob is asked once she has revealed').toBe('ask');
      const offerAsk = asks(bob.page).first();
      await expect(offerAsk.locator('.draft__ask-title')).toHaveText(`${BROKER}: Offer e2e-alice a card for ${revealed}?`, { timeout: UI_TIMEOUT });
      await expect(askCards(offerAsk), 'every card of his pool is a choice').toHaveCount(45);
      const his = await cardNames(askCards(offerAsk));
      const offeredAt = his.findIndex((n) => n !== BROKER);
      if (offeredAt < 0) throw new Error('bob drafted nothing but Deal Brokers');
      const offered = his[offeredAt]!;
      await askCards(offerAsk).nth(offeredAt).click();

      /* ── the offer is shown to alice alone, and she is asked to accept it ── */
      await expect(alice.page.getByTestId('draft-seen').locator('li').last(), 'alice is shown his offer').toHaveText(`${BROKER}: ${offered} offered by e2e-bob`, { timeout: PACK_TIMEOUT });
      for (const p of players) await expect(logLines(p.page).filter({ hasText: offered }), `${p.name}: the table is told nothing of it`).toHaveCount(0);
      const accept = asks(alice.page).first();
      await expect(accept.locator('.draft__ask-title')).toHaveText(`${BROKER}: Accept an offer?`, { timeout: PACK_TIMEOUT });
      expect(await cardNames(askCards(accept)), 'his is the one offer').toEqual([offered]);
      await askCards(accept).first().click();

      /* ── the two cards change pools, and the table is told ── */
      for (const p of players) {
        await expect(logLines(p.page).filter({ hasText: `e2e-alice exchanged ${revealed}, ${offered} with e2e-bob` }), `${p.name}: is told of the exchange`).toHaveCount(1, { timeout: UI_TIMEOUT });
      }

      /* ── every Deal Broker left is declined, and only then does the room go on to deck building ── */
      await Promise.all(players.map((p) => declineToTheEnd(p.page)));
      for (const p of players) await expect(p.page, `${p.name}: is at the deck builder`).toHaveURL(/#\/deck\//, { timeout: UI_TIMEOUT });
    } finally {
      await stack.stop();
    }
  },
);
