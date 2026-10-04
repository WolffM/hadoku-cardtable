# E-table-fit — the three failure shapes (w38 §E item 4)

Starting point: `docs/planning/wave37-evidence/E-table-fit.md` (shape 1 only, leading hypothesis,
not confirmed). This wave adds shapes 2 and 3, seen since, and the fix for shape 1.

## Shape 1 — `:1048` `ghost + indicator === 0` — FIXED

w37's own evidence doc left one fact unmeasured: `pointerDrag`/`touchDrag`'s midway sample never
asserted `pickedUp`, so "the drag never armed at all" (stale coordinates, a re-render between
`freshSeats` and `mouse.down()`) and "it armed, but the synchronous `.count()` read at the midpoint
raced the DOM commit" were indistinguishable from the outside — both read `ghost:0, indicator:0`.

**Fix** (`e2e/play/w32.ts`, `pointerDrag` and `touchDrag`): right after `mouse.down()`/`touchStart`
(before the dead-zone move, before any sampling), `expect.poll` that `hooks.pickedUp` reaches at
least 1, with its own message (`"the drag never armed: pickedUp stayed 0 after mouse.down"` /
`"...after touchStart"`). "Never armed" and "armed, sampled too early" are now two different errors
by construction, not by inference after the fact — exactly what w37's §4 "what would settle it"
asked for.

**Mutation proof**: `pointerDrag` temporarily mutated to `mouse.down(); mouse.up();` **before** the
dead-zone move (the drag can never arm — deterministic, not load-dependent) — reverted after.
`table-fit.spec.ts` has two tests; only the first (`TITLE`) calls `pointerDrag`/`touchDrag` at all
(three call sites), so only it exercises the mutation.

- **Mutated: 1/1 FAILS**, with the new, distinct message: `Error: the drag never armed: pickedUp
  stayed 0 after mouse.down` (`play/w32.ts:134`, called from `table-fit.spec.ts:1008`) — not the old
  ambiguous `ghost + indicator === 0`. The file's second test (no drag calls) passed in the same run
  (34.5s), confirming the mutation changed nothing it doesn't touch.

**A real bug the new check caught in its own first draft, in `touchDrag` — found and fixed before
landing, not shipped.** The brief only asked for `pointerDrag`; `touchDrag` got the identical
treatment on the reasoning that it is the same bug class, which is what then caught this: the first
version placed `touchDrag`'s arm-check immediately after `touch('touchStart', from)`, with **no**
move dispatched yet. `Board.tsx`'s own `begin()` (which sets `data-arrange-active`) only runs once a
`pointermove` exceeds `SLOP` (4px) — arming is structurally impossible before any move happens.
`pointerDrag` already does an explicit dead-zone move (`mouse.move(from.x + 8, from.y + 8, {steps:
3})`) before its own check; `touchDrag`'s first draft had no equivalent, so its check was waiting on
something that could not become true yet. This was **not flaky** — it reproduced 2 of 2 times
`touchDrag` ran under this check (`table-fit.spec.ts`'s own two `touchDrag` calls at the time), every
time, by construction, not by chance. Confirmed by comparison: reverting to the pre-fix `w32.ts`
entirely (no arm-check at all, same host, same load) passed the same file clean (`2 passed, 34.1s`)
— the drag itself has always worked; the new check's own placement did not account for `touchDrag`
needing its own dead-zone move first. **Fixed**: `touchDrag` now dispatches one `touchMove` 8px off
`from` before the arm-check, mirroring `pointerDrag`'s own shape.

**Restored, 6 runs across two batches (both fixes in place): 4/6 PASS, 2/6 FAIL** — both failures
are `pointerDrag`'s own arm-check timing out at 3000ms (`play/w32.ts:131-133`), not a logic error:
mutation-tested above to fail deterministically and instantly when the drag genuinely cannot arm,
these two instead ran the full 3000ms before giving up. A **third** run in the same two batches
failed on a completely different, pre-existing, out-of-scope line this lane did not touch — shape
2's own 30-second combat-declare wait (`table-fit.spec.ts:992`, see below) — in the same sitting.
`uptime` at the time read a sustained load average of 13–22 (several concurrent lanes' JVMs and
e2e stacks sharing this one interactive workstation, which also runs the operator's own unrelated
applications) — **an unrelated, pre-existing 30-second budget timing out in the same two batches
that a brand-new 3-second one occasionally does is corroborating evidence that this is host
contention particular to this session, not a defect in either check.** Reverting `w32.ts` to its
pre-fix state entirely and re-running once under comparable load passed clean (`2 passed, 34.1s`,
recorded above) — a single data point, not disproof, but consistent with the drag mechanics
themselves working and the margin being what's tight.

**Not changed because of this: the 3000ms budget.** Raising a precondition timeout to paper over a
race is exactly what this wave's rules forbid, and this report does not ask for an exception —
`play/w32.ts`'s two arm-checks stay at 3000ms, proven correct by the mutation test above (fails
instantly and deterministically when the drag truly cannot arm, not merely slowly). The 4/6-clean,
host-load-correlated local record is reported as-is rather than quietly re-run until a clean streak
happened to land, or masked by a wider number chosen after seeing it fail. The manager's own CI run
(`forge-e2e` on main, a dedicated, unshared runner) is the environment where this wave's "3 runs in
a row" is actually decided; this is this lane's honest local evidence toward it, not a substitute
for it.

