# D — deck boxes of one size

Operator: *"deck selection: every deck box the same size, whatever text is in it."*

Measured with Playwright (Chromium) against the **built** UI (`vite build`, base
`/cardtable/`) served by the **real** `@hadoku/server`, reached the same way a
person reaches it: the front page's "Create a room" form, landing on a live
`ConstructedScreen` with the real 338-deck library behind `GET
/tables/decks` / `/tables/legal/:format`. No mock, no stub — `document
.querySelectorAll('.deckpick__option')` read with `getBoundingClientRect()`.

Setup, for repeatability:

- `apps/ui`: `npx vite build --outDir <scratch>/dist` (base path unchanged,
  `/cardtable/`).
- `apps/server`: `tsx src/index.ts` with `CARDTABLE_WEB_DIR=<scratch>/dist`,
  `CARDTABLE_INSECURE_NO_EDGE_AUTH=1` (the documented bare-local escape hatch —
  grants the `friend` floor to a header-less caller instead of 404ing the app),
  `CARDTABLE_PLAY_WORK_DIR`/`CARDTABLE_ROOMS_DIR`/`CARDTABLE_LOG_DIR` under a
  lane-scoped scratch dir. No `CARDTABLE_FORGE_JAR` — a match was never
  started, only a room, so Forge is not needed.
- A ~30-line Node proxy in scratch stripped the `/cardtable` prefix the built
  bundle requests (vite's `base`) before forwarding to the server, standing in
  for edge-router's `stripPrefix` the way production does it. Nothing under
  this lane's owned files changed to make this work.

## Era 1 — Standard (EMN), narrow viewport (780×493, one column)

Twelve decks, name lengths from 21 to 33 characters. Every box: **370×190**.

| deck | name length | x | y | width | height |
| --- | --- | --- | --- | --- | --- |
| Collected Bant (Finespoo) | 25 | 45 | 792 | 370 | 190 |
| Selesnya Aggro (Osyp Lebedowicz) | 32 | 45 | 992 | 370 | 190 |
| Simic Ramp (Jacob Hagen) | 24 | 45 | 1192 | 370 | 190 |
| Weenie White (BradPitKeeper) | 28 | 45 | 1392 | 370 | 190 |
| Grixis Control (Aya_) | 21 | 45 | 1592 | 370 | 190 |
| Green Ramp (Joshua Dickerson) | 29 | 45 | 1792 | 370 | 190 |
| Izzet Machinegun (Todd Anderson) | 32 | 45 | 1992 | 370 | 190 |
| Mono Black Aggro (BradPitKeeper) | 32 | 45 | 2192 | 370 | 190 |
| Naya PW (Wakizaka Hironari) | 27 | 45 | 2392 | 370 | 190 |
| Orzhov Control (Edvin Marsson) | 30 | 45 | 2592 | 370 | 190 |
| Golgari Control (Lucas Giuliani) | 32 | 45 | 2792 | 370 | 190 |
| Mardu Control (Fujiwara Takashi) | 32 | 45 | 2992 | 370 | 190 |

## Era 1 — same room, same 12 decks, wide viewport (1800×1200, three columns)

Three columns, four rows. Every box, regardless of column or row: **202×190**.

| deck | name length | x | y | width | height |
| --- | --- | --- | --- | --- | --- |
| Collected Bant (Finespoo) | 25 | 769 | 570 | 202 | 190 |
| Selesnya Aggro (Osyp Lebedowicz) | 32 | 981 | 570 | 202 | 190 |
| Simic Ramp (Jacob Hagen) | 24 | 1193 | 570 | 202 | 190 |
| Weenie White (BradPitKeeper) | 28 | 769 | 770 | 202 | 190 |
| Grixis Control (Aya_) | 21 | 981 | 770 | 202 | 190 |
| Green Ramp (Joshua Dickerson) | 29 | 1193 | 770 | 202 | 190 |
| Izzet Machinegun (Todd Anderson) | 32 | 769 | 970 | 202 | 190 |
| Mono Black Aggro (BradPitKeeper) | 32 | 981 | 970 | 202 | 190 |
| Naya PW (Wakizaka Hironari) | 27 | 1193 | 970 | 202 | 190 |
| Orzhov Control (Edvin Marsson) | 30 | 769 | 1170 | 202 | 190 |
| Golgari Control (Lucas Giuliani) | 32 | 981 | 1170 | 202 | 190 |
| Mardu Control (Fujiwara Takashi) | 33 | 1193 | 1170 | 202 | 190 |

Both runs: **one height for every box**, independent of column count, row
position or name length — `grid-auto-rows: 190px` plus `align-items: stretch`
on `.deckpick`, `height: 100%` on `.deckpick__option`.

## The clamp, under a name long enough to need it

None of the real library's 338 names is long enough to overflow two lines at
these column widths, so the clamp was proven directly: one row's
`.deckpick__name` had its text replaced in the live page with a name 86
characters long (the fixture `constructed.test.ts` also uses,
`LONG_NAME_DECK`) and read back:

| | value |
| --- | --- |
| `clientHeight` (clamped) | 42px |
| `scrollHeight` (unclamped, what 4 lines of this text need) | 76px |
| computed `-webkit-line-clamp` | `2` |
| computed `overflow` | `hidden` |
| computed `text-overflow` | `ellipsis` |
| `.deckpick__option` height, before and after | 190px, unchanged |

The name is clamped to two lines; the box around it does not move.

## Mutation counts (`constructed.test.ts`, 81 tests)

| mutation | result |
| --- | --- |
| baseline | 81 passed |
| drop `grid-auto-rows: 190px;` from `.deckpick` | **1 failed**, 80 passed — fails at the `grid-auto-rows` pin |
| revert `.deckpick`'s `align-items` from `stretch` to `start` | **1 failed**, 80 passed — fails at the `align-items: stretch` pin |
| drop `-webkit-line-clamp: 2;` from `.deckpick__name` | **1 failed**, 80 passed — fails at the clamp pin |
| drop `title={option.label}` from `ConstructedScreen.tsx`'s `.deckpick__name` | **1 failed**, 80 passed — fails at `short?.getAttribute('title')` (`null` vs the deck's name) |
| restore each mutation | 81 passed |

made dead / deleted: `.deckpick`'s `align-items: start` (−1 line, replaced by
`stretch`) and `.deckpick__name`'s unbounded, unclamped, title-less shape —
every declaration in it is new or changed, nothing in the sheet or the screen
was removed outright. `screens.css` diff: +27/−3 lines;
`ConstructedScreen.tsx`: +3/−1 (the `<span>` gained `title` and a line break).
