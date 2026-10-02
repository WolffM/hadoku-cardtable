# §S4 — the repeated `getAbilityToPlay` ask, chased to its cause and fixed

**Claim the brief asked to settle**: `s1-full-control.md`/`s2-ponder.md` (lane
S) and `g2-full-control-ponder.md` (lane G) all measured that casting a
single-ability hand card under Full Control asks `getAbilityToPlay` twice (G
saw a third, irregular-delay ask in two of three runs). None of them said
*why* — S called it "Forge's own bridge-level behaviour" without naming a
mechanism; G proposed hiding it in `LiveBoard.tsx` without knowing whether it
was safe to hide unconditionally. The manager asked for the cause, with
evidence, before accepting it as a quirk — hypothesis (a) a duplicate
`selectCard`, (b) a reply that resolved to null/ABORTED, (c) a different
`Input` re-entering, or (d) something else.

## Method: instrument a real match, not just read the source

Two temporary probes were added to `PlayBridge.java` (both removed before
this file was written — `git diff` against HEAD shows zero change to that
file):

1. A `System.err.println` in `SeatGui.getAbilityToPlay`, `act`'s
   `selectCard` case, and `resolve`, each with a timestamp — so the exact
   order of client acts, ask opens, and ask resolutions could be read off
   `bridge.stderr.txt` (a plain log file, never the JSON protocol channel:
   `protocol`, a separate `PrintStream` captured before `System.setOut
   (System.err)`, is the only thing that writes the wire).
2. `diagDumpInputs(tag)`: for every human-controlled `Player` in the live
   `Game` (reached the same way `refreshActionable` already does —
   `LOBBY.getHostedMatch().getGame()`, in-process, no network hop), print the
   Java class of `PlayerControllerHuman.getInputQueue().getInput()`. Called
   immediately before and after `selectCard`, inside `getAbilityToPlay`
   itself, and around `resolve`'s `ask.answer.complete(result)`.

Driven by `apps/server/src/play/scenario.ts`'s real-Forge harness
(`startScenario`, the same `Match.fromClient` path a real socket uses) against
`scenarios/lone-spell.state`, with `Match.setFullControl(0, true)` called
before casting Mana Leak over Memnite. Every `getAbilityToPlay` round and
every `act`/`resolve` was logged with its timestamp and the live `Input`
class on both seats.

## What the live match actually did

For **both** seats' casts (seat 1's Memnite, seat 0's Mana Leak — full control
was only ever on for seat 0, so this is not a full-control-specific
phenomenon) the sequence was:

```
act selectCard(hostCard)                                    [the player's click]
  input: A=InputPassPriority  (at the moment of the click)
getAbilityToPlay(hostCard, [oneAbility])         — ROUND 1
  input: A=InputPassPriority
resolve(round1, oneAbility)                                   [the one answer]
getAbilityToPlay(hostCard, [oneAbility])         — ROUND 2     <-- NO act in between
  input: A=null                                                <-- NOT InputPassPriority, NOT a new Input
resolve(round2, oneAbility)
```

Exact run (seat 0, Mana Leak, host card 81, ability 189 both rounds):

```
t=…840488297  DIAG act selectCard seat=0 card=81
t=…840579786  input player=A: InputPassPriority
t=…843209797  getAbilityToPlay seat=0 host=81 nAbilities=1      [ROUND 1]
t=…843245206  input player=A: InputPassPriority
t=…890704999  resolve s0-1 result={id:189, label:"Counter target spell…"}
t=…893445250  getAbilityToPlay seat=0 host=81 nAbilities=1      [ROUND 2 — no act in between]
t=…893483189  input player=A: null                              [not InputPassPriority, not a new Input]
t=…941040282  resolve s0-2 result={id:189, label:"Counter target spell…"} [same ability]
```

This single trace rules out hypotheses (a)–(c) directly, not by inference:

- **(a) a duplicate `selectCard`**: no `act` of any kind — not from this
  lane's client code, not a retry, not a stale click — appears between round
  1's resolve and round 2's open. The log is a complete, timestamped record of
  every `act` this seat sent; there is none there.
- **(b) a reply that resolved to null/ABORTED**: round 1 resolved to a REAL,
  valid, non-null ability (`id:189`), which is exactly what Forge's own
  `InputPassPriority.onCardSelected` requires to proceed (a null/ABORTED
  reply is treated as cancelling the whole selection per the brief's own
  citation of that method — it would not have reached a second ask at all).
