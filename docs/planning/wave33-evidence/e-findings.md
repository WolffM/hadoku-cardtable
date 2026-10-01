# §E — Full Control, toggled while a seat holds priority over an already
non-empty stack, leaves that seat's own subsequent cast with no effect at all

**Reported by**: lane E, against `e2e/w33.spec.ts`'s Q7 (`lone-spell.state`).
Not an e2e bug — ruled out id/zone mistakes, click-timing races, and host
contention before writing this up. Wave 34 material; Q7 itself now asserts
the counter's OUTCOME instead (Memnite ends up in bob's graveyard) rather
than depending on Full Control at all, so this does not block wave 33.

## The symptom

`lone-spell.state`: alice (seat 0) holds Mana Leak and 3 untapped Islands;
bob (seat 1, `activeplayer=ai` in the scenario's convention, an ordinary
human seat) has an uncontested Main Phase 1 and a free 0-cost creature
(Memnite). Sequence:

1. Bob casts Memnite (`castCard`, a plain click + no Pay Mana Cost needed).
   Stack count goes 0 → 1. Confirmed every time.
2. Priority passes to alice with Memnite the only thing on the stack.
   `offered(alice.page)` correctly lists Mana Leak's id (confirmed: id 102,
   `data-board-card`, `closest('[data-zone]') === "hand"` — not an Island,
   not a stale id from scenario setup).
3. **With Full Control turned ON for alice** at this point (clicking
   `[data-testid="live-full-control"]`, confirmed via
   `aria-pressed="true"`) — at EITHER of two different moments tried (before
   her cast is ever offered, i.e. right after the match opens with bob not
   yet having acted; or after, right before clicking Mana Leak's card) — the
   click on Mana Leak's card produces **no observable effect whatsoever**:
   - No "Pay Mana Cost" text ever appears (confirmed via `says()` polled
     every 50ms for 3s immediately after the click, and again via a 60-
     iteration/3s loop with no live-prompt ever opening either).
   - `stackCount()` never changes from `1` (bob's Memnite stays the only
     stack item) for the full 15s the test waits.
   - No error, no live-prompt, no change to `enabledOk` state — `says()`
     stays fixed on the SAME text that was showing before the click
     (`"Priority: Alice\nTurn: 1 (Bob)\nPhase: Main phase, precombat\nStack: 1
     to Resolve."`) for the entire window.
   - After enough real time passes with nothing happening, a **generic**
     `getAbilityToPlay` ask eventually surfaces on its own (confirmed via
     `data-method="getAbilityToPlay"` on the `live-prompt` sheet, ~15s
     later) — this is Forge's own fallback for "you must declare your
     priority action," not a response to the click; it arrives on the SAME
     schedule whether or not Mana Leak was ever clicked.
4. **With Full Control left OFF**, the identical click on the identical
   card, in the identical scenario, works: the cast succeeds, and because
   nobody is left to respond, the server auto-passes both seats and Mana
   Leak resolves immediately — `stackCount()` is measured going straight
   from `1` to `0` (Memnite countered), too fast for `expect.poll` to ever
   catch the transient `2`-item window in between. This is the ORIGINAL
   race `w33.spec.ts`'s header comment (and the manager's first follow-up)
   already anticipated Full Control as the fix for — but Full Control
   itself is what's broken for this exact seat/window.

## What this rules out

- **Wrong card id.** `offered(alice.page)` was printed in full
  (`[{"id":"102","zone":"hand","text":"Mana LeakInstantCounter target spell
  unl..."}]`) immediately before the click, both with and without Full
  Control — same id, same zone, every time.
- **A click-timing race in the test's own polling.** `castCard` was rewritten
  (this wave) to wait before its first check, to keep calling `answerPrompt`
  while any live-prompt is open, and to throw a NAMED error rather than
  silently return if it never sees the stack move — it reliably reports
  "stuck on <exact text>" every time Full Control is on, and reliably
  returns once the stack genuinely changes every time it's off. Behaviour is
  deterministic across repeated runs, not flaky.
- **Host contention.** Reproduced identically (`uptime` load ~2-3, no other
  JVM visible above idle) and under load (lane S's own match JVMs observed
  at 200-300% CPU at other points this session) — the symptom and the exact
  stuck text are IDENTICAL either way.
- **Toggle timing.** Tried both "Full Control on before the match's first
  action is even offered to alice" and "Full Control on only once her cast
  is already offered" — identical wall both times.

## What this does NOT rule out (not investigated further — handing off)

- Whether Full Control's effect here is specific to "a seat holding priority
  with something ALREADY on the stack that isn't theirs" (this scenario),
  versus any seat/any window — Q18's Prodigal Sorcerer and the Doom Blade
  test both turn Full Control on successfully for a seat casting from an
  EMPTY stack, and both work fine, so the empty-stack case is NOT affected.
  The common thread across the one broken case (Q7) and the two working
  ones (Q18, Doom Blade) is specifically "was anything already on the stack,
  put there by the OTHER seat, when Full Control was switched on" — worth
  checking first.
- Whether this is `match.ts`'s own Full Control wiring (`auto.ts`'s policy
  values going stale, or `boardInteraction`'s `weaklySelectable` union not
  being re-sent on the toggle) or something in `PlayBridge.java`'s
  `setFullControl` handling not re-pushing the actionable set the way S's
  `refreshActionable` fix now does for scenario application. Not read.

## Repro

