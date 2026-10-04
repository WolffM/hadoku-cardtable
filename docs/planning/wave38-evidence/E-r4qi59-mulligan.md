# E-r4qi59 — the mulligan-driver stall (w38 §E item 2)

**The named lead (wave file): `keepBothHands`'s `clickedFor` map (`scenario.ts:171`, `:198`, `:219`)
clicks a distinct question text once; if that click is swallowed and Forge re-asks the identical
text, the loop never re-clicks and waits forever.** Asked to prove or kill this from the artifact.

## The artifact read

`gh run download 37161388557 -R WolffM/hadoku-cardtable -n forge-e2e-evidence-1`, stack `R4Qi59`
(w33's "a stack item carries its target… (the Doom Blade case)", the `auto-target` scenario).
`headSha` for this run is `5a4cae0`, an ancestor of both w37 fixes (`aa0c340` §E.1's
`awaitScenarioHand`, `ceeffab` §A's bridge resync) — **this evidence predates both**, so it is read
against the OLD `startScenarioMatch` (a bare `offered(page)` poll, no hand-containment
precondition).

`play-server-stack-R4Qi59.jsonl` (66 lines, full file read): seat 1 (bob, the `ai…` seat) gets two
`stop-decided` lines at `23:23:46.613`/`.614`, both `"decision":"kept","buttons":[true,true]`, and
then **nothing else for this match ever appears in the log again** — the next line is the
harness's own `shutdown-begin` at `23:25:15.783`, 89 seconds later. The final page snapshot (alice's
side) shows `status: Waiting for Bob…` still up.

The test's own failure is `w33.spec.ts:643`: `"alice is offered Doom Blade — the precondition
'auto-target' sets up"`, a **90-second** `expect.poll` timeout on `offered(alice.page)` — **not**
`keepBothHands`'s own `"the mulligan never settled on both sides"` error, which has its own 30-second
budget (`200 * waitForTimeout(150)`) and a completely different message.

## The named lead, killed by its own predicted shape

If a click were genuinely swallowed on the wire, `keepBothHands`'s dedup (`clickedFor.get(f) ===
text`) would skip every re-click while Forge kept re-showing the identical, unanswered question —
and the function would throw **its own** `"the mulligan never settled on both sides: alice {…} | bob
{…}"` within **30 seconds** of the click being lost, with a dump of both sides' live state attached.

That is not what happened. The test ran for 90 seconds inside a *different* assertion
(`w33.spec.ts`'s own "is offered" poll), which only runs **after** `startScenarioMatch` — and by
extension `keepBothHands` — has already **returned without throwing**. A function that hangs
forever on a lost click cannot also return normally 30 seconds later and let a caller's unrelated
90-second poll be the one that times out. **The dedup-trap mechanism, as stated, is killed by the
artifact: it predicts the wrong failure (a 30s `keepBothHands` throw), and the observed one is a 90s
"offered" timeout from code that runs only once `keepBothHands` is already done.**

## What is NOT killed: Forge's own side of this

A's own closing note for w37 (independently, from the same run) reads this differently: *"Forge
parked on seat 1's keep-or-mulligan prompt, hook never ran."* That is consistent with the log (seat
1 stuck at `buttons:[true,true]` with no further `stop-decided` ever recorded) — **Forge itself**
never received or never acted on an answer for seat 1's keep/mulligan decision. Confirmed from the
bridge's own source (read-only, `PlayBridge.java` ~line 1622, A's §A comment): the scenario's
`startGameHook` runs from `PhaseHandler.setupFirstTurn`, which Forge calls only **after**
`MulliganService.perform()` returns. If seat 1's mulligan genuinely never resolves inside Forge, the
hook structurally cannot have run yet — exactly A's framing, now traced to the line that makes it
true, not just asserted. For `keepBothHands`
to have returned without throwing while that is true, its own detection of "this seat is past the
mulligan" must have read `true` for bob **incorrectly** — most likely the `live-prompt` short-circuit
(`scenario.ts` ~line 162: *"the mulligan is over the instant a real ASK opens"*) firing on something
that was not actually the end of bob's mulligan, or `says(bob.page)` reading text that no longer
matched `openQuestion` for a reason other than the question being answered (the snapshot's own
`Waiting for Bob…` overlay on alice's side raises the same possibility for bob's page, un-evidenced
either way — this artifact has no DOM snapshot of bob's own page at the moment `keepBothHands`
exited).

**This cannot be confirmed or killed from this artifact.** The server log in this codebase has no
record of `act`-kind frames at all (`match.ts`'s `fromClient`, `case 'act'`: `this.command(...);
return { ok: true };` — no `this.deps.log(...)` call on that path) — every button-bar click
`keepBothHands` makes, lost or not, leaves zero trace server-side. Only modal `ask`+`reply`
round-trips are logged. There is no way to tell, after the fact, whether bob's "keep" click reached
the server, whether it was answered and Forge silently disagreed, or whether the client-side read of
"past the mulligan" simply misfired.

## What this run does NOT need any more (already improved, independent of this item)

Since `aa0c340` (w37 §E.1), `startScenarioMatch` waits up to 20 seconds for the scripted hand to
land **by name**, before any caller's own "is offered" poll ever runs. If this exact shape recurs
today, the failure is `scenario "auto-target" did not apply: human hand is […]` inside ~20 seconds,
not a 90-second generic "offered" timeout — strictly more informative, and already shipped. That is
a side effect of §E.1, not a fix for this item.

## Decision

No change made to `scenario.ts` for this item: the one lead named in the wave file is killed by the
artifact's own evidence (wrong predicted failure shape); the real mechanism (why `keepBothHands`
let Forge's still-open mulligan slip past as "clear") is a live client/server disagreement this
artifact's log format cannot capture (no `act`-frame logging) and that I could not safely guess a
fix for. **Moved to w39** with the specific gap: either add server-side logging for `act` frames (at
least `selectButtonOk`/`selectButtonCancel` during an open ask-less question) or reproduce live with
`keepBothHands` instrumented to print its own per-tick `{seat, text, mark}` decision, neither of
which this lane's budget covered.

## Done-when, for this item

Artifact read in full; the named lead evaluated against the observed failure shape and killed on
that basis (not assumed); the alternative mechanism stated as open, with exactly what would settle
it (server-side `act` logging, or a live instrumented repro) and why neither ran this wave (time
budget, and `match.ts` logging is unowned/engine-adjacent this wave). No edit to `scenario.ts`.