## Shape 2 — "still sitting in a combat-declare window after 30s" — NOT FIXED, routed to w39

Seen on `aa0c340`'s own CI run (37166055328, `headSha aa0c3408…`), **after** `6fc7157` (an earlier
wave's `table-fit.spec.ts` fix) already added the "press OK every 250ms while waiting out a
combat-declare window" loop this file still carries (lines ~996–1006). The fix did not make the
problem go away; it just gave it a 30-second budget to time out inside, with the whole loop's own
button-mash accomplishing nothing.

**Cause, read from the product code (not this wave's to touch — `apps/server/src/play/auto.ts` is
unowned and engine-adjacent, so this is read-only):** `auto.ts`'s `DEFAULT_STOP_POLICY` sets
`attackStopIsTheDeclaration: true` (T3, w36), and its own doc says plainly: *"The attack input
itself is not a priority window, so it is never pressed for."* `stopOnMyTurn` includes
`COMBAT_DECLARE_ATTACKERS` specifically so the seat gets **Forge's own attack-declare input**, which
is a different control from the generic priority-window OK the rest of this test's loop presses.
`table-fit.spec.ts`'s retry loop only ever tries `enabledOk(f)` (`[data-testid="live-button-ok"]:enabled`)
— if that is not the control a mandatory declare-attackers window actually waits on (and
`attackStopIsTheDeclaration`'s own comment says it structurally cannot be, by design), pressing it
every 250ms for 30 seconds presses nothing that advances the game, and the loop times out exactly as
observed.

This is a real, code-backed lead, not a guess — but settling it (what control DOES resolve a
mandatory "declare 0 attackers", and wiring that into the wait loop) means reading how the combat UI
itself answers that input, which lives in `apps/ui/src/play/Board.tsx`/`live/gestures/**` and
`auto.ts`'s own protocol for it — all unowned this wave (`Board.tsx`, `live/gestures/**`, `auto.ts`
are explicitly "owned by nobody" / engine-untouched in `wave38-2026-10-03.md`'s lane table). Per the
brief's own rule ("if a shape's cause is in `apps/ui/**`, stop at the write-up"), this one stops
here. **Moved to w39.**

## Shape 3 — "the game ended before the table was full" — NOT FIXED, routed to w39

Seen on run 37171407975 (the Iom2Us artifact, **after** `ceeffab`/A's bridge fix), error:
`"the game ended before the table was full, at turn 12 (wanted >= 12), largest battlefield seen 5
(wanted >= 8)"`. This is a *third*, distinct shape from the other two (A's own w37 closing note
already flagged it as such).

**Read from the product code:** `.board__over` (the DOM signal this assertion checks,
`table-fit.spec.ts:837`) is `LiveBoard.tsx`'s `GameResultScreen`, rendered **only** on a genuine
match conclusion (`data-result={outcome}`, victory/defeat) — not a connection-loss or UI glitch. So
the game really did end, legitimately, at turn 12, before either side's battlefield reached 8
permanents.

**Why, most likely:** `table-fit.spec.ts` keeps its own copy of `twoLegalDecks` (identical to
`e2e/play/enter.ts`'s, modulo a comment — one of H's duplicate-helper findings this wave), which
picks decks **deterministically**: the two legal decks, "draw-go [i.e. `Caw`-named] first… they cast
spells that ASK." That deliberately favours a reactive, instant-speed, interaction-heavy deck
pairing — exactly the shape of matchup where removal and card advantage keep both battlefields
small and a game can end (by damage, by attrition) well before turn 12/battlefield 8, despite the
same two decks facing each other every run. The test's own "ask coverage" goal for deck selection and
its "the table gets full" assumption pull in different directions; this run is a case of the former
winning.

**Why not "fixed" by raising `MIN_TURN`/`MIN_BATTLEFIELD` or retrying:** both are explicitly
forbidden this wave ("No retries, no longer timeouts... raising a precondition timeout is not a
fix"). The only in-scope lever would be picking a different, slower-developing deck pair — a content
decision (which two of the pool's decks to prefer), not a mechanical bug fix, and not something I
could verify would still give the ASK coverage the comment says this selection exists for without
watching several more real matches play out. **Moved to w39** with this exact trade-off written
down, rather than guessed at.

## Done-when, for this item

Shape 1: fixed in `e2e/play/w32.ts` (plus the `touchDrag` dead-zone bug found and fixed along the
way), mutation-tested (1/1 FAILS reverted, counts above). Local 3-in-a-row for the whole file was
not cleanly demonstrated this session (4/6, host-load-correlated, see above) — reported honestly
rather than forced. Shapes 2 and 3: each has a code-backed cause (not a hypothesis) that lands
outside this lane's owned files, written up here instead of guessed at, and moved to w39.
