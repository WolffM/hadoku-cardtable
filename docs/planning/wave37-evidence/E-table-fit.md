# E-table-fit — the second, separate `table-fit.spec.ts` red (w37 §E.2)

**The operator's own framing for this item** (wave file, §E.2): *"The table-fit
red is a second, separate flake."* `table-fit.spec.ts:728` failed on `fba269b`'s
run with `alice: the ghost and the indicator were drawn`, at host load 12.8. It
uses no scenario — confirmed: nothing in the failing test's path calls
`startScenarioMatch` or touches `e2e/play/scenario.ts`.

## The evidence read

`gh run download 37158514682 -R WolffM/hadoku-cardtable -n forge-e2e-evidence-1 -D /tmp/claude-1000/w37-E/artifact`.

`test-results/table-fit-a-live-match-fit-022ec--a-prompt-inside-the-window/error-context.md`:

```
Error: alice: the ghost and the indicator were drawn
expect(received).toBe(expected) // Object.is equality
Expected: 2
Received: 0
> 1048 | expect(trace.midway.ghost + trace.midway.indicator, `${f.name}: the ghost and the indicator were drawn`).toBe(2);
```

(Playwright's own "Location: table-fit.spec.ts:728:1" in the same file is the
`test(TITLE, async ({ browser }) => {` line — the whole test's own entry point,
which is what the reporter prints for an assertion failure inside a `try`
block that is not itself wrapped in its own named step; the real failing line
is `1048`, given directly in the stack excerpt.)

