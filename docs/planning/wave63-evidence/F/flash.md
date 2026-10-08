# F — "priority flashing back and forth in untap/upkeep/draw"

The operator: *"i notice priority flashing back and forth in untap/upkeep/draw.
that doesn't happen when passing through turns. it's a bit distracting, can
you unify that behavior."*

## Measured first

The wave file named three candidates for "the drawn priority holder": the
rail's `data-whose`, the control buttons' `disabled` state, and End Turn's
`data-highlight`. A real match (`apps/server/src/play/scenarios/w63-flash.state`,
driven by `e2e/w63-flash.spec.ts`, local jar `702b207eda874df8bae60435284f40836ed8799c.jar`,
alice PACED — see "Fast Mode" below) was watched continuously with a
`MutationObserver` on all three, plus `Board.tsx`'s own `.seat__flag`
("priority"), across a **normal** turn's `UNTAP`/`UPKEEP`/`DRAW` and the
**same** span reached instead by pressing End Turn (Forge's `skipPhaseDelay`
exemption).

**None of the three named candidates ever moved** inside the span, either
way, any run (0 flips, every time). What flashed is `Board.tsx`'s own
`.seat__flag`, fed by `BoardPlayer.hasPriority` (`adapter.ts`, `readBool(p,
'HasPriority')`) — Forge's raw, per-frame wire fact. Before any fix it
ping-ponged 10 times across the normal span and 6 times across the crawled
one, confirmed against a real Forge jar.

Neither `Board.tsx` nor `adapter.ts` is lane F's row (nor on the "owned by
nobody" list — an apparent gap in how the wave file scoped the candidates).
The fix stays inside `LiveBoard.tsx`, the seam between the raw view and
`Board.tsx`'s rendering, and never touches either file.

### Fast Mode matters to the measurement

The e2e harness forces every friend's Fast Mode ON by default — the opposite
of a real player's own default (paced). With it on, every queued frame
flushes at once and React batches several raw flips into one commit, so the
flash is invisible (a first pass with Fast Mode left on measured 0 flips
everywhere, including the real bug). Fast Mode is turned back off for
`alice` through the real settings checkbox before watching.

## The fix

`apps/ui/src/play/live/LiveBoard.tsx`:

- `withGatedPriority(view, viewerOpen, opponentOpen)` — a pure rewrite of
  `view.players[].hasPriority`: drawn = Forge's own raw fact, AND the seat
  genuinely has something open. An auto-passed window draws no flag at all.
  Returns `view` unchanged when nothing needs correcting.
- `viewerOpen` is the existing pop-up signal (`myOwnDecisionOpen`) OR an
  ordinary live bar — the bare "your move, nothing on the stack" stop, real
  and never the thing flashing.
- `opponentOpen` is `isWaitingForOpponent(match) && !viewerOpen` — the
  server's own fact about the opponent being genuinely parked on something,
  with the same guard the "waiting for them" banner already needs (a stale
  fact must never survive the viewer's own window opening — see its own
  note on the mulligan-end race).
- `LiveBoard` hands the gated view to `<Board>` instead of the raw one.
  Every other use of `match.view` (the rail, the logbook, the status line)
  is untouched.

**First design, reviewed and replaced.** The first cut held each side's last
real value with a `useState`/`useEffect` hook rather than gate on it
statelessly. The manager's review caught two bugs that design had: the
viewer's own flag stayed lit, stale, through a whole opponent turn after the
viewer passed; and a stale "waiting for them" fact could light the
opponent's flag at the same time the viewer's own window opened (both lit
at once). The stateless gate has neither failure mode by construction — it
holds no state to go stale.

After the fix, the identical spec against the identical real jar:

```
[w63-flash] priority-flag flips: normal=0 crawl=0
```

## Both flags, and the viewer passing

Two more checks, over the whole match (not only the narrow spans):

- `bothFlagsEverLit` — scans every recorded row; never true. `e2e/w63-flash.spec.ts`
  also drives this directly against the real board unit-side
  (`LiveBoard.test.ts`'s own `never lights both flags at once` test, which
  constructs exactly the stale-fact race: the opponent's flag lit from a real
  `waitingOn` fact, then the viewer's own window opens before that fact
  clears — asserts only the viewer's flag shows).
- the viewer's own flag reads `'false'` the instant they have passed their
  own real window (checked at the moment the measured span begins).

## Does the opponent's flag lag Forge's real window opening?

Measured cross-page (wall clock — the two pages' own `performance.now()` are
not comparable, each resets at its own navigation): the gap between bob's
own control bar going live (a REAL decision for him) and alice's flag
lighting for it, over the whole match, four runs:

```
144, 5020
30, 117, 4857
92, 138, 4852, 4919
2, 202, 4709, 4896
```

Reproducible across every run: most gaps are small (2-200ms, well within
normal socket/render latency), but there is consistently one gap of
roughly 4.7-5.0 seconds. That is not a measurement artifact of the pairing
(fixed to a strict in-order 1:1 match after the first attempt's naive
nearest-search double-matched one alice event to two bob events). It
coincides with bob's SECOND real window of the match — the one reached
through the crawled turn. The likely mechanism: `forge:seats` (which carries
the `waitingOn` fact `isWaitingForOpponent` reads) is never paced by
`pace.ts`, but a crawl still sends a large burst of OTHER frames in the same
stretch, and something downstream of this lane's row (`apps/server/src/play/match.ts`'s
`checkWaitingOn`, or `socket.io`'s own per-socket ordering) can apparently
queue the seats update behind that burst. Not confirmed, and not this lane's
files to chase further — reported as asked, not fixed, since the flag never
MIS-shows (no false positive, no stuck-false): it is just slow to light,
once, after a crawl, well outside the untap/upkeep/draw window this wave
item is about. No assertion was added to gate on this number — it is cross-page
and wall-clock-based, which a busier claw could plausibly stretch further
without the UI being wrong, and it would mis-report a genuine finding as
flakiness.

## Mutation

Reverting `<Board view={visualView} .../>` to `<Board view={match.view}
.../>`:

- `apps/ui/src/play/live/LiveBoard.test.ts`, the new describe block: **4
  FAIL** (the four end-to-end tests reading `Board.tsx`'s real `.seat__flag`
  through a replay match), 4 pass (the pure `withGatedPriority` unit tests,
  untouched by this mutation) — restored, **8 pass**.
- `e2e/w63-flash.spec.ts` against the real jar: **FAILS** —
  `priority-flag flips: normal=4 crawl=4`, `expect(4).toBeLessThanOrEqual(1)`
  — restored, **1 passed**, `priority-flag flips: normal=0 crawl=0`.

## A deliberate deviation from the wave file's literal text

§F's "done when" says `pace.test` should fail when the fix is reverted.
Measured: `pace.ts`'s own classification treats a `HasPriority`-only player
delta exactly like any other player-property change — pacing is not where
this bug lives, and `pace.ts` needed no change at all (`git diff` on it is
empty; its own 22 tests pass unmodified, before and after). The wave file's
assumption about where the fix would land (plausibly `pace.ts`, alongside
the three named rail/bar candidates) did not survive contact with a real
match.
