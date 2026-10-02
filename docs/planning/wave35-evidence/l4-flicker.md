# R6 — the End Turn flicker: diagnosis and fix

Lane L, wave 35. Playtest item R6: *"a flicker when clicking End Turn."*
Diagnosed before fixing, per the brief.

## What re-renders: the phase rail, not the control bar

### The phase rail

`.live__phases` (`LiveBoard.tsx`'s `PhaseRail`) carries `data-combat`, which
`live.css` uses to switch `--rail-rows` between 8 (out of combat — the six
combat steps collapse to one `Combat` row, wave 31 P1) and 13 (in combat,
every step its own row). The rail's `height` is derived from `--rail-rows`
(wave 33 §L1's `--rail-row-h` arithmetic) and the change is animated:

```css
.live__phases {
  height: calc(var(--rail-chrome) + var(--rail-rows) * var(--rail-row-h));
  transition: height 0.3s ease;
  ...
}
```

That transition exists on purpose (wave 32 Q3: *"sized by its rows and
animated in CSS only"*) and is asserted in `LiveBoard.test.ts`.

**Every turn, crawled or not, passes through the six `combat` steps** — Begin
of Combat through End of Combat — even when nobody attacks. So `inCombat`
flips `false → true → false` once per ordinary turn, which is already one
grow-then-shrink per turn under normal pacing. That alone is not the bug: at
human pacing (seconds between phases) each transition finishes cleanly before
the next one starts, so it reads as a single smooth resize, which is what Q3
asked for.

### The control cluster — checked, and ruled out

`.live__buttons` redraws whenever `match.buttons` changes (`updateButtons`
notify frames). If Forge were sending a flurry of button updates during the
same window, the cluster would be an equally good suspect. It isn't: see
below.

## The trigger: End Turn arms a real crawl

`apps/server/src/play/endturn.jvm.test.ts` (wave 32 Q5, lane S) proves this
against a REAL Forge match, not a guess:

- Pressing the `End Turn` button (Forge's own `InputPassPriority` cancel,
  `PlayBridge.java`'s `setPhaseDelayOff`) arms `skipPhaseDelay` for exactly
  the yield that follows.
- The phases from that click to the end step arrive **under 50ms apart**
  (`gaps` in that test, asserted `< 50` for every gap) — `upToEnd.length` is
  asserted `> 3`, i.e. several phase deltas, not one.
- Every one of those deltas is `applyDelta` carrying a `Phase` change on the
  game object — exactly what `PhaseRail` reads to compute `inCombat`. The
  test's own capture (`phaseChanges`) confirms the traffic in the crawled span
  is `Phase` deltas; it carries no button-bar frames, which is the evidence
  the control cluster is not implicated — Forge only sends `updateButtons` at
  a real decision point, and the whole point of the crawl is that there isn't
  one until the far end.

So an End Turn click is, by Forge's own measured behaviour, the ONE action in
this UI guaranteed to flip `data-combat` several times within a single 300ms
window — not once, as normal pacing does, but several times while the
PREVIOUS transition is still animating.

## Why that reads as a flicker

A CSS transition that is retargeted before it finishes does not play out and
restart cleanly — it animates toward whichever target is current `right now`.
Re-arming a 300ms transition every <50ms for the length of a crawl (a few
hundred ms to just over a second, by `upToEnd.length`) does not look like one
clean resize; it looks like the rail visibly growing and shrinking against
itself for the whole span, because the box is always mid-flight toward a
target that is about to change again. That is the flicker: not a remount
(nothing in `PhaseRail` or its ancestors keys on the phase or the turn — the
element is one persistent node throughout), but the SAME box, animating, at a
rate no animation on this timescale was built to settle at.

## The fix

`LiveBoard.tsx`'s `useCrawlGuard(view.phase)`: records the time of each phase
change, and sets a `crawling` flag (cleared after a `250ms` cooldown) the
moment two changes land less than `80ms` apart — i.e. it takes a SECOND fast
change to call it a crawl; one ordinary phase change never arms it. The flag
is rendered as `data-crawl` on `.live__phases`, and `live.css` turns the
transition off while it is present:

```css
.live__phases[data-crawl] {
  transition: none;
}
```

What does **not** change: `data-combat`, `data-phase`, `data-turn` and the
row list are computed exactly as before, synchronously off `view`, with no
delay — every existing assertion about them (immediate, not eventual) still
holds. Only the ANIMATION is suppressed, and only for the span that would
otherwise judder: a crawl now snaps through its sizes (invisible at crawl
speed, since each one holds for under 50ms), and a real, human-paced entry
into combat still gets the smooth grow Q3 asked for, because a single phase
change 80ms+ after the last one never sets `data-crawl` at all.

## Mutation test

`LiveBoard.test.ts`, describe block `R6 — the End Turn flicker: the rail's
resize transition is suppressed during a crawl`:

- Reverting `useCrawlGuard` to `return false;` (so `data-crawl` is never set):
  **2 of 2 new cases fail** (the "two fast phase changes arm it" case and the
  "a crawl transitions through `data-combat` with no transition" case).
- Reverting the CSS rule alone (deleting `.live__phases[data-crawl] {
  transition: none; }` from `live.css`): **1 of 2 fails** (the CSS-reading
  case; the JS-only case, which only asserts the attribute, still passes).
- Restored: all cases pass, and the full `LiveBoard.test.ts` file is green
  (116/116 after this item's two cases were added).

Unit-tested only: this is jsdom + fake timers, not a real Forge match. The
CRAWL MECHANISM itself (the <50ms gaps) is proven separately, and already, by
`endturn.jvm.test.ts` — this fix does not need to re-prove that a crawl
happens, only that the rail stops animating once `data-crawl` says one is.