- **(c) a different `Input` re-entering**: this seat's `InputQueue.getInput()`
  is `InputPassPriority` for round 1 and **`null`** for round 2 — not a new
  `Input` instance, not the same one re-entering. Round 2 happens in the GAP
  between two `Input`s, which no `Input` subclass can explain.

## (d): the actual cause, named and cited

Forge-game's own `PlaySpellAbility.playSpellAbility` (the static method every
`Input` eventually calls once a card is chosen — `InputPassPriority` via
`PlayerControllerHuman.playChosenSpellAbility`, `InputPayMana`'s own
mana-ability path via `activateManaAbility`'s
`game.getAction().invoke(() -> PlaySpellAbility.playSpellAbility(…))`) does
this, unconditionally, before anything else:

```java
// forge-game/src/main/java/forge/game/player/PlaySpellAbility.java:80-99
public static boolean playSpellAbility(final PlayerController controller, final Player p, SpellAbility sa) {
    …
    sa = chooseOptionalAdditionalCosts(p, sa);   // <-- line 98
    if (sa == null) { return false; }
    …
}

// :140-152
static SpellAbility chooseOptionalAdditionalCosts(Player p, final SpellAbility original) {
    PlayerController c = p.getController();
    final List<SpellAbility> abilities = GameActionUtil.getAdditionalCostSpell(original);
    final SpellAbility choosen = c.getAbilityToPlay(original.getHostCard(), abilities);   // <-- the second ask
    …
    return GameActionUtil.addOptionalCosts(choosen, list);
}
```

and `GameActionUtil.getAdditionalCostSpell`:

```java
// forge-game/src/main/java/forge/game/GameActionUtil.java:567-589
public static List<SpellAbility> getAdditionalCostSpell(final SpellAbility sa) {
    final List<SpellAbility> abilities = Lists.newArrayList(sa);   // <-- singleton, the SAME sa
    if (sa.isSpell()) {
        for (KeywordInterface inst : source.getKeywords()) {
            if (inst.getOriginal().startsWith("AlternateAdditionalCost")) {
                abilities.clear();
                … // only this keyword ever makes the list anything but [sa]
            }
        }
    }
    …
    return abilities;
}
```

Unless the card has Forge's `AlternateAdditionalCost` keyword (Mana Leak,
Memnite, and Ponder do not — no card in either scenario does), this method
always returns a one-element list holding the exact ability already chosen,
and `chooseOptionalAdditionalCosts` always calls `getAbilityToPlay` again with
it. **This is a genuine, Forge-internal, non-`Input` call site, reached
unconditionally for every single ability activation — a cast, an activated
ability, or a mana ability — not a bug in this bridge, `match.ts`, `auto.ts`,
or the browser.** It cannot be fixed in Forge: `forge/` is pinned
(917bb193) and read-only per the wave's own rules.

## The "sometimes a third ask" was never a third repeat

Running the same probe through Mana Leak's own mana payment (tapping an
Island, `InputPayManaOfCostPayment`) found the identical two-round shape is
POSSIBLE for a mana ability too (its own `activateManaAbility` also ends in
`PlaySpellAbility.playSpellAbility`) — but a clean run, with no overlapping
clicks, paid the full `{1}{U}` cost in **exactly one ask per land, no
repeat**. An earlier, messier probe run (this lane's own polling test issuing
a fresh `selectCard` on the same land every 50 ms before its locally-held
`tapped` flag caught up) produced what looked like a second ask for the SAME
land — confirmed in that run's own log to be preceded by a second, genuine
`act selectCard` for that card: this lane's own script re-clicking an
already-tapped land, the exact "script's own bug" shape
`g2-full-control-ponder.md` already warned about, not a product behaviour.

Re-reading G's own three-round Ponder trace with this in hand:
`g2-full-control-ponder.md` never confirms the third round's host card — it
was chased "while this repro spent attempting to pay mana by clicking a
land", which is exactly when a SEPARATE, legitimate `getAbilityToPlay` for
the LAND's own mana ability would appear. The most likely reading, consistent
with everything measured here: there is no undetermined "sometimes 3, same
ask" case — every cast asks exactly twice, and a third `getAbilityToPlay`
seen nearby is a different, unrelated ask for whatever card is being tapped
for mana.

## The fix

