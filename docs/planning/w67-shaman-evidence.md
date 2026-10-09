# w67-shaman — evidence (2026-10-09)

The report (operator, verbatim):

> playing Viridian shaman with no available targets creates an awkward lag situation. My guess is
> that the card is looking for available targets then cancels and just plays the card instead. i'm
> curious why this situation creates 2s~ of lag … this lag exposes some brittle behavior in how the
> card back is drawn/animated because when the card is released then my cursor can still move and i
> think there is still some logic somewhere that tries to look for the cursor when the animation
> starts rather than animating it to where the cursor was released.

## How it was measured

- Scenarios: `apps/server/src/play/scenarios/w67-shaman.state` (alice: Viridian Shaman in hand, three
  Forests; bob: empty board, empty hand; no artifact anywhere) and `w67-bears.state` (the same board
  with Grizzly Bears, a vanilla 2/2 — the baseline).
- Spec: `e2e/w67-shaman.spec.ts`, three runs per job — `shaman`, `bears`, and `shaman-held` (bob on
  Full Control holds priority 2 s while the Shaman is on the stack, then presses OK). Alice drags the
  card with real `page.mouse` steps, releases over her battlefield, at once moves the pointer 300 px
  away and keeps it drifting for 4 s (6 s in `shaman-held`), then holds it still 3 s. Both pages
  record every animation frame: the lift/ghost (`[data-cast-lift]`, `[data-cast-ghost]`), the stack
  card (`[data-placed-spell]`), bob's back (`.presence__back`), the flight copy
  (`.presence__handoff`), the real battlefield card (with its computed visibility), each element's
  own visibility, alice's pointer and bob's drawing of it (`[data-board-overlay] .presence`).
- Server: a new probe-mode trace in `apps/server/src/play/match.ts` — `forge-frame` (every frame
  Forge sends), `forge-command` (every command sent to Forge) and `wire-frame` (every frame put on
  a seat's socket), behind `CARDTABLE_PLAY_PROBE=1` (the e2e harness's servers; never production).
  Each row carries the log's own ms `t`, so the spec prints it relative to alice's `pointerup`.
- Five green claw jobs (forge.yml `only=e2e`, video on): runs 37980414562, 37980425279 (Shaman
  only), 37982030321, 37982040517, 37984569931 (all three runs each). All times below are ms after
  alice's `pointerup`.

## (a) The timeline

One representative job per column (run 37980425279 for the first, 37984569931 for the rest).

| Phase | Shaman | Shaman (other job) | Bears | Shaman, bob holds 2 s |
| --- | --- | --- | --- | --- |
| `selectCard` act reaches Forge (`forge-command act`) | 13 | 8 | 10 | 8 |
| Forge's `getAbilityToPlay` for the cast → **browser** auto-answers (`LiveBoard.tsx:1610`) | 55 → 76 | 17 → 39 | → 36 | → 30 |
| Forge re-asks it; server answers (`ask-auto-answered`) | 127 | 46 | 44 | 37 |
| Payment withheld + auto-paid (`auto-paid`) | 199 | 82 | 75 | 75 |
| alice's priority auto-passed (`auto-passed` seat 0) | 307 | 169 | 144 | 148 |
| bob's priority auto-passed (seat 1) / bob presses OK | 346 | 187 | 170 | 2043 (his OK reaches Forge) |
| Spell drawn on alice's stack (`[data-placed-spell]`) | 372 | 197 | 160 | 181 |
| Resolution: creature in alice's battlefield DOM | 543 | 261 | 251 | 2110 |
| Trigger's `getAbilityToPlay` ("When Viridian Shaman enters, destroy target artifact") → browser answers | 477 → 539 | 234 → 283 | (none) | → 2141 |
| alice: zero-distance landing flight ends, real card shown | **889** | **576** | **560** | **2429** |
| bob: real card shown for good | **987** | **646** | **560** | **2476** |

Other Shaman jobs: shown for good on alice's screen at 1073 / 620 / 573 ms; Bears at 739 / 539.

**On the claws there is no 2 s.** Release-to-board is 0.55–1.1 s for the Shaman and 0.54–0.74 s for
Grizzly Bears: the trigger is not what makes it slow. What the data shows instead:

