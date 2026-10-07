# §P — release, seams, their hand's rows (AB6, AB4, AB5)

The operator, Playtest 12:

- AB6 (AA4, second ask): *"release the card to play it. it immediately appears on the board
  (bad), and the phantom cardback is still attached to the cursor (also bad)."*
- AB4 (AA5, second ask): the cursor drifts at the board/board and board/hand seams.
- AB5: *"when the screen is resized to be very vertical, the cards get smaller so they can fit
  in the hand in a two stack. however, the opponent still sees the cards depicted in a row."*

## What changed

`packages/shared/src/presence.ts`: `PresenceSpotSchema` drops `owner` — a spot is now a fraction
of the WHOLE board (`x`/`y`), with `zone` carried as a hint only, never used to place the point.
`PresenceSchema` gains `handRows: 1 | 2`.

`apps/ui/src/play/live/presence.ts`:

- `spotOf` returns a board-relative fraction plus whichever zone the point fell in (or `null`);
  it no longer scales by that zone's own box.
- `placeSpot` mirrors the WHOLE board top-to-bottom (`y → 1 − y`) and leaves `x` alone — the
  sender's own side, at the bottom of their board, is drawn at the TOP of the receiver's (the
  receiver's opponent's place), and the reverse. No zone's box scales either side any more.
- `pointerup`/`pointercancel` on a held card (`handsOf(canvas).held`) sends a presence message
  at once, outside the throttle (`sendRelease`): `held: false`, and the release point itself as
  `from` — the exact spot, not inferred later. The listener is on `canvas`, so it runs before the
  gesture layer's own release handler (`window`-scoped) has had a chance to move the DOM off
  `held`.
- `handRowsOf` reads this seat's own hand's row count off the DOM (two distinct row tops among
  its `<li>`s is 2, otherwise 1) and it rides on every outgoing message, including the release.
- Receiving: a release message's `from` sets the hand-off's start point directly
  (`backWas`), ahead of the older fallback (the last place the back was actually drawn), which
  still covers a release that never reached this seat explicitly. The arrow is only ever drawn
  while `held` — once let go, `from` is the release spot, never an arrow tail, so the two uses of
  one field never collide. `handRows` sets `data-presence-rows` on `[data-zone="hand"][data-owner="them"]` (2) or clears it (1).

`apps/ui/src/play/live/presence.css`: a new rule, keyed on `[data-presence-rows="2"]`, runs the
identical `--rows` arithmetic `board.css`'s own lane-row CSS already runs, aimed at
`.card-backs` instead — the only way to draw their hidden hand in two rows without editing
`board.css`/`Board.tsx` (neither owned this wave).

`apps/server/src/play/socket.ts`: no code change — the relay already spreads the whole parsed
message (`{ ...parsed.data, seat }`), so `handRows` and the new spot shape pass through for
free.

### A deploy is not a reload

A match in progress spans a deploy: a tab still on the OLD bundle keeps sending the old shape (a
spot's `owner` field, no `handRows` at all) until its own seat reloads it. `PresenceSpotSchema`
now accepts an `owner` key and drops it in a `.transform()` — never carried into the parsed spot,
so no receiver can read it even by accident — and `PresenceSchema`'s `handRows` is
`.default(1)`, so a message with the key entirely absent still parses, as the one row every build
before this one ever drew. A `handRows` that IS present but outside `{1, 2}` is still malformed,
same as any other wrong-shaped field.

`socket.test.ts`'s presence case: the old two malformed-field assertions stay (a smuggled card
id, an out-of-range fraction), `handRows` outside `{1, 2}` is still malformed, and a new case
proves an old-shape message (a spot's `owner` present, no `handRows`) RELAYS — not dropped, not
logged `presence-malformed` — with `handRows` defaulted to 1 and `owner` gone from what bob
receives.

`e2e/presence.spec.ts`: two new specs, `letting go of a held card with no further pointer move
takes the back down on the other screen at once` (AB6) and `a hand that draws in two rows on one
screen draws the same two rows as the OTHER seat's hidden hand` (AB5). AB5 needed a scenario
giving one seat a hand big enough to wrap into two rows, which no existing scenario's scripted
hand is — committed as `apps/server/src/play/scenarios/ai-seven-card-hand.state` (seat 1 dealt
seven Mountains) rather than written at test time, so a crash before cleanup can never leave an
untracked file in the source tree. It adds no entry to `scenarios/README.md`'s own table (not an
owned file this wave; nothing in the server or e2e code enumerates the directory or reads that
table, so the file works without one — flagged for the manager to decide).

