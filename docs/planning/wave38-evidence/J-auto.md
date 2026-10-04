# J — `auto.jvm.test.ts`: three reds, all stale drivers, fixed in the test

**Verdict: test, not product.** All three tests drove the match in ways the product has since
stopped tolerating, and each of the three changes that broke them was deliberate. The brief's lead
(the default policy's `'forgeAuto'` hides payments) is **killed**. `maybeAutoPay` (`match.ts:1612-1627`)
presses Auto without withholding a single frame, so a payment prompt and its `Auto` bar still reach
the seat. The payment rows were missing because **no payment ever happened**: the match stalled before
anyone cast.

## How it was found

The HEAD failures were identical across `auto-clean1.log` (lane J), `auto-run1.log` and my own
instrumented run (`/tmp/claude-1000/w38-J/trace-run1.log`): `1 casts … 1 payments`, test 1 ran its full
200 s deadline, and tests 2 and 3 each ran theirs too. A loop that runs to its deadline is a stall, not
a wrong count. So I traced every frame and every driver action (temporary instrumentation, removed).
Traces: `/tmp/claude-1000/w38-J/trace1.txt` (HEAD), `trace-t1.txt`, `trace-t2.txt`, `trace-t3.txt` (after
fix 1).

## Cause 1: the driver clicks a card Forge did not offer, and the bar never comes back (all three tests)

`trace1.txt`, seat 1 (B) on turn 1:

```
973051 s1 setWeaklySelectable [97,113]   "Priority: B … Main phase, precombat"  ok=true
973132 DRIVER s1 land 97
…                                        (Preordain cast, paid, resolved)
973963 s1 "Priority: B … Main phase, postcombat"  ok=true   (setWeaklySelectable [] just before)
973979 DRIVER s1 land 113                <- a second land in one turn; Forge offered nothing
973979 s1 updateButtons ok=false         <- the server disables the bar on any act
                                            (then nothing for 200 s)
```

The driver plays "a land" in each of the precombat and postcombat main phases (its `acted` key is
per phase). Forge ignores the second one. Two later changes turned that ignored click into a
permanent stall:

- `ad2d4b7` (2026-10-02) added `disableStaleButtons` (`match.ts:900`): every act a seat sends
  disables its buttons until Forge speaks again. When Forge ignores the act it never speaks, so the
  driver, which presses only a live OK, waits forever.
- `9ccc35b` (2026-10-02, fork `9729168d`) made Forge offer lands at priority, which is what makes
  "only click what is offered" a usable rule for this driver.

The board never sends that click. `apps/ui/src/play/live/match.ts:1119` `selectCard` refuses a card
that is not in `boardInteraction(match).selectable`.

`git log -L` on the driver lines: `const land = hand.find((c) => c.land)` dates from `f6cf0e6`
(2026-09-24), and tests 2 and 3's land and cast choices from `ff28af9` and `1c9bdd3` (2026-09-26/27).
None of them has changed since. The file's last edit is `29fa186` (2026-09-28), which is before both
changes above.

**Fix:** each driver clicks a hand or battlefield card only when it is in the seat's current
`setWeaklySelectable` set, which is what the board does.

## Cause 2: test 1's "own main phase is never passed" counts the own Declare Attackers step (test 1)

After fix 1, test 1 reached 2 casts and 2 payments and failed at the `ownMain && passed` sweep
(`auto-fix-run1.log`, `auto-fix-run2.log`). `trace-t1.txt` shows the row was
`{"seat":1,"phase":"Declare Attackers Step","idle":true,"ownMain":true,"passed":true}`.

- The test's `ownMain` is `isOwnMainPhaseEntry(message)`, which is any phase in the policy's
  `stopOnMyTurn`. That line is from `d48965c` (2026-09-24), when the set was only `MAIN1`/`MAIN2`.
- `29fa186` (2026-09-28) added `COMBAT_DECLARE_ATTACKERS` to the default's `stopOnMyTurn`.
- `f7ad0b8` (2026-10-03, T3) then made that window pass when there is nothing to do
  (`attackStopIsTheDeclaration`): the attack input is the stop, and the empty priority window after it
  is not.

B had no creature and nothing castable, so the server passed the window. That is what T3 is for.

**Fix:** the row counts as `ownMain` unless it is the Declare Attackers step under
`DEFAULT_STOP_POLICY.attackStopIsTheDeclaration`. That reads the policy's own field, not a copy of it.

## Cause 3: tests 2 and 3 park on the opponent's cleanup discard

After fix 1, both still ran to the deadline with `0 payment rows` (`auto-fix-run2.log`). Their last
frames (`trace-t2.txt:275`, `trace-t3.txt:373`):

```
s1 "Cleanup Phase\nSelect 1 card(s) to discard to bring your hand down to the maximum of 7 cards."
s1 updateButtons ok=false
```

These drivers play only seat 0. Seat 1 never plays a land, so it reaches eight cards, and that OK stays
dead until a card is picked. The B-wins-the-coin-toss start (`B, you have won the coin toss`, answered
by the driver's live-OK press) puts B's cleanup ahead of A's second land drop. `scenario.ts`'s
`passUntil` handles this same prompt already.

**Fix:** tests 2 and 3 pick the first hand card on a cleanup discard prompt, once per prompt.

## Revert / restore

| state | runs | result | log |
| --- | --- | --- | --- |
| HEAD's test (all three fixes reverted) | 3 (J's clean run, J's run 1, my traced run of test 1) | 3 failed / 3 failed / test 1 failed, identical counts | `auto-clean1.log`, `auto-run1.log`, `trace-run1.log` |
| fix 1 only | 2 | 3 failed (new places: the `ownMain && passed` sweep, and the payment rows) | `auto-fix-run1.log`, `auto-fix-run2.log`* |
| all three fixes | 3 in a row | **3 passed, 42 s**, in the full serial run · **3 passed, 50 s**, alone · **3 passed, 48 s**, alone | `full-run.log`, `auto-green-run2.log`, `auto-green-run3.log` |

\* `auto-fix-run2.log` (05:49:56 to 05:57:29) overlapped the manager's accidental parallel jar run
(≈05:52 to 06:05). I used it only for its traces, which show the same deterministic stalls as run 1. Its
pass/fail and timing do not count.

The green runs record what the HEAD runs never reached: test 2 saw `#22 payment: cost={1}{W}
sources=[1,11] planned=[]`, and test 3 saw `item 6: Forge offered ["Island","Mountain"] for {R}`. Those
are the two payment windows the tests exist to record, now reached under the default policy.

The revert evidence is the three HEAD runs above, which are the file without any of the three fixes. I
did not run a separate revert-after-fix mutation: the host budget went to the full serial run.

All logs are under `/tmp/claude-1000/w38-J/`.

## Not a product bug, but written down

A selection Forge silently ignores leaves that seat's bar disabled until Forge next speaks
(`disableStaleButtons`). No browser path can produce one today, because `selectCard` gates on the
offered set. Any other client of the act route (a test, a future client) can, and it hangs. That is for
the w39 engine wave to judge; nothing in w38 touches it.
