# AB11 — Bitterblossom, by name, against a real Forge jar

`scenarios/bitterblossom.state`: seat 0's own uncontested Main Phase 1,
Bitterblossom in hand, two Swamps up. `auto.jvm.test.ts`'s own
`'Bitterblossom: the payment and the priority that follows it never reach
the seat'` casts it for real and passes (6.6s, real jar).

## Server log (real run)

```
auto-paid     {"seat":0,"cost":"{1}{B}"}
auto-passed   {"seat":0,"phase":"Main phase, precombat"}
prompt-withheld  {"seat":0,"kind":"payment","why":"auto-pay"}
prompt-withheld  {"seat":0,"kind":"priority","why":"auto-pass"}
```

Both windows — the `{1}{B}` payment (one unambiguous answer under
`DEFAULT_STOP_POLICY`'s `forgeAuto`) and the caster's own next priority (the
spell resolving on the stack, `passOwnSpell`) — were decided and withheld in
order, exactly as the ledger's own production timeline describes (auto-paid,
then auto-passed, milliseconds apart).

## The seat's own frames, from the moment of the cast to the spell resolving

```
updateButtons, getAbilityToPlay, clearWeaklySelectable, applyDelta,
setWeaklySelectable, applyDelta, setWeaklySelectable, applyDelta,
clearWeaklySelectable, applyDelta, setWeaklySelectable, message,
clearWeaklySelectable, applyDelta, applyDelta, setWeaklySelectable,
showPromptMessage, updateButtons
```

No `showPromptMessage` carrying `Pay Mana Cost` anywhere in that list — the
payment window never reached the seat. The `showPromptMessage`/`updateButtons`
pair near the end is a SEPARATE, later, genuine priority window (the normal
game resuming after Bitterblossom resolves) — not the withheld one; the two
`prompt-withheld` log lines above are what prove the payment and its own
immediate next-priority window specifically.

## Mutation (match.test.ts)

- Reverted to the pre-wave `match.ts` (forward-then-decide): 6 of 81 tests
  failed (every "nothing sent"/"both frames sent in order" pin).
- Restored: 86/86 pass (81 original + 5 added for the design check and the
  real payment-interleaving shape this evidence run itself exposed).

## A real bug this proof itself found and fixed

The FIRST version of this fix flushed a parked half on ANY frame that was not
itself a `showPromptMessage`/`updateButtons` — including `setWeaklySelectable`
and state frames. `InputPayMana.updateMessage`'s own order (buttons, THEN the
actionable set, THEN the message) means EVERY payment interleaves a
`setWeaklySelectable` between its two prompt halves, so that version threw the
buttons half away unpaired, live, on every single payment — worse than the bug
this file fixes. Caught by this exact Bitterblossom run hanging (the seat's
own crude driver had no reason to click a never-withheld, never-forwarded live
Auto button). Fixed in two parts: the flush trigger now fires only on an ASK
frame (a genuinely different window shape), never on a state or
actionable-set frame; and the safety-flush window itself moved from 250ms to
2000ms, because the measured real gap between the two halves of a payment
input reached 251ms under load — tighter than the production-measured 16ms
this file's own header cites, and only 1ms past the original window.
