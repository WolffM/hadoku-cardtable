# Lane B — e2e migration and the real-Forge proof (wave 51)

Done by the manager session itself. Commits `4d2804f`, `6182be4` on `w51`. The screenshots
named here are written by `e2e/w51-control-box.spec.ts` into this directory and are gitignored
(`*.png`); this file describes them.

## Migration

`e2e/play/board.ts` now exports `BUTTON_ONE`/`BUTTON_TWO` and `enabledOk`/`enabledCancel`:
Forge's button one and two wherever the page draws them — the box's `Next Phase`/`End Turn`, the
decision pop-up's `live-decision-ok`/`-cancel`, the payment window's `live-payment-ok`/`-cancel`,
a selection pop-up's `selection-done`/`-cancel`. By construction at most one of each is enabled
at a time. Every site in the blast radius moved onto those helpers, or onto the exact new testid
where the spec means one thing:

- `play/board.ts`, `play/scenario.ts` (re-exports `enabledCancel`), `play/hands.ts` (the bot's
  in-page look and its `press`, which built `live-button-${which}` and was not found by a literal
  grep), `play/confirm.ts` (comment).
- `play.spec.ts`, `prompts-offboard.spec.ts`, `w31.spec.ts` (comments), `w32.spec.ts` (End Turn is
  `live-button-end-turn`; the ordinary pass is `live-button-next-phase`), `w34.spec.ts`
  (comments), `w35.spec.ts`, `w36.spec.ts`.
- `table-fit.spec.ts`: the per-frame check now breaches unless the box is exactly
  `Next Phase`, `End Turn`, `Full control`, `Concede`, by testid and text.
- Not in the wave file's blast radius, found red by the full gate: `w46-stack.spec.ts` (the caster
  holding priority over the stack now has a decision pop-up, so the big view correctly never pins;
  the spec now measures while the OPPONENT holds priority, both on full control) and
  `w49-counterspell.spec.ts` (a product bug, fixed in lane A, `704c8db`; the spec is unchanged).

## `e2e/w51-control-box.spec.ts`

Test 1 (`bolt-player.state`):
- Main 1, empty stack: `Next Phase` and `End Turn` enabled, no pop-up; bob's box: both greyed, four
  buttons.
- A click-cast Lightning Bolt (full control: Forge first asks `getAbilityToPlay`): "Select any
  target" is the decision pop-up with Forge's `Cancel` only; `Next Phase` and `End Turn` greyed and
  present. `target-cancel.png`: the pop-up at mid-right with Forge's line and `Cancel`, the Bolt
  parked where it was released, the box reading `Next Phase` / `End Turn` greyed, `Full control`
  pressed, `Concede`. Cancel → the Bolt is back in hand, the stack is empty, `Next Phase` is back.
- The Bolt on the stack: the pop-up shows Forge's priority line ("Stack: 1 to Resolve.") and `OK`,
  no second button; `Next Phase` greyed, `End Turn` enabled; the box never contains `OK`.
- §A.6, at 1280×800 and 1366×768: the stack thumbnail row's bottom edge to the pop-up's top edge
  is **6px at both** (3 consecutive runs). `stack-over-decision-1280x800.png` and
  `stack-over-decision-1366x768.png`: the Bolt's thumbnail sits directly on top of the pop-up, its
  arc running to bob's face, rather than at the top of the column.
- The pop-up's `OK` → the Bolt resolves, bob is at 17, the pop-up is gone, both boxes are four.

Test 2 (`attackers-declared.state`): `Next Phase` at Main 1 moves into Forge's live declare-attackers
window; there the pop-up has `OK` and no second button (Alpha Strike stays refused), and the box
is greyed. Memnite clicked → `data-attacking="true"`; `attackers-declared.png`: Forge's "Select
creatures to attack…" line and `OK` in the pop-up, the box greyed. The pop-up's `OK` leaves
`COMBAT_DECLARE_ATTACKERS`, and bob goes to 19.

## Runs

- `w51-control-box.spec.ts`, CI's env (jar, res, work dir `~/.cache/cardtable-play-work/w51-B`):
  **3 of 3 green, 2 passed each, 0 skipped**.
- Full forge-gated e2e, CI's spec derivation and `jq` judge (split into four batches of five, each
  under its own `heavy.lock`, per the tracker's rule from `a467829`):
  - HEAD `bad497e`: 75 expected, **3 unexpected, 1 skipped**: `w46-stack` ×1 (+1 serial skip) and
    `w49-counterspell` ×2, both caused by this wave (above).
  - HEAD `6182be4`: 78 expected, **1 unexpected**: `played-card` "a creature nobody responds to…
    (Fast Mode off)", the landing ghost flew 190px wide. This wave's: the band-moved wake ran inside
    React's commit (fixed in lane A, `e16657b` → rebased `8d6cfde`).
  - HEAD `8d6cfde` (rebased onto main with w52, against w52's installed jar): 82 expected,
    **1 unexpected**: `table-fit` "a live match fits…", a hand card "not visible" at the cleanup
    discard. It reproduced 1 of 3. Main's next commit `989d197` names that test as its fix ("a
    played card Forge never took comes back even when another question has opened"), so w51 was
    rebased onto it.
  - On top of `989d197`: `table-fit` failed 1 of 4 at a different step, "the drag never armed".
    A hit-test log showed the card's centre on `live-decision`: alice at Main 1 with an empty stack
    after a mana tap, i.e. Forge's `OK + Undo (N)`, which this wave makes a pop-up, floating over a
    tapped card at the battlefield's right end. The spec now drags the rightmost card a pointer
    can reach: **4 of 4 green**.
  - Same HEAD: `played-card` ×3 (**15 passed**), `played-card` + `w51-control-box` (**7 passed**),
    `w52-mana` green in the `8d6cfde` gate.
- A run made with a pre-rebase build against w52's newly installed jar failed 19 of 19 with "offered
  nothing to play". That was an old server against a new jar, not evidence about this wave.
- While gating, another manager (`w52`) ran e2e outside `heavy.lock` on the same ports; one of
  this lane's runs died on `19108 … is already used`. The runner used afterwards takes the lock AND
  waits for the four ports to be free.
