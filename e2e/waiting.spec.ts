/**
 * Wave 42 §L, W1. Playtest 7, the operator's own words:
 *
 * *"if opponent is choosing to play/draw something needs to be showing on
 * the other persons screen as well. i think the coinflip prompt should be
 * shown to both players at once. and for the one who lost they get the
 * waiting prompt. same for mulligan, if opponent is chosing to mulligan we
 * need some waiting prompt."*
 *
 * Forge resolves the coin toss itself and only ever asks the WINNER the
 * Play/Draw question (`apps/ui/src/play/prompts/ConfirmPrompt.tsx`'s own
 * module header, citing `PlayerControllerHuman.chooseStartingPlayer`); the
 * loser is never asked anything at that step, and Forge sends them no wire
 * text for the moment either (`LiveBoard.tsx`'s `isWaitingForPregameDecision`
 * has the full citation chain — `AbstractGuiGame.awaitNextInput()` is a
 * `final`, LOCAL-ONLY desktop timer, never relayed over the wire).
 *
 * "The coinflip prompt should be shown to both players at once" is read
 * here as: the instant one seat is asked Play/Draw, the OTHER seat already
 * has a pop-up on screen, in the SAME decision-area slot and the SAME
 * `.confirm` card shape — and the same holds while either seat answers its
 * own opening mulligan. Once the game is actually under way (turn 1), the
 * same pop-up keeps showing, now carrying the server's own verb instead of
 * the plain pregame sentence — wave 62 §D (AE3) unified the pregame pop-up
 * and the old mid-game top line into this one component, one testid
 * (`live-waiting-pop`): there is no longer a second, mutually-exclusive
 * shape to tell apart, only the SENTENCE differs by when it fires.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test } from '@playwright/test';

import { enterMatch, makeTitled } from './play/board.ts';
import { openFriend, type Friend } from './play/browser.ts';
import { answerConfirm, confirmNo, confirmYes } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(
  titled(
    'W1 — while the OTHER seat decides play/draw or a mulligan, this seat sees the decision-area pop-up, named, at the same instant',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const alice = await openFriend(browser, 'alice');
      const bob = await openFriend(browser, 'bob');
      await enterMatch(alice, bob, stack.origin);

      const playOrDraw = (f: Friend) => f.page.getByTestId('live-play-or-draw-play');
      const waitingPop = (f: Friend) => f.page.getByTestId('live-waiting-pop');

      /* ── the coin toss: exactly one seat is asked, the other gets the pop-up, named, at once ── */

      await expect
        .poll(
          async () => (await playOrDraw(alice).count()) + (await playOrDraw(bob).count()),
          { timeout: 30_000, message: 'exactly one seat is asked Play/Draw — Forge already resolved the toss itself' },
        )
        .toBe(1);
      const winner = (await playOrDraw(alice).count()) > 0 ? alice : bob;
      const loser = winner === alice ? bob : alice;

      // "the coinflip prompt should be shown to both players at once" — in
      // the SAME poll window the winner's own Play/Draw question is open,
      // the loser already has the decision-area pop-up.
      await expect(playOrDraw(winner), `${winner.name}: the Play/Draw question itself is up`).toBeVisible();
      await expect(waitingPop(loser), `${loser.name}: the decision-area pop-up is up, same instant`).toBeVisible();
      const loserPopupText = (await waitingPop(loser).textContent()) ?? '';
      // "for the one who lost they get the waiting prompt" — named, not a placeholder.
      expect(loserPopupText, `${loser.name}'s pop-up names ${winner.name}, not a generic placeholder`).toContain(winner.name);
      // The winner's own screen shows no pop-up at all — it is their own move.
      await expect(waitingPop(winner), `${winner.name}: it is their own move — no pop-up`).toHaveCount(0);

      await playOrDraw(winner).click();

      /* ── the opening mulligan: asked sequentially, the other seat's pop-up is up each time ── */

      // Whichever seat is asked first, the other seat's pop-up is up — "same
      // for mulligan, if opponent is choosing to mulligan we need some
      // waiting prompt."
      await expect
        .poll(
          async () => (await confirmYes(winner.page).count()) + (await confirmYes(loser.page).count()),
          { timeout: 30_000, message: 'one seat is asked its opening Keep/Mulligan first' },
        )
        .toBeGreaterThan(0);
      const firstMulligan = (await confirmYes(winner.page).count()) > 0 ? winner : loser;
      const secondToDecide = firstMulligan === winner ? loser : winner;

      await expect(confirmNo(firstMulligan.page), 'Mulligan is button 2, beside Keep').toBeVisible();
      await expect(waitingPop(secondToDecide), `${secondToDecide.name}: the pop-up is up while ${firstMulligan.name} decides their own mulligan`).toBeVisible();
      const firstPopupText = (await waitingPop(secondToDecide).textContent()) ?? '';
      expect(firstPopupText, `${secondToDecide.name}'s pop-up names ${firstMulligan.name}`).toContain(firstMulligan.name);
      await expect(waitingPop(firstMulligan), `${firstMulligan.name}: deciding their own hand is not "waiting"`).toHaveCount(0);

      await answerConfirm(firstMulligan.page, 'yes');

      // Roles flip: the other seat now answers their own opening hand, and
      // the first-to-decide seat (done, nothing left to do yet) gets the pop-up.
      await expect(confirmYes(secondToDecide.page), `${secondToDecide.name}: their own keep/mulligan question opens`).toBeVisible({ timeout: 30_000 });
      await expect(waitingPop(secondToDecide), `${secondToDecide.name}: deciding their own hand is not "waiting"`).toHaveCount(0);
      await expect(waitingPop(firstMulligan), `${firstMulligan.name}: now gets the pop-up for the other seat's own mulligan`).toBeVisible();
      const secondPopupText = (await waitingPop(firstMulligan).textContent()) ?? '';
      expect(secondPopupText, `${firstMulligan.name}'s pop-up names ${secondToDecide.name}`).toContain(secondToDecide.name);

      await answerConfirm(secondToDecide.page, 'yes');

      // Both have kept. Whoever chose Play holds priority at turn 1 — the
      // game is properly under way now, so the OTHER seat still gets the
      // same pop-up, now carrying the server's own verb-based sentence
      // rather than the plain pregame one (AE3's whole point — one shape,
      // both uses).
      await expect
        .poll(
          async () => (await waitingPop(alice).count()) + (await waitingPop(bob).count()),
          { timeout: 30_000, message: 'exactly one seat now has the pop-up, waiting on the one holding priority at turn 1' },
        )
        .toBe(1);
    } finally {
      await stack.stop();
    }
  },
);
