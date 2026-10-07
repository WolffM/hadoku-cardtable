# Lane S handoff — not landing this wave, moves to the next one

Manager's call (20:5x UTC): a full jvm run takes ~50 min on a claw and lane S
cannot be verified before this wave's hard stop, so S does not land wave 55.
This is the state of the tree at hand-off. Plain facts, no ticket ids in code
(ids are fine here).

## What `match.ts` now does (end state in the worktree, uncommitted)

`onFrame`'s old forward-then-decide order for `showPromptMessage`/
`updateButtons` is replaced by hold-decide-forward, narrowed twice over the
course of this session:

1. **Pairing.** Each half is parked per seat (`SeatState.pendingPrompt`/
   `pendingButtons`) until its partner arrives, or `PROMPT_HOLD_FLUSH_MS`
   (2000ms) elapses, or an ASK frame arrives for that seat (a different
   window shape entirely, never paired with a prompt/buttons half). Once
   both halves are known, `decidePendingWindow` runs the three deciders
   (`maybeAutoPass`, `maybeConfirmChosenCost`, `maybeAutoPay`) ONCE and sends
   both frames, or — if answered — a disabled `updateButtons` correction
   only when the seat's last-sent bar was actually live (`SeatState.wireButtonsLive`),
   nothing otherwise.
