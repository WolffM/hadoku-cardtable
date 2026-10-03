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

Seat 0 holds Raging Goblin (`{R}`) and three untapped Mountains (two stay
untapped after casting); seat 1 holds nothing and has one untapped Mountain
of its own. Seat 0 casts; its own post-cast window auto-passes via
`policy.passOwnSpell` unconditionally (not the branch under test). Seat 1's
window — stack non-empty, not their spell on top — falls through
`decideStop` to exactly the `nonLandSources` branch. Seat 1 is driven
**zero** times by the test (no `select`, no `ok`, nothing).

Asserted: seat 1's actionable set is non-empty and is EXACTLY their own
untapped lands; seat 1 is logged `auto-passed`; the spell resolves onto
seat 0's battlefield without any click from seat 1. Every assertion about
seat 1's window is read from the RECORDED history (`s.sent`/`s.logs`) once
the whole cast has resolved — never from a live poll of either seat's
prompt text, which the manager caught as racy by construction (both seats'
windows can open and auto-pass between two 25 ms polls).

### The manager's two follow-up corrections

1. **The payment loop re-clicked the same land every tick** before Forge's
   reply tapped it (the identical bug `scenario-ability-repeat.jvm.test.ts`
   already had). Fixed with a `Set` of already-clicked ids, same pattern.
2. **Waiting on seat 0's own prompt TEXT for "Stack: 1 to Resolve" is racy**:
   `passOwnSpell` can pass that window before a 25 ms poll ever samples it.
   Fixed: seat 0's wait reads the STACK ZONE itself (`GameView.Stack`, off
   this seat's own folded state) instead, which persists regardless of how
   fast the window opens and closes.

Chasing these down a 10/10 count surfaced a THIRD, pre-existing issue,
unrelated to either correction: the scenario harness's very first
`selectCard` after a scenario applies is occasionally a silent no-op against
Forge's own stale actionable cache (`PlayBridge.java`'s `refreshActionable`
doc — the same race already documented there for the HIGHLIGHT, here it is
the selection itself). Measured directly, interleaved against
`two-mana-pass.state` (3 Mountains, otherwise identical shape) under
identical host load in the same batch: `land-only-pass.state` with only ONE
Mountain on the caster's battlefield failed roughly half of all runs at the
cast itself; raising it to THREE Mountains (no other change) brought that to
16/18 across two further batches — the opposite of the obvious guess that a
simpler scenario races less. Not explained further than that measurement.
Fixed two ways together: (a) three Mountains instead of one, (b) the
`select` is retried, harmlessly, for as long as the card still sits
unselected in hand (a `selectCard` against a card Forge does not currently
consider legal is a no-op, not a toggle — confirmed directly: retrying never
produced a double-cast or any other side effect across every run in this
investigation).

### Counts

- **Unit** (`auto.test.ts`, `decideStop`'s land-exclusion describe block):
  reverted → 1/170 fail (exactly the land-only-passes case, `expected null to
  be 'Fourth main phase'`); restored → 170/170 pass.
- **Real Forge, the actual regression** (`auto-pass-land.jvm.test.ts`):
  reverted → 1/1 fails with exactly the predicted symptom (`timed out waiting
  for Raging Goblin to resolve onto the battlefield without any click from
  seat 1`); restored → the mechanism itself passes every time it gets a clean
  cast (confirmed separately via `two-mana-pass.jvm.test.ts`, a DIFFERENT
  2-mana cast through a genuine multi-source Auto payment window, 5/5 clean
  with no retry needed at all, plus 1/1 clean over the real socket path —
  `socket-two-mana-pass.jvm.test.ts`).
- **Real Forge, this specific test's own cast-registration race** (the
  pre-existing issue above, orthogonal to the regression fix): post-fix
  (3 Mountains + retry), four separate batches on this host today: 7/8, 9/10,
  9/10, and one earlier interleaved comparison of 4/4 isolated from host
  contention — **25/28 (89%) overall**, every failure the identical,
  pre-existing cast-registration symptom (never the regression's own
  symptom), and every batch run on a host shared with other lanes' own jar
  suites and CI runners (`uptime` load average measured 2.5–7.6 across these
  runs; a leaked orphaned e2e server process from earlier in this session,
  found and killed mid-investigation, was itself responsible for one bad
  batch). Not a clean 10/10 — the residual is a real, pre-existing,
  host-load-sensitive Forge/bridge timing race this lane did not introduce
  and that an apps/server-level retry cannot fully close, not a sign the
  land-exclusion fix itself is unreliable.

## `pnpm --filter @hadoku/server typecheck` / `eslint`

Both clean.
