# AB11 — Bitterblossom against a real Forge jar

`scenarios/bitterblossom.state`: seat 0's uncontested Main Phase 1, Bitterblossom in
hand, two Swamps up, `DEFAULT_STOP_POLICY`. `auto.jvm.test.ts`, "Bitterblossom: the
payment and the priority that follows it never reach the seat", casts it for real.
Claw run 37693274063 (forge-jvm, sha 55e3b3d), tagged stdout:

## Server log (what the server decided)

```
auto-paid        seat 0  {1}{B}
auto-passed      seat 0  Main phase, precombat
prompt-withheld  seat 0  kind payment   why auto-pay
prompt-withheld  seat 0  kind priority  why auto-pass
```

The payment (one unambiguous answer under `forgeAuto`) and the caster's own priority
with Bitterblossom on the stack (`passOwnSpell`) were both decided before either half
of either window was sent.

## The seat's wire, from the click to the spell resolving

```
updateButtons, getAbilityToPlay, clearWeaklySelectable, applyDelta,
setWeaklySelectable, applyDelta, setWeaklySelectable, applyDelta,
clearWeaklySelectable, applyDelta, setWeaklySelectable, message,
clearWeaklySelectable, applyDelta, applyDelta, setWeaklySelectable,
showPromptMessage, updateButtons
```

- The first `updateButtons` is the server disabling the seat's own bar on its click
  (`disableStaleButtons`), label `OK`.
- No `showPromptMessage` carries `Pay Mana Cost`, and since 7aa15b6 no `updateButtons`
  carries `Auto`: `InputPayMana` sends a disabled `Auto` bar, then the enabled one, then
  the prompt; the newer bar replaces the held one, and the pair is withheld whole.
  The suite asserts both.
- The closing `showPromptMessage`/`updateButtons` is the next real stop: seat 0's own
  Main Phase 1 with the stack empty again.
- `message` is the server's own `paid …` line (`trackPayment`), the one record of the
  auto-pay the seat does see.

## Before this wave

Production match `m-45b21c9f6cbd` (2026-10-07 17:27:55Z): the ask answered at .888, `auto-paid {1}{B}`
at .894, the caster's priority `auto-passed` at .904, and both windows drawn on the seat,
because `match.ts` forwarded each prompt on arrival and decided on the buttons frame.
