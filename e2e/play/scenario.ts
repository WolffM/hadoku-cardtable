/**
 * Wave 33 shape 1: a match whose opening state Forge is TOLD, not dealt.
 *
 * `scenario` on `POST /api/play/matches` is the text of a Forge puzzle file's
 * `[state]` section (`forge/forge-gui/res/puzzle/*.pzl`: `humanlife=`,
 * `humanhand=`, `humanbattlefield=`, `activephase=`, …). `human…` keys land
 * on seat 0, `ai…` keys on seat 1 — regardless of who is actually sitting
 * there, because this harness always seats two real browsers. S (lane S,
 * `apps/server/src/play/socket.ts`'s `parseStartBody`) is who reads the
 * field; this file only sends it.
 *
 * ## Why the request carries no `room`
 *
 * A match against a person normally starts from a room (`POST { room }`),
 * gated by `apps/server/src/http/routes.ts` — unowned this wave, and that
 * gate's `startFromRoom` does not know about `scenario`. The gate's OWN code
 * only inspects `room` and `seats`; a body with neither (and `decks` null or
 * absent) falls through untouched to play's own router
 * (`apps/server/src/play/socket.ts`'s `POST /matches`, owned by lane S),
 * which is where `parseStartBody` lives and where the `scenario` field is
 * read. So `{ opponent: 'human', decks: [null, null], scenario }` reaches
 * lane S's code directly, with no change needed to the unowned gate. If that
 * reading is wrong — if S instead wires `scenario` through the room path —
 * this file is the one to change; nothing about the spec files should.
 *
 * `Match.claim` (`play/match.ts`) hands the first free seat to whoever joins
 * first and the binding is then permanent, so alice (who is always navigated
 * to the match and settled first) is seat 0 and bob is seat 1 — the seat
 * order `human…` / `ai…` keys assume.
 *
 * ## The probe flag
 *
 * The settled rule is that the route 400s `scenario-needs-probe` without
 * `CARDTABLE_PLAY_PROBE=1`. Proving that 400 is lane S's done-when item (it
 * needs no browser); `../play/harness.ts`'s `startPlayStack` already sets the
 * flag unconditionally for every e2e play stack (wave 31), so every helper in
 * this file is simply using a probed stack, the same as every other play e2e.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Browser, type Page } from '@playwright/test';

import { openFriend, type Friend } from './browser.ts';
import type { PlayStack } from './harness.ts';
import { TURN_TEXT } from './turn.ts';

const PREFIX = '/cardtable';

/**
 * `apps/server/src/play/scenarios/*.state` — the directory shape 1 commits S
 * to writing into, one file per named scenario these specs ask for.
 */
export const SCENARIOS_DIR = resolve(import.meta.dirname, '..', '..', 'apps/server/src/play/scenarios');

/** The named scenario's `[state]` text, verbatim, read fresh for every call. */
export function readScenario(name: string): string {
  const path = resolve(SCENARIOS_DIR, `${name}.state`);
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`no scenario file for "${name}" at ${path} (lane S writes these — see docs/handoff/w33.md §S item 2): ${String(err)}`, { cause: err });
  }
}

export interface ScenarioMatch {
  alice: Friend;
  bob: Friend;
  matchId: string;
}

export const matchUrl = (origin: string, matchId: string): string => `${origin}${PREFIX}/#/match/${matchId}`;

export const says = async (page: Page): Promise<string> => (await page.getByTestId('live-says').textContent()) ?? '';
export const enabledOk = (page: Page) => page.locator('[data-testid="live-button-ok"]:enabled');
export const enabledCancel = (page: Page) => page.locator('[data-testid="live-button-cancel"]:enabled');

async function boardUp(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 30_000 });
}

/**
 * Keep whatever hand each seat is dealt: press OK on a play-or-draw,
 * keep-or-mulligan, or London-mulligan bottom-pick question on EITHER page,
 * until neither shows one. A scripted scenario still runs the London
 * mulligan ritual on the hand it is DEALT, before its own `human…hand=` ever
 * applies (shape 1 says nothing excuses it from that) — so both seats need
 * answering, independently and repeatedly, through ALL THREE steps: a seat
 * that keeps on the first look bottoms zero cards, but Forge still raises
 * that question and still parks on it until OK is pressed. Missing this one
 * (as an earlier version of this helper did) does not show up as "the
 * mulligan never settled" — the loop's own exit condition is satisfied by
 * the text moving on to this unmatched question, so it returns — but it
 * leaves `match.asks`/the open selection live, which makes `boardInteraction`
 * return nothing-clickable FOREVER after: every later `data-selectable`
 * check in every scenario's own first ask then times out, looking exactly
 * like a product bug.
 */
