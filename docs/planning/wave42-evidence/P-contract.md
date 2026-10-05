# P-contract — what L mounts

Wave 42 §P's components, for lane L (`apps/ui/src/play/live/LiveBoard.tsx`) to mount. Everything
below is exported from `apps/ui/src/play/prompts/index.ts`. **If this file changes, it is
re-exported there too — re-read both if either one looks stale.**

## The problem this answers

A Forge **selection** (`setSelectables(cards, min, max)`, `match.selectables` in
`../live/match.ts`) is not one of the fourteen `ask` methods `PROMPT_COMPONENTS`/`PromptFor`
already dispatch. It has no `callId` and nothing to `onAnswer` — answering it is a **click**
(`selectCard`), the same sender a board click already uses. So `SelectionPrompt` is NOT a
`PromptProps<M>` component and is not in `PROMPT_COMPONENTS`. You mount it yourself, next to
(not instead of) however `LiveBoard.tsx` already renders `ask`/`paying`/`playOrDraw`/`confirmPrompt`.

## 1. `classifySelection`

```ts
import { classifySelection, type SelectionLike, type SelectionKind } from '../prompts/index.ts';

function classifySelection(
  selection: SelectionLike | null,  // shape-compatible with `LiveSelectables`: { cards, min, max }
  boardCardIds: ReadonlySet<number>,  // every id the board can draw a clickable tile for (match.view's battlefield permanents)
): SelectionKind;  // 'none' | 'off-board' | 'on-board'
```

Call it every render `match.selectables !== null` (or is). Drive what you mount off the result:

