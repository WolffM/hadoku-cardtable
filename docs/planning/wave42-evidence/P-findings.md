# P-findings — wave 42, lane P ("the pop-ups")

Real-Forge scripts, one per operator quote, each pass/fail state measured, not assumed.
Scenarios: `apps/server/src/play/scenarios/w42-relentless-dead.state`, `w42-worldbreaker.state`,
`w42-sanctum-worldbreaker.state`.

**Revised after a manager send-back** (two items corrected from the first pass — both read from
`~/.pm2/logs/cardtable-out.log` for match `m-09487f336215`): see §2 and §1's own "declined"
correction below.

## Item 1 — W18, the soft-lock (Relentless Dead)

> *"you may pay {X}. If you do, return another target Zombie creature card … from your
> graveyard"* — no board element could pick it or decline it.

`apps/ui/src/play/prompts/offboard.jvm.test.ts`, 3/3 passing.

- **A single legal graveyard target produces NO wire frame at all** (Forge's own
  `TargetSelection` auto-picks it) — a one-target graveyard proves nothing, which is why the
  scenario carries two Zombies (Diregraf Ghoul, Dread Wanderer).
- **With two, the real jar sends** `notify setSelectables { cards: [two graveyard ids], min: 1,
  max: 1 }` — the soft-lock's exact shape, neither id on a battlefield.
- **Answered:** picking either id (`selectCard`) returns exactly that card to the battlefield;
  the other stays untouched.
- **Declined — CORRECTED.** `relentless_dead.txt`'s second trigger carries
  `OptionalDecider$ You`: the "you may" decision is made BEFORE targeting, as the existing
  `getAbilityToPlay` ask (one ability, the trigger itself) — the SAME shape as every other
  trigger here, already rendered by the existing `GetAbilityToPlayPrompt`
  (`ChoicePrompts.tsx`) with its own "None" button. **The first pass tried to prove "declined"
  by sending a raw cancel act straight at the open target SELECTION** (which the wire does
  accept — Forge's `InputSelectTargets` honours it — but which Forge's own bar never offers:
  `bar.enable2` is measured `false` for this mandatory, min-1 target). That was answering the
  wrong question. Declining is now proven by answering `null` to the `getAbilityToPlay` ask:
  both graveyard cards stay untouched, no selection ever opens, and the game continues normally
  (`buttons(0).label1 === 'OK'`, no lock). Nothing in this lane's NEW files was needed for this
  half — `GetAbilityToPlayPrompt` already existed and already has a None button.
- **The mandatory-target finding stays true and is still asserted**: once the ability IS played,
  the resulting target selection has no Cancel (`bar.enable2 === false`), so `SelectionPrompt`
  correctly draws none there either — declining happens a step earlier, not here.

**Fix:** `SelectionPrompt`/`classifySelection` (`apps/ui/src/play/prompts/SelectionPrompt.tsx`) for
the off-board picker; the decline path needed no new code (existing `GetAbilityToPlayPrompt`).
Mounted by lane L in `LiveBoard.tsx` for `classifySelection(...) === 'off-board'`.

## Item 2 — W18 (Sanctum of Ugin) and W16 (World Breaker) are ONE event — CORRECTED

> *"sanctum of ugin triggered and it should ask me for a yes/no if i want to sacrifice it but
> it's just asking for an arrow which doesn't make any sense??"* (W18)
>
> *"i played worldbreaker and it went on the stack. but the effect that i'm choosing was never
> explained to me. the decision box should pop up for things like this."* (W16)

**The manager's own read of the production log is correct, and the first pass's isolated Sanctum
jar test (Bane of Bala Ged — since deleted, see below) never reproduced the real report.** World Breaker has `K:Devoid`
(colorless despite `{6}{G}`) and mana value 7, so casting it with Sanctum of Ugin in play fires
BOTH triggers from the SAME cast — the production log's `ask-auto-answered … method:"order"` at
01:00:10.795, 14ms after the `{6}{G}` auto-pay, is exactly that. Bane of Bala Ged has no cast
trigger of its own, so the first pass's isolated Sanctum test could never produce this.

New scenario `w42-sanctum-worldbreaker.state`; new suite
`apps/ui/src/play/prompts/sanctum-worldbreaker.jvm.test.ts`, 4/4 passing. **Measured sequence**
(the `order` ask is auto-answered by the SERVER — never reaches the browser):

```
ask getAbilityToPlay   "World Breaker - Creature 5/7"                    (cast it)
notify updateButtons   Auto/Cancel → Auto enabled                         (pay {6}{G})
ask getAbilityToPlay   "When you cast this spell, exile target…"         (World Breaker's own trigger — one option)
ask openZones          Battlefield (no-op notice)
notify setSelectables  { 7 land ids (Sanctum included — it IS a land), min:1, max:1 }
notify showPromptMessage "World Breaker (81) - When you cast this spell, exile target
  artifact, enchantment, or land. […]\n\nSelect target artifact, enchantment or land"
  ← WORLD BREAKER'S OWN TEXT, never Sanctum's
(player picks a target — not logged as an ask; THIS is the production log's 40-SECOND GAP
 between s0-27 (openZones, 01:00:10.865) and s0-28 (01:00:50.963) — no ask to wait on, just
 an unexplained on-board selection, exactly W16's own diagnosis)
ask getAbilityToPlay   "Whenever you cast a colorless spell…"            (Sanctum's own trigger, queued AFTER World Breaker's own trigger resolves — one option)
notify updateButtons   Yes/No
notify showPromptMessage "Sacrifice Sanctum of Ugin?"                     ← SANCTUM'S OWN TEXT, never conflated
```