async function keepBothHands(alice: Friend, bob: Friend): Promise<void> {
  const openQuestion = /play or draw|keep your hand|return \d+ card/i;
  // Each side's own "past the mulligan" flag, set from the SAME read that
  // decided whether to click it — not a separate later re-check. Two reads
  // taken moments apart raced here once: the second could land on a message
  // that had already moved on (or flickered back), concluding "both sides are
  // clear" while one side's button was still disabled on its own open
  // question, which then never got clicked at all.
  let aClear = false;
  let bClear = false;
  // The exact text each side was last clicked for. The button can stay
  // visibly enabled for a while after the click — the server's own reply
  // round-trip, worse under load — and a loop that re-clicks on every tick
  // regardless sends the SAME `selectButtonOk` several times for one
  // question. Forge answers that by applying the extra clicks to whatever it
  // asks NEXT, which wedges the sequence (measured: stuck on "Do you want to
  // keep your hand?" with Keep enabled, forever). One click per distinct
  // question text, then wait for the reply, fixes it.
  const clickedFor = new Map<Friend, string>();
  for (let i = 0; i < 200 && !(aClear && bClear); i++) {
    for (const [f, mark] of [
      [alice, (v: boolean) => (aClear = v)],
      [bob, (v: boolean) => (bClear = v)],
    ] as const) {
      const text = await says(f.page);
      if (text === '') continue; // not loaded yet: neither clear nor an open question to answer
      if (!openQuestion.test(text)) {
        mark(true);
        continue;
      }
      mark(false);
      if (clickedFor.get(f) === text) continue; // already answered this exact question; wait for Forge's reply
      // Wave 35 R2: the coin toss / play-draw question moved into its own
      // decision-area host (`live-play-or-draw-host`, lane G's
      // `PlayOrDrawPrompt`, wired by lane L) — `live-button-ok` is now
      // DISABLED for the whole time this question is open (L's own mutation-
      // tested guard), so the old `enabledOk` click below never fires for it
      // and this loop hung forever on "Would you like to play or draw?"
      // until this branch was added. The mulligan's own two questions ("keep
      // your hand", "return N card(s)") are unaffected by R2 and still
      // answer through the control bar's OK, unchanged.
      const button = /play or draw/i.test(text) ? f.page.getByTestId('live-play-or-draw-play') : enabledOk(f.page);
      if ((await button.count()) > 0) {
        clickedFor.set(f, text);
        await button.click();
      }
    }
    if (aClear && bClear) return;
    await alice.page.waitForTimeout(150);
  }
  throw new Error(`the mulligan never settled on both sides: alice "${await says(alice.page)}" | bob "${await says(bob.page)}"`);
}

/**
 * Start a match seeded by the named scenario (shape 1): `POST
 * /api/play/matches` with `{ opponent: 'human', decks: [null, null], names,
 * scenario }`, then alice's page is opened and settled onto the board FIRST
 * (so she claims seat 0, the `human…` seat) and bob's second. Both keep
 * whatever hand they are dealt. Returns once both boards are up with no
 * mulligan question outstanding on either side.
 */
export async function startScenarioMatch(browser: Browser, stack: PlayStack, scenarioName: string): Promise<ScenarioMatch> {
  const scenario = readScenario(scenarioName);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');

  const res = await alice.context.request.post(`${stack.origin}${PREFIX}/api/play/matches`, {
    data: {
      opponent: 'human',
      decks: [null, null],
      names: ['Alice', 'Bob'],
      scenario,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`scenario "${scenarioName}": POST /api/play/matches answered ${res.status()} ${await res.text()}`);
  }
  const { matchId } = (await res.json()) as { matchId: string };

  // alice FIRST and settled before bob opens, so claim order gives her seat 0.
  await alice.page.goto(matchUrl(stack.origin, matchId));
  await boardUp(alice.page);
  await bob.page.goto(matchUrl(stack.origin, matchId));
  await boardUp(bob.page);

  await keepBothHands(alice, bob);
  return { alice, bob, matchId };
}
