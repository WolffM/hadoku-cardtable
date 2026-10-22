# Retrospective: the live board collapsed in prod (2026-10-21)

**Operator, 2026-10-22 01:18Z:** *"critical bug in prod. game ui/board scaling seems to be completely
broken."* The screenshot showed each player area squeezed into a strip about 72 px wide at the board's
left edge, with an empty table beside it.

## What broke

The draft pod circle (`33e3f9dc`) styled `.seat` in `apps/ui/src/styles.css`:
`position: absolute; width: 72px; transform: translate(-50%, -20px)`. The match board's player area
is also `<section class="seat">` (`play/Board.tsx`). `board.css` only overrides the properties it
sets, so every live board inherited the pod's box. Every stylesheet in this app is global and
nothing scopes a class name.

The fix (`a3dea3f0`) moved the pod's seats to their own block, `seatbar__seat`. No `.seat` rule
remains outside the board's own sheets.

## Timeline (UTC)

| time | what |
| --- | --- |
| 23:20 | The pod-circle lane's proof run is green. It was dispatched with `specs='draft.spec dr-draft-picks w72-pod'`, so no board spec ran. |
| 23:29 | `776706bc` (carrying `33e3f9dc`) pushed. `check` is green. |
| 23:35, 23:45 | **Deployed. Prod is broken from here.** |
| 23:54 | Forge on `776706bc` finishes **red**: `table-fit.spec.ts:739` and `:2009`, the two board-fit specs, both fail. The red gates nothing, and nobody reads it. |
| 00:25 – 00:39 | Three more deploys (`2e594c09`, `a81a5977`, `da90038a`), all still broken. |
| 00:30 – 00:53 | Forge on `da90038a` is red with 12 failures. A session re-dispatches `w31 "reload with a selection"` twice and traces it to the `.seat` rules. |
| 00:55 | The fix `3dcaf635` is proven, with `table-fit` green. It lands as `a3dea3f0`. |
| 01:09 – 01:17 | CI for `b02970ce`, `a4309840` and `ce7cfd75` is cancelled by newer pushes. The 01:12 "ce534971" redeploy actually re-serves `e08ddeb8`, which predates the fix (a redeploy's sha label is main's head at trigger time). |
| 01:18 | The operator reports the bug. |
| 01:21 | `check` on `ce534971` is green and deployed. `seatbar__seat` is in the shipped CSS, cardtable's `pm_uptime` is 01:21:18Z, and `/health` reports `bundle: ok`. |

**Broken in prod for 1 h 46 min.** The test that catches it went red **19 minutes into** that window.
The fix existed **26 minutes** before it reached prod.

## Why the board e2e didn't stop it

It did catch it. Three things stopped that from mattering.

1. **The red gates nothing.** Since `a7dd8b2`, deploys wait only on `check`, and Forge runs in
   `forge.yml` beside the deploy. A red there is "the lander's work item". For the first 36 minutes, nobody picked it up.
2. **The proof before landing only ran the specs picked for the changed paths.** The lane changed
   `styles.css`, `spectate.css`, `screens.css` and draft components. The spec selection treats these
   as draft paths. A global stylesheet is not a draft path: any change to a shared sheet can move
   any screen.
3. **Layout leaks are invisible to `check`.** Vitest runs in jsdom, which has no layout. Nothing in
   `check` knows which component owns which class.

Behind all three is the class of bug, and nothing mechanical guards it. The session that fixed it wrote down a rule ("grep a block name before styling it"), but a written rule does not stop a lane that never greps.

## Changes

A–C are proposed for the operator's yes. D is a standing rule for every lander.

**A. A CSS ownership test in `check`** (`apps/ui/src/css-ownership.test.ts`). It fails before push,
at no proof cost.
- **Rule A:** each sheet belongs to the modules that import it. A selector *claims* the block of its
  leftmost class. The test fails when sheets of two different owners claim the same block. The
  global sheets (`styles.css`, `chrome.css`) may claim only an allowlist of shared blocks.
- **Rule B:** the test fails when two directories render the same block and it is not on the
  shared allowlist. This rule scans every string literal, not just `className=`. SeatBar builds
  `['seat', …]` as an array, which a `className=` grep misses.
- **How it would have caught `.seat`:** Rule A fails on `styles.css` `.seat` against Board's
  `board.css` `.seat__ident`. Rule B fails on `'seat'` rendered from `components/` and `play/`.
- **Run against today's main**, Rule A flags `zone`, `confirm`, `card`, `seatbar`, `shell`, `pod`
  and `deckpick`. Each must be fixed or allowlisted when the test lands. A prototype is in the
  audit's scratch (`owner.mjs`).

**B. A change to a shared stylesheet runs the board specs.** Changes to `styles.css`, `chrome.css`,
`screens/screens.css`, `components/spectate.css` or `play/*.css` add `table-fit` to the spec
selection, both in the lane's proof run and in the per-push Forge run.

**C. A Forge red on main pages the next lander.** `scripts/land.sh` refuses to land while the last
completed Forge run on main's head is red and nobody has claimed it (`claim.sh claim forge-red`). A
red then blocks the next land instead of sitting unread.

**D. Before trusting a redeploy, confirm prod from the deploy tree.** Read the tree's sha, grep the
shipped bundle for the change, and check `pm_uptime`. Never go by the run's sha label.

## The audit that followed

