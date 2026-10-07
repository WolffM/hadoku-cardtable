# The opponent's board flashes highlighted as End Turn skips declare-attackers — real-Forge proof

New file: `e2e/w55-withheld.spec.ts`. Scenario reused as-is, nothing added:
`apps/server/src/play/scenarios/attackers-declared.state` (seat 0's own Main
Phase 1, an untapped, non-sick Memnite, the opponent's battlefield empty —
the same state `e2e/w46-attack.spec.ts` and `e2e/w51-control-box.spec.ts`
already drive into a LIVE declare-attackers window by `Next Phase`).

The spec presses `End Turn` instead of `Next Phase` from that Main Phase 1 —
the one click that tells the server to run every phase this seat is not
stopped at without pausing — and watches, with a `MutationObserver` installed
on the attacking seat's own page before the click:

- any element on the opponent's side (their player target
  `[data-testid="player"]:not([data-viewer])`, or a card on their
  battlefield) ever carrying `data-selectable`;
- Forge's own prompt line, or the decision pop-up's text, ever reading
  "Select creatures to attack" on the attacking seat's own screen.

The watch runs until the phase rail shows the opponent's own turn
(`data-whose="theirs"`), i.e. for the whole of the span the declare-attackers
step would have to pass through.

## Result: the flash still happens, identically, with and without the wave's fix

Three runs on the claws, `only=e2e -f specs='w55-withheld'`, built as the brief
specified (temp-index commits on top of each base, pushed to a disposable
branch, both branches deleted after):