| kind | meaning | what to mount |
| --- | --- | --- |
| `'none'` | nothing open, or the selection named no cards (a player-only selection) | nothing from this file |
| `'off-board'` | at least one named card is not in `boardCardIds` — the soft-lock shape (W18, Relentless Dead's graveyard target) | `SelectionPrompt`, every named card (board ones included — one picker, not a mix) |
| `'on-board'` | every named card is already in `boardCardIds` — measured true for W16 (World Breaker's cast trigger: `setSelectables` naming every land on the table) | `SelectionPrompt` too (W16 — see §2): the board's own highlight stays live underneath, but the decision area should also show Forge's own prompt line as a titled sheet, the same as every other ask already gets |

**Removed since the previous version of this file: a `'confirm'` kind and its `promptCardId`
parameter.** It existed for the hypothesis that Sanctum of Ugin's "may sacrifice yourself" cost
reaches the wire as a min-0 selection naming only its own prompt subject. **Measured false**
(`sanctum-worldbreaker.jvm.test.ts`) — Sanctum's trigger is an ordinary bar confirm, never a selection — and no
other real card was found to send that shape either, so the manager had it deleted as dead,
speculative code (repo rule: no dead code). If `SelectionPrompt.tsx`'s own call site in
`LiveBoard.tsx` still passes a third argument or still has a `selectionConfirm`/`live-selection-
confirm-host` branch, that is now stale and should come out too (lane L is removing it at the
same time this lane removed the kind).

**W18's Sanctum of Ugin complaint is ALREADY FIXED, by wave 36's T4 — not by anything in this
file.** Measured against the real jar (`sanctum-worldbreaker.jvm.test.ts`): casting a colorless MV7+ spell
while controlling Sanctum of Ugin produces an ORDINARY bar confirm — `updateButtons {label1:"Yes",
label2:"No", enable1:true, enable2:true}` plus `showPromptMessage "Sacrifice Sanctum of Ugin?"` —
never a `setSelectables` at all. `isConfirmPrompt(bar)` is already `true` for this exact shape, and
`LiveBoard.tsx`'s existing `confirmPrompt && bar !== null` branch (T4, already landed, not this
lane's to touch) already mounts `ConfirmPrompt` for it. **Nothing for you to wire for Sanctum
specifically.**

`boardCardIds` is yours to build from `match.view` (every permanent id currently drawn on a
battlefield, either seat's). This file does not read `match` at all, so it cannot drift from
whatever `Board.tsx`/`adapter.ts` consider "on the board" — you own that definition; just pass it
in consistently with whatever the board itself offers a click for.

## 2. `'off-board'` and `'on-board'` — `SelectionPrompt`

```tsx
import { SelectionPrompt } from '../prompts/index.ts';

<SelectionPrompt
  message={match.prompt ?? ''}              // Forge's own prompt line, verbatim
  cards={[...match.selectables!.cards]}     // Forge's own order
  lookup={lookup}                           // the same `PromptLookup` every other prompt here gets
  picked={match.highlighted ?? new Set()}   // Forge's own marks — see `../live/match.ts`'s header on `setHighlighted`
  onPick={(id) => selectCard(match, id)}    // exactly the sender a board click already uses
  done={
    match.selectables!.min === 0 && match.buttons?.enable1
      ? { label: match.buttons.label1, enabled: true, onClick: () => pressButton(match, 'ok') }
      : undefined
  }
  cancel={
    match.buttons?.enable2
      ? { label: match.buttons.label2, enabled: true, onClick: () => pressButton(match, 'cancel') }
      : undefined
  }
/>
```

- `done`/`cancel` are both **optional** — omit the one Forge has not enabled on the bar right now;
  `SelectionPrompt` draws neither button when both are omitted.
- Every click on a tile calls `onPick(id)` **immediately** — a selection answers Forge one click at
  a time, it is not "check several boxes then submit" the way `chooseEntitiesForEffect` is. Do not
  wrap this in a staged/local-state submit.
- Mount this for `'on-board'` too (W16, measured against the real jar in `worldbreaker.jvm.test.ts`:
  casting World Breaker sends `setSelectables` naming all 8 lands on the table, every one already
  a battlefield permanent — `'on-board'`, not `'off-board'`). The board's own highlight stays
  exactly as it is underneath — this only adds the titled pop-up `showPromptMessage`'s text never
  got before (Forge's own words: `"World Breaker (81) - When you cast this spell, exile target
  artifact, enchantment, or land. […]\n\nSelect target artifact, enchantment or land"`).

## 3. What this lane did NOT touch

- `LiveBoard.tsx`, `live.css`, `match.ts`, `match.test.ts`, `LiveBoard.test.ts` — all lane L's.
  This lane's own `*.jvm.test.ts` proves the wire shapes by driving `apps/server/src/play/scenario.ts`
  directly (`s.select`/`s.cancel`), never through `LiveBoard`.
- `e2e/waiting.spec.ts` — lane L's.

## 4. Real-Forge proof this lane already has (so you do not need to re-derive the shapes)

- `apps/ui/src/play/prompts/offboard.jvm.test.ts` — Relentless Dead, item 1: reproduces the
  soft-lock's exact `setSelectables` shape (two graveyard ids, min 1 max 1, neither on a
  battlefield), proves picking one enters it on the battlefield, and proves Forge's own bar has
  `enable2: false` for this exact mandatory (min 1) selection, so `SelectionPrompt` correctly
  draws no Cancel button for it. **The REAL "you may pay {X}" decline is a step EARLIER and
  needs nothing from this file**: `relentless_dead.txt`'s second trigger carries
  `OptionalDecider$ You`, so declining is answering `null` to the existing `getAbilityToPlay`
  ask (`GetAbilityToPlayPrompt`'s own "None" button, `ChoicePrompts.tsx`) — already built,
  already mounted, nothing for you to add for it either.
- `apps/ui/src/play/prompts/worldbreaker.jvm.test.ts` — World Breaker, item 3: proves the
  `'on-board'` shape and that Forge's own prompt text naming the trigger is on the wire.
- `apps/ui/src/play/prompts/sanctum-worldbreaker.jvm.test.ts` — **W18 and W16 are ONE event**
  (manager send-back, confirmed from the production log): World Breaker is `Devoid` (colorless)
  and mana value 7, so casting it with Sanctum in play fires BOTH triggers off the SAME cast.
  Measured: they resolve SEQUENTIALLY (World Breaker's own target selection first, Sanctum's
  Yes/No after), each with its own correct text, never conflated, Sanctum's own Yes/No proven an
  ordinary `isConfirmPrompt`-true bar confirm both ways (Yes sacrifices + searches, No keeps it).
  No code beyond items 1 and 3 needed — this suite is the proof that the combination needs
  nothing extra from you either. (An earlier, isolated `sanctum.jvm.test.ts` — Bane of Bala Ged,
  Sanctum alone — proved the same bar-confirm shape without World Breaker in the mix; deleted as
  a duplicate once this suite covered the real combined case too.)
- `apps/server/src/play/scenarios/w42-relentless-dead.state`, `w42-worldbreaker.state`,
  `w42-sanctum-worldbreaker.state` — the scenarios behind the above.
