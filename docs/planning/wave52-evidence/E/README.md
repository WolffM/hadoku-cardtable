# Wave 52 §E — evidence

## The fork

`WolffM/forge` branch `cardtable/w52-mana`, cut from the pin `9729168d`:

| sha | change |
| --- | --- |
| `127c0ad3` | `PlayerControllerHuman.tryUndoLastAction` drops `cachedActionableCards` before `showMessageInitial()`, so the re-shown priority prompt rescans the board the undo left (W10) |
| `e5db0510` | `AvailableActions.cardHasActionable` offers a mana ability whose cost is a tap plus mana (`CostTap` + `CostPartMana` only) when `canAfford` says the mana can be paid now (pool or another source). A tap-only ability is still offered as before; any other cost part (life, sacrifice) still is not |

Why "tap plus mana" and not every mana ability the payment prompt offers (`cardHasPlayableManaAbility`
takes any playable mana ability): a priority click on Lotus Petal or a painland would sacrifice or
cost life with no prompt shaped for it yet. The w35 comment in the same method held that line, and
the Signet doesn't need it moved.

## The jar

Built per `docs/FORGE_JAR.md` in the scratch clone `~/.cache/w7b-forge` (`clean package`, offline,
JDK 21.0.12 / Maven 3.9.16), verified (step 3: `server` present in `Main.class`, no Sentry),
staged at `~/.cache/w52-jar/forge.jar`:

- built: sha256 `984f247a0026a4db480050f0025112788fa24389bd709d60977fac51a8fad6a3`
- installed before w52: sha256 `89e824c9ba5329b09dae20ab646c688361ff9a2614ce8910e95f2e3fe9f1f53c`

Install and restart: see "Install" below.

## Scenarios

- `w52-e-signet.state` — Azorius Signet + three Islands, Divination in hand, turn 1 MAIN1.
- `w52-e-island.state` — one Island, MAIN2, nothing castable (W10's shape).

## `e2e/w52-mana.spec.ts`, real Forge

1. The Signet is offered at priority; a click taps it, the pool reads `{W:1, U:1}`, exactly one
   Island is tapped (Forge's Auto paid the `{1}` under the default `'forgeAuto'`), no prompt is left.
2. Island tap → pool `U:1` → Undo (button 2, "Undo (1)") → untapped, pool empty → the Island is
   offered again → a click taps it again. Main 1 with Divination castable (`w52-e-signet`).
3. The same in Main 2 with nothing castable (`w52-e-island`).

Against the staged w52 jar, work dir `~/.cache/cardtable-play-work/w52-e`: 3 consecutive runs,
`3 passed`, 0 skipped, each time. (One attempt between runs 2 and 3 never started: port 19008 was
held by another e2e run, `EADDRINUSE` from the harness's web server. It is not counted either way.)

## Mutations (each fork commit reverted, jar rebuilt, spec re-run)

Mutant jars built from `cardtable/w52-mana` with one commit reverted (`~/.cache/w52-jar/mutants.sh`).

| reverted | jar | spec result |
| --- | --- | --- |
| `127c0ad3` (undo drops the cache) | `mut-undo.jar` | **2 failed**, 1 passed: both Island cases fail on "the Island is offered again after Undo" (Expected true, Received false), which is the W10 symptom. The Signet case passes |
| `e5db0510` (Signet at priority) | `mut-signet.jar` | **1 failed**, 2 passed: the Signet case fails on "Azorius Signet is offered at priority". Both Island cases pass |

Restored: the branch tip is unchanged (`e5db0510`); the staged jar is the unmutated build.

## `match.ts` (UI) `setWeaklySelectable` handling

Blast radius: Undo republishing a fresh set needs no UI change. The UI folds every
`setWeaklySelectable` as a whole replacement (`apps/ui/src/play/live/match.ts`, the
`setWeaklySelectable` branch of the fold), and spec cases 2 and 3 show the Island offered and
clickable again after Undo with no UI change.

GATE_RESULTS

INSTALL_RESULTS