2. **Overwrite protection.** A second half of the SAME kind arriving before
   the first ever paired used to silently overwrite and lose the first
   (found via a real-jar Ponder-under-Full-Control repro: its own "Do you
   want to shuffle…" confirm can open before the caster's "Stack: 1 to
   Resolve" buttons ever arrive). Fixed: the stale half is flushed, unpaired,
   before being overwritten.
3. **Narrowed hold.** A half is parked ONLY if it has a shape a decider could
   ever read: `promptCouldBeAnswered` (a `showPromptMessage` matching
   `Priority: `/`Pay Mana Cost: `, or carrying `confirmAbility`) and
   `buttonsCouldBeAnswered` (an `updateButtons` with `label1: 'Auto'` or
   `'Yes'`/`'No'`, for a buttons-first payment or chosen-cost confirm).
   Everything else — `InputAttack`'s own per-toggle `updateButtons` refresh
   chief among them — is sent at once, exactly as before this wave. Found
   via a real-jar repro (Q14, `w33.spec.ts:248`): holding an unanswerable
   buttons-only refresh for the full 2s window made a click land on a stale
   card.

`auto.ts` gained two exports (`PRIORITY`, `PAY_MANA` — the exact same two
regexes `readPromptFacts` already used, never a second copy) so `match.ts`
can read them for the narrowing above.

## Every verify run this session, with its result

| run | branch | base | result |
| --- | --- | --- | --- |
| 37673038028 | `verify/w55-S` | w55 HEAD at the time | e2e `w46-attack`: 2/2 passed |
| 37672308600 | `verify/w55-S` | w55 HEAD | jvm full set: 2 failed (lane C/E's own #22 claim, lane D) — later root-caused as a stale-pairing bug in the TEST harness's own row-building, not match.ts; fixed, reproduces the suite's documented baseline exactly once fixed |
| 37678102451 | `verify/w55-S2` | w55 HEAD | full suite (both): not fully read before being superseded by the origin/main rebase ask |
| 37679032975 | `verify/w55-S3` | `e7a10c6` (origin/main `ff95769` + lane P's jvm-harness fix) | e2e: 85 passed, 4 failed (`prompts-offboard:174`, `w33:208`, `w35:190`, `w54-blockers:101`); jvm: 33 passed, 8 failed (table below) |
| 37682635655 | `verify/w55-S4` | `e7a10c6` | e2e, same 4 specs + the overwrite-drop fix: still 4 failed — the fix was real but did not touch these (see below) |
| 37684808956 | `verify/w55-S5` | `e7a10c6` | e2e, 25 specs including the 3 mine (w35 dropped — tracker's own fix): **prompts-offboard:174, w33:208, w54-blockers:101 all PASS**; one NEW red, `w33.spec.ts:248` Q14 (below) |
| — | `verify/w55-S6` | — | **never dispatched** — the hold-narrowing fix (Q14's own cause) was written after the 21:45 UTC "no more claws dispatches" instruction landed; unverified on claws |

## The three e2e fixes that went green on S5

- `e2e/play/scenario.ts`, `keepBothHands`'s settle loop: `anyPriorityReached`
  used to flip only on literal `^Priority:` text or an open ask. A real,
  answerable, non-mulligan window that is neither (Q12's own "Select
  creatures to block …") never flipped it — and since this wave can
  withhold a seat's own auto-passed priority outright, `Priority:` text can
  now go unforwarded for a whole match. Fixed: a live `enabledOk`/
  `enabledCancel` under non-"Waiting for …" text also counts.
- `e2e/prompts-offboard.spec.ts:174`: replaced a drawn-`enabledOk`-count
  assertion ("priority genuinely returns — no lock") with `expect.poll` on
  either a live OK or the server's own structured log (`serverLog(stack)`,
  already exported from `e2e/play/board.ts`) showing the next window was
  decided (`auto-passed`/`prompt-withheld`/`prompt-forwarded`) — the window
  that follows the decline can now be server-decided rather than a drawn stop.
- `passDeclareAttackers` (`w33.spec.ts` and `e2e/play/combat.ts`) needed NO
  change — both already gate on `phaseOf(page)` being at or past
  `COMBAT_DECLARE_BLOCKERS` before looking for the Declare-Attackers text,
  and phase (a Tier-C state frame) is never held.

## Q14's 2-second lag, and the narrowing it forced

`w33.spec.ts:248` ("clicking a declared attacker undeclares it") went red on
S5 specifically BECAUSE the settle-loop fix above let the suite run far
enough to reach it. Server log (`play-server-stack-ofc7Et.jsonl`, match
`m-9c93d2e4809b`): seat 0's attack window produced `prompt-forwarded …
why:"unpaired"` lines exactly `PROMPT_HOLD_FLUSH_MS` (2000ms) apart —
`InputAttack`'s own per-toggle `updateButtons` refresh never comes with a new
`showPromptMessage` (the window's own prompt was sent once, long before), so
every click's buttons update sat parked for the full safety window before
flushing, and the test's own click landed on a now-stale card. Confirmed in
9 of the run's own match logs — a real, repeatable 2s lag in ordinary combat
play, not a one-off. The narrowing above (item 3) is the fix: the bug class
is `Match.holdPromptWindow` is unchanged. **Not verified on claws** — no
dispatch was made after this fix (see the table).

## The 8 jvm failures from S3 (`gh api .../jobs/112990050560/logs`)

All 8 are green on `main` at `ff95769` without lane S (the baseline run,
37678666255, has only the pre-existing pinned `prompts.jvm` reveal red) — so
every one of these is this lane's own contract, not a pre-existing red. Read
the assertion + error line for each; my own one-line read follows each:

1. **`cast-hidden.jvm.test.ts`**, "manual payment, one land tap at a time …
   the opponent sees nothing between taps": `Error: timed out waiting for the
   spell to resolve to the stack`. — A manual, multi-tap payment is exactly
   `InputPayMana`'s own repeated-update shape (buttons refreshed once per
   tap, sometimes without a fresh message). **Read: a real decision bug, now
   addressed** by the overwrite-drop + narrowing fixes (both post-date S3);
   unverified on claws.
2. **`phyrexian.jvm.test.ts`**, "offers Gitaxian Probe at {U/P} with no
   land …": `expect(gravesOf(0)).toBe(before.graves + 1)` — 0 received. The
   cast never completed (a Phyrexian-mana payment is the same `InputPayMana`
   shape). **Same read as #1.**
3. **`priority.jvm.test.ts`**, "casts a spell and reports who holds
   priority …": `the caster was never given priority with its spell on the
   stack: expected 0 to be greater than 0`. The caster's own post-cast
   priority window never arrived at all. **Read: the overwrite-drop bug
   (this exact shape — a window silently lost before its pair completed) —
   now fixed; unverified on claws.**
4. **`scenario-blockers.jvm.test.ts`** Q12, "a defender with one creature is
   NOT auto-passed …": `expect(s.buttons(1)?.enable1).toBe(true)` — false
   received. Forge's own block-window buttons never arrived enabled. **Read:
   plausibly the overwrite-drop bug (a block window's own prompt/buttons
   pair lost to an interleaving ask); could also be a genuine decider
   regression — I did not get to isolate which. Flagging both possibilities
   for whoever picks this up.**
5. **`scenario-order.jvm.test.ts`** Q8 (×2), "timed out waiting for seat 0 at
   Upkeep with both upkeep triggers on the stack" (both cases share this
   same precondition helper, `driveToUpkeepWithBothTriggers`). **Read: the
   overwrite-drop bug (two upkeep triggers' own windows interleaving before
   the first pairs) is the most likely shape; now fixed; unverified.**
6. **`scenario-priority.jvm.test.ts`** Q17, "the caster does not hold
   priority on its own spell …": `timed out waiting for the caster to be
   shown its own spell on the stack`. **This is the EXACT shape the
   overwrite-drop fix's own Ponder repro targets** (a caster's own
   post-cast priority window lost to an interleaving window). High
   confidence this is fixed; unverified on claws.
7. **`w52-s-augur.jvm.test.ts`**, "Augur and two Swamps …": `Mirri's Guile's
   optional trigger was put to the seat: expected true, got false` — the
   trigger confirm never reached the seat. **Read: the overwrite-drop bug**
   (Mirri's Guile's trigger confirm interleaving with Augur's own upkeep
   stop/sacrifice-confirm sequence, the exact kind of two-window race the
   fix targets). High confidence; unverified.

None of these 8 were re-run after either match.ts fix landed — the ~50 min
full jvm runtime does not fit this wave's remaining budget. **This is the
single largest unverified claim in this handoff**: my read is that 6-7 of
the 8 are the overwrite-drop bug and are now fixed, but nobody has watched a
real jar confirm it.

## Readers never audited this wave (static risk unknown, never run)

`cast-hidden`, `phyrexian`, `scenario-ability-repeat`, `scenario-blockers`,
`scenario-thoughtseize`, `scenario-priority`, `scenario-glen`,
`scenario-w46-b-counterspell`, `scenario-order`, `endturn`, `w46-block-stop`
— all named in the original blast-radius table, several now CONFIRMED red
(above) rather than merely unaudited. Every e2e spec beyond the ones named
in this doc (`w31`, `w33`, `w35`, `w46-attack`, `w46-stack`,
`w49-counterspell`, `w51-control-box`, `w53-prompt-words`, `w54-blockers`,
`prompts-offboard` were run at some point this session; the rest of the
original blast-radius e2e list — `drag`, `played-card`, `play`,
`table-fit`'s own prompt assertions — were not).

## AB3 ("Waiting for Hadoku" flashes)

Finding unchanged from earlier in this session
(`docs/planning/wave55-evidence/S/ab3-waiting-for.md`): a CLIENT gap state
(`apps/ui/src/play/live/LiveBoard.tsx`'s `isWaitingForOpponent`/`myMoveNow`,
`!myMoveNow(match)`), not a server-forwarded window — the brief's own fork
puts this on the tracker, unfixed by this lane, file outside S's ownership
either way.

## AB9 (declare-attackers flash) — not this lane's work, found by someone else

`docs/planning/wave55-evidence/S-AB9/declare-attackers.md` and
`e2e/w55-withheld.spec.ts` appeared in the shared worktree mid-session; I
read the evidence doc only (name/content not authored by me). Its finding:
the opponent's-board flash survives WITH and WITHOUT this lane's `match.ts`
fix — caused by `setWeaklySelectable`/state frames (never held) plus
`apps/ui/src/play/live/match.ts`'s `boardInteraction`'s unconditional
`declaringAttackers` branch on the CLIENT, not the `showPromptMessage`/
`updateButtons` pair this lane's fix withholds.

## Telemetry (AB13) — narrower than the brief asked for, and why

The brief's Settled text asked for "a per-match ring buffer of frames EACH
WAY" (implying every forwarded AND withheld frame). What is actually
implemented: the ring (`Match.framesRing`, `FrameLogEntry[]`, written once to
`$CARDTABLE_PLAY_WORK_DIR/<matchId>/frames.jsonl` on match end) records only
**decided** windows — ones that actually went through `decidePendingWindow`
(paired, with a real withheld/forwarded decision from one of the three
deciders). After the narrowing above, a window no decider could ever read
(an `InputAttack` button refresh, a "Waiting for …" status) bypasses holding
entirely and is never recorded — there was never a decision to record. This
is a deliberate scope reduction forced by the narrowing's own correctness
requirement (recording everything would mean going back to holding
everything, reintroducing the Q14 lag). `FRAMES_RING_SIZE = 500`; measured
(synthetic, 500 representative rows): ~93.6 KiB, ~192 bytes/row. Not measured
against a literal 20-turn real match (time).

## Everything verified locally at hand-off

- `pnpm --filter @hadoku/server exec tsc --noEmit -p .`: clean.
- `pnpm exec eslint` on every touched file: clean.
- `pnpm exec vitest run apps/server/src --exclude "**/*.jvm.test.ts"`: 749
  passed, 5 skipped (pre-existing), 0 failed.
- `match.test.ts` + `auto.test.ts`: 280/280 (89 + 191).
- Mutation re-run (`match.ts`/`auto.ts` reverted to `git show HEAD:...`):
  12/280 fail. Restored: 280/280 pass.

## Files changed (final, uncommitted)

`apps/server/src/play/match.ts`, `match.test.ts`, `auto.ts`, `auto.test.ts`,
`auto.jvm.test.ts`, `auto-pass-land.jvm.test.ts`, `w52-s-augur.jvm.test.ts`,
`w52-s-signet.jvm.test.ts`, `socket.test.ts`, `browser/browser.test.ts`,
`scenarios/bitterblossom.state` (new), `docs/planning/wave55-evidence/S/*`,
`e2e/play/scenario.ts`, `e2e/prompts-offboard.spec.ts`.

Not touched: `e2e/w35.spec.ts`, `e2e/w55-withheld.spec.ts`,
`docs/planning/wave55-evidence/S-AB9/*` (someone else's).

## What is left, in priority order

1. Re-run the 8 jvm failures (table above) against the current tree — this
   is the single biggest unknown.
2. Dispatch `verify/w55-S6` (base `e7a10c6` + the current tree) for e2e
   `w33 w54-blockers prompts-offboard w46-attack w51-control-box w31
   w46-stack w49-counterspell w53-prompt-words` to confirm the hold-narrowing
   fix actually turns Q14 green and does not regress anything else.
3. Audit the never-run readers list above.
4. A dedicated client-side (DOM) proof for AB9 — the finding in `S-AB9/` is
   real but the fix is not owned by this lane's files (either widen the hold
   to cover `setWeaklySelectable`/`setHighlighted`/`setSelectables`, or gate
   `boardInteraction`'s opponent-player branch more narrowly — both touch
   files outside `match.ts`).
