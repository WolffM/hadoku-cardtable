# G — V4, V5, V2: the drag redesigned around the operator's demo

Operator (playtest 6): *"dragging Evolving Wilds: it played the moment it passed the hand"*
(V4), *"dragging another card: it locked by the hand and drew the targeter arrow"* (V5), and
*"a cast in progress can be undone back to the hand: right-click, or Cancel on its first
choice"* (V2). The operator approved the release rules in a demo
(https://claude.ai/artifact/3Y1E4pvAnWj1NgKbE5Hrx7, *"yep that looks correct"*): nothing reaches
Forge until the release.

## Root cause and the fix

`apps/ui/src/play/live/gestures/install.ts` used to send a hand card's cast the moment the
pointer crossed into the viewer's own battlefield (the "settle"), with two stopgaps layered on
top of it since (`cancelCastNetwork`'s settle branch, `endLandedClickCast`). All three are
deleted. A lifted hand card now sends nothing until the gesture ends; `resolveLift` is the one
place that happens, reading the card's current type line
(`apps/ui/src/play/live/gestures/cast.ts`'s `needsTarget` — Instant, Sorcery, or an Aura
subtype) against where the release landed:

- over the viewer's own hand: floats back, nothing sent (any card);
- no target needed, over the viewer's own battlefield: played, with one placement call at the
  release point;
- no target needed, elsewhere: floats back, nothing sent;
- a target is needed, anywhere outside the hand: cast now, the card parks at the release point,
  and the pre-existing click-targeting arrow (unchanged) draws from it once Forge opens a
  target ask.

Right-click and Escape both call one `cancelLive`: while a cast is parked, Forge's own Cancel is
sent only if a selection or a payment is actually open; before any cast (a bare lift), nothing
is sent — this is the regression `ae1a236` fixed, and it stays fixed. A left click that lands on
nothing Forge's selection names, while a cast is parked, cancels the same way (the demo's own
addition beyond the wave file: *"a click on empty table cancels"*).

`apps/ui/src/play/Board.tsx`: R9's placement is now a single call (`notePlayedTo`, from
`resolveLift`), so the module-global version counter and `useSyncExternalStore` subscription
that existed only to catch a second, settle-then-release call are deleted — the one call always
happens before Forge's reply adds the card to the battlefield, so the ordinary re-render that
follows is already the right moment to apply it.

## Cues (item 7)

Three, all driven from `apps/ui/src/play/live/gestures/cast.ts` and drawn in
`apps/ui/src/play/live/gestures/gestures.css`:

- the viewer's own battlefield zone (`data-drop="ok"|"hint"`) lights up for a no-target card
  only — a targeted card never lands in a row, so the cue never appears for one;
- the viewer's own hand zone (`data-cancel-hint`) lights up whenever ANY lifted card sits over
  it;
- a verdict label on the card itself (`data-cast-verdict`, rendered via CSS `::after`): "let go:
  play it", "let go: back to hand", or "let go: choose a target", matching the demo's own text
  verbatim.

All three were viewed live against a real Forge match (not committed — see below) and matched
the design exactly.

## Unit tests

`apps/ui/src/play/live/gestures/gestures.test.ts`: 79 tests, one `describe` per phase (lifting,
each Settled rule, cancelling, R9's seam, the pre-existing selection/ask carve-outs). Item 9's
three named cases:

- `right-click before any cast sends nothing, whatever button 2 currently means on the control
  bar` — the hand has no literal land in the committed fixture's starting state (ids 54/47/17/
  46/60: Leapfrog, Fearless Halberdier ×2, Ral's Dispersal, Hellkite Whelp), so this uses
  Leapfrog, a no-target creature, which exercises the identical rule;
- `right-click mid-target, while a cast is parked, sends exactly one selectButtonCancel` — Ral's
  Dispersal (Instant, id 17), two right-clicks, one `selectButtonCancel` frame;
- `a click lifts the card with no button held; the next press is the release, at its own point`
  — click-arms Leapfrog, then resolves it at a SECOND, unrelated point.

Mutation test (the End Turn case): reintroduced an unconditional `pressButton(match, 'cancel')`
in `cancelLive`'s bare-lift branch (simulating the old regression). Full file: 1 failed / 78
passed, the failure being exactly `right-click before any cast sends nothing…`. Reverted: 79/79
pass.

`pnpm run check` (typecheck, lint, every non-jar suite, from the worktree root): exit 0,
100 files / 3368 tests passed, 69 skipped (jar-gated, no jar env in that run).

`combat-drag.jvm.test.ts` (real Forge jar, `heavy`): 1/1 passed — an attack and a block declared
by dragging, which also exercises casting creatures onto the battlefield through the new
release-only path to get there.

## Made dead / deleted

`git diff --stat` on this lane's files: 922 insertions(+), 860 deletions(-) across
`install.ts`, `cast.ts`, `types.ts`, `gestures.css`, `gestures.test.ts`, `Board.tsx`,
`Board.test.ts`. Net is positive (new cues, a richer, more granular test suite, and mutation
coverage the old suite did not have), but the specific settle/stopgap machinery the wave named
is gone: the `'settled'` drag stage and its `stagedAt`/`cast` fields, `cancelCastNetwork`,
`endLandedClickCast`, and — in `Board.tsx` — `pendingVersion`, `bumpPendingVersion`,
`subscribePending`, `getPendingVersion`, and the `useSyncExternalStore` import and call site.
The "settle-then-release race" test in `Board.test.ts` (a scenario that can no longer occur) is
deleted with it, and the old R7/R13/R9 `describe` blocks in `gestures.test.ts` (whose names and
comments were themselves wave/ticket-numbered narrative) are replaced by plain behavioural
descriptions.

## Screenshots (viewed, not committed)

Taken at 1280×800 against a real Forge match (a solo bot game, `apps/ui` + `apps/server` built
and run through `e2e/play/harness.ts`'s stack, never the repo's own dist or a committed fixture)
and viewed directly, not committed — kept only in `/tmp/claude-1000/w39-G/`:

- **Battlefield highlight**: Evolving Wilds lifted and moved over the viewer's own battlefield —
  a solid blue outline + tint on the battlefield zone, and "let go: play it" above the card.
  The R9 placement-preview bar (pre-existing, unrelated to this wave) is visible too, confirming
  it still fires alongside the new cue.
- **Hand cancel-hint + verdict label**: the same card moved back over the hand — the hand zone
  carries a warm amber outline + tint, and the label above the card reads "let go: back to
  hand".
- A full round trip was also driven end to end against the real match: release over the hand
  (float-back, `data-cast-lift="returning"`, zero frames sent) and then a second lift released
  over the battlefield, which played Evolving Wilds for real (hand count 7 → 6, the land visible
  on the battlefield) — V4's own case, confirmed live.

The committed fixture's starting hand never carries an Instant/Sorcery/Aura, so the "choose a
target" verdict and the parked-cast cue were not captured live in this session; both are proven
by the unit suite (`gestures.test.ts`'s `'a card that needs a target is cast at the release…'`
and the `verdictFor` unit tests) against the exact same code path.
