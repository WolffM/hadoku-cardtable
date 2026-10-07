# §X — counters in exile (AB10)

Operator (Playtest 12, AB10): *"ancestral visions is a card placed into exile
with suspend counters. we need a way to visualize cards in exile with
counters on them."*

## What changed

- `Board.tsx`'s `Counters` draws for a card in the exile pile too, not only
  on the battlefield (`CardOnBoard`'s new `inExile` prop, passed from `Zone`
  as `inExile={zone === 'exile'}`). Marks (summoning sick, attacking, a
  token) stay battlefield-only — only counters read off the battlefield.
- `Counters` takes a `timeFirst` flag (on for `inExile` only): a `Time`
  counter sorts first, ahead of whatever else is on the card, with a stable
  sort so every other pair keeps Forge's own order. Battlefield counters are
  never reordered.
- `card.css`: a doc-only note on the existing `.board-card__counters` rule —
  no new selector. The badge is already positioned against its OWN card box
  (`bottom-left`), and `board.css`'s pile stacking (newest card on top, in
  normal document paint order) already keeps that box real in a
  graveyard/exile pile the same way it does on the battlefield, which is why
  the top (newest) exiled card shows its counters and a buried one's are
  covered by the next card, same as the rest of the state layer already was.
- New scenario `apps/server/src/play/scenarios/w56-x-suspend.state`:
  Ancestral Vision in seat 0's exile with three `Counters:TIME=3`, landing
  DIRECTLY at seat 0's own Upkeep via `activephase` (a JUMP — no
  phase-begin/end effects run), so the count reads 3 the instant any client
  ever sees the match.

## Why the scenario lands on a JUMP, not the Cleanup-step shape `two-triggers.state` uses

First attempt landed at the OPPONENT's Cleanup Step (`two-triggers.state`'s
own shape) and let the ordinary game loop walk forward into seat 0's first
Upkeep. Measured against the real jar: by the time ANY client-visible state
was read (after `finishMulligan` alone), the Time counter had ALREADY
dropped from 3 to 2 — neither seat has a legal play (both decks are nothing
but Mountains), so the server auto-passes every empty priority window with
no client round trip at all, and that auto-pass outran the test every time
it was tried (3/3 local jar runs, `[w56-x-tmp]` log lines below).

```
[w56-x-tmp] exile card 89 (Ancestral Vision) counters=[["Time",3]]
[w56-x-tmp] before upkeep: 3
[w56-x-tmp] exile card 89 (Ancestral Vision) counters=[["Time",2]]
[w56-x-tmp] after upkeep: 2
```

That run never actually caught "3" from a cold client read — the "before"
value above was read moments after the match started, before the drive loop
began, and it still raced past 2 inside the SAME tick a few lines later.

Fix: `activephase=UPKEEP` (a dev-mode JUMP — `scenarios/README.md` — "no
phase-begin/end effects run... nothing already in play reacts to landing
here") lands directly in seat 0's own Upkeep with Suspend's trigger NOT yet
fired, so 3 is the only value a client can ever observe at landing. The
ordinary game loop then has to walk a full lap — Draw, Main 1, combat,
Main 2, End, Cleanup, bob's whole empty turn, Untap — into a SECOND, real
Upkeep (this time entered by `PhaseHandler`'s own walk, not a jump) before
Suspend's trigger ever fires. Re-measured the same way, 3/3:

```
[w56-x-tmp2] right after mulligan, phase=Upkeep step, turn={"n":1,"owner":"A"}
[w56-x-tmp2] exile card 89 (Ancestral Vision) counters=[["Time",3]]
[w56-x-tmp2] before: 3
[w56-x-tmp2] exile card 89 (Ancestral Vision) counters=[["Time",2]]
[w56-x-tmp2] after: 2, phase=Upkeep step
```

Both verification scripts were throwaway (`scenario-w56-x-tmp.jvm.test.ts`,
deleted before this lane handed off) — not part of the diff; this is the
record of what they showed.

## Proof

**Unit — `pnpm exec vitest run apps/ui/src/play/Board.test.ts
apps/ui/src/play/live/parity.test.ts`**: 218 passed (216 + 2), restored.
Reverted (my hunks only, lane N's concurrent `installNumbers` mount left
untouched): 2 failed / 216 passed — the two new/edited `Board.test.ts`
assertions on exile counters, by name:

- `§A.15 — a card’s state is drawn > the state layer is drawn on the
  battlefield, and ONLY its counters also in an exile pile`
- `§A.15 — a card’s state is drawn > a suspended card’s Time counter leads
  in an exile pile — Forge’s own order everywhere else (AB10)`

`parity.test.ts` needed NO re-record: the committed fixture's own exile zone
is empty (`fixtures.ts`'s own header — "nothing exiled"), so the new
`inExile` branch never fires against it and the byte-for-byte pin
(`BASELINE_LENGTH`/`BASELINE_SHA256`) is unchanged, reverted or restored.
Checked directly (both states pass identically) rather than assumed.

**Local e2e probe** (`pnpm --filter @hadoku/ui --filter @hadoku/server
build`, then `pnpm --filter @hadoku/e2e exec playwright test -c
playwright.config.ts w56-exile.spec.ts`), local jar, ports 49009/49029/
49109/49129: 3/3 passed, ~9-14s each, 0 skipped.

**Claws** (`verify/w56-X`, `forge.yml` dispatched with `only=e2e
specs='w56-exile.spec.ts'`): see the manager's own record of the run URLs —
printed to stdout per the lane's own instructions (claws upload no evidence
on green).

## Made dead / deleted

Nothing. No code this lane replaced — `Counters`, `CardOnBoard` and `Zone`
are extended, not rewritten; the two throwaway JVM scripts used to pick the
scenario's shape were deleted before handoff and never entered the diff.

## Not verified

- Hovering a BURIED (non-topmost) exiled card to see ITS OWN counters through
  the inspector: `inspect/index.ts` clones only the `CardTile` (`.card`)
  element, which does not include the sibling counters layer, for ANY zone —
  battlefield included. That is a pre-existing limit of the inspector, not
  something this lane's change narrows or widens, and `inspect/index.ts` is
  not in this lane's file list. The brief's own phrasing ("the inspector or
  the pile's own fan, whichever the pile already has") is read as "use
  whichever mechanism already exists" rather than "build one" — and the
  pile's own fan (every exiled card IS its own `<li>`, stacked by
  `board.css`'s pile CSS, newest fully on top) is what actually carries this:
  the top card's own counters are real, visible DOM, not a clone.
- Multiple DIFFERENT counter types stacking in a real exile pile against
  Forge (the e2e scenario gives Ancestral Vision only `Time`, by design — see
  the operator's own case). The `timeFirst` reordering is pinned at the unit
  level with a synthetic mixed-counter card (`Board.test.ts`'s own new test)
  instead.