`table-fit-summary.json` in the same artifact confirms the match itself was
healthy up to this point: coin toss, mulligans, and `playedTo: "turn 15 (wanted
>= 12), largest battlefield seen 8 (wanted >= 8)"` all recorded — the summary
stops exactly at `ptCornerChecked`, one field before `defaultPlacements` is
ever set (`table-fit.spec.ts:1060`), which is only written after the assertion
at line 1048 — consistent with the crash happening exactly there and nowhere
earlier. `server.jsonl` (13 lines, the harness's own server) carries nothing
for this match's id (`m-9d54eb4b10d8`); `table-fit.spec.ts` starts its own
standalone stack (`startPlayStack`, this file's own header: "The same stack
`play.spec.ts` uses"), not one of the shared pool's `play-server-stack-*.jsonl`
logs, so there is no separate per-stack trace to read for it — the
`error-context.md` and `table-fit-summary.json` above are the full evidence
this artifact carries for this failure.

## What line 1048 actually measures, and why "0" is a different failure shape than the two this exact line has hit before

This assertion has a documented history right above it in `table-fit.spec.ts`
(lines 1026–1047), from two earlier, already-fixed bugs:

1. The drag landed inside a `COMBAT_DECLARE_ATTACKERS` window, where
   `install.ts` deliberately claims the press for attack declaration instead
   — fixed by waiting out the declare window first (lines 1005–1015).
2. Once (1) was fixed, the count read 3 (an extra stale, `hidden` indicator
   singleton reused by the Arena-cast gesture) — fixed by excluding
   `[hidden]` in the selector (`e2e/play/w32.ts`'s `DRAG_HOOKS.indicator`).

Both of those produced a **nonzero but wrong** count (1, or 3). This run's
count is **0 + 0 = 0**: neither the ghost nor the indicator was in the DOM at
all at the moment the midway sample was taken. That is not "the wrong
element was counted" (bug 2's shape) or "a different gesture claimed the
press" (bug 1's shape, which would still draw ITS OWN ghost/indicator, just
for the wrong purpose) — it is "nothing had been drawn yet", which points at
*when* the sample is taken relative to *when* the drag's visual state
commits, not at what is drawn or which gesture answers the press.

## The leading hypothesis — not confirmed, not observed live: a race in the drag probe's midway sample

`e2e/play/w32.ts`'s `pointerDrag` (lines 113–138) and `touchDrag` (lines
146–170) — the shared helper `table-fit.spec.ts` imports this call through
(`import { … pointerDrag, touchDrag, … } from './play/w32.ts'`, line 135) —
drive the drag as a sequence of `page.mouse.move()` calls and read the DOM
count **synchronously, in the same tick**, right after dispatching the one
move that lands on the midpoint step:

```ts
// e2e/play/w32.ts:124-134
const steps = 12;
let midway: DragTrace['midway'] = { ghost: 0, indicator: 0, pickedUp: 0 };
for (let i = 1; i <= steps; i++) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  if (i === Math.floor(steps / 2)) {
    midway = {
      ghost: await page.locator(hooks.ghost).count(),
      indicator: await page.locator(hooks.indicator).count(),
      pickedUp: await page.locator(hooks.pickedUp).count(),
    };
  }
}
```

`page.mouse.move()` resolves once Playwright's CDP call to dispatch the
input event returns — it does not wait for the page's own pointer-event
handler to run or for React to commit the resulting state (`data-arrange-ghost`
/ `data-arrange-indicator` only exist in the DOM once that commit has
happened). There is no `await` of any kind between "the move that should arm
the drag visuals" and "count what the DOM shows" — no `expect.poll`, no frame
wait. Under load, that ordering is not guaranteed, and the `.count()` calls
could land in the window before the handler has run and committed — reading
`0` for both, which is consistent with what this run shows. `touchDrag`
(lines 154–164) has the identical shape over CDP touch events.

This is the LEADING hypothesis, not a confirmed cause: nobody watched this
race fire live this wave (unlike §A.1's own mutation proof, there is no
revert-fails/restore-passes count behind it), and the artifact does not carry
enough to rule out the alternative below.

## What the evidence does NOT rule out

`trace.midway.pickedUp` is captured by `pointerDrag` (same object, same
tick) but this test's own assertion at line 1048 only checks
`ghost + indicator` — `pickedUp`'s value at the failing moment was never
asserted or logged, so the artifact does not say whether it was `0` or `1`.
That is the one fact that would tell the hypothesis above apart from a
second, equally consistent one:

**The drag may never have started at all.** `card` is a locator built from
`land.id` (read from `freshSeats`, itself re-read fresh after waiting out a
combat-declare window specifically because the board can keep moving on its
own even with both bots paused — this test's own comment says so,
lines 1016–1020). Between that `freshSeats` read and `pointerDrag`'s own
`boxOf(card)` call, and between `boxOf` and the actual `mouse.down()`
dispatch, there is a further gap in which the board could still re-render —
Forge's own progression is not gated on anything this test controls. If
`mouse.down()` landed on a stale coordinate (the card having moved, or the
phase having advanced into another `install.ts`-claimed window per the
already-documented bug 1 shape, just not caught by the 30 s wait above this
time), the drag would never arm at all: `pickedUp`, `ghost` AND `indicator`
would all read `0` for the WHOLE sequence, not just a transiently-missed
midpoint sample. From the outside — one `ghost + indicator` assertion at one
point in time — this looks identical to the sampling-race hypothesis above.

## What would settle it (w38)

1. In `pointerDrag`/`touchDrag` (`e2e/play/w32.ts`), include `pickedUp` in
   whatever gets asserted or logged at the call site, not just `ghost` and
   `indicator` — the single missing fact above.
2. Sample (or `expect.poll`) immediately after `mouse.down()`/`touchStart`,
   before the first move, and fail with a distinct message there if
   `pickedUp` never reaches `1` — that isolates "never armed" from "armed,
   then the midway sample raced" by construction, rather than inferring it
   after the fact.
3. If `pickedUp` does confirm non-zero at the down event, THEN the fix
   sketched below (a short poll instead of one synchronous `.count()` at the
   midpoint) is the next step. If it does not, the fix is instead in
   whatever let the board move the card out from under a already-"fresh"
   read — a different bug, in a different place.
4. To reproduce under load: run `table-fit.spec.ts` repeatedly
   (`--repeat-each`) while pinning the host with an unrelated CPU load (e.g.
   another `taskset`-pinned Forge match, the same technique §A.1 used), and
   capture a screenshot plus the full `[data-arrange-*]`/`[data-card-id]`
   DOM state at the midpoint on every run, not just a failing one.

Neither of these was run this wave: `e2e/play/w32.ts` is not a file this
lane owns (the wave file's lane table lists `e2e/table-fit.spec.ts` and
`e2e/play/scenario.ts` for §E; `w32.ts` is shared — `e2e/w36.spec.ts` imports
the same `pointerDrag`, `touchDrag` and `DRAG_HOOKS` from it) and is not
listed under any lane this wave. Per the wave file's own rule ("A lane that
believes it needs one stops and reports"), this write-up stops here: **no
edit was made to `e2e/play/w32.ts` or to `table-fit.spec.ts`.**

## What a fix would look like, IF the leading hypothesis is confirmed (not applied this wave)

In `pointerDrag`/`touchDrag`, replace the single synchronous `.count()` read
at the midpoint step with a short poll (`expect.poll` or a tight retry loop,
bounded well under the step's own timing budget) that accepts the midway
reading once it stabilises, instead of trusting whatever the DOM shows in the
same tick as the triggering `mouse.move()`/CDP touch event. That is a change
to a file no lane owns this wave — flagged for the tracker to route (a
w32.ts owner, or folded into the lane that next touches the arrange-drag
probe), parallel to how an `apps/ui/**` cause would route to w38.

## Done-when, for this item

`E-table-fit.md` exists with a cause: a LEADING HYPOTHESIS (a race in
`e2e/play/w32.ts`'s `pointerDrag`/`touchDrag` midway DOM sample, file:line
above), explicitly not confirmed, one alternative the evidence does not rule
out (the drag never arming at all), and the instrumentation that would
settle which one it is, for w38. Not a product bug either way, and not
something this lane's own files (`table-fit.spec.ts`, `scenario.ts`) can
resolve without editing a file this lane does not own. No change was made to
`table-fit.spec.ts` for this item.
