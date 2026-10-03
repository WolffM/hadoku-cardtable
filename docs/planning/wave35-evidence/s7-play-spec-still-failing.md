# Wave 35 §S follow-up, continued — `play.spec.ts` "a spell resolves unattended" still failing after the land-exclusion fix

## The question

E confirmed the land-exclusion fix (`ad2d4b7`) is in the dist `play.spec.ts`
runs against, yet the check still failed 2/2: five casts (Incinerate, Magus
of the Moon, Ashenmoor Gouger, Magus of the Scroll, Demigod of Revenge), each
`left:true, arrived:false, pressed:[]`. Asked to reproduce at the jvm level
with the same shape (untapped lands left after a cast) and log `decideStop`'s
facts to find out whether the fix itself has a gap, or whose bug this is.

## What was built to check it

Two new real-Forge tests, both proving the land-exclusion mechanism itself is
sound for the shape the finding describes — a cast that leaves untapped
lands on both sides, going through a genuine multi-source Forge "Auto"
payment window (not the single-source shortcut `decidePay` answers without
ever showing a button):

- `two-mana-pass.jvm.test.ts` — bare `Match.fromClient`, Goblin Piker
  (`{1}{R}`) off 3 Mountains, 1 left over opponent Mountain. Both seats
  auto-pass, the cost auto-pays, the creature resolves — logged directly:
  `auto-paid {1}{R}` then `auto-passed` for BOTH seats. 5/5 clean runs.
- `socket-two-mana-pass.jvm.test.ts` — the same cast over the REAL
  `attachPlay` socket path (the same gap category the R4 investigation
  found), both peers doing nothing but answering generic asks. Also clean,
  same `auto-paid`/`auto-passed` sequence.

Both prove: the mechanism this item fixed works correctly, including through
a real multi-source payment window and over the real socket, not just the
single-land case `auto-pass-land.jvm.test.ts` already covered.

## What `play.spec.ts` is actually hitting — not this lane's bug

Added a temporary `debug-autopass` log line to `maybeAutoPass` (removed
before handing back; not shipped) dumping `readPromptFacts`'s full output
every time it is evaluated, then ran `play.spec.ts` myself
(`cd e2e && npx playwright test -c playwright.config.ts play.spec.ts`,
confirmed ports 19008/19028/19108/19128 free first) and read the resulting
`e2e/.run/play-server.jsonl`.

**Found it.** Every stack-non-empty window opened to seat 1 (bob, "UB
Faeries") during alice's casts carries `nonLandSources: [131]` — a single,
real, NON-land actionable item, not a land:

```json
{"seat":1,"phase":null,"stackTopMine":false,"sources":[131],"nonLandSources":[131],"confirmLive":false,"myTurn":false}
```

`decideStop`'s final branch correctly reads this as "there IS something real
to do" and refuses to auto-pass — exactly as designed (a non-land actionable
item is supposed to hold the window open; only a LAND is excluded). Object
131 is owned and controlled by seat 1 (confirmed from the raw capture: `Owner
1, Controller 1`, moved `Library → Hand`), and bob's deck ("UB Faeries,
Jonathan Randle") holds Spellstutter Sprite (Flash) and Slaughter Pact
(castable at instant speed for free, paid later) — both genuine instant-speed
responses a real opponent could legitimately choose to cast while alice's
spell is on the stack. This reproduces identically across BOTH stack-non-empty
windows sampled in depth, for the entire length of the game, not just near the
5 failed casts — the same nonland item sits available to bob every single
time alice casts something, for dozens of windows in a row.

**This is correct behaviour, not a bug.** The land-exclusion fix is working
exactly as specified: a land never blocks the pass, and a real card does.
What changed is that `play.spec.ts`'s own "hands off, only the server" phase
(the loop right before the `unattended` check) only calls `answerPrompt` and
`clickOfferedTarget` — it never presses anything to DECLINE a flash
opportunity nobody intends to take. Before this wave, land noise in
`facts.sources` dominated every window regardless of whether a real flash
option was ALSO present, so the test's premise ("nothing ever needs a human
to look at it") happened to hold by coincidence, for the wrong reason. Now
that lands are correctly excluded, the window correctly reflects REALITY —
bob genuinely has something to decide, every time — and the test's own driver
has no code path that presses OK to decline it.

**Whose bug this is**: `e2e/play.spec.ts`'s own "hands off" loop, not
`apps/server/src/play/**`. The fix belongs there — either give that loop a
`pressOk()` fallback the way the test's OWN earlier `castSomething` loop
already has, or accept that a two-colored interactive deck is not a valid
precondition for an "unattended" proof and only run this specific check
against a deck with nothing at instant speed. Not this lane's file to edit;
reported here with the mechanism, not guessed at.

## Debug instrumentation

Was added to and removed from `match.ts`'s `maybeAutoPass` (a `readPromptFacts`
dump via `this.deps.log`, gated on nothing — meant to be temporary). Confirmed
removed: `diff` against the last known-clean `match.ts` checkpoint from this
session is empty. `pnpm --filter @hadoku/server typecheck` clean after
removal.

## Counts

