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

import { enabledOk, says } from './board.ts';
import { openFriend, type Friend } from './browser.ts';
import { confirmYes } from './confirm.ts';
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

/** The named `[state]` key's value, split on `;`, empty-string dropped to `[]`. */
function scenarioHand(scenario: string, key: 'humanhand' | 'aihand'): string[] {
  const line = new RegExp(`^${key}=(.*)$`, 'm').exec(scenario)?.[1] ?? '';
  return line.trim() === '' ? [] : line.split(';').map((name) => name.trim());
}

/** `true` when every name in `want` is present in `have` at least as many times (by name, order aside). */
function handContains(have: string[], want: string[]): boolean {
  const pool = [...have];
  for (const name of want) {
    const i = pool.indexOf(name);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/**
 * Wait (w37 §E.1) for the scenario's scripted hand to land on one seat's own
 * page, by card NAME, read from the hand zone — every card there, selectable
 * or not (`[data-board-card]`, no `[data-selectable]` filter: that filter is
 * `e2e/play/hands.ts`'s own, built for a different question, "what can I
 * click", and would make an empty-offered board look identical to a
 * never-applied one — exactly the ambiguity this precondition exists to
 * remove).
 *
 * This is deliberately NOT "something is offered" (`offered(page)` in the
 * w33–w36 specs): an empty actionable set on a correctly-applied scenario is
 * §A's own bug, and this precondition has to be able to tell that case apart
 * from "the scenario never applied at all". Hand membership, not
 * selectability, is the only signal that does.
 *
 * Checks CONTAINMENT, not equality: every scripted name must be present
 * (counting duplicates), but an extra card the hand has picked up since
 * apply — a trigger's own draw, say — does not fail this check. `want` empty
 * is satisfied immediately: there is no card name to confirm presence of.
 */
async function awaitScenarioHand(page: Page, scenarioName: string, seat: 'human' | 'ai', want: string[]): Promise<void> {
  const names = () =>
    page.locator('[data-zone="hand"][data-owner="you"] [data-board-card] .card__name').allTextContents();
  const deadline = Date.now() + 20_000;
  let have = await names();
  while (!handContains(have, want)) {
    if (Date.now() >= deadline) {
      throw new Error(`scenario "${scenarioName}" did not apply: ${seat} hand is ${JSON.stringify(have)}`);
    }
    await page.waitForTimeout(150);
    have = await names();
  }
}

export const matchUrl = (origin: string, matchId: string): string => `${origin}${PREFIX}/#/match/${matchId}`;

export { says, enabledOk };
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
  // Sticky, once true: has EITHER side's own line ever started "Priority:" —
  // the one unambiguous sign the coin-toss/keep handoff is behind both of
  // them, independent of what either happens to be showing on THIS tick.
  // Shared, not per-seat: a scenario can give one seat (an empty hand, say)
  // nothing to ever decide, so ITS OWN line may read "Waiting for ___..."
  // for the rest of the match and never once read "Priority:" — but once the
  // OTHER seat has shown real priority at least once, that is still
  // unambiguously past the handoff, because the active seat always reaches
  // its own first priority before the other ever needs to wait on it.
  // A transient "Waiting for Bob..." (the coin-toss handoff sends it too,
  // and so does every ordinary priority pass for the rest of an ordinary
  // game) matches neither `openQuestion` nor a real keep prompt, so treating
  // ANY non-match as "past the mulligan" — this function's own earlier
  // shape — can return before the real keep prompt has even been SENT,
  // leaving it unanswered forever once this function has already given up
  // watching for it. A structurally identical bug, independently diagnosed
  // server-side against `showPromptMessage` frames, is in
  // `docs/planning/wave40-evidence/B-thoughtseize.md`.
  let anyPriorityReached = false;
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
      if (/^Priority:/i.test(text)) anyPriorityReached = true;
      // The mulligan is over the instant a real ASK opens (`live-prompt`,
      // e.g. a replacement effect's own choice — Cavern of Souls' "choose a
      // creature type" on ETB, once a scenario applies itself after the
      // mulligan). `live-says` is Forge's status LINE, and it can still read
      // the stale "Do you want to keep your hand?" for a tick after the ask
      // opens (a separate wire field, not a signal this ask-driven step
      // overwrites) — checked for `live-prompt` FIRST, before the text
      // regex, so that staleness never reads as "still mid-mulligan" and
      // spins here (clicking nothing, since the bar/confirm the text implies
      // is long gone) until the whole loop's own cap gives up.
      if ((await f.page.getByTestId('live-prompt').count()) > 0) {
        // An open ask is as far past the handoff as priority is: the other
        // seat may only ever wait on it.
        anyPriorityReached = true;
        mark(true);
        continue;
      }
      if (!openQuestion.test(text)) {
        // Only genuinely clear if real priority has landed SOMEWHERE at
        // least once — never just because THIS tick's text happens not to
        // look mulligan-ish (see this function's own header for why that
        // was wrong: "Waiting for ___..." passes that test too, long before
        // the real keep prompt is even sent).
        mark(anyPriorityReached);
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
      // until this branch was added.
      //
      // Wave 36 T4: "keep your hand?" moved the SAME way, into its own
      // `ConfirmPrompt` pop-up (`prompt-confirm-yes`/`prompt-confirm-no`,
      // `e2e/play/confirm.ts`) — Keep is button 1 (`prompt-confirm-yes`),
      // never Mulligan, same default this helper always took. Only "return N
      // card(s)" (the bottom-pick SELECTION, not a confirm) is unaffected and
      // still answers through the control bar's OK.
      const button = /play or draw/i.test(text)
        ? f.page.getByTestId('live-play-or-draw-play')
        : /keep your hand/i.test(text)
          ? confirmYes(f.page)
          : enabledOk(f.page);
      if ((await button.count()) > 0) {
        clickedFor.set(f, text);
        await button.click();
      }
    }
    if (aClear && bClear) return;
    await alice.page.waitForTimeout(150);
  }
  // Not stuck on the wire: a real ask (e.g. a scenario's own ETB replacement
  // choice, applied right after the mulligan) had opened and was answered
  // correctly — `live-says` just still read the stale "keep your hand?" line
  // for a seat whose mulligan was already over, which is exactly what the
  // `live-prompt` check above now catches before this loop ever gets here.
  // If this still throws, something genuinely never got answered — the dump
  // is what to hand whoever looks at it.
  const dump = async (f: Friend) => ({
    says: await says(f.page),
    ok: await enabledOk(f.page).count(),
    cancel: await f.page.getByTestId('live-button-cancel').count(),
    confirmYes: await confirmYes(f.page).count(),
    confirmHost: await f.page.getByTestId('live-confirm-host').count(),
  });
  throw new Error(`the mulligan never settled on both sides: alice ${JSON.stringify(await dump(alice))} | bob ${JSON.stringify(await dump(bob))}`);
}

