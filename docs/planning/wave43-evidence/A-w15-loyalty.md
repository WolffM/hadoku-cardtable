# §A — W15: a planeswalker's loyalty shows as a changing value, the way P/T does

*"plainswalker loyalty counters should show as a changing value same way power/toughness are
displayed for creatures."*

## What was already there

`apps/ui/src/play/adapter.ts`'s `toBoardCard` (unowned this wave, and already correct — not
touched) already keeps `card.loyalty` CURRENT: a loyalty `Counter` when the battlefield has one,
the printed value before it ever does (`card.loyalty = loyaltyCounter !== undefined ? … :
readStr(face, 'Loyalty') ?? '0'`, gated on `core.includes('Planeswalker')`). What was missing was
purely the DRAW: `Board.tsx`'s `PowerToughness` only ever looked at `entry.card.power`/`toughness`
— both `undefined` for a planeswalker (adapter.ts never sets them for one) — so `boardPT` returned
`null` and the component drew nothing at all for a planeswalker, not even a static number.

## Fix

`Board.tsx`: `PowerToughness` now dispatches to a new `Loyalty` component first, whenever
`entry.card.loyalty !== undefined`. `Loyalty` reuses `.board-card__pt`/`.board-card__pt-n` —
the SAME classes the creature P/T badge already uses — wholesale, with one number instead of two
and no `data-pt-state` (plain): `card.css` is w44's file this wave, so a new class there would be a
stop-and-report, and it was not needed — the existing badge already does everything a single
changing number needs.

## Proof against real Forge

`w43-planeswalker.state` (this lane's own scenario): seat 0 controls Elspeth, Sun's Champion at
loyalty 2 (`|Counters:LOYALTY=2`, explicit — see the scenario file's own header for why: Forge's
engine never showed a code path that seeds a freshly-placed planeswalker's loyalty counters on its
own in `GameState.java`, so the number is pinned rather than assumed). At loyalty 2 her other two
abilities (`-3`, `-7`, from `elspeth_suns_champion.txt`) are unaffordable, so Forge's own
`getAbilityToPlay` has exactly one legal choice — which the SERVER answers on its own the instant
the card is clicked, confirmed from the server's structured log:

```
ask-answered      … callId=s0-1 method=getAbilityToPlay ms=5
ask-auto-answered … callId=s0-2 method=getAbilityToPlay why="forge re-asked its own already-answered getAbilityToPlay"
stop-decided      … stackEmpty=false …   (activated, on the stack)
auto-passed       …
stop-decided      … stackEmpty=true …    (resolved — all inside the same tick)
```

No ability picker ever reaches the browser, and activate→resolve→auto-pass happens in under 100ms
— too fast for a `stackCount` poll to reliably observe the stack non-empty (the same transient-
stack race `wave33-evidence`'s Full Control note already describes for Mana Leak; found the hard
way, in this lane's own first draft, as a spurious `castCard(...) never saw the stack change`
failure with the activation having, in fact, already happened). The fix: poll the loyalty NUMBER
itself, scoped to Elspeth's own card id specifically (not a bare `.board-card__pt` on the
battlefield — her `+1` creates three 1/1 Soldier tokens, each with its OWN P/T badge, so an
unscoped locator becomes a Playwright strict-mode violation — several elements — the moment her
ability resolves; found as a second real flake before scoping the selector).

`e2e/table-fit.spec.ts`'s new W15 test: reads the badge as `"2"` before anything is clicked, clicks
Elspeth's card once, and asserts the SAME badge reads `"3"` within 10s. The cost of a loyalty
ability (`Cost$ AddCounter<1/LOYALTY>`) is paid on ACTIVATION, not resolution, so the number is
already correct the instant the ability goes on the stack — the number on the board changes with
real play, which is the whole of W15's claim.

## Mutation check

Reverted the `PowerToughness`/`Loyalty` dispatch in `Board.tsx` (commented out the
`if (entry.card.loyalty !== undefined) return <Loyalty …>` line) — both jsdom proof tests in
`Board.test.ts` ("shows the current loyalty in the SAME badge…", "updates on the board when the
loyalty does…") failed (badge count 0 instead of 1); the third test in the same `describe`
("draws an ordinary P/T badge… for a creature whose card carries no loyalty at all") was
unaffected, 196/198 total. Restored, 198/198. (The real-Forge e2e proof exercises the identical
source line; not separately mutated.)

## Spec runs (3 consecutive, jar env, no SKIPPED)

Run alongside W6 and W19 in the same `table-fit.spec.ts` invocation — see `A-w19-ring-clip.md`'s
run table (all three tests share one `-g` filter and one run).
