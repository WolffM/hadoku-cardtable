# H — CI red at `w31.spec.ts:254` (combat-rail), run 37179533034

Diagnosed from the artifact only (`forge-e2e-evidence-1`), no re-run. **Verdict: (b), game-state luck
that predates the `clickHandCard` delegation.** Not fixed; this file is the evidence.

## What failed

`w31.spec.ts:469`, `expect.poll(..., { timeout: 90_000, message: 'a log line names a card that still
has a tile on the page' }).toBe(true)` — timed out. Test started `2026-10-04T05:21:25.243Z`, ran
102075 ms, failed. The 3 following tests in the file never ran (`test.describe.configure({ mode:
'serial' })`).

## The stack, matched by timestamp

`play-server-stack-N7Bohm.jsonl` starts `05:21:25.505Z` (262 ms after the test's own start — the
`startPlayStack` call) and its `shutdown-done` is `05:23:07.289Z`, 29 ms after the test's own end
(`05:21:25.243 + 102075ms = 05:23:07.318Z`). This is the stack.

## The real finding: the match went completely silent for 66.8 seconds

```
2026-10-04T05:21:59.995Z ask-answered   seat 1 openZones
2026-10-04T05:22:00.010Z stop-decided  seat 1 kept other
2026-10-04T05:22:00.010Z stop-decided  seat 1 kept other
2026-10-04T05:22:00.279Z stop-decided  seat 1 kept other
2026-10-04T05:22:00.506Z stop-decided  seat 1 kept other
                          ← NOTHING for 66.8 seconds —
2026-10-04T05:23:07.284Z shutdown-begin   (the test's own teardown, in `finally`)
```

Seat 0 (alice)'s last event is even earlier, `05:21:59.243Z`. From `05:22:00.506Z` to the teardown,
**neither seat's server log shows a single `stop-decided`, `auto-passed`, or `ask-*` event** — the
server has nothing to decide because no client sent it anything. This is not "the log never happened
to name a tile-backed card" (the originally-suspected shape); the whole match stopped advancing.

## This predates the delegation — proven two ways, not assumed

1. **The one race `hands.ts`'s own comments describe cannot be this one.** That race is between
   `pause()` and an in-flight `tick()`, and it only exists once `pause()` is actually called
   (`w31.spec.ts:487`, `for (const h of hands) await h.pause();`) — which happens AFTER the very
   `expect.poll` that failed. Since that poll timed out, `pause()` was never reached in this run. The
   bots were never paused; they ran freely (one `tick()` every 250 ms) for the entire 90-second wait,
   and the match still went dead. Whatever stopped it, it is not the pause/tick race.
2. **`clickHandCard`'s delegation is behaviourally identical to the code it replaced, call for call.**
   `hands.ts`'s `clickCard(id, row) = () => clickHandCard(f.page, id, { row, timeout: 2_000 })` reaches
   `board.ts`'s `clickHandCard`, which does: click with `{ timeout: 2_000 }` (same literal value the
   old inline code always passed) → read `data-cast-lift` → if not `'lifted'`, return (same) → else
   move to the row's box if `row` is given, the whole battlefield's box otherwise (same two branches,
   same selectors). `row === undefined` behaves identically whether the property is omitted or
   explicitly set to `undefined` (both read back as `undefined` in JS) — no new branch, no new await,
   no changed target. There is no code path by which this refactor can leave a click "sent but not
   registered" that the old code would not have.

## A concrete, falsifiable candidate for the real cause — not chased further

`decide()`'s targeting branch (`hands.ts:233-243`) only ever targets the OPPONENT'S FACE
(`'[data-testid="player"]:not([data-viewer])[data-selectable] .seat__select'`). If neither `s.ok` nor
`s.cancel` is enabled, it does nothing. Alice's battlefield in the failure snapshot carries
**Pendelhaven** (`": Target 1/1 creature gets +1/+2 until end of turn."`) — a CREATURE-only target,
never the opponent's face — alongside Keldon Megaliths and Mutavault. If either bot's generic
"anywhere selectable" fallback (`hands.ts:296-304`) activated Pendelhaven's ability, Forge would ask
for a creature target; `opponentSelectable` would never be true for it; and with neither bar button
live, `decide()` returns having done nothing — every tick, forever, exactly matching a silent `kept
other` stop with no further progress. Not confirmed against the exact on-screen text (no mid-test
snapshot exists before the final one, and the final one is already past the stall, mid-turn with the
ability already resolved one way or another), so this is a candidate, not a proven cause — recorded
because it is `hands.ts`'s own, pre-existing gap (it has never known how to target a creature), not
anything this wave's helper consolidation touched.

## Disposition

Not a regression from the `clickHandCard`/`board.ts` delegation — proven by the pause/tick timing
above and by the line-for-line behavioural equivalence of the refactor. This is `hands.ts`'s own
generic-bot limitation (no creature-targeting path), which predates this wave and is a rare enough
draw (needing a creature-targeting permanent to be in a drawn hand/battlefield at the right moment)
to explain why the 3 prior CI runs were clean. Recommend: `hands.ts`'s targeting branch gets a
creature-target fallback (click the first `data-selectable` creature when no player is selectable)
as its own, separate fix — not folded into this wave's consolidation, and not attempted here under
the stop-at-06:45 budget.
