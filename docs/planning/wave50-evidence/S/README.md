# Lane S evidence — server, storage, import

## Import run

Against the read-only snapshot, into a scratch dir (never production's data dir):

```sh
python3 scripts/sfx/import.py --from docs/handoff/snapshot/finished \
  --seed docs/handoff/snapshot/assignments-seed.json \
  --to /tmp/claude-1000/w50-S/sounds
```

```
140 takes, 140 files copied, 82 folders, 12 cells assigned -> /tmp/claude-1000/w50-S/sounds
```

Matches the wave file's expectation exactly (140 takes, 12 cells). `catalogue.json` and
`assignments.json` were additionally parsed with the REAL `@hadoku/shared` schemas
(`CatalogueSchema`, `AssignmentsSchema`) in a one-off node check — both `safeParse` to `success:
true`, and every file path referenced by `assignments.json`'s 12 cells resolves to an entry in
`catalogue.json` (zero missing). Section counts in the built catalogue: `Colour sounds` 90,
`Library` 33, `Moments` 10, `Land types` 7.

## Tests

- `packages/shared/src/sounds.test.ts`: **19 passed** (CellId row/column pairing, `TAKE_FILE_RE`'s
  traversal gate, all four schemas, `SOUND_MATRIX`'s shape) — one valid and one invalid case each
  for both `CellId` and `TAKE_FILE_RE`, per the brief.
- `apps/server/src/http/sounds.test.ts`: **18 passed** — friend read / friend write-refused /
  admin write, `canEdit` true only for admin, a malformed cell and an unknown catalogue file both
  400, a missing data dir is an empty catalogue, the take-serving route's traversal gate (encoded
  slashes, `..`, an absolute-looking path, wrong extension, uppercase folder — all 400, and the
  response body never carries a planted secret file's contents), the atomic-write crash case, the
  concurrent-PUT race case, and the two corrupt-file / dropped-cell logging cases added for the
  manager's review (below).
- `pnpm run check` (whole repo, via the required `flock` wrapper, no `CARDTABLE_FORGE_JAR`/`_RES`
  exported first): **does NOT exit 0**, and the failure is not in this lane's files. Full log:
  `docs/planning/wave50-evidence/S/check.log`.
  - `packages/shared typecheck: Done`, `apps/server typecheck: Done` — this lane's files are clean.
  - `apps/ui typecheck: Failed` on `src/sound/builderClient.test.ts(154,14)` and `(157,21)`:
    `Property '_src' does not exist on type '{}'`. `apps/ui/src/sound/builderClient.ts` and its
    test are lane U's files (concurrently being written in this same worktree, per the wave file's
    lane table), not this lane's — left untouched, per the brief ("if check fails ONLY on files
    that are not yours, record which and why, don't touch them"). The repo's `check` script is
    `typecheck && lint && test`, so this single typecheck failure also blocked lint/test from
    running repo-wide; this lane's own targeted `vitest` runs (above, 37/37) and per-package `tsc`
    (`packages/shared`, `apps/server`, both clean, run standalone) stand in for that.
  - A first attempt at this run was additionally confounded by its own timing: queued for a long
    time behind w49's heavy-lock jvm gate, it finally executed while this lane's `sounds.ts` was
    mid-edit (the manager's fixes), and the `echo "EXIT $?"` chained with `;` rather than `&&`
    masked the real exit code in that attempt's summary line — caught by reading the log body, not
    the echoed line, and re-run clean (on this lane's own files) after finishing the edits.

## Manager review: two fixes

The manager pre-read `sounds.ts` and flagged two issues before this lane reported. Both are fixed,
in `apps/server/src/http/sounds.ts` only:

1. **Lost update on concurrent PUTs.** The PUT handler's read-modify-write
   (`readAssignments` → mutate → `writeAssignments`) had no serialization. Two overlapping PUTs —
   exactly lane U's drag, which sends one PUT for the source cell and one for the target — could
   each read the same prior `cells` object before either wrote, so the second write silently
   discarded the first's change. Fixed with `withWriteLock`, a promise-chain mutex scoped to one
   `attachSounds` instance: every PUT's critical section now waits for the previous one to settle
   (success or failure) before it reads.
2. **Silent swallow on corrupt files.** A `catalogue.json`/`assignments.json` that fails
   `JSON.parse` or the schema still degrades to empty (kept, per the brief), but now logs
   `sounds-file-corrupt` with the file and the reason. `readAssignments` additionally logs
   `sounds-assignments-cells-dropped` with a count when one or more cell entries are dropped for
   being malformed (not a valid `CellId`, or not a string array) — the corrupt-FILE case and the
   dropped-CELLS-within-an-otherwise-valid-file case are different failures and get different
   events.

## Mutation tests (required)

### The admin gate (re-run after the fixes above)

Removed the admin check in the PUT route (`if (!isAdmin(req))` → `if (false)`), ran
`apps/server/src/http/sounds.test.ts`:

```
Tests  1 failed | 17 passed (18)
× PUT /api/sounds/assignments/:cell > a friend cannot write: 403, and nothing is persisted
  → expected 200 to be 403
```

Exactly the one test tied to the admin gate failed; the other 17 (including the new concurrency and
logging tests) kept passing. Restored the line verbatim, confirmed with a byte-identical `diff`
against the pre-mutation file, and re-ran:

```
Tests  18 passed (18)
```

### The write lock (new)

Replaced `withWriteLock`'s body with `return fn();` (no serialization at all) and ran just the new
concurrency test 8 times in a row:

```
Tests  1 failed | 17 skipped (18)   [all 8 runs]
```

Deterministic in both directions: **0 of 8 passed** with the lock removed, and a separate 5-run
check on the UNMUTATED code found **5 of 5 passed**. The failure is the exact lost update the fix
targets — `after.cells` holds only `{"WU|spell": [...]}`, `m-win|play` silently missing:

```
- "m-win|play": ["m-win/take-synth-1.ogg"],
  "WU|spell": ["wu/take-v1-4000.ogg"],
```

Restored `withWriteLock` verbatim (byte-identical `diff` against the pre-mutation file) and
re-confirmed 18/18.

## Decisions made because the brief, or the snapshot, was ambiguous

1. **The traversal-safe path grammar (`TAKE_FILE_RE`) is lowercase-only, but source folders carry
   the colour code's own case** (`BG.land`, `WUBRG.creature`). `import.py` lowercases only the
   folder segment of the served path (`BG.land` → `bg.land`); filenames in this snapshot are
   already all-lowercase so nothing there changes. The catalogue's `sound` field for a colour
   identity stays the canonical uppercase id (`BG`), since that is what `SOUND_MATRIX`/`CellId`
   use for lookups — only the on-disk path is case-folded.
2. **Library sound names and groups are NOT invented.** `docs/handoff/snapshot` carries no
   `round3.json`/`prompts.json`, but the repo's own `scripts/sfx/round3.json` does, and — checked —
   covers all 22 `lib-*` folders in this snapshot exactly. `import.py` reads it directly rather than
   guessing labels.
3. **Colour-identity and event names come from `SOUND_MATRIX`, not `scripts/sfx/prompts.json`.**
   `prompts.json`'s moment vocabulary (`m-land`, `m-tap`, `m-counter`, `m-lifegain`) predates the
   operator-approved builder and does not match the wave file's binding `EVENT_IDS`
   (`m-tapcard`, `m-damage-player`, …). Checked by diffing the two id lists before choosing; using
   the stale file would have silently produced catalogue entries whose `sound` never matches any
   `CellId` row.
4. **`assignments.json` on disk stores only `{ cells }`.** `canEdit` is not persisted — it is
   computed per request from the caller's tier, the same way every other admin gate in this repo
   works. `AssignmentsSchema` (the wire shape, `{ cells, canEdit }`) is reused for the on-disk
   `cells` validation by just not populating `canEdit` when reading, rather than maintaining two
   near-duplicate schemas.
5. **A corrupt or hand-edited `catalogue.json`/`assignments.json` degrades to empty, not a 500.**
   The brief only specifies this for a *missing* directory; extending the same behaviour to a file
   that exists but fails to parse or fails the schema seemed like the same principle (a sound
   builder with no sound should never be the reason the admin screen won't load) and is covered by
   this repo's general "a missing dir means an empty catalogue, never a crash" rule in the wave
   file's Settled section.
6. **`GET /takes/:folder/:file` does not check catalogue membership** — only the structural
   `TAKE_FILE_RE` grammar and the resolved-path-stays-inside-the-dir check. The brief's "every file
   in a PUT body must already be in the catalogue" rule reads as scoped to the PUT route (the one
   that writes `assignments.json`); the raw file route is a dumb static-file server behind the
   traversal gate, same as how a CDN would serve it.

## What could not be verified

- **The deployed/production path.** Everything above ran against a scratch directory under
  `/tmp/claude-1000/w50-S/`; production's data dir was never touched, per the brief — the tracker
  runs the real import after deploy (wave file, "Watches the tracker holds").
- **Lane U's consumption of `packages/shared/src/sounds.ts`.** Landed first (before lane U's
  worktree work was checked here) and typechecks/tests clean on its own; whether lane U's
  `builderClient.ts` and `SoundBuilder.tsx` actually compile against these exact exports is lane
  U's own verification, not re-run from this lane.