**Conclusion: the two questions are sequential, not overlapping, and each already carries its
own correct text once each half is fixed.** World Breaker's own target pop-up
(`SelectionPrompt`, item 3's fix) shows World Breaker's own words; Sanctum's own Yes/No pop-up
(the existing `isConfirmPrompt`/`ConfirmPrompt`, wave 36's T4) shows Sanctum's. **No additional
code was needed beyond items 1 and 3's own fixes** — proven end to end, both in the jar suite and
in the browser (`e2e/prompts-offboard.spec.ts`'s three W18+W16 tests). The 40-second gap in
production is the smoking gun: the operator was stuck on exactly the unexplained on-board
selection W16 diagnoses, and in their report blended it with Sanctum's own (correctly-worded, but
chronologically separate) question that followed once they finally clicked a target.

**`sanctum.jvm.test.ts` (Bane of Bala Ged, Sanctum alone) and its scenario `w42-sanctum.state` are
now DELETED** (a further manager follow-up): `sanctum-worldbreaker.jvm.test.ts` already proves
both of Sanctum's own answers (Yes sacrifices and searches; No keeps it in play) on the
operator's real board — the isolated-Sanctum-alone case was a duplicate jar suite CI pays for on
every server push, testing a strictly narrower situation than the combined suite already covers.

**`classifySelection`'s `'confirm'` kind and its `promptCardId` parameter are now REMOVED** (a
further manager follow-up): it existed only for the original, superseded hypothesis that
Sanctum's cost might reach the wire as a selection, no real card was ever found to send that
shape, and the repo rule is no dead code. `SelectionKind` is now `'none' | 'off-board' |
'on-board'`; `selection.test.ts`'s three `'confirm'`-specific cases were deleted (14 → 12 unit
tests; counts corrected below); lane L removed the matching `selectionConfirm` mount and
`live-selection-confirm-host` branch in `LiveBoard.tsx` at the same time.

## Item 3 — W16, World Breaker ("Worldbreaker")

`apps/ui/src/play/prompts/worldbreaker.jvm.test.ts`, 2/2 passing (isolated, no Sanctum) plus the
combined suite above. Every named id in the `setSelectables` is already a battlefield permanent —
`classifySelection` reads `'on-board'`, not `'off-board'`: the board's own highlight already
offers a click on each land. **What was missing was never the click — it was that Forge's own
prompt text, already on the wire, was never shown anywhere except the collapsed log.**
`SelectionPrompt`, mounted for `'on-board'` too, is the fix: the text draws as the pop-up's
title via the existing `PromptTitle` line-break rule. Clicking a target exiles exactly that
permanent — proven against the real jar, in isolation and combined with Sanctum.

## Browser-level proof

`e2e/prompts-offboard.spec.ts`, 7/7 passing (built UI + lane L's `LiveBoard.tsx` wiring, real
Forge jar, real browser, Playwright, 3 consecutive green runs):

1. Relentless Dead: the off-board picker shows 2 tiles; clicking one puts it on the battlefield.
2. Relentless Dead: no Cancel/Done button renders for the mandatory target selection.
3. Relentless Dead: the REAL decline — `GetAbilityToPlayPrompt`'s own "None" button — leaves both
   graveyard cards untouched and the bar's OK stays pressable (no lock).
4. World Breaker alone: the pop-up shows 8 tiles and Forge's own trigger text, in a
   `role="dialog"` element named by it.
5. World Breaker + Sanctum: the target pop-up names World Breaker's own text, not Sanctum's.
6. World Breaker + Sanctum: after picking a target, Sanctum's own Yes/No pop-up appears next
   (`live-confirm`), named by Sanctum's own text, and No keeps it in play.
7. World Breaker + Sanctum: Yes sacrifices Sanctum and resolves the library search.

## Mutation test

`apps/ui/src/play/prompts/evidence/mutations.txt`, "wave 42 §P item 1" entry, re-run after the
`'confirm'` removal dropped `selection.test.ts` from 15 to 12 tests (its three `'confirm'`-only
cases deleted): `classifySelection`'s off-board branch deleted (`return 'on-board'`
unconditionally) — 2 of 12 tests fail; restored, 12/12. The mutation and the two tests it kills
are unchanged; only the total count moved.

## Made dead / deleted

`−205 lines`: `apps/ui/src/play/prompts/sanctum.jvm.test.ts` (181 lines) and
`apps/server/src/play/scenarios/w42-sanctum.state` (24 lines), both deleted as a duplicate of
`sanctum-worldbreaker.jvm.test.ts` / `w42-sanctum-worldbreaker.state`, which already prove both
of Sanctum's own answers on the operator's real board. The rest of this wave's own surface area
is new (a selection previously had no decision-area treatment at all); nothing else existing was
superseded.

## Done-when, checked

- `pnpm run check`: exit 0 (re-run after the send-back's corrections).
- All real-Forge scripts pass: `offboard.jvm.test.ts` 3/3, `worldbreaker.jvm.test.ts` 2/2,
  `sanctum-worldbreaker.jvm.test.ts` 4/4 — 9/9 total (the isolated `sanctum.jvm.test.ts`, 3/3, is
  deleted as a duplicate — see "Made dead / deleted" above).
- All seven browser specs pass, 3 consecutive green runs (per the send-back's own rule).