1. **The ETB trigger costs one browser round trip, after the card has already landed.** Forge
   sends `getAbilityToPlay` for the trigger (one ability, labelled with the trigger's text) right
   behind the `applyDelta` that puts the Shaman on the battlefield. It goes to the browser
   (`match.ts` `openAsk` → `openAskFrame`, line 2630) because the server's `onlyAnswer` leaves a
   lone `getAbilityToPlay` to the client by design (`apps/ui/src/play/prompts/rules.ts:580-600`).
   The browser answers it from a React effect (`LiveBoard.tsx:1610`) in 43–107 ms. Forge's game
   thread is parked until then: the "Priority: Alice … Stack: Empty" window follows only the answer.
   There is no target ask at all: with zero candidates `TargetSelection.chooseTargets` returns false
   at once (`forge-gui/.../player/TargetSelection.java:115-118`), so the operator's guess — "looks
   for targets, then cancels" — is right about Forge, but it costs one round trip, not seconds. On
   the real internet that round trip is the player's RTT plus a React render; it delays the next
   priority window, not the landing.
2. **The cast itself costs a browser round trip too** (`getAbilityToPlay` s0-1, 11–60 ms on the
   claws, a full RTT in production), then the server's own re-ask answer and auto-pay.
3. **Every landing ends with a 300 ms flight to nowhere on the caster's screen.** The ghost already
   glided into the reserved gap at the release (`install.ts:773-783`); at resolution it is put back
   at that same point and `landCastGhost` flies it from the gap to the gap (`install.ts:1007-1020`,
   the client's own `landing` row says `dx: 0, dy: 0` in every run) — `FLOAT_BACK_MS` = 300
   (`cast.ts:103`) with the real card hidden under it. It looks like a card already standing there,
   so it is not perceived lag, but it is 300+ ms between "in the DOM" and "shown".
4. **The one way to get the reported ~2 s on this board is the opponent holding priority.**
   `shaman-held` is 2.43 s, and it is a human's click, not the engine. Bob's stop is auto-passed on
   the claws because he has no mana source (`stop-decided` … `sources: 0`); a friend with untapped
   lands or a held card gets the stop kept and the creature waits on them. That is true of every
   creature, not of the Shaman.

Not verified: what made the operator's own game slow. Production logs carry no per-frame trace
(probe mode only), and the `match-frames` ring for the operator's game was not in
`~/.pm2/logs/cardtable-out*.log` when this was written (the ring is logged at match end; the only
"Viridian" in the logs is a Viridian Zealot, 2026-10-08). If it happens again, the facts to read
are: was bob's priority `prompt-forwarded … kept` while the Shaman was on the stack, and the
`ask-answered ms` of the trigger's `getAbilityToPlay`.

## (b) Does anything chase alice's pointer?

**Nothing moves toward the post-release pointer — on either screen, in any of the 11 recorded
runs.** The spec measures every drawn stand-in's distance from the straight path between the release
point and the card's final place: alice's screen has 0 off-path frames in every run; bob's off-path
frames are all explained below and none is near the pointer (62–302 px from it).

What the recording did find — two defects on bob's screen and one on both, all "the card is drawn
somewhere it shouldn't be while the cursor moves", which is very likely what was seen:

### B1. A phantom back that lives exactly as long as the pointer keeps moving (bob's screen)

Run 37984569931, `shaman`: at 194 ms, the instant bob's back hands over to the stack card at the
release point (441,332), a **new** card back appears in the reserved gap (452,291), `data-waiting`,
at the fallback size **152×212** — more than twice a battlefield card (68×95). It stands there
through the stack, through the landing flight, after the card is shown, and goes at **5665 ms** —
1484 ms after alice's pointer stopped (4181 ms). Run 37982030321 shows the same phantom in `bears`
(from 346 ms) and `shaman-held` (from 387 ms), each still standing when the record ended.

Cause, two parts, both `apps/ui/src/play/live/presence.ts`:

1. **A stale `placing` echo opens a new wait.** Alice's presence messages carry `placing.at` = the
   centre of her parked ghost (`handsOf`, `presence.ts:335`) — and the ghost is gliding into the gap,
   so the point moves. One sent before her ghost retired reaches bob just after `handToSpell` ended
   his wait (`presence.ts:899`). `draw()` (`presence.ts:808-814`) sees `waiting === null`, and the
   AE18 stale guard compares the echo's point with `recentlyPlaced.at` — the RELEASE point
   (`presence.ts:1021`) — not the gap, so it misses, and a fresh point wait is stood up at the gap
   (`standBack`, sized from a hand card; both hands are empty here, so the CSS fallback size).
2. **Its grace is a debounce on the pointer.** The next messages carry `placing: null, held:
   false`, which re-arms the wait's timer to `CLEARED_GRACE_MS` (1.5 s) **on every message**
   (`presence.ts:837-839`: `clearTimeout(waiting.timer); waiting.timer = setTimeout(…)`). Alice's
   pointer sends a message every 60 ms while it moves, so the phantom cannot end until she stops —
   then it goes 1.5 s later. Its lifetime is literally tied to the cursor moving: "some logic that
   looks for the cursor".

### B2. The card glides into the gap, jumps back to the release point, then flies into the gap again (both screens)

Alice (37984569931 `shaman`): ghost glides release (441,551) → gap (454,602) over 300 ms (the
`landingFrame` block, `install.ts:773-783`) … at 197 ms it is replaced by the stack card back at the
**release point** (441,551), 104×145 (`placeSpell(source, point, 'you')`, `install.ts:756`) … at
261 ms the ghost reappears in the gap. Bob: the same — back glides to the gap, the stack card is
drawn at the release point (194 ms, `handToSpell` → `placeSpell(id, backAt)`, `presence.ts:887`),
then a flight copy flies from the release point into the gap (`stackBound`, `presence.ts:948-950`,
`flyTile`, `presence.ts:909-915`). With an opponent holding priority the card sits back at the
release point, at stack size, for the whole wait (2 s in `shaman-held`), and only then travels.

### B3. The real card shows in its slot before its flight starts (bob's screen)

Bob's real card is visible in the gap for 13–79 ms (`field … vis=visible` at 324/654/811 ms, then
`vis=hidden` when the flight copy starts at 337/733/834 ms) — the copy flies in on the NEXT match
change, not the one that put the card there (`handoff`'s `stackBound` rAF, `presence.ts:909-915`).

Also seen, smaller: bob's held back trails the pointer (60 ms throttle + 90 ms CSS transition), so at
the release it is up to ~180 px behind (284,250 vs 441,332 in 37984569931) for one or two frames
before the placement snaps it; the stack card's first frame on alice can be 104×268 (its tile's first
render) for ~35 ms. The 104×145 stack card at 672,224 on bob is `data-placed-pending`, hidden — not a
flash.

## Proposed fixes (not implemented)

1. **B1 (the phantom), `presence.ts`.** (a) In `draw()`'s `placing` branch, treat a `placing` echo
   as stale whenever the screen just handed this episode over — e.g. remember the episode as ended
   in `handToSpell`/`onPlacement` (`recentlyPlaced` with `until`) and refuse ANY `placing` inside
   that window, not only one at the same point; or have the sender stop reporting `placing` for a
   card whose `forge:placement` already went out (it knows: `resolveLift` sent it). (b) Make the
   `CLEARED_GRACE_MS` arm-once (`if (!waiting.cleared) { … }`), the same fix AE16 made to
   `checkWaitingOn` — a grace must not be a debounce.
2. **B2 (back-and-forth).** Register the stack point at the gap the stand-in actually waits in, not
   the raw release point: `install.ts:756` `placeSpell(source, point, …)` → use `me.at` once the
   landing frame has measured the gap (or simply don't draw a played permanent's own stack entry
   while it is the lone item — the parked ghost already stands for it, which is what
   `carryCastOffStack`'s comment says the design is). Same on bob: hand the back to the stack card
   at the back's current point (`back.getBoundingClientRect()`), not `backAt`.
3. **The 300 ms flight to nowhere** (`install.ts:1007-1020`): when the settled box is within a few
   px of `p.at` (the `landing` report's `dx`/`dy`), skip `landCastGhost` and release at once — the
   card is already drawn there. Saves 300 ms of hidden card on every own landing.
4. **The trigger's round trip:** answer a lone `getAbilityToPlay` server-side when it is a trigger
   (the label is Forge's own trigger description) — the client's reason for owning it
   (`rules.ts:580-600`, naming what was played after a click) does not apply to a trigger nobody
   clicked. Saves one player RTT before the next priority window, not before the landing.

None of these touch the ~2 s of a held priority, which is a human's turn to act; if the operator's
opponent had a stop kept, the fix is in what the board shows meanwhile (B2), not in the time.

## Telemetry added (kept)

- `apps/server/src/play/match.ts`: `TRACE_FRAMES` (probe mode), `frameGist`, and three log rows —
  `forge-frame` in `onLine`, `forge-command` in `command`, `wire-frame` in `send`. Unit-tested in
  `match.test.ts` (`frameGist`), including a frame whose `card` is `null` (the first cut crashed the
  probe server on one — runs 37979551772/37979562967).
- `e2e/w67-shaman.spec.ts` + the two scenarios: the recorder, the off-path chase test and the
  `[shaman]` evidence lines.