```sh
# e2e/w33.spec.ts, Q7's test body, with this block re-inserted right after
# "alice is offered her counterspell" and before castCard:
await alice.page.getByTestId('live-full-control').click();
await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
```
Scenario: `apps/server/src/play/scenarios/lone-spell.state`. Run
`pnpm --filter @hadoku/e2e test w33.spec.ts -g Q7` against a live Forge
build (`CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES` set).

---

# §E2 — a multi-step resolution (Ponder's reorder sequence) can get silently
auto-answered start to finish, with no click, no ask, nothing reaching the
browser at all

**Reported by**: lane E, against `e2e/w33.spec.ts`'s Ponder spec
(`ponder.state`). Same "don't depend on this" shape as §E above, but the
opposite direction: here it's the ABSENCE of any stop, not Full Control
breaking one. The spec no longer depends on this sequence at all (it now
asserts Ponder's text straight off the stack item, before any of this
starts) — this is recorded because the manager asked for it, as wave 34
material for whoever owns Ponder's follow-up resolution path.

## The symptom

`ponder.state`: alice (seat 0) holds Ponder and 3 untapped Islands; nothing
on the opposing side to respond with (`void bob` — his page is never
touched). After `castCard` casts Ponder (stack 0 → 1):

- **With no intervention at all** (no click of any kind after the cast):
  `says(alice.page)`, polled every 40ms for up to 15s, went straight from
  Ponder sitting on the stack to a **fresh, empty-stack priority stop**
  (`"Priority: Alice\nTurn: 1 (Alice)\nPhase: Main phase, precombat\nStack:
  Empty"`), repeated unchanged for the rest of the window. No "Do you want
  to shuffle the library?" shortcut ever appeared, no `live-prompt` modal
  ever appeared, no ask of any kind reached the browser — yet the stack is
  empty, meaning Ponder's ENTIRE effect (the look-at-3, the reorder-or-
  shuffle decision, and the optional draw) ran and resolved on its own.
  Captured verbatim across a 6-repeat debug run, every single sample:
  ```
  PONDERDBG {"text":"Priority: Alice\nTurn: 1 (Alice)\nPhase: Main phase, precombat\nStack: Empty","stack":0}
  ```
  (repeated ~40 times per run, unchanged, until the test's own timeout).
- **With Full Control turned ON for alice before casting** (the empty-stack
  case — safe per Q18/Doom Blade, see §E above): made it WORSE, not better —
  5 of 5 repeats failed the same way (`live-prompt` count stayed `0` for the
  full 15s), where the no-intervention version had been intermittently
  getting a REAL ask through (observed elsewhere in this session: 4/10,
  then 3/10, passing some runs by having the ask show up).
- **With an explicit Cancel click on the generic "Stack: 1 to Resolve"
  priority stop** (tried before isolating the above): intermittently left
  alice's own client reading `"Waiting for Bob..."` forever — i.e. the
  manual click handed priority to BOB in a way the normal, click-free
  auto-pass never does, and since this seat's own test never drives bob's
  page, that seat then has nothing left to answer it. This is what first
  surfaced the whole investigation; removing the click (letting auto-pass
  handle that first stop, same as Q17) fixed THAT specific hang, but did
  not fix the underlying auto-answer behavior above.

## What this looks like

The same class of bug as Q8's finding (`docs/handoff` / the Q8 removal
note): an ask that has a legal default reply, or that nobody is holding up,
gets answered by the server's own default policy before it ever becomes a
real, interactive ask on the wire — except Q8 could at least observe the
auto-answer happening (`ask-auto-answered` in the server log); here, nothing
in `says()`/`stackCount()`/`live-prompt` distinguishes "resolved via a real
multi-step player choice" from "the whole thing defaulted itself away,"
because the only observable difference is in a server log this lane's e2e
harness does not read on the HTTP path (`e2e/play/scenario.ts`'s
`startScenarioMatch` goes straight to `/api/play/matches`, bypassing
whatever would surface `ask-auto-answered` events the way `Q8`'s removed
spec could see them through `apps/server/src/play/match.ts`'s own log).

## Not investigated further — handing off

- Whether this is `auto.ts`'s own policy set (same file Q8's `two-triggers`
  investigation touched) extending further than "one legal reply" asks, to
  cover Ponder's reorder/shuffle choice too, by default.
- Whether Full Control's apparent WORSENING of the symptom (5/5 vs. a
  partial pass rate with nothing toggled) is a second, independent bug, or
  the same root cause expressed differently once Full Control changes which
  policy path `auto.ts` takes.
- Whether the real ask, when it DOES arrive (the intermittent passing
  runs), is reaching the browser because of a genuine race Forge itself has
  (a real nondeterminism in whether the reorder step needs a decision), or
  because of something timing-dependent in this test's own polling.

## Repro

```sh
# e2e/w33.spec.ts's OLD Ponder test body (before this wave's fix), or:
cd apps/server/src/play
# cast Ponder via the HTTP scenario path, then poll says()/stackCount() with
# NO click of any kind for 15s — watch stackCount go to 0 with no ask ever
# having appeared.
```
Scenario: `apps/server/src/play/scenarios/ponder.state`. The CURRENT spec
(`w33.spec.ts`, "Ponder's full oracle text is readable while it sits on the
stack") no longer depends on this path — it reads Ponder's stack item text
immediately after casting, with Full Control holding it there, before any
of the above has a chance to run.