## The monotonic crossing numbers (AB4)

Unit test, `apps/ui/src/play/live/presence.test.ts` → `the mirror › a pointer crossing the
centre line and the hand edge places monotonically on a DIFFERENTLY-sized board`: the sender's
board is the usual fixture (overlay 1000×800); the receiver's hand zone (`them`) is a different
size (360×260 at a different position) inside a very differently shaped overlay (400×1400) — the
exact kind of mismatch that drove the old zone-relative math to drift at a seam. A straight line
down the sender's board at `x = 500`, crossing its own centre line (`y = 400`) and its own hand's
top edge (`y = 650`):

| sender y | placed y on the receiver |
| -------- | ------------------------- |
| 100      | 1225.0 |
| 300      | 875.0  |
| 390      | 717.5  |
| 400      | 700.0  |
| 410      | 682.5  |
| 500      | 525.0  |
| 640      | 280.0  |
| 650      | 262.5  |
| 660      | 245.0  |
| 750      | 87.5   |

Strictly decreasing at every step, including across both seams (`y=400`, `y=650`) — no jump, no
reversal, regardless of the receiver's own zone sizes, because the receiver's zone boxes are
never read for this at all.

## Claws proof (real Forge, two real browsers)

`e2e/presence.spec.ts`, pushed to `verify/w55-P` (my files, plus the committed scenario
fixture, on top of HEAD), `forge.yml` dispatch with `specs=presence`; branch deleted after each
run.

First run (runtime-written scenario, owner/handRows rejected outright):
https://github.com/WolffM/hadoku-cardtable/actions/runs/37669848104 (`forge-e2e` job
112958650007) — 3/3 passed, 0 skipped, 1.0m.

Second run, after the three fixes (ticket ids out of comments/titles, the scenario committed as
a fixture, wire compatibility for an old-shape sender):
https://github.com/WolffM/hadoku-cardtable/actions/runs/37671245688 (`forge-e2e` job
112963435861) — **3/3 passed, 0 skipped**, 26.8s:
  - `bob sees alice's pointer, a card back while she holds a card, her arrow while she aims — and
    never which card`
  - `letting go of a held card with no further pointer move takes the back down on the other
    screen at once`
  - `a hand that draws in two rows on one screen draws the same two rows as the OTHER seat's
    hidden hand`

Local probe (same spec, same jar, before each claws run): 3/3 passed both times (23.9s, most
recently).

## Mutation (pins fail when reverted)

Both performed against `apps/ui/src/play/live/presence.test.ts` by temporarily reverting the
one line, confirming the red, then restoring the file verbatim (diffed byte-identical against a
backup afterwards):

- **Drop the release send** (`onPointerRelease` made a no-op): `sending › letting go of a held
  card sends at once…` FAILS — `expected [...] to have a length of 2 but got 1`. 1 of 13 tests in
  the file fails; the other 12 are unaffected.
- **Drop `handRows`** (the `data-presence-rows` set/clear deleted from `draw`): `receiving ›
  their hand rows … set data-presence-rows on the hidden hand; 1 clears it` FAILS — `expected
  null to be '2'`. 1 of 13 tests in the file fails; the other 12 are unaffected.

## Made dead / deleted

- `PresenceOwnerSchema` (`packages/shared/src/presence.ts`) — placing a spot never scales by a
  zone's box any more, so there is nothing left for `owner` to name. The bare key survives on the
  wire ONLY as a pre-deploy sender's own leftover field, accepted and dropped by a `.transform()`
  — it is never a value this schema's own output type carries, and no receiver reads it.
- The per-zone scaling branch in `placeSpot` (the `data-zone="…"][data-owner="…"]` lookup and the
  battlefield-mirror special case) — replaced by the single whole-board mirror.
- The arrow being drawn from a non-null `from` regardless of `held` — now gated on `held`, so a
  release's `from` (the release spot) is never mistaken for an arrow tail.