`apps/server/src/play/auto.ts`'s new `repeatedAbilityToPlay(frame, last)`:
pure over `SeatState.lastAbilityToPlay` (the host card + ability id a seat was
just given an answer for — written in `match.ts`'s `fromClient` `case
'reply'` whenever a `getAbilityToPlay` reply resolves to a real ability, and
by the repeat-collapse itself) and the incoming frame. Answers a
`getAbilityToPlay` offering exactly one ability with that SAME ability if and
only if it is the SAME host card and SAME ability id this seat was just
answered for — nothing else. `match.ts`'s `onFrame` calls it **ahead of the
full-control gate**, on purpose: this is not a decision the player ever gets
to make differently the second time, so full control does not need to show
it twice. A real DIFFERENT host card (a land's own, distinct ability) never
matches and is never touched.

This does not change Forge's behaviour (it still asks twice, or more); it
recognises Forge's own already-answered question and answers it the same way,
so the PLAYER sees the ask exactly once, regardless of how many times Forge's
engine asks it, full control on or off.

## The test: `scenario-ability-repeat.jvm.test.ts`

Two cases against real Forge:

1. **Mana Leak over Memnite, Full Control on** (`lone-spell.state`): asserts
   the CLIENT (`s.sent`) sees exactly one `getAbilityToPlay` ask for Mana
   Leak's host card, and that answering it leads to Pay Mana Cost and the
   stack reaching 2 (the cast completing).
2. **Ponder, Full Control on** (`ponder.state`): asserts the client sees
   exactly one `getAbilityToPlay` ask for Ponder's host card, and that — after
   paying for it and passing this seat's own priority (full control also
   turns off autopay, so that is a real click too) — the `order` ask and then
   the shuffle confirm reach the client, matching the brief's own description
   of what should happen next.

**Mutation test**: reverting the fix (`const repeat = null;` in `match.ts`,
disabling the collapse) — both cases FAIL, `expected … to have a length of 1
but got 2` (2 failed / 2 reverted). Restoring the fix — both PASS again (2
passed / 2 restored).

```
CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
pnpm exec vitest run apps/server/src/play/scenario-ability-repeat.jvm.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```

## Confirmation in pre-existing, unrelated suites (no regression)

`priority.jvm.test.ts` (casting Lightning Bolt, no full control, pre-existing,
unmodified) now logs, unprompted:

```
{"evt":"ask-answered","seat":0,"callId":"s0-3","method":"getAbilityToPlay","ms":49}
{"evt":"ask-auto-answered","seat":0,"callId":"s0-4","method":"getAbilityToPlay","why":"forge re-asked its own already-answered getAbilityToPlay"}
```

— the fix engaging naturally in real gameplay this lane did not script, with
the test's own (loose, `toBeGreaterThan`-style) assertions still passing.
`auto.jvm.test.ts`'s lane-C run (two full Preordain casts, each paid with a
DUAL land — Volcanic Island, a genuine 2-ability choice that must NOT be
collapsed) logged 4 `getAbilityToPlay` asks reaching the browser for 2
complete casts: exactly 1 (the spell, single-ability, repeat collapsed) + 1
(the land, a real 2-option choice, never collapsed, its OWN
`chooseOptionalAdditionalCosts` repeat collapsed too) per cast — the expected
count under a working fix, not the 4-per-cast an unfixed repeat would have
produced.

Also run clean (all passing, no changes needed): `match.test.ts`,
`auto.test.ts` (unit, 234 tests), `scenario-order.jvm.test.ts` (Q8),
`scenario-priority.jvm.test.ts` (Q7/Q17), `phyrexian.jvm.test.ts`,
`blockers.jvm.test.ts` (Q10/Q12), `endturn.jvm.test.ts` (Q5),
`mulligan.jvm.test.ts`, `scenario-combat.jvm.test.ts` (Q14),
`scenario-targets.jvm.test.ts`, `reload.jvm.test.ts`.

## Files changed

- `apps/server/src/play/auto.ts` — new `repeatedAbilityToPlay`.
- `apps/server/src/play/match.ts` — `SeatState.lastAbilityToPlay`, set on a
  real client reply (`fromClient`'s `case 'reply'`) and dispatched ahead of
  the full-control gate in `onFrame`.
- `apps/server/src/play/scenario-ability-repeat.jvm.test.ts` — new, the two
  cases and the mutation-test trail above.
- `docs/planning/wave34-evidence/s4-repeated-ask.md` — this file.

No change to `PlayBridge.java`, `forge/`, or any file outside this lane's
list. The two temporary diagnostics described above were removed before this
file was written; `git diff` against `HEAD` for `PlayBridge.java` is empty.