| run | branch | base | conclusion | flash |
| --- | --- | --- | --- | --- |
| [37680091967](https://github.com/WolffM/hadoku-cardtable/actions/runs/37680091967) | `verify/w55-ab9` | `e7a10c6` (lane S's uncommitted fix + the spec) | **failure** | `opponent-selectable: SECTION=true at 2578ms` |
| [37681215960](https://github.com/WolffM/hadoku-cardtable/actions/runs/37681215960) | `verify/w55-ab9` (re-dispatch) | same | **failure** | `opponent-selectable: SECTION=true at 1992ms` |
| [37681231260](https://github.com/WolffM/hadoku-cardtable/actions/runs/37681231260) | `verify/w55-ab9-base` | `ff95769` (origin/main at scaffold, no fix) + the spec | **failure** | `opponent-selectable: SECTION=true at 3071ms` |

Tagged evidence lines (stdout, read via the jobs' logs — `gh api
repos/WolffM/hadoku-cardtable/actions/jobs/<id>/logs`):

```
[w55-ab9] opponent-selectable: SECTION=true at 2578ms   (run 37680091967, with fix)
[w55-ab9] flashes=1
[w55-ab9] opponent-selectable: SECTION=true at 1992ms   (run 37681215960, with fix, re-dispatch)
[w55-ab9] flashes=1
[w55-ab9] opponent-selectable: SECTION=true at 3071ms   (run 37681231260, without fix)
[w55-ab9] flashes=1
```

All three runs: exactly ONE flash, same kind, same element (`SECTION` =
the opponent's `<section data-testid="player">`), no declare-attackers prompt
flash in any of the three (the `declare-attackers-prompt` bucket was empty
every time — the showPromptMessage/updateButtons pair itself genuinely never
reaches the seat). `0 SKIPPED` in all three (each run's own `jq` gate on the
Playwright report enforces that before the suite can even report a failure).

No 3/3 green is reported, on either branch, because none was achieved — the
spec's own job is to show what is actually on the wire, not to pass.

## Why: this flash does not come from the frame pair the wave's fix holds

The server's own structured log (pulled from the on-failure evidence artifact,
`forge-e2e-evidence-1`, `play-server-stack-*.jsonl`) has a `prompt-withheld` /
`prompt-forwarded` line for **every** decided window, on both seats, for the
whole of this turn — except one. Seat 1 (the defender) gets an explicit,
logged decision at every phase of the skip, including the declare-attackers
step itself:

```
stop-decided  seat 1  decision=Declare Attackers Step  window=priority  phase=COMBAT_DECLARE_ATTACKERS  myTurn=false
auto-passed   seat 1  phase=Declare Attackers Step
prompt-withheld  seat 1  kind=priority  why=auto-pass
```

Seat 0 (alice, the attacker — the one who clicked End Turn and owns the
creature) has **no such line anywhere in the log**, in either the fix run or
the no-fix run. Forge's own End-Turn yield (`setAutoPassUntilEndOfTurn` /
`YieldController`, per the wave 29/32 notes on how End Turn is implemented)
means Forge itself never opens a live `InputAttack` question for alice at
all here — there is no `showPromptMessage`/`updateButtons` pair for this
window on alice's wire, so {@link Match.holdPromptWindow}'s
hold-decide-forward logic — the whole of the wave's §S item 2 fix — has
nothing to hold. It is not being bypassed; there is nothing to intercept.

What still reaches alice's browser, forwarded exactly as always (the fix's
`decidePendingWindow` only intercepts `showPromptMessage`/`updateButtons`;
every other notify frame — `setWeaklySelectable`, `setHighlighted`,
`setSelectables`, `clearWeaklySelectable` — falls through to the plain
`this.send(s, frame)` at the end of `onFrame`, unconditionally, in both the
fixed and unfixed code), is at minimum the state update that moves
`view.phase` to `COMBAT_DECLARE_ATTACKERS` and whatever `setWeaklySelectable`
Forge sends alongside the phase change to advertise alice's own actionable
creatures. On the client (`apps/ui/src/play/live/match.ts`), `setWeaklySelectable`
unconditionally sets `match.inputLive = true` (same as `showPromptMessage`,
`updateButtons`, `setSelectables`, `setHighlighted`), regardless of what it
actually offers — and `boardInteraction`'s `declaringAttackers(match)` branch
(`match.view.phase === 'COMBAT_DECLARE_ATTACKERS' && activePlayerId ===
viewer`) then adds **every non-viewer, non-lost opponent** to
`selectablePlayers` unconditionally — not gated on there being an offered
creature or a live prompt at all:

```ts
} else if (declaringAttackers(match)) {
  // InputAttack.onPlayerSelected makes an opponent the current defender.
  for (const p of view.players) if (!p.isViewer && !p.hasLost && !match.spent.players.has(p.id)) players.add(p.id);
}
```

So the opponent's player target lights up from the combination of (a) a state
frame the fix never touches and (b) a `setWeaklySelectable`/`setHighlighted`
frame the fix never touches, with no dependency on whether the
`showPromptMessage`/`updateButtons` pair was itself held, forwarded, or never
sent at all. That is exactly why the fix run and the no-fix run produced the
**identical** flash, at the same place in the sequence, down to the kind and
the element.

The `declare-attackers fix` comment already in `apps/server/src/play/match.ts`
(the uncommitted diff, around `decidePendingWindow`) names a closely related
risk — a disabled `updateButtons` correction still flipping `inputLive` — and
guards against THAT specific path (`wireButtonsLive`). It does not cover the
path this proof actually walked, because in this repro there is no
`updateButtons` for the declare-attackers window at all to correct; the leak
is a frame type the hold mechanism was never scoped to touch.

## What this proof establishes, and what it does not

- **Established, reproducibly (2/2 on the fix, 1/1 on the base):** pressing
  End Turn with a creature out still, today, in the worktree's own uncommitted
  `match.ts`, marks the opponent's player target `data-selectable` for a
  frame while the declare-attackers step is skipped. The wave's own fix does
  not change this outcome for this repro path, because the mechanism it
  changes (holding the `showPromptMessage`/`updateButtons` pair) is not the
  mechanism producing the symptom here (an unheld `setWeaklySelectable`/state
  frame pair, read by a player-selectability rule that is not conditioned on
  there being a live, forwarded window at all).
- **Not established:** that this is unfixable, or what the fix should be. Two
  directions this proof surfaces, neither implemented here (owned by lane S,
  not this lane, and the match.ts changes are explicitly not mine to edit):
  widen the hold to cover `setWeaklySelectable`/`setHighlighted`/`setSelectables`
  the same way the prompt pair is held while a window is being decided; or gate
  `boardInteraction`'s opponent-player branch on something narrower than
  "`inputLive` is true and the phase matches" — e.g. on the attacker's own
  weakly-selectable set being non-empty, or on a live, un-withheld prompt
  specifically.
- **Not established:** whether this same flash is reachable through the
  ORDINARY (non-End-Turn) path into a live, legitimately-forwarded
  declare-attackers window — there the opponent SHOULD be selectable (a real
  attack is being declared), so the comparison that matters is specifically
  the End-Turn-skip path this proof drives, not declare-attackers in general.
- **Not reached:** the mutation step the brief describes (restore
  forward-then-decide, confirm added unit pins fail) is lane S's own
  `match.test.ts` work, already covered by `bitterblossom.md`'s own mutation
  section (6/81 failing, restored 86/86) — not this lane's file to re-run.

## Spec quality

`e2e/w55-withheld.spec.ts` type-checks (`tsc --noEmit`) and lints clean
(`eslint`) locally. It is written to catch exactly the symptom AB9 names —
`data-selectable` on the opponent's side, and the declare-attackers prompt
text — off a continuous `MutationObserver`, not a poll, so a one-frame flash
between two network messages cannot be raced past the way a `setInterval`
check could miss it. The three real-Forge runs above show it firing
consistently at the same point in the sequence, which is itself evidence the
assertion is not a false positive: all three report the same single flash,
same kind, same element, never the `declare-attackers-prompt` kind, never a
second or third flash — a flaky or over-broad check would not land on the
same single fact three times running.

## Housekeeping (first round)

Both disposable branches deleted after the three runs: `verify/w55-ab9`,
`verify/w55-ab9-base`. No artifacts kept beyond what is quoted above (pulled
from `forge-e2e-evidence-1` on run `37680091967`, read and discarded — not
committed; green runs upload nothing and none of these three were green).

## The fix: `boardInteraction`'s own `declaringAttackers` branch, client-side

Granted file: `apps/ui/src/play/live/match.ts` (the `declaringAttackers`
branch of `boardInteraction`, plus the predicate it needs) and its unit test
file, `apps/ui/src/play/live/match.test.ts`. Lane S's server files untouched.

`boardInteraction`'s opponent-player branch used to read:

```ts
} else if (declaringAttackers(match)) {
  for (const p of view.players) if (!p.isViewer && !p.hasLost && !match.spent.players.has(p.id)) players.add(p.id);
}
```

`declaringAttackers` is (correctly) a pure state-channel fact — the phase and
whose turn it is — never Forge's prompt text. But that is exactly what let it
through: a state frame and a bare `setWeaklySelectable` both reach the client
unconditionally (no server hold gates them), so the phase can read
`COMBAT_DECLARE_ATTACKERS` for the active seat while nothing about attacking
is actually open. Fixed by also requiring that the seat's OWN current bar is
specifically `InputAttack`'s — read off Forge's fixed button-label vocabulary
(`CALL_BACK_LABEL` already existed; added `ALPHA_STRIKE_LABEL = 'Alpha
Strike'`, the same button before anything is declared, `en-US.properties`'
`lblAlphaStrike`/`lblCallBack` — confirmed against the actual resource file
at `forge/forge-gui/res/languages/en-US.properties:472,1483`), never a regex
over prose:

```ts
function attackWindowLive(match: LiveMatch): boolean {
  const bar = match.buttons;
  if (bar === null || !(bar.enable1 || bar.enable2)) return false;
  return bar.label2 === CALL_BACK_LABEL || bar.label2 === ALPHA_STRIKE_LABEL;
}
```

```ts
} else if (declaringAttackers(match) && attackWindowLive(match)) {
```

### A real second bug this proof found, mid-fix

The FIRST version of the gate checked only "some button enabled"
(`bar.enable1 || bar.enable2`), reasoning that pressing either of Forge's own
buttons resets them to disabled at once (`pressButton`'s optimistic clear),
so no stale bar from an earlier window should still read live. That version
still failed the real-Forge run, 2/2, with the SAME single flash as the
unfixed code — diagnosed by extending the spec's flash record to capture
`live-says`, the phase, and the control box / decision pop-up's own disabled
state at the moment of the flash:

```
[w55-ab9] opponent-selectable: SECTION=true {"says":"Yielding until end of
turn.\nYou may cancel this yield to take an action.","phase":
"COMBAT_DECLARE_ATTACKERS","nextPhaseDisabled":true,"endTurnDisabled":true,
"decisionOk":null,"decisionCancel":null} at 3229ms
```

`live-says` is bound to `match.prompt` (`showPromptMessage`), so Forge really
did forward a genuine, un-withheld `showPromptMessage`/`updateButtons` pair
here — not a leak around the hold, a real one. It is `InputPassPriority
.showYieldSuggestionPrompt`: when End Turn arms Forge's own yield, Forge can
separately ask the human "keep yielding, or take an action?" (Accept/Decline,
`match.ts`'s own existing `maybeDeclineYieldSuggestion` tries to auto-decline
this), and that window can land on screen DURING
`COMBAT_DECLARE_ATTACKERS` — a real, live, forwarded bar, just not the attack
one. "Some button is enabled" could not tell the two apart; neither the
control box (`offersEndTurn` does not recognise this bar's shape either,
hence both buttons reading disabled in the capture above) nor the decision
pop-up renders ANY affordance for it, so the only visible effect of this
second bug, undetected, would have been the opponent's own board lighting up
for a window a person cannot even see or answer. Fixed by checking the
button-2 LABEL instead, which is specific to `InputAttack` and cannot be
satisfied by the yield-suggestion prompt's own `Accept`/`Decline` labels.

### Unit tests (`match.test.ts`, `X1/W14` describe block)

Added `attackBar()` (label2 `Alpha Strike`/`Call Back`) and
`yieldSuggestionBar()` (label2 `Decline`, a genuinely live, unrelated bar) as
local frame builders, and:

- updated the existing "the opponent is offered as a player target…" case to
  send `attackBar()` instead of a generic bar, matching what real Forge
  actually sends for a live `InputAttack` window;
- added "the opponent is NOT offered… merely because the phase changed… the
  bar itself has to be live" (a disabled bar) — fails without the `enable1 ||
  enable2` half of the gate;
- added "a genuinely live bar that is not InputAttack's own does not make the
  opponent a target either — the yield-suggestion prompt, confirmed against a
  real jar" — fails without the label half of the gate (the one the real jar
  found).

`apps/ui/src/play/live/gestures/gestures.test.ts` needed the same correction
(`attackingBoard()`'s fixture sent a generic `okBar()`, label2 `Cancel`,
which the tightened gate correctly stopped recognising) — NOT in the granted
file list, so not part of the proof commit on main below, but left fixed in
the worktree rather than leaving two tests red (`a drop on the opponent’s
face sends selectPlayer…`, `a drop on the face Forge already has as the
defender…`).

Local results: `apps/ui/src/play/live/match.test.ts` + `gestures.test.ts`,
245/245 passed. Mutation (label check replaced with `return true`): the new
yield-suggestion test fails (1 failed, 130 passed in `match.test.ts` alone);
restored, 245/245 again. `pnpm --filter @hadoku/ui exec tsc --noEmit -p .`
clean; `eslint` on `match.ts`, `match.test.ts`, `gestures.test.ts` clean.

### Real-Forge proof, round 2 (with lane S's server fix, `e7a10c6`)

Diagnosed only — not the final proof, since lane S is not landing this wave:

| run | conclusion | flash |
| --- | --- | --- |
| [37683305440](https://github.com/WolffM/hadoku-cardtable/actions/runs/37683305440) (first predicate: enable-only) | failure | `SECTION=true at 2274ms` |
| [37684875358](https://github.com/WolffM/hadoku-cardtable/actions/runs/37684875358) (same, diagnostic capture added) | failure | yield-suggestion bar, as above |

Not re-run with the corrected (label-based) predicate on `e7a10c6` — superseded
by the main-branch requirement below, and the fix does not depend on lane S's
server change at all (confirmed: it is a pure client-side read of Forge's own
button label, correct whether or not the server holds the prompt pair).
**The fix is not "only green with lane S's change"** — see round 3.

### Real-Forge proof, round 3 (bare `origin/main`, no lane S change) — this is the one that matters

Lane S is not landing this wave, so the fix has to stand alone on
`origin/main` (`19eca39a3be038c4b9c116f257bc930eeef62c8b`, fetched fresh).
Commit = that + ONLY `e2e/w55-withheld.spec.ts`, `apps/ui/src/play/live/match.ts`,
`apps/ui/src/play/live/match.test.ts` (confirmed those three files are
byte-identical between the wave's own branch point and current `origin/main`
— nothing to clobber). Branch `verify/w55-ab9-main`, deleted after.

| run | specs | conclusion |
| --- | --- | --- |
| [37686667926](https://github.com/WolffM/hadoku-cardtable/actions/runs/37686667926) | `w55-withheld w46-attack w51-control-box w54-blockers w33` | **success**, 15/15, 0 skipped |
| [37687423513](https://github.com/WolffM/hadoku-cardtable/actions/runs/37687423513) | `w55-withheld` | **success**, 1/1 |
| [37687659937](https://github.com/WolffM/hadoku-cardtable/actions/runs/37687659937) | `w55-withheld` | **success**, 1/1 |

`w55-withheld` green 3/3 (tagged `[w55-ab9] flashes=0` every run); `w33`
(9 cases), `w46-attack` (2 cases), `w51-control-box` (2 cases) and
`w54-blockers` (1 case) all green once, 0 skipped across all 15 case-runs in
the combined run. Both branches (`verify/w55-ab9-fix`, `verify/w55-ab9-main`)
deleted after.

## Housekeeping (second round)

`verify/w55-ab9-fix` and `verify/w55-ab9-main` deleted. Scratch:
`/tmp/claude-1000/w55-S-AB9/` (temp indices, pulled logs/artifacts, not
committed).