/**
 * Start a match seeded by the named scenario (shape 1): `POST
 * /api/play/matches` with `{ opponent: 'human', decks: [null, null], names,
 * scenario }`, then alice's page is opened and settled onto the board FIRST
 * (so she claims seat 0, the `human…` seat) and bob's second. Both keep
 * whatever hand they are dealt, then (w37 §E.1) each seat's own hand is
 * polled until it reads back as the scenario's scripted `human…hand=`/
 * `ai…hand=` cards, by name — or this throws by scenario name inside the
 * 20 s budget below, rather than let a caller's own "is anything offered"
 * poll run out looking exactly like that. Returns once both boards are up,
 * no mulligan question is outstanding on either side, and both scripted
 * hands have landed.
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

  // w37 §E.1: fail by name, fast, if the scripted zones never land — rather
  // than let the caller's own `offered(page)` poll time out looking
  // identical to §A's "applied, nothing offered" bug. Both seats are checked
  // concurrently: one seat's hand can land before the other's, and there is
  // no ordering between them to wait on.
  await Promise.all([
    awaitScenarioHand(alice.page, scenarioName, 'human', scenarioHand(scenario, 'humanhand')),
    awaitScenarioHand(bob.page, scenarioName, 'ai', scenarioHand(scenario, 'aihand')),
  ]);

  return { alice, bob, matchId };
}
