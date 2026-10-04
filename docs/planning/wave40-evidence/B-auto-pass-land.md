# B — the long pole: auto-pass-land's "seat 0's own spell to reach the stack" never arrives

**Status: diagnosed with hard evidence, NOT fixed. Reverted to HEAD behaviour; the CI line stays
pinned.** A first fix (a 1 s clock-gated floor on the test's own retry) worked, but it is a timing fix,
and the manager's review was right to reject it ("a flaky test is fixed by order, never by timing").
An order-gated alternative was sought and not found — see "Why no order-based gate exists", below —
so the retry is left exactly as it was at HEAD and the line stays on `known_flaky`. The bridge change
this lane also drafted (`PlayBridge.java`'s `applyDelta` reorder) is likewise reverted; see
`B-applydelta-order.md`.

## Reproduced, twice, at the HEAD baseline

`auto-pass-land.jvm.test.ts` at HEAD (no changes), serial, `--fileParallelism=false`:

| batch | runs | fail |
| --- | --- | --- |
| with the bridge reorder applied | 10 | 1 (run 6) |
| with the bridge reorder reverted (current, final state) | 10 | 1 (run 3) |

1 of 10 both times — the same order of magnitude as CI's 1 of 4 (37204094431), with or without the
bridge change. No `taskset -c 0` needed; the shared host's own contention was enough.

## The dump (the new infra caught it on the first failure)

Run 6's timeout wrote `seat-0-s-own-spell-to-reach-the-stack-*.dump.json`. The frame history is 35
entries long and stops dead at `t=7369` — nothing happens for the rest of the 45 s budget:

```
t=7182  s0 setWeaklySelectable [81, 88, 89, 90]   <- the scripted hand, Raging Goblin among them
t=7188  s0 showPromptMessage "Priority: A … MAIN1 … Stack: Empty"   buttons OK enable1=true
t=7344  s1 showPromptMessage "Waiting for A…"
t=7369  s0 updateButtons {OK enable1:false}       <- then: nothing, ever, for the rest of the run
```

No `Pay Mana Cost` prompt, no stack entry, no further frame for seat 0 at all. The bridge's own
stderr (captured in the dump's `stderrTail`):

```
13:05:42 [INFO ] FGameClient: Client sent GuiGameEvent 3625: selectCard (3 args)
13:05:42 [INFO ] GameProtocolHandler: Received: GuiGameEvent 3625: selectCard (3 args)
13:05:42 [ERROR] RemoteClient: Network encode error for A (event: GuiGameEvent 3626: getAbilityToPlay (3 args)): java.lang.ArrayIndexOutOfBoundsException
13:05:42 [INFO ] FGameClient: Client sent GuiGameEvent 3627: selectCard (3 args)
13:05:42 [INFO ] GameProtocolHandler: Received: GuiGameEvent 3627: selectCard (3 args)
13:05:42 [ERROR] RemoteClient: Network encode error for A (event: GuiGameEvent 3628: getAbilityToPlay (3 args)): java.lang.ArrayIndexOutOfBoundsException
    … (repeats identically, every ~25 ms, climbing past event 3660+, for the whole remaining budget)
```

**The server tries to send `getAbilityToPlay` back to seat 0 and fails to ENCODE it, every single
time, forever.** `RemoteClient`'s own log line names the exception
(`java.lang.ArrayIndexOutOfBoundsException`) but not a stack trace, and the failure is inside Forge's
own network/serialization layer (`forge/` — not a file this lane may change). Once it starts failing
it never recovers.

## Mechanism: the test's own blind retry, re-sending `selectCard` with no floor

`auto-pass-land.jvm.test.ts` resends `s.select(0, goblin.id)` on every 25 ms poll tick as long as the
card is still in hand and no `Pay Mana Cost` prompt has shown — no lower bound on how soon after the
first select it tries again. No human click lands that fast. The working theory, not provable further
without instrumenting Forge's own serializer (out of scope): re-sending `selectCard` for the same card
while the game thread is still inside the FIRST `chooseSpellAbilityToPlay()` starts a second,
overlapping ability-resolution for the same card, and something in that overlap corrupts the state the
encoder trips on every time afterward.

## Why no order-based gate exists (read from the SAME dump)

The manager asked for a retry gated on evidence the previous select was refused/ignored — the bridge's
own `rejected` log line, or a fresh offer/priority frame that postdates the select and still shows the
card in hand — rather than a clock. Checked both, against the actual failure:

- **No `rejected` line is possible here.** That only fires when `card()`'s id lookup throws (the
  decode race shape). This card resolves fine — Forge's own engine accepts the `selectCard` call and
  starts processing it; the corruption happens INSIDE that processing, not at the lookup. A card not
  currently in Forge's actionable set is not reported back at all; it is silently ignored at the
  game-logic level, with no wire signal distinguishing "ignored" from "being processed".
- **No fresh offer/priority frame exists to wait for.** The dump's own frame history shows **zero**
  wire traffic for seat 0 between the original select (sent once, around `t≈7182-7188`, right when the
  hand data arrived) and the retry loop's very first tick 25 ms later. The corrupting second send fired
  in the SAME narrow window that any order-based gate would also have to wait through — there was
  nothing yet to gate on. Once broken, there is also nothing to gate on ever again (the dump's own
  silence for the remaining 38 s proves it): a genuinely stuck first attempt and a freshly-corrupted
  one are wire-indistinguishable from outside the bridge.

**Conclusion: no order-based signal exists to tell this retry apart from a legitimate one.** Per the
manager's own fallback, the retry change is dropped entirely — `auto-pass-land.jvm.test.ts` is back to
its pre-wave40 behaviour (confirmed: `git diff` against it now shows only the dump-context wiring from
item 1, additive and already proven safe, nothing retry-related) — and the CI line stays pinned.

## The product hazard (separate from "fix this test")

**A second `selectCard` for the same card during the first's `chooseSpellAbilityToPlay()` leaves every
later `getAbilityToPlay` failing to encode (an `ArrayIndexOutOfBoundsException` inside Forge's own
serializer), forever, for that seat.** A fast real double-click on a hand card in a live match could, in
principle, do exactly this — nothing about the mechanism above is specific to the test harness; it is
specific to sending `selectCard` for the same card twice while Forge is still resolving the first.

**What would settle it:** a jar test that sends two `selectCard` acts back to back with zero delay (no
floor, no retry loop — a deliberate double-fire) and checks whether the SAME `getAbilityToPlay` encode
failure appears.

**Run once (6 times, in fact, out of curiosity once the first didn't reproduce it) — did NOT
reproduce it:**

| run | result |
| --- | --- |
| 1–6 | reached `Pay Mana Cost` normally every time, `getAbilityToPlay` ask observed and answered cleanly |

So the hazard is real (seen once, with full diagnostic detail, under ordinary 25 ms-interval retry
pressure) but is **not** a simple function of "two sends close together" — a synchronous double-fire,
even six times running under `taskset -c 0`, never hit it. It needs the second send to land in a
narrower window than "immediately" — specifically while Forge's game thread has progressed INTO
`chooseSpellAbilityToPlay()` but not yet finished it, which a same-tick double-send from Node (both
acts processed by the bridge's single `bridge-stdin` reader thread, essentially back to back before
Forge's game thread has necessarily even started) does not reliably land in. The 25 ms-apart blind
retry that originally found it apparently sometimes does, under the right host contention. **Not fixed
in the bridge this wave, per instruction** — recorded here as a known hazard for whoever next touches
`PlayerControllerHuman.chooseSpellAbilityToPlay()`'s re-entrancy or Forge's own serializer.

## For the manager

- **`known_flaky` line stays pinned**, unchanged: `wave 35 §S follow-up: a spell resolves unattended
  for the seat holding only lands, against real Forge seat 1 holds only untapped lands while seat 0's
  spell is on the stack, and is auto-passed without ever acting`.
- `auto-pass-land.jvm.test.ts`: `git diff` now shows only the three `s` dump-context arguments added to
  existing `waitUntil` calls (item 1's infra) — no retry-floor code remains.
- `PlayBridge.java`: byte-identical to HEAD (`git diff --quiet HEAD -- …PlayBridge.java` exits 0).
  Proposal recorded in `B-applydelta-order.md` for the tracker, not shipped.
