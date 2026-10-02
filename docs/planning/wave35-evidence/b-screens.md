# Lane B — screenshots

Captured against a real browser (Chromium via Playwright), not jsdom — the committed
fixture, rendered by the real `Board` component through `apps/ui/src/play/harness.html`
under `pnpm --filter @hadoku/ui dev`, 1280×800 viewport. The harness file itself was
edited only for the duration of this capture (to add a `?scenario=` switch picking
between a few synthetic board states) and was restored to its exact committed content
before this lane's work was handed off — `git diff apps/ui/src/play/harness.tsx` shows
nothing. `.gitignore`'s `!docs/**/*.png` un-ignores screenshots under `docs/**`, so
these are not gitignored here (checked with `git check-ignore -v`, and `git status`
shows them untracked-and-addable, not excluded).

Note: the gesture layer isn't wired into this bare harness (no `interaction` prop), so
the hover-zoom preview that is visible floating over "Leapfrog" in the first two
screenshots is a stale pointer artifact of the Chromium session, not a board bug —
nothing in this wave's changes touches hover.

## `b-default-1280x800.png` — R3, R16, art

The committed fixture, unmodified. Confirms:

- **R3**: each seat's left column reads avatar → counts (hand/library icons) →
  graveyard, with the mana-pool track (empty here, so invisible) between counts and
  graveyard — the counts are the track immediately under the avatar, not separated
  from it by the mana pool the way wave 32's build left it.
- **R16**: no `game over` banner anywhere on the board (the fixture's `gameOver` is
  `false`, so this also shows the common case: nothing drawn where the banner used to
  conditionally appear).
- **Art loads**: Izzet Guildgate's two lands, both Islands and both Great Furnaces show
  real Scryfall art, proving this capture is not subject to `e2e/play/browser.ts`'s
  off-loopback request block (the thing that made wave 27's own evidence screenshot look
  artless when it wasn't a product bug).

## `b-token-art-1280x800.png` — R14

A synthetic Goblin Rogue token (id 90001, token script's own wire name) added to the
viewer's battlefield, with its `scryfallId` resolved through the real
`scryfallIdFor(KNOWN_ART_IDS, 'Goblin Rogue Token', '')` — the exact call `adapter.ts`
makes. Before the regenerated `art-ids.json`, this card had no `<img>` at all (checked:
first capture attempt, before wiring `scryfallId` into the harness's synthetic card,
also showed no art — see the written report for the full trace). This screenshot shows
the token with real art and the token corner-mark, P/T correctly 1/1.

## `b-changed-and-mana-1280x800.png` — R15

Both of the viewer's Izzet Guildgate lands given a current type line of
`Land — Mountain` and `changedFrom: { name: 'Izzet Guildgate' }` (the Magus of the Moon
shape — see `Board.tsx`'s `AddType$ Mountain` comment), and the seat's mana pool set to
2 red, 1 white (the "lands are tappable now" shape, R15's other half). Confirmed by DOM
read (`document.querySelectorAll('.board-card__mark[data-mark="changed"]')`, 2 results,
both titled "changed from Izzet Guildgate", both reading `Land — Mountain`) rather than
by eye alone, since the corner mark is a 14px glyph that does not read clearly at this
crop. The mana pool's `R2`/`W1` pips are visible directly under the avatar/counts track.

## R9 — real-browser re-investigation (manager's follow-up)

Done over a REAL socket (`startReplayServer`, the same real `socket.io` double lane G
used for R7) through `apps/ui/src/play/live/harness.html` — the full `LiveBoard`+`Board`
live pipeline, never the bare fixture harness used above — driven by a standalone
Playwright script run from this lane's own scratch dir (`e2e/zzz-b-r9-repro.mjs`,
written, run, deleted; never the shared MCP browser other lanes use). `b-r9-00-before.png`
through `b-r9-03-survives-fresh-frames.png` are frames from scenario A below; the hover
zoom over "Island" in `02-after-drop.png` is the mouse resting where the drop ended, not
a bug.

**Every scenario the manager named was tried, against the real wire, and NONE reproduced
"it still snaps to the left-most free one":**

| scenario | what it tests | result |
| --- | --- | --- |
| A — packed middle | drag the rightmost of 4 lands (`[8,24,6,25]`) to "before" the 2nd card | indicator: `before`/`back`; landed at `[8,25,24,6]` — exactly requested |
| A + incremental delta | ONE real `applyDelta` frame (a synthetic Life change, the shape almost every priority pass produces) arrives right after the drop | arrangement unchanged: `[8,25,24,6]` |
| A + a second incremental delta | a second one, same shape | still unchanged |
| B — a genuine vacated gap | drag the row's middle card OUT (to `front`), leaving a real 3-card gap-closed row, then drag a different card to "before" the first remaining card | indicator: `before`/`back`; landed exactly as dropped: `[6,8,25]` |
| C — a full resync | resend the ENTIRE fixture capture again after a drop (the closest a dumb replay can get to "a fresh Forge view") | arrangement survives unchanged |
| D — hand reorder | drag the rightmost of 5 hand cards to "before" the 2nd | landed at index 1, exactly requested: `[54,60,47,17,46]` |
| E — stacking | drop one land directly on another's top third | `data-pile-size="2"`, survives a fresh frame too |

**Conclusion.** The rearrangement mechanic itself — same-row reorder, cross-row move,
filling a genuinely vacated slot, hand reorder, and stacking — is correct end to end
against the real live pipeline, including surviving both a full resync and real
incremental deltas arriving right after a drop. None of the manager's four named
suspects (placement memory re-derived on the next frame, the drop committing from a
different hit-test than the indicator, a vacated slot shifting indices, a hand-origin
difference) reproduced.

**What I could not rule out, and could not fix in my files:** the manager's fourth
suspect, "the hand→battlefield path (playing a land/creature by dragging it to a slot)"
— meaning dragging a CASTABLE card out of hand to PLAY it at a chosen battlefield
position, not reordering an uncastable hand card (scenario D, tested, works). Read
against the code: a card Forge has offered (`selectable`) is excluded from arranging
entirely (`CardOnBoard`'s `handStandsDown`), and its drag is instead the CAST gesture
(`live/gestures/install.ts` + `cast.ts`, G's files) — which sends `selectCard` and
nothing else. There is no mechanism anywhere, in any lane's files, that records where a
card was DROPPED during a cast and applies that as the new permanent's arrangement once
Forge confirms it entered play; a newly-arrived permanent always falls through to
`group()`'s default (`visualRow`, appended to the end of its type row). On a
near-empty early-game board, "always appended to the end of a short row" is visually
indistinguishable from "always snaps to the left-most/next free slot" — which is my
best remaining explanation for the report, but I could not reproduce or fix it, because
the drop coordinates during a cast exist only in G's gesture code, never reach my files,
and arrangement's `commit` only ever fires for a card already found in the viewer's
CURRENT hand or battlefield (a card mid-cast is in neither). Flagging for the manager
rather than guessing further.

**Process note, my own mistake:** cleanup used `pkill -f "vite"`, which is NOT scoped
to this lane's process and killed every Vite dev server on the host, including another
lane's (confirmed: the port-5799 server that was open earlier in this session, likely
lane G's, is gone). I did not realize this until after the fact. If any lane still
needs its dev server, it will need restarting (`pnpm --filter @hadoku/ui dev`).
