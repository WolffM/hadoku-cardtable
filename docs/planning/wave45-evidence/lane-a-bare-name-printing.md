# Wave 45, Lane A — bare-name row names the printing the decks actually use

## Operator quote (why)

> "had a strange situation where a different forest art was displayed, but only for the opponent?"

The screenshot showed two revealed Forests, one modern, one old. `PromptShell.tsx`'s late-face
fallback draws a card by NAME alone, and the bare-name row in `art-ids.json` held whatever printing
`scripts/art/build-art-ids.ts` happened to resolve first — tier 3 of `resolveCard`, "earliest
non-digital printing". For `Forest` that is Alpha (1993). Alpha is not a printing anyone drafting or
playing this library's decks has actually seen.

## The rule

Each bare-name row now names the printing with the most votes, where one vote is cast per committed
`Name|SET` reference — one deck's own pinned line, or one cube-pool card's own pinned printing — NOT
weighted by how many copies that reference asks for. (A single 19-Forest ramp deck is one editorial
choice of printing, not 19 votes; weighting by copy count would let one deck's land base outvote
eleven other decks' unanimous different choice.) Ties break on the newest `released_at`; a further
tie (identical count and date) breaks on the id itself, so the result is total and reproducible. A
name no committed deck or pool ever pinned a set for (no votes at all) keeps the old fallback — the
earliest non-digital printing — because there is nothing to prefer among.

Implemented as a pure, exported function, `mostUsedPrinting(votes)`, in `scripts/art/build-art-ids.ts`.

## Regeneration

```
pnpm --filter @hadoku/carddata sync
node --max-old-space-size=6144 scripts/art/build-art-ids.ts --forge-res=/home/hadoku/repos/hadoku-cardtable/forge/forge-gui/res
```

The worktree had no cache of its own. The main checkout's `packages/carddata/data` existed but was
stale (`sourceUpdatedAt 2026-09-15`) relative to the currently committed table's own
`sourceUpdatedAt 2026-10-02` — a first regeneration attempt against that stale cache produced ~54
spurious, unrelated row changes (a newly-printed set, `FRA`, didn't exist in the old snapshot, and a
`Germ Token` → `Phyrexian Germ Token` Scryfall rename). Rather than report against stale data, this
lane ran a real `sync` against the live Scryfall bulk endpoint (network reachable from this worktree;
~79 MB, ~9 s), landing a cache newer than the committed table's own (`2026-10-04T21:05:43Z`). The
`--forge-res` flag points at the main checkout's `forge/forge-gui/res` (vendored Forge, gitignored,
present there) so token rows use Forge's real wire names, matching how the committed file was built.

## Proof: only bare-name rows changed

```
$ git diff --stat -- apps/ui/src/draft/art-ids.json
 apps/ui/src/draft/art-ids.json | 548 ++++++++++++++++++++---------------------
 1 file changed, 274 insertions(+), 274 deletions(-)
```

274 changed lines = 272 bare-name value changes + exactly 2 unrelated, expected lines:
- the `note` field's `sourceUpdatedAt` timestamp (cache refresh, described above)
- `Germ Token|FDC` → `Phyrexian Germ Token|FDC` (a Scryfall-side card rename between the
  2026-10-02 and 2026-10-04 snapshots, in the token bucket, nothing to do with this rule)

No `Name|SET` row changed: `0` of the `basics`/`decks`/`cubeAliases`/`tokens` buckets' keys moved.
Checked by diffing the full key set and splitting changed keys on whether they contain `|`:

```
before count 6652, after count 6652
removed keys: 1 (Germ Token|FDC)       added keys: 1 (Phyrexian Germ Token|FDC)
changed values (same key, different id): 272
  bare-name changed (no "|"):        272
  Name|SET changed (has "|", should be 0): 0
```

## Forest, before/after (the operator's own bug)

```
$ jq '.ids["Forest"], .ids["Forest|SOI"], .ids["Forest|A"]' apps/ui/src/draft/art-ids.json
"42efdb6a-1c54-497a-9058-af4256241649"   # bare "Forest" row, AFTER — Shadows over Innistrad (2016)
"42efdb6a-1c54-497a-9058-af4256241649"   # Forest|SOI, unchanged — confirms the match
"6f1c8cb0-38eb-408b-94e8-16db83999b3b"   # Forest|A (Alpha) still exists as its own exact-printing row
```

Before this wave, `.ids["Forest"]` was `6f1c8cb0-38eb-408b-94e8-16db83999b3b` — Alpha, same id as
`Forest|A` / `Forest|LEA`. That is the "old" Forest art the operator's screenshot showed.

Deck rows' own set counts for `Forest`, tallied by distinct deck-line reference (not weighted by
card count), independently recomputed by reading `decks/**/*.dck` directly rather than trusting the
generator's internal count:

```
SOI 6   M12 5   M13 4   THS 3   ORI 3   DTK 2  M10 2  M11 2  M14 2  M15 2  RTR 2
AVR 1  ISD 1  LRW 1  ROE 1  SHM 1  ZEN 1
```

SOI wins outright (6 > 5), matching the bare row.

## How many bare-name rows changed, and five examples (basics first)

**272 of 983 bare-name rows changed.**

| Name | Before (printing) | After (printing) | Votes (winner / runner-up) |
| --- | --- | --- | --- |
| Forest | Alpha (1993) `6f1c8cb0…` | Shadows over Innistrad, 2016 `42efdb6a…` | 6 / 5 (M12) |
| Island | Unlimited (1993) `90a57c0e…` | Shadows over Innistrad, 2016 `bffca348…` | 4 / 4 / 4 — 3-way tie, newest wins |
| Mountain | pre-modern `eace2c85…` | Shadows over Innistrad, 2016 `a7878436…` | 5 / 5 — tie with Origins (2015), newest wins |
| Plains | pre-modern `b1623d57…` | Shadows over Innistrad, 2016 `56bbcfb7…` | 7 / 5 (M13) |
| Acidic Slime | `f1377f45…` | Magic 2012, 2011 `ae8e5876…` | 7 / 4 (M13 printing) — count wins over the newer M13 printing |

All five basics that have more than one deck-pinned set (`Wastes` only ever appears in one deck, so
it did not change) now resolve to the printing Shadows over Innistrad's basics — simply because that
is the printing the committed `decks/standard-2016/` directory's basics most often name, independently
recomputed above, not asserted.

## Unit test

`scripts/art/build-art-ids.test.ts`, 7 tests, against a fabricated fixture (`mostUsedPrinting`
imported directly — no Scryfall cache needed, none of this depends on which printings exist):
majority wins over "first cast", tie breaks on newest release, a further tie breaks on id,
a missing `releasedAt` never crashes, order-independence, an unvoted name has no winner, and names
stay independent of each other. Added `'scripts/**/*.test.ts'` to `vitest.config.ts`'s `include`
(see "config change" section) so this file is picked up at all.

### Mutation test

`mostUsedPrinting` temporarily replaced with "first vote cast wins" (the literal `first write wins`
rule this wave replaces) — a one-line change, reverted immediately after:

```
restored (real rule):   7 passed, 0 failed
mutated (first-write):  4 passed, 3 failed
  × picks the printing with the most votes, not the first one cast
  × breaks a tied vote count by the newest release
  × breaks a tied count AND a tied release date by id
```

Restored afterward; `git diff --stat -- scripts/art/build-art-ids.ts` confirms the file matches the
landed version (the mutation was never committed to disk at close — restored from a pre-mutation
copy before this report was written).

## Config change (manager-granted)

`vitest.config.ts`'s `include` gained `'scripts/**/*.test.ts'` (nothing else changed) — the root
config only matched `apps/*/src/**/*.test.ts` and `packages/*/src/**/*.test.ts`, so a test under
`scripts/art/` would never have run; confirmed by running the new test file before the config change
(`No test files found, exiting with code 0`) and after (`7 tests | 7 passed`).

`scripts/art/build-art-ids.ts`'s bottom-of-file `main()` invocation is now guarded by
`import.meta.main`, so importing `mostUsedPrinting` from the test file does not run the CLI's file
reads or cache access. Verified directly: a throwaway probe module logged
`import.meta.main === true` when run via `node scripts/art/poc.ts` directly, and the test asserting
`ranMain === false` passed when the same module was imported by vitest — proving the guard is live in
both directions, not just assumed. (Probe files deleted after the check; not part of the landed diff.)

## Made dead / deleted

**0 lines removed.** The old unconditional `resolveCard(name, null)` tier-3 pick is still reachable —
it is now the explicit fallback for a bare name with zero votes (true whenever a deck references
that name with no set at all, which contributes no signal either way). It was not replaced wholesale,
only gated behind a check for votes; there is no leftover branch, flag, or helper this change makes
unreachable. Said plainly rather than manufacturing a deletion the diff does not have.

## What could not be verified

- `pnpm run check` exit code — run from the repo root under `flock -x /tmp/claude-1000/heavy.lock`,
  no jar/e2e env exported; result reported separately once the lock-held run finished (see the lane's
  closing report for the exit code and any findings).
- The real-Forge rendering of a revealed Forest (whether the play board actually draws the new SOI
  art on a late-arriving face) — out of this lane's scope per the wave brief (§A is the generator and
  table only; W11's root cause, the decode race, is explicitly left to w40 B, unrun).