- `two-mana-pass.jvm.test.ts`: 5/5 clean (bare Match).
- `socket-two-mana-pass.jvm.test.ts`: 1/1 clean (real socket + real jar) —
  not batch-repeated further since the bare-Match version already carries
  the mutation/reliability burden for this mechanism and the real-socket
  harness exists to rule OUT a socket-specific gap, which it did on the
  first clean run.
- `play.spec.ts`, run directly: reproduced the manager's exact finding (1/1,
  same 5 casts, same `left:true/arrived:false/pressed:[]` shape), with full
  `decideStop` facts captured proving the cause.

## The manager's challenge, and the bisection

The manager pushed back, correctly: before this wave the OLD jar never put
lands in the actionable set at all (that is R15's whole change), so if `[131]`
is a real non-land item, `decideStop` would have refused the SAME WAY on the
old jar too — and this check passed on 0.30.0 CI. Something this wave must
have changed it. Asked to bisect with one `play.spec.ts` run per step,
server rebuilt each time a source changed, ports confirmed free first.

**Every combination tried still fails, identically** (same 5 casts, same
`left:true/arrived:false/pressed:[]`, and — checked explicitly — `everOffered`
and `casts` are **byte-identical** across all three runs, confirming the
exact same deterministic game state is reached every time regardless of
which combination is running):

| Step | Server code | Jar | Result |
| --- | --- | --- | --- |
| current (baseline) | HEAD (`ad2d4b7`) | current (R15) | FAILS |
| (a) | HEAD (`ad2d4b7`) | **old** (`~/.cache/cardtable-w35/forge.jar.prev`, pre-R15) | FAILS |
| (b) | **pre-wave** (`025c6fe`, no Q17 fix, no land-exclusion fix at all — raw `facts.sources`) | current (R15) | FAILS |
| (c) | **pre-wave** (`025c6fe`) | **old** (pre-R15) | FAILS |

Step (c) is the one that matters most: pre-wave server code AND the pre-R15
jar, together, against the CURRENT `e2e/play.spec.ts` — the closest
reproduction of "everything as it was on 0.30.0" this worktree can assemble —
still fails the same way. Since the old jar never offers a land as
actionable, `[131]` being present and blocking the pass on step (c) proves
`[131]` was never a land in the first place, on any version tested — it is
a genuine non-land item, both before and after this wave, exactly as the
first write-up concluded.

**The e2e driver itself, checked against `origin/main` (the wave-35 branch
point) directly, does not explain it either**:
- `e2e/play/prompts.ts` (`answerPrompt`, used in the failing loop): **zero
  diff**.
- `e2e/play.spec.ts`: a small diff (39 lines) — the opening Play/Draw button
  moved off `live-button-ok` to its own `live-play-or-draw-play` testid (an
  EARLIER, unrelated step), a doc comment added right above the existing
  assertion (no behaviour change), and `h.pause()` → `await h.pause()` in the
  LATER hand-driving phase. None of it touches the failing loop
  (`dragToBattlefield`/`dragLanded`/`arrived`/`clickOfferedTarget`, lines
  ~279–450 and the watch loop itself) or anything upstream of it — confirmed
  line-for-line, not just by absence from the diff.
- `e2e/play/hands.ts`: real changes (R7's click-then-settle gesture, R2's
  Play/Draw handling), but `connectHands`/`hands.push` — where any of this
  runs — happens strictly AFTER the `resolvedUnattended` check in the test's
  own sequence. Not active yet when the loop in question runs.
- The two decks (`decks/standard-2008/*.dck` for "Red Deck Wins" and "UB
  Faeries") and the deck library/catalogue they come from: unchanged since
  before `origin/main` (commit `7029898`, an ancestor of the branch point).

**What is left, and what is not resolved**: no code or data difference
between "now" and "everything this worktree can reconstruct of 0.30.0"
changes the outcome. The test's own comments already name the one variable
no seed controls: *"the seed fixes Forge's shuffles and the coin toss, and
explicitly NOT the AI or thread timing… which is what decides how far this
game actually gets."* A JVM's own thread scheduling is exactly that
uncontrolled variable, and it is entirely plausible a 0.30.0 CI run reached a
DIFFERENT point in the same deterministic shuffle before its own turn/time
budget ran out — one where bob's flash-speed option never happened to be
live at the moment alice cast something — without any code change at all.
That was not reproduced here (this host's own runs were suspiciously
consistent across all four combinations above, which argues against pure
chance on THIS host today, but says nothing about a different host on a
different day). Flagged, not resolved: if there is a code-level cause left,
it is outside every file this bisection could vary (`apps/server/src/play/**`,
`e2e/play.spec.ts`, `e2e/play/prompts.ts`, `e2e/play/hands.ts` for the
relevant phase, the deck library) — the next place to look, if the
contradiction needs to close further, is whatever actually decided "passed
on 0.30.0 CI" (the specific run's own `everOffered`/`casts`/`passes` log, if
it still exists, would say directly whether that run ever reached a real
cast at all, or passed through the `casts.length === 0` / UNPROVEN branch).

All bisection copies were restored: `match.ts`/`auto.ts`/`visibility.ts`
diffed byte-identical against `ad2d4b7` (HEAD) after restoring, typecheck
and the full unit suite (679/679) clean, `dist/index.js` rebuilt from the
restored source, no orphaned processes left from any bisection run.
