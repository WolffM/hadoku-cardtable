# Wave 35 §S follow-up, item 1 — the R15 land-exclusion regression in `decideStop`

## The finding (lane E, `docs/planning/wave35-evidence/e-runs.md`)

`play.spec.ts`'s "nobody presses a button and the spell still resolves" check
failed 5/5 against the full `forge-e2e` suite. Traced to `auto.ts`'s
`decideStop`: its last branch only auto-passes a priority window once Forge's
own actionable set (`facts.sources`) is empty. Wave 35 F's R15 land-tapping
fix makes Forge offer every UNTAPPED LAND with a mana ability through that
same actionable set at ordinary priority — so on any normal turn with a land
left untapped, that set is essentially never empty, and the "nothing to do,
pass" shortcut this check (and real games) depends on stops firing.

## The fix

`auto.ts`:
- `SeatNotes.ownBattlefieldLandIds?: ReadonlySet<number>` — the viewer's own
  battlefield land ids (from `SeatProjector.ownBattlefieldLandIds()`,
  `visibility.ts`).
- `PromptFacts.nonLandSources` — the actionable set (`sources`) with the
  seat's own battlefield lands filtered out. Payment facts are untouched
  (`sources`/`plannedSources` still carry every id Forge named — a land can be
  a legitimate payment source, just never a reason to hold priority on its
  own).
- `decideStop`'s final branch reads `facts.nonLandSources` instead of
  `facts.sources`.

`match.ts`'s `notesOf` wires `s.projector.ownBattlefieldLandIds()` into
`SeatNotes`.

## Why `auto.jvm.test.ts` (the existing suite) is not a clean proof by itself

Reverting the fix does fail all 3 of its tests, but the first failure's own
evidence (`Beginning of Combat Step`/`End of Combat Step`, `idle:false,
passed:true`) is `skipsThisTurn`'s `skipNonStopPhases: 'always'` branch
(`auto.ts:1022-1024`), which returns BEFORE the `nonLandSources` check and
never reads it — on the ACTIVE seat's own turn, every non-stop phase is
auto-skipped unconditionally regardless of lands, both before and after this
fix. That failure (and the 2 JVM-exit timeouts after it) reproduce
inconsistently run to run and are JVM thread-timing noise (`"thread timing is
not seeded"`, per that file's own comment), not a clean signal tied to this
branch. The suite's "nothing to do" population is also dominated (22/26
stops) by windows where the raw actionable set was already fully empty — not
the land-only case this fix changes behaviour for — so it does not reliably
exercise the mechanism at all.

## A targeted, isolated real-Forge proof

New: `scenarios/land-only-pass.state` + `auto-pass-land.jvm.test.ts`.

Seat 0 holds Raging Goblin (`{R}`) and two untapped Mountains (one stays
untapped after casting); seat 1 holds nothing and has two untapped Mountains
of its own. Seat 0 casts; its own post-cast window auto-passes via
`policy.passOwnSpell` unconditionally (not the branch under test). Seat 1's
window — stack non-empty, not their spell on top — falls through
`decideStop` to exactly the `nonLandSources` branch. Seat 1 is driven
**zero** times by the test (no `select`, no `ok`, nothing).

Asserted: seat 1's actionable set is non-empty and is EXACTLY their own
untapped lands; seat 1 is logged `auto-passed`; the spell resolves onto
seat 0's battlefield without any click from seat 1.

Note: the scenario harness's own very first `setWeaklySelectable` push after
a scenario applies is a known, pre-existing, timing-dependent race (see
`PlayBridge.java`'s `refreshActionable` doc comment) — confirmed separately
(a standalone repro) that it sometimes ships a stale empty set for 40+
seconds with no further push until a selection forces Forge to recompute.
This test does not depend on that first push: it drives seat 0's cast by
selecting the scripted hand card directly (a legal selection is honoured
regardless of what the stale highlight said) and reads seat 1's actionable
set only once the spell is genuinely on the stack, well past where that race
has settled.

### Counts

- **Unit** (`auto.test.ts`, `decideStop`'s land-exclusion describe block):
  reverted → 1/170 fail (exactly the land-only-passes case, `expected null to
  be 'Fourth main phase'`); restored → 170/170 pass.
- **Real Forge** (`auto-pass-land.jvm.test.ts`, isolated branch):
  - **Reverted**: 1/1 run fails, with exactly the predicted symptom —
    `timed out waiting for Raging Goblin to resolve onto the battlefield
    without any click from seat 1` (seat 1 is never auto-passed; the window
    stays open on nothing but its own lands).
  - **Restored**: 5/6 runs pass cleanly. 1 run failed at an EARLIER wait
    (seat 0's own "Pay Mana Cost" prompt, immediately after the revert→restore
    round-trip) — a different failure mode than the regression's own symptom,
    consistent with the pre-existing scenario-harness timing race described
    above (host contention right after a flock-serialized prior run), not a
    recurrence of the regression. Re-run immediately after: clean pass, and
    one further pair of runs after that: both clean. No run in the restored
    state ever reproduced the reverted run's specific failure.

## `pnpm --filter @hadoku/server typecheck`

Clean (exit 0) with the fix restored.
