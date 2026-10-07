# Wave 53 §T — evidence

Operator's own words (Playtest 9, ledger row R15, echoed in the wave file):
*"cards like 'Magus of the moon' and 'Urborg tomb of yawgmoth' change the
types of cards. i need this to be visually indicated by a tag of some kind …
put one of our overlay pills over the type bar."* Item 3 is the w52 follow-up
their own §S evidence flagged as out of lane: *"The UI's `nothingToDecide`
still counts own lands only. With a Signet offered, End Turn is not
highlighted for that seat."*

Run 2026-10-06/07 on hokon, Node 24.18.0, `apps/ui` 0.32.32 base (post w51
merge, `aa56402`). Jar: `~/.local/share/cardtable/forge.jar`. Res: the main
checkout's `forge/forge-gui/res`. Work dir: `~/.cache/cardtable-play-work/w53-T`
(disk, never tmpfs).

## 1-2 — the pill

### The wire fact, read at the source

`packages/forge-wire/src/tier-c.ts:425`'s `ChangedTypes: 'StringMapType'` is
**not** this fact. Read at the source
(`forge/forge-game/src/main/java/forge/game/card/CardView.java:788-792`,
`Card.java:5477` `getChangedTextTypeWords()`): it is a word-SUBSTITUTION map
for rendering RULES TEXT after a type-change-text effect (a "Human" reading
"Wizard" in a triggered ability's own wording) — neither Urborg nor Magus of
the Moon populates it, and it has nothing to do with comparing a permanent's
current type line against its printed one.

`forge/forge-game/src/main/java/forge/trackable/TrackableProperty.java:123`:
`Type(TrackableTypes.CardTypeViewType)` is the only type-related property —
the CURRENT type line, live. Forge's wire carries no printed/original-type
field for a card's type line at all (confirmed: no `PrintedType`/`OriginalType`
entry anywhere in that file for `Type`, unlike `OriginalColors` next to
`Colors` or `OriginalManaCost` next to `ManaCost`). So "printed" can only ever
come from our OWN static card data — which is exactly what wave 35 built
(`adapter.ts`'s `changedFrom`, comparing the wire's `Type` against
`POOL_PRINTED_TYPE_LINE`) and what this lane now surfaces as a pill instead of
a corner mark.

### What changed

