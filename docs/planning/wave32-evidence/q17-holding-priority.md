# Q17 — "holding priority on my own spells is weird, why is that still happening?"

Lane S, wave 32. Real Forge (w31 jar), `apps/server/src/play/priority.jvm.test.ts`. Also holds
the answer to lane G's Q7 question (the last section).

## Diagnosis (before any fix)

`passStackWindows` is `true` (`auto.ts`), as the brief said, and it is not the cause. Who holds
priority and which stop fired, measured:

Seat 0, turn 3, two Mountains in play, four Lightning Bolts in hand. It casts one Bolt at the
other player (one Mountain taps, one stays untapped). Frames the seat was sent, from the click:

```
+155ms  PROMPT  "Lightning Bolt (6) … Select any target"      (a selection input)
+209ms  PROMPT  "Lightning Bolt (6) deals 3 damage to B. Pay Mana Cost: {R}"   -> auto-paid {R}
+220ms  ACTIONABLE [20,26,10]                                   <- the other three Bolts
+220ms  PROMPT  "Priority: A  Turn: 3 (A)  Phase: Main phase, precombat  Stack: 1 to Resolve."
+221ms  BUTTONS [OK] [End Turn]
        ... nothing else.  Five seconds later the spell is still on the stack.
--- server decisions after the cast:  ask-answered x3, auto-paid {R}.   NO auto-passed.
```

Forge hands priority back to the CASTER (`Priority: A`, with its own spell under
`Stack: 1 to Resolve.`). `decideStop` reaches the stack-window rule, which passes only when Forge
named nothing castable (`passWhenNothingToDo` and an EMPTY actionable set). Here Forge named three
Bolts, so the seat is left holding priority on its own spell until it clicks OK. **No phase stop
fired** (`isStopPhase` is not consulted with a non-empty stack): the stop is the "something is
castable" rule.

The same cast with nothing else castable (a hand of Memnites, which cannot be cast with a stack)
is passed at once (the spell resolved 23 ms after the caster's prompt), which is why this looks
intermittent: it depends on what the hand holds.

## It is the leak wave 28 removed from the phases, still standing on the stack

A stop conditioned on what the seat COULD do is a stop conditioned on what it HOLDS. Every cast
told the table whether the caster held another response, by whether it sat there or not.

## The fix

`StopPolicy.passOwnSpell` (default `true`; `FULL_CONTROL_POLICY` `false`) and the fact behind it,
`PromptFacts.stackTopMine`, read off the board (`SeatProjector.stackTopActivator`: the top
`GameView.Stack` item's `ActivatingPlayer`). A stack window whose top item the seat itself
activated is passed whatever it could do. **An item the opponent put on the stack is untouched**:
answering it is what a held instant is for, and that window is still a stop when the seat has one.
A held response to your own spell is what full control is for.

After the fix, same scenario: the caster is passed at +221 ms, the opponent at +225 ms, and the
spell resolves at +238 ms with `Stack: Empty` and the seat's own main-phase stop back.

**Decision for the manager, easy to reverse:** this is a default flip, one policy value. If the
operator wants to hold priority after a cast without full control, `passOwnSpell: false` is the
whole revert.

## Mutation counts

- `priority.jvm.test.ts` (real Forge): `passOwnSpell` branch removed, **reverted fails 1 / restored
  passes 2**.
- `auto.test.ts`: branch removed, **reverted fails 2 / restored passes 164**.
- `visibility.test.ts` + `auto.test.ts`: `stackTopActivator` always null, **reverted fails 2 /
  restored passes 188**.

## Q7 (asked by lane G): why did the operator still see "select target spell" with one spell up?

Not because `onlyAnswer` is off. A real Mana Leak against a real spell (the second test in the same
file) sends the seat:

```
getChoices  message "Select target spell"  min 0  max 1
            choices [ { key "c0", label "Memnite - Creature 1 / 1", ref { kind "stackItem", id 1 } } ]
```

**`min: 0`.** Forge lets the caster decline a target, so it is an optional question (cast, or
cancel the cast), and `onlyAnswer` is right to leave it: it answers `getChoices` only when the
floor equals the option count (`min === keys.length`) or there is one option with `min === 1`. The
same ask with `min: 1` IS answered (asserted in the test). It is a `getChoices` ask, not a selection
input, so G's `autoAnswer` in `prompts/rules.ts` is the right place to take the single option for a
`stackItem` choice: the structured fact is `choices[0].ref.kind === 'stackItem'` with `max >= 1`, no
prose. I did not widen `onlyAnswer` server-side: answering every one-option `min: 0` ask there would
also answer optional "you may sacrifice a creature" questions.