The operator asked for "other weird hardcoded slop like this". Three read-only audits ran: CSS
collisions, UI logic, and server plus packages. Each finding below was spot-checked against the
code. The text-based clone detector (jscpd) found little (0.36 % in the UI). The waste is semantic:
the same rule restated in different shapes.

### CSS: waiting to break like `.seat` did

1. **`.card-back` margin depends on bundle order.** `play/card.css:1778`
   `.card-back + .card-back { margin-left: … }` and `prompts.css:870` `.prompt__library > .card-back`
   have equal specificity. The prompt's ghost library is right only because prompts.css lands later
   in the bundle.
2. **`.stack { visibility: hidden }` is unscoped** (`board.css:1736`). Any new `stack` block would be
   invisible.
3. **`face` (PlayerMark) is styled only in the board's `card.css`,** yet the draft renders it.
   `styles.css:1069-1084` copies those rules for `.seatbar__face`. Fix: add a `play/marks.css`
   imported by `marks.tsx`.
4. **Three header buttons are each absolutely positioned from a different sheet** (settings, stats,
   decks) at `right: 0`, `40px` and `80px`. Fix: one `.shell__tools` row.
5. **The settings panel is `z-index: 60`, which ties `--z-zoom`.** stats, rooms and screens also use
   raw z-indexes. Fix: add a `--z-modal` tier.
6. **Duplicate rules and dead selectors.** Seven error rules, nine copies of the pressed-button
   fill, and three copies of the round button. Dead: `.zone__head`, `.pods*`, `.tables__seat` /
   `__opponent` / `__invite`, `.lobby__form` and `.rooms__hint`.

### UI logic

1. **A drafted deck's basics come from two algorithms.** `ConstructedScreen.tsx` `draftedDeckOf`
   splits 17 by largest remainder, while the editor's Auto uses `deck/build.ts` `suggestBasics`. The
   same pool gets different lands depending on the screen. There are also three colour→basic maps
   and four `WUBRG` arrays beside `@hadoku/deck`'s `DECK_COLORS`.
2. **A second reduced-motion check survived `b6df60da`.** `LiveBoard.tsx:447` `motionWanted` is
   used with inverted polarity. presence and gestures treat a missing option as "no motion", while
   numbers and placed treat it as "ask the media query".
3. **The API base and fetch helpers are written about seven times.** `type Fetch` ×5, `isRecord` /
   `bodyOf` / `serverMessage` ×2–3. `credentials` is set inconsistently.
4. **The viewer and opponent are looked up inline about 35 times,** with two different notions of
   "viewer" in `match.ts` (`viewerIdOf` against `viewerPlayerIdOf`).
5. **Animation durations are written twice, in TS and in CSS.** This affects numbers, placed, crash
   and `REVEAL_BEAT_MS`. Fix: the existing `--*-ms` pattern, with CSS reading a variable the TS
   constant sets.
6. **Three silhouette SVGs and four fallback behaviours for an avatar.** Fix: one `<Avatar>`.
7. **Board DOM selectors are rebuilt across six files,** including `[data-board-overlay]` ×6. Fix:
   one `board-dom.ts`.

### Server and packages

1. **A room has four seat stores and three ready flags.**
   - The truth is the routes blob (`playersOf`).
   - The lobby's `tables[].seats` is a mirror rewritten on every GET.
   - `podSeats` and the Gauntlet's own `ready[]` are separate again.
   - Fix: make the lobby's `TableRecord` the one store. About −250 lines.
2. **Request bodies are validated by hand instead of with shared Zod schemas.** `rooms.ts` alone
   has about 260 lines of parsers. `drafts.ts` `parseSaveBody` disagrees with the shared
   `SaveDraftDeckBodySchema`, so the UI's pre-check and the server accept different bodies. Limits
   are copied as literals (`64 * 1024`, `maxLength={60}`, `AVATAR_ID_MAX` ×2).
3. **`RoomView`, `RoomSettings` and `isTournament` are declared on both sides.** The two
   `isTournament` copies have drifted: the server's checks `startedAt` and `rounds`, the UI's does
   not.
4. **Match end is detected by the dialog title `'Match ended'`.** The constant is defined
   separately in the server and the UI, whose comment claims "the two packages share no module".
   Fix: an explicit signal in shared.
5. **Forge delta-key encoding is written three times** (forge-wire, `visibility.ts`, UI `wire.ts`).
   `id * 16 + CurrentState` appears inline four more times.
6. **The format engines in carddata are copied.** `generic-format` against `standard` repeats about
   107 lines, and the two history generators repeat about 109.
7. **Env reads are scattered outside `config.ts`.** The data directory is derived from the log
   directory. `lobby.ts:222` documents `CARDTABLE_ROOM_FORMAT`, but the real variable is
   `CARDTABLE_NEW_ROOM_FORMAT`.
8. **Smaller duplicates:** the room-id regex ×6, the JSON log line ×20, `identityFromHeaders(…)` ×9
   and the body-error middleware ×4. Dead exports include `isSeated` and `EXAMPLE_METHODS`.

## Order, if approved

1. **The guard first** (A and B), together with the CSS items it flags, so the next leak cannot
   land.
2. **The two behaviour bugs:** drafted-deck basics, and the reduced-motion defaults. Each gets its
   failing spec first.
3. **Consolidations, one area lane each, each landing net negative:**
   - room seats and ready flags
   - request schemas
   - match-ended signal and wire keys
   - UI http client
   - viewer/opponent lookups and board DOM selectors
   - carddata engines
