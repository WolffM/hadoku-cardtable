# Lane E — run evidence (wave 35)

**FINAL. Full forge-e2e CI-set: 41 expected, 0 skipped, 0 unexpected,
445s (7.4m) on this host's cleanest run.** Timing comparison against main's
own CI baseline, and what grew, below.

Env used for every run below:

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="$HOME/.local/share/cardtable/forge.jar"
export CARDTABLE_FORGE_RES="/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res"
export CARDTABLE_PLAY_WORK_DIR="/tmp/claude-1000/w35-e/work"
```

Every run: ports (19008/19028/19108/19128) confirmed free first, then
`pnpm --filter @hadoku/ui --filter @hadoku/server build` and
`npx playwright test` both under the shared `flock`. tsc and eslint clean on
every file this lane touched, every time.

## The reload check's row-set scope — two rounds of ruling

First round: `rowCardIdSets` compared card-id sets PER ROW (per battlefield
tier, keyed `owner:zone:tier`). This immediately found a real, deterministic
mismatch: Figure of Destiny (id 9) sits in the LANDS row live (placed there
via R9's "any slot") but reverts to the CREATURES row after a reload. Reported
before guessing which way to resolve it.

**The manager's ruling**: rows ARE the arrangement — R9 explicitly lets a
player put a creature in the lands row, so a per-row set cannot survive a
reload until the arrangement itself persists (wave 36). Fixed: `zoneCardIdSets`
now merges every tier into ONE set per `owner:zone` (your battlefield, their
battlefield, your hand, graveyards/exile too, since the same helper's
selector reaches them) — the real game-state claim, and it stays strict: a
card that vanished, changed zone, or crossed sides still fails, with its own
message, before the order-relaxed text comparison runs. Closing comment
extended verbatim per the ruling: *"After wave 35's R9 (any slot), a card the
player placed is put back on reload because the arrangement is in memory
only — including which ROW it sits in (Figure of Destiny placed in the lands
row returns to the creature row)."*

**Confirmed: 6/6** (`--repeat-each=3`) after the zone-level fix.

## The three blockers this lane carried, and how each closed

### R4 (Thoughtseize) — fixed in the spec, two real bugs

S confirmed (real socket.io + real jar, 4/4) the caster gets exactly one
`chooseSingleEntityForEffect` — the `notify:setSelectables` first found was
Thoughtseize's own TARGETING step (choose a player), never answered. Fixed:
(1) added an `opponentTarget` click; (2) `play/prompts.ts`'s own
`answerPrompt` has a case for `chooseSingleEntityForEffect` and was
answering the discard choice itself before this spec's own check ran — fixed
by reading the open ask's `data-method` first and skipping the generic drain
for that one method. **10/10, then 10/10 again.**

### R9b (settle/release race) — confirmed fixed (B, `2181aed`)

`notePlayedTo` now safe to call twice (a `useSyncExternalStore` wakes every
mounted `Board`). Was ~75% fail across 17 runs before. **10/10** after.

### `table-fit.spec.ts` — three real bugs, all fixed

1. **Row-placement** (this lane): `play/hands.ts`'s bot always settled a
   cast at the whole battlefield's centre, which sits inside the BACK row's
   box — fixed by aiming at the type-correct row, and by making the settle a
   single jump instead of an animated move.
2. **Left-column spacing** (B's exact spec, applied verbatim): R3 moved the
   mana pool between the counts and the graveyard; added a `manaPool` field
   to `measureColumns()` and split the check into counts→manaPool→graveyard,
   mirrored for `them`, same tolerance on each pair.
3. **Tapped-land arrange-drag ghost** (root-caused via the manager's own
   diagnostic — logged every indicator's outerHTML at the midway point): two
   stacked bugs — a combat-declare window (`install.ts`'s documented
   behaviour, fixed by waiting it out AND actively pressing OK through it,
   since the bots are paused for this whole section and nobody else will
   advance it), and two separate reusable indicator singletons (R9's own
   cast-preview vs. the arrange-reorder drag's) sharing one selector, fixed
   with `:not([hidden])` in `play/w32.ts`'s `DRAG_HOOKS`.

   **Confirmed: 6/6** (`--repeat-each=3`).

### `play.spec.ts` — two real bugs, both fixed

1. **"a spell resolves unattended"**: S's diagnosis — R15's land exclusion in
   `decideStop` is correct; bob's own deck genuinely holds a real
   instant-speed response. Fixed: `declineBobsRealOffer()` presses bob's OK
   deliberately (recorded) only when his own offered set holds a non-land
   card; `unattended` now requires `aliceOwnPresses.length === 0`. UNPROVEN
   guard semantics unchanged. **This fix also made the test FASTER** (see
   timing below) — the old loop ran to its own deadline every time bob's
   real option blocked the pass; the new one resolves as soon as the caster
   is genuinely left alone.
2. **The reload check** — see the dedicated section above.

   **Confirmed: 6/6** (`--repeat-each=3`) after both fixes, run twice (once
   per row-set ruling).

## A whack-a-mole, closed with one generous margin, then a GENUINE host-load ceiling found

Running the full CI set repeatedly after the above (each ~450-550s, 41-test
run) surfaced three DIFFERENT "a scenario sets up" precondition misses across
three separate runs, never the same test twice — closed by giving every such
precondition in `w33.spec.ts`/`w34.spec.ts` (nine total) the same 90s margin,
with `test.setTimeout` raised to 3 minutes everywhere it was needed.

**After that fix, THIS HOST went through a period of severe, external memory
pressure** (observed directly, not mine: `uptime` load average 14.68 →
6.24 → 9.55 over about 20 minutes; `free -h` showed up to 38 GiB of 63 GiB
swap in use) — none of it from this lane's own processes (checked: this
lane's own JVMs are two small 1 GB-heap "spare" processes, by design, torn
down or kept warm between runs; the bulk of memory use was elsewhere on the
host, including six long-lived `actions-runner` JVMs unrelated to this
lane). Four consecutive full-set runs during that window each failed
EXACTLY ONE test, a DIFFERENT one every time (a 90s-margin precondition
miss twice, a benign table-fit read-order artefact once, and once the
pre-existing, already-documented Q17 transient-stack race S measured at
61/66 ≈ 92% — not a new bug). As load eased, a clean run followed
immediately with no code change. This is the signature of host contention,
not a logic defect — recorded here rather than chased with more margin,
which would not have helped against a host that was briefly swapping.

## Full `forge-e2e` CI-set runs, timed — the whole sequence today

| Run | Elapsed | expected | skipped | unexpected | Note |
| --- | --- | --- | --- | --- | --- |
| Before R4/R9b/table-fit fixes | 416s (6.9m) | 31 | 4 | 6 | |
| After R4/R9b fixed, table-fit not yet | 475s (7.9m) | 39 | 0 | 2 | |
| After table-fit's two remaining fixes | — | — | — | 0 (table-fit) | confirmed separately, 6/6 |
| After `play.spec.ts`'s decline fix, before reload-order fix | — | — | — | 3 (reload-order, new finding) | |
| After the per-row reload fix (superseded) | 471s (7.8m) | 36 | 0 | 1 | host-load precondition miss |
| After bumping that one margin | — | — | — | 1 | a DIFFERENT test, same class |
| After the 90s margin everywhere | **469s (7.8m)** | **41** | **0** | **0** | clean |
| After the per-ROW reload check (pre-ruling) | — | — | — | 3 (row-set, expected per the old scope) | reported, ruled on |
| After the per-ZONE reload fix, host under heavy load | 556s / 444s / 549s / 355s (4 runs) | — | — | 1 each, different test each time | host contention (above) |
| **Final, host load eased** | **445s (7.4m)** | **41** | **0** | **0** | |

## Per-spec timing: this run vs. main's CI baseline (run `37034941166`, job
`110931019804`, 28 tests, `success`, job span 291s / 4.85m total)

Both columns are the PLAYWRIGHT TEST PORTION only (`Running N tests` to the
final `N passed`), not the CI job's install/build/chromium-install steps —
on this host those added only ~15-19s beyond the test run on the baseline
job (built from the job's own total vs. its own "28 passed (4.6m)" line);
assumed roughly similar now.

| File | main (28 tests) | now (41 tests, clean) | Δ |
| --- | --- | --- | --- |
| `play.spec.ts` | 50.7s | 28.4s | **−22.3s** (the decline-fix resolves faster than the old loop's own dead-end retries) |
| `table-fit.spec.ts` | 44.5s | 31.0s | **−13.5s** (the phase-gate + indicator fixes remove wasted retry time) |
| `w31.spec.ts` | 47.1s | 55.0s | +7.8s (the combat-rail test's own focus/blur fix costs a bit more than the old hover did) |
| `w32.spec.ts` | 18.1s | 18.7s | +0.6s (noise) |
| `w33.spec.ts` | 63.2s | 86.8s | +23.6s (~2.6s/test — the 90s precondition-margin safety net) |
| `w34.spec.ts` | 48.7s | 68.0s | +19.3s (~3.2s/test — same margin) |
| `w35.spec.ts` | 0s (did not exist) | 154.2s | **+154.2s — 13 new specs, the wave's own new coverage** |
| **Total** | **272.4s (4.54m)** | **442.1s (7.37m)** | **+169.7s (+2.83m)** |

**What grew, plainly**: the new `w35.spec.ts` itself is 91% of the growth
(154.2s of 169.7s) — this is the wave's required new coverage, not overhead.
The 90s precondition margins on `w33`/`w34` (needed specifically BECAUSE this
host is sometimes under load — see above — not needed on a quiet host) add
another ~43s. `w31`'s combat-rail fix adds ~8s. `play.spec.ts` and
`table-fit.spec.ts` got FASTER by a combined ~36s, partially offsetting the
rest.

**Does it fit in 8 minutes?** Borderline, and NOT reliably, by my own direct
measurement tonight: this exact 41-test set ran clean in 7.4-7.8m on a quiet
host, but swung to 5.9-9.3m test-portion alone across six consecutive
attempts purely from transient host memory pressure outside this lane's
control (see above). Projected onto the baseline job's own ~15-19s fixed
overhead, a quiet-host total lands at roughly 7.6-8.0m — right at the
8-minute budget on a good day, and over it by as much as a minute or more on
a loaded one, which is consistent with the manager's own reported 8.9m for
the actual CI run (that run also still carried this lane's own
not-yet-committed `play.spec.ts` bug, whose old retry-to-deadline loop was
itself ~22s slower per the table above, before even accounting for host
load). **Not dropping any spec**, per instruction — the growth is the wave's
own new coverage plus a margin that exists specifically to keep this same
host's occasional contention from producing false reds.

## What is NOT a bug, corrected from an earlier misreading this session

- The webServer's `no Forge` console line — `e2e/harness.ts`'s own webServer
  deliberately never gets Forge env (draft matches don't touch it); the REAL
  play server (`startPlayStack`) gets it from this shell's `process.env`.
- `live-log-peek` assertions always reading count 0 (the element does not
  exist anywhere in `apps/ui/src` except as this test's own absence-check).
- Arrangement (including R9's cast-settle position AND which row a card
  sits in) not surviving a page reload — in-memory-only since wave 32, by
  the manager's own ruling; persisting it is tracked for the next wave, not
  a defect in this one.

## Files changed (this lane's `e2e/**` + `.github/workflows/ci.yml` only)

`e2e/w35.spec.ts` (new), `e2e/w31.spec.ts`, `e2e/w33.spec.ts`,
`e2e/w34.spec.ts`, `e2e/table-fit.spec.ts`, `e2e/play.spec.ts`,
`e2e/play/hands.ts`, `e2e/play/scenario.ts`, `e2e/play/w32.ts`,
`e2e/arrow.spec.ts`, `e2e/w32.spec.ts`, `.github/workflows/ci.yml` (added
`w35.spec.ts` to the forge-e2e job). No file outside this lane's ownership
was touched.
