# P8 - Gitaxian Probe with no land, against real Forge

Test: `apps/server/src/play/phyrexian.jvm.test.ts`. Sixty Gitaxian Probe per side, so no
land ever exists. Seed 20260930, seat 0's first main phase.

## Reproduced (wave-8 jar)

```
[phyrexian] main phase: hand=[19,33,31,16,23,58,57,38] life=20 actionable=[]
```

Eight Probes in hand, Forge's actionable set (`setWeaklySelectable`) is empty: nothing
is clickable.

## Cause

`AvailableActions.canAfford` -> `ComputerUtilMana.canPayManaCost(sa, player, 0, false)`, the
AI payer. At `ComputerUtilMana.java:722-724` it gives up on Phyrexian life for any script
with `AIPhyrexianPayment$ Never`, and `cardsfolder/g/gitaxian_probe.txt` carries it. That
is an AI strategy hint; a human may always pay 2 life.

## Fix (fork commit 917bb193)

`canAfford` keeps the AI check, then falls back to `canAffordWithLife`: for k = number of
Phyrexian shards (`ManaCost.getPhyrexianCount()`) down to 1, if `Player.canPayLife(2k)`,
pay k shards with life (`ManaCostBeingPaid.payPhyrexian()`) and ask whether mana covers the
rest. No card names.

```
[phyrexian] main phase: hand=[19,33,31,16,23,58,57,38] life=20 actionable=[16,33,19,38,23,57,58,31]
[phyrexian] payment prompt: "Gitaxian Probe (19) - A looks at B's hand. A draws a card.\n\nPay Mana Cost: {U/P}\n(Click on your life total to pay life for phyrexian mana.)"
[phyrexian] after: life=18 graveyard=1 hand=8
```

## A second defect, NOT fixed here (server, lane S's file)

Forge wraps the life line in parentheses (`InputPayManaOfCostPayment.java:106`:
`"\n(" + sb + ")"`), so the real prompt is `...{U/P}\n(Click on your life total to pay life
for phyrexian mana.)`. `apps/server/src/play/auto.ts:676`, `LIFE_INSTEAD = /^Click on your
life total to pay life for /m`, is anchored at the line start and never matches it. With no
land, `noWayToPay` is true, `alternativePayment` false, and under the DEFAULT policy
`decideCancel` presses Cancel at the moment the prompt opens (log `auto-cancelled
{U/P}`), so the cast dies right after it is offered. `auto.test.ts:537` and `:1834` pass
because their fixtures omit the parentheses. One-line fix: `/^\(?Click on your life total
to pay life for /m`, and add the parenthesised form to those fixtures. Until then the
test pins the seat's policy to `unpayableCost: 'ask'` (commented in the test); drop the pin
once `auto.ts` is fixed.

## Mutation

Reverted (wave-8 jar): 1 failed / 1 (actionable=[], run 3 times, 3 of 3 red).
Restored (fork jar): 65 of 67 runs passed. The 2 reds were both `actionable=[]` at the
main-phase read, both in the first three runs after the jar was copied, with the fixed jar
(sha256 below); neither reproduced in 65 consecutive runs, including 12 under a full-CPU
load. Root cause not found.