- `apps/ui/src/play/adapter.ts`: `BoardCard.changedFrom` now carries `printed`
  (the printed line itself, not just the card's name) so the board can draw
  the hover text without a second lookup. New `BASIC_LAND_TYPE_LINES` (Plains,
  Island, Swamp, Mountain, Forest — `"Basic Land — <Type>"`, confirmed against
  `forge-gui/res/cardsfolder/p/plains.txt` etc.) merged into
  `POOL_PRINTED_TYPE_LINE`: without it the operator's own literal case —
  Urborg turning a PLAINS into a Swamp — could never be detected, because
  `pool.json` carries zero rows for any basic land name (checked directly).
- `apps/ui/src/play/Board.tsx`: `StateMarks`' old `changed` corner mark
  (wave 35) is REMOVED — replaced, not duplicated, by a new `TypePill`
  component, wired into `CardOnBoard` beside `ChosenTypeLabel`. Visible text:
  the CURRENT type line. `title`: the PRINTED line (the same native-hover
  mechanism `ChosenTypeLabel`/the counters already use — no second, custom
  hover surface was added).
- `apps/ui/src/play/card.css`: `.board-card__type-pill` — a band over the type
  bar (between the marks and the chosen-type corner, not a fifth corner),
  `--accent-ink` (the same token wave 35's mark used), `pointer-events: none`
  (never eats a click Forge offered, never grows the card's box —
  `e2e/table-fit.spec.ts`).
- `apps/ui/src/play/Board.test.ts`: the two wave-35 "changed" mark tests
  rewritten for the pill (current text visible, printed text on `title`,
  and an explicit check that the old corner mark is gone); the adapter-level
  test's `toEqual` extended to the `{ name, printed }` shape.

### Real Forge

Two new scenarios, card scripts confirmed present under
`$CARDTABLE_FORGE_RES/cardsfolder` before relying on them:

- `apps/server/src/play/scenarios/w53-t-urborg.state` — seat 0 controls
  Urborg, Tomb of Yawgmoth (`AddType$ Swamp`, no `RemoveLandTypes` —
  `forge-gui/res/cardsfolder/u/urborg_tomb_of_yawgmoth.txt`) and a Plains.
- `apps/server/src/play/scenarios/w53-t-magus.state` — seat 0 controls Magus
  of the Moon (`AddType$ Mountain | RemoveLandTypes$ True` —
  `.../m/magus_of_the_moon.txt`) and Seachrome Coast, a NONBASIC land with no
  printed subtype at all (`Types:Land` in its own script; `pool.json` already
  carries `typeLine: "Land"` for it, so no data addition was needed for this
  half).

`e2e/w53-type-pill.spec.ts`, two tests:

| test | battlefield card | current (pill text) | printed (title) |
| --- | --- | --- | --- |
| T1 | Plains | `Basic Land — Plains Swamp` | `Basic Land — Plains` |
| T2 | Seachrome Coast | `Land — Mountain` | `Land` |

T2 also asserts Magus of the Moon itself wears no pill (the effect names
"nonbasic lands", not the creature causing it).

**3 consecutive runs, 0 SKIPPED, post-merge build** (`pnpm --filter @hadoku/ui
build && pnpm --filter @hadoku/server build`, then `npx playwright test
w53-type-pill.spec.ts` — `CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES` present,
`forge.ok` is `true`, so neither test's `skip` fired, and all THREE tests in
the file ran each time, T3 included):

- run 1: `3 passed (29.2s)` — T1 8.9s, T2 9.3s, T3 8.7s
- run 2: `3 passed (31.4s)` — T1 9.5s, T2 9.0s, T3 10.5s
- run 3: `3 passed (29.9s)` — T1 9.0s, T2 9.7s, T3 8.9s

### Mutation (item 4, the pill half)

Drop the type comparison in `adapter.ts` (`changedFrom` forced to always
`null`, i.e. the effect reads as "nothing changed"): `Board.test.ts` +
`adapter.test.ts` — **1 failed / 248 passed** (of 249). The ONE failure is the
adapter-level test that exercises the comparison itself
(`"R15: the adapter sets changedFrom when the wire's current type line
disagrees with our own printed data"` — `expected null to deeply equal {
name: 'Izzet Guildgate', printed: 'Land' }`). The two Board-level pill tests
do NOT fail under this mutation, because they hand-build `changedFrom` as
test input rather than deriving it — exactly as intended: they test the
DRAWING, this one tests the COMPARISON. Restored
(`git diff` shows no `MUTATION` marker left, and the diff's net
insert/delete counts match the pre-mutation diff exactly); re-run: **377
passed (377)** across `Board.test.ts` + `adapter.test.ts` + `match.test.ts`.

## 3 — `nothingToDecide` folds in `manaOnly` (gated on w51, unlocked 00:27 UTC)

w52 §S's own evidence (`docs/planning/wave52-evidence/S/README.md`) flagged
this exact gap: *"With a Signet offered, End Turn is not highlighted for that
seat... fold `manaOnly` into `LiveMatch` and read it there."* `manaOnly` is
carried on the SAME `setWeaklySelectable` frame as `cards`
(`packages/forge-wire/src/tier-b.ts`'s `SetWeaklySelectableSchema`) — already
typed on the wire since w52, never read by `match.ts` until now.

### What changed (`apps/ui/src/play/live/match.ts` — only the frame
plumbing `weaklySelectable` itself already needed, and `nothingToDecide`)

- `LiveMatch.weaklySelectableManaOnly: ReadonlySet<number> | null` — new
  field, mirroring `weaklySelectable`'s own three states (set on the frame,
  cleared on `clearWeaklySelectable`, cleared in `discardLocal`, `null` at
  match creation).
- `nothingToDecide`: a weakly-selectable id now clears the loop when it is
  EITHER the viewer's own battlefield land (unchanged) OR named in
  `weaklySelectableManaOnly` (new) — never the other way around: a
  `manaOnly` fact about a card Forge has not actually offered changes
  nothing.

### Unit test (`apps/ui/src/play/live/match.test.ts`)

`actionable` took an optional `manaOnlyIds` parameter. Two new cases beside
the existing land one:

- true — the actionable set names ONLY a manaOnly id (a non-land stand-in for
  a Signet).
- false — the SAME non-land id offered, `manaOnly` absent (the bridge could
  not classify it: must not regress to "nothing to decide" for every
  non-land).

### jvm/e2e proof on w52's Signet scenario

Two legs, because `w52-s-signet.state` itself proves a DIFFERENT claim than
the one this item needs. That scenario puts the Signet on the OFFERING
seat's battlefield specifically to show the SERVER auto-passes it
(`apps/server/src/play/w52-s-signet.jvm.test.ts`, lane S's, not touched here)
— an intentionally transient window a human never has to act in. End Turn's
highlight is about a seat's OWN priority staying open with nothing left to
decide (`nothingToDecide`'s whole subject), which that scenario does not
exercise at all.

- **Leg 1 — the wire fact is real, re-confirmed on this tree's jar.** Re-ran
  the EXISTING `apps/server/src/play/w52-s-signet.jvm.test.ts` unmodified
  (`CARDTABLE_FORGE_JAR`/`RES` set, `--pool=forks --poolOptions.forks.
  singleFork=true`): `Tests  1 passed (1)` — *"seat 1's window with seat 0's
  spell on the stack offers the Signet, and is auto-passed without seat 1
  acting"*, 6.2s. This is the direct real-Forge proof that
  `setWeaklySelectable.manaOnly` really does equal the whole offered set for a
  Signet + Islands battlefield — exactly the shape `nothingToDecide`'s new
  branch consumes.
- **Leg 2 — the UI claim itself, end-to-end.** New scenario
  `apps/server/src/play/scenarios/w53-t-signet-only.state`: w52's own
  battlefield (Azorius Signet + two Islands) on the VIEWER's side, at an
  ordinary postcombat main with an empty hand — `nothing-left.state`'s own
  proven shape (e2e/w35.spec.ts R5), swapped from a no-ability creature to a
  mana rock, so what is new here is specifically the `manaOnly` fold, not the
  land case w35 already covered. `e2e/w53-type-pill.spec.ts`'s T3: `End
  Turn` is enabled AND carries `data-highlight`. Included in the SAME 3
  consecutive runs recorded above (all three tests in the file ran together
  each time) — T3 alone: 8.7s, 10.5s, 8.9s, 3/3 green.

### Mutation (item 4, the highlight half)

Drop the `weaklySelectableManaOnly` branch in `nothingToDecide` (back to the
pre-w53 two-line loop): `match.test.ts` — **1 failed / 127 passed** (of 128).
The ONE failure is exactly the new case
(`"true when the actionable set names ONLY a manaOnly source (a Signet, not a
land)"` — `expected false to be true`); the "manaOnly absent" negative-control
case and every pre-existing case (including the land-only one from wave 35)
still pass. Restored (no `MUTATION` marker left in the diff); re-run: **377
passed (377)** across all three suites.

## `pnpm run check`

**Exit 0**, jar env UNSET (`CARDTABLE_FORGE_JAR`/`RES`/`PLAY_WORK_DIR` all
unset before the run): `tsc --noEmit --strict` → eslint → `vitest run
--passWithNoTests`. `Test Files  109 passed | 43 skipped (152)` / `Tests
4449 passed | 113 skipped (4562)` — the 43 skipped files are the jar-gated
`*.jvm.test.ts` suites (skip by design with no jar configured; confirmed by
the file count, not by reading every skip line), nothing of this lane's own
failed or skipped.

## Decisions made (brief was silent or the gate forced a call)

- **Removed, not duplicated, wave 35's corner "changed" mark.** The operator
  asked again, in Playtest 9, for the SAME fact as "a pill over the type bar"
  — explicitly not the corner glyph that already shipped. One signal for one
  fact: `StateMarks` no longer draws `changed` at all.
- **Added the five basic land type lines to `POOL_PRINTED_TYPE_LINE`.**
  Without it, Urborg's textbook target (an actual Plains) could never trigger
  the pill in real play — `pool.json` carries no basic lands at all. A basic
  land's type line never varies by printing, so this is not the same kind of
  cube-specific guess the rest of that index is; scoped to exactly the five
  classic basics.
- **The pill's position is a fixed proportion of the card's own box
  (`top: 22%`), not a live measurement of `CardTile`'s own `.card__type`.**
  That element is covered by art at board scale (`styles.css`'s `.card__art`
  sits above it, `z-index: 1`), so there is nothing to measure on screen in
  the common case; matching an invisible element's exact pixel position
  would be effort spent on a DOM node nobody sees.
- **Item 3's e2e proof is a NEW scenario (`w53-t-signet-only.state`), not
  `w52-s-signet.state` itself.** The latter is built to prove the server's
  auto-pass of an OPPONENT's priority (a transient window) and never gives a
  human seat a live decision to highlight; End Turn's highlight is about a
  seat's OWN, stable priority. Re-running `w52-s-signet.jvm.test.ts`
  unmodified supplies the "on w52's Signet scenario" leg the brief names
  directly; the new scenario supplies the actual UI claim.
- **No new `apps/ui/src/play/live/*.jvm.test.ts` file.** A jvm-harness-level
  test driving `match.ts` directly against a real JVM was considered (same
  family as `board-play.jvm.test.ts`), but it needs a `MatchSpec`/mulligan
  driver this lane does not already have a reference for, is not in this
  lane's exact file list, and the unit test plus the two e2e legs above prove
  the same claim with less new surface. Flagged here in case the manager
  wants it built properly in a follow-up wave.

## Not verified

- The manager's gate message said the merge (`aa56402`) carried a pinned
  band test into `Board.test.ts`; confirmed that test is untouched by this
  lane's edits (re-read after the merge, before editing further), but it was
  not re-run here — lane T's own suites (`Board.test.ts`, `adapter.test.ts`,
  `match.test.ts`) were, and `pnpm run check` below covers the rest.
