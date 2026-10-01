# §L1 — the rail's rows, the same height in and out of combat

**Claim the brief asked to settle**: make the phase rail's rows equal height in and
out of combat, within 0.5px, **by CSS**, not by loosening the test's tolerance —
and do it by bringing the out-of-combat rows DOWN to the compact height, not by
stretching the combat ones.

## What was actually wrong

`.live__phases`'s own height was already a clean calc: `--rail-chrome` (29px: the
turn row, padding, border, gap) plus `--rail-rows` (8 out of combat, 13 in) times
one thirteenth of `35% - --rail-chrome`. That part was correct and unchanged.

The bug was downstream of it: `.live__step` (each row) was `flex: 1 1 0`, i.e. it
never had its OWN height — it only *shared* whatever `.live__steps` had left
after the turn row, split evenly among however many siblings (8 or 13) happened
to exist. Two things make that split imprecise in a real browser:

1. The split only equals the intended `(35% - chrome)/13` figure if the REAL
   rendered chrome (the turn row's actual box, actual padding, actual border,
   actual 4px gap) matches the `--rail-chrome: 29px` guess exactly. Any mismatch
   is divided by `n`, so the SAME absolute mismatch produces a bigger per-row
   error at `n=8` than at `n=13` — the two states drift apart.
2. `flex-grow` distributes leftover WHOLE pixels unevenly across siblings when
   the total doesn't divide evenly (confirmed below: rows inside a single state
   already differed by up to 1px from each other, before comparing states).

This is exactly why the existing e2e assertion (`e2e/w31.spec.ts`, "combat is one
rail step outside combat and six inside... same row height", `insideRow` vs.
`outsideRow`, tolerance `<= 2`) was flaky rather than reliably red or green: the
gap is real but depends on exactly how much the real chrome drifted from the
guess at the moment of the sample.

## The fix (final — see "Follow-up" below for the `dvh` attempt that preceded it)

`.live__step` now gets its own height, computed ONCE and read literally, instead
of inferred by sharing:

```css
.live {
  --live-h: 100dvh;   /* fallback only — see LiveBoard.tsx */
  height: 100dvh;
  ...
}
.live__phases {
  --rail-chrome: 29px;
  --rail-rows: 8;
  --rail-row-h: calc((var(--live-h) * 0.35 - var(--rail-chrome)) / 13);
  height: calc(var(--rail-chrome) + var(--rail-rows) * var(--rail-row-h));
  ...
}
.live__phases[data-combat] {
  --rail-rows: 13;                 /* unchanged — only the row COUNT differs */
}
.live__step {
  flex: none;
  height: var(--rail-row-h);        /* was: flex: 1 1 0 */
  ...
}
```

```ts
// LiveBoard.tsx
useLayoutEffect(() => {
  const el = rootRef.current;
  if (el === null || typeof ResizeObserver === 'undefined') return undefined;
  const sync = () => el.style.setProperty('--live-h', `${el.getBoundingClientRect().height}px`);
  sync();
  const observer = new ResizeObserver(sync);
  observer.observe(el);
  return () => observer.disconnect();
}, []);
```

`--rail-row-h` reads `--live-h`, a LENGTH, not a `%`. A percentage stored in a
custom property is NOT resolved where it's declared — it's resolved against
whichever box the property is later read ON. `.live__phases`'s own `height`
reads `35%` correctly (relative to `.live`, its containing block), but the
moment `.live__step` (a different box, inside `.live__steps`) reads the SAME
variable, a `%` inside it would silently re-resolve against `.live__steps`
instead — which is itself sized by the row count, reintroducing an n-dependent
value as the first attempt (the measurement below shows this went straight to
garbage, 2px and 4px rows, not just "close"). A length has no containing block
to re-resolve against, so the same number reaches every row regardless of
which box reads it.

`--live-h` holds `.live`'s own REAL resolved height in pixels, not the
viewport's. The first version of this fix used `35dvh` in place of `35%`
(`dvh` has the same "no containing block" property a length does, and is what
`.live`'s own bare rule already uses) — correct in the lane's own measurement
harness, where `.live` has no `.shell--match` ancestor and so IS the full
viewport. **It is wrong on the real match route**, where `.live` sits under the
real header and is shorter than the viewport; see "Follow-up" below for the
full finding and numbers. `--live-h` is kept current by a `ResizeObserver` in
`LiveBoard.tsx` (guarded: jsdom, this file's own unit tests, has no
`ResizeObserver`), using `useLayoutEffect` rather than `useEffect` so the
value is correct from the FIRST painted frame, not merely from the second —
see "Follow-up" for why that distinction turned out to matter too.

Net effect: both states now read the identical CSS value for every row's height.
Not "close within a tolerance" — the same computed number, bit for bit — and it
is `.live`'s own height doing the computing, in whatever shape put `.live`
there.

## Measurement

### Method

Three ways, cross-checked:

1. **An isolated static fixture** (`.live` + `.live__phases` + the real DOM shape
   both states produce, live.css linked unmodified) — fastest iteration, confirms
   the mechanism in isolation.
2. **The real app, live.** `apps/ui/src/play/live/harness.tsx` (committed, this
   lane's own file) against `apps/ui/src/play/live/replay-server.ts`'s committed
   fixture replay server (test support, read-only — a real socket.io server on an
   ephemeral loopback port replaying the committed Tier C capture
   `tierc-game1-seq1-27.json`, then a scripted `Phase` delta toggling
   `COMBAT_DECLARE_BLOCKERS` / `MAIN1` so both states can be sampled against the
   SAME running match). Driven by Playwright (`browser_navigate` /
   `browser_evaluate`, `getBoundingClientRect()` on `.live__phases` and every
   `.live__step`), at both required viewports. This is the real React tree, the
   real CSS cascade, real fonts — not a stand-in.
3. **The real e2e spec against real Forge**, unmodified
   (`e2e/w31.spec.ts`, "combat is one rail step outside combat and six inside...
   same row height", P1/P12/w32 Q3), run under the heavy lock after
   `pnpm --filter @hadoku/ui --filter @hadoku/server build` — see run counts
   below. Lane E owns this file; it was run, not edited.

### Numbers — method 2, the real running app

Selector: `.live__step` (every row in the rail, `data-testid="live-phases"`'s
`<ol class="live__steps">` children). `n` is `.live__step`'s count — 8 out of
combat, 13 in combat.

| viewport | out of combat (n=8) | in combat (n=13) | diff |
| --- | --- | --- | --- |
| 1280×800 | 19.296875px (every row, min=max) | 19.296875px (every row, min=max) | **0.000px** |
| 1366×768 | 18.4375px (every row, min=max) | 18.4375px (every row, min=max) | **0.000px** |

Before the fix (same method, same real app, `.live__step { flex: 1 1 0; }`, no
`--rail-row-h`), at 1280×800: out of combat ranged 18.84375–19.84375px across the
8 rows (max 19.84375), in combat ranged 19.015625–20.03125px across the 13 rows
(max 20.03125) — confirming finding 1 above (rows differ from EACH OTHER inside
one state, not just across states) and showing this particular sample's cross-state
gap (~0.19px) was well inside the old 2px tolerance — consistent with the
tracker's finding that the original bug is a 3-of-5 FLAKE (the gap's size depends
on the live chrome/font state at sample time), not a constant, which is exactly
why a from-source fix was wanted over a tighter tolerance.

### Numbers — method 1, isolated fixture (sanity check, independent of any running match)

| viewport | out of combat (8 rows) | in combat (13 rows) |
| --- | --- | --- |
| 1280×800 | 19.296875px × 8 | 19.296875px × 13 |
| 1366×768 | 18.4375px × 8 | 18.4375px × 13 |

Matches method 2 exactly, confirming the equality is structural (the CSS), not an
artifact of one particular match's content.

### e2e — `e2e/w31.spec.ts`'s own "same row height" test, real Forge, unmodified, at its existing 2px tolerance

These five runs were against the FIRST version of the fix (`35dvh`) — see
"Follow-up" below for why that unit was wrong on the real route, and for the
`--live-h` version's own, later e2e counts (10/10, after also fixing a
`useEffect`/`useLayoutEffect` race the follow-up found).

| build | runs | result |
| --- | --- | --- |
| fixed (`35dvh` version) | 5 | **5/5 passed** |
| reverted to the w32 formula (`flex: 1 1 0`, no `--rail-row-h`) | 3 | 3/3 passed |

The revert's 3/3 pass does **not** contradict the tracker's "3 of 5" finding —
the old bug is a flake whose failure rate depends on the live chrome/font state
at sample time (method 2's own before/after numbers show the gap was as small as
~0.19px in one sample and the tracker measured ~2.16px in another), so 3 samples
are not expected to reproduce it reliably. The DOM-level measurement above
(methods 1 and 2) is the stronger evidence for this fix specifically because it
is exact (0.000px, not "passed N more times"): it shows the new code cannot
produce the old drift at all, rather than sampling for its absence. The `.live.css`
declaration tests added to `LiveBoard.test.ts` (`wave 33 §L1`) are the
mutation-provable claim for this same fact — see the lane report for the
revert/restore counts.

## Follow-up — the manager's catch: `dvh` is the viewport, not `.live`

The first version of this fix (above, "method 2" numbers) used `35dvh` in place
of `35%`. That measurement was taken against `apps/ui/src/play/live/harness.tsx`
directly — `<LiveBoard match={m} />` with no `Shell`/`AppChrome` around it — where
`.live` has no `.shell--match` ancestor and so falls back to its own bare rule,
`height: 100dvh`. There, `.live` IS the full viewport and `dvh` and "`.live`'s own
height" are the same number, which is exactly why that measurement could not have
caught this.

**The real match route is different.** `live.css`'s own `.live` comment says so —
*"chrome (100dvh) → header · content → [watchparty's room frame] → .shell--match
(100%) → .live (flex 1) → board (flex 1)"* — `.live` is `height: auto` there,
sized by flex UNDER the real `AppHeader`, which is real chrome with real height,
not a CSS fiction.

### Method (this follow-up)

A second throwaway harness (same pattern as above: a temporary, uncommitted
`.tsx`/`.html` pair in `apps/ui/`, deleted before this lane's work ended),
rendering the REAL component chain — `AppChrome` (real `@wolffm/task-ui-components`
header, real CSS) → `RoomShell`'s own shape (either nothing, or the REAL
`RoomChrome` from `@wolffm/watchparty-ui/room-chrome`, built directly with a
dead `serverOrigin` to stand in for the "identity + room resolved" case, since
this app has no server-side `/session/whoami` for `RoomShell`'s own `useWhoami()`
to resolve against) → `MatchScreen` (real, via its `makeTransport` prop) →
`LiveBoard`, fed by the same committed replay-server fixture as method 2. Driven
by Playwright, same as before.

### `.live`'s real height is shorter than the viewport — confirmed three ways

| viewport | `.live` height (this harness) | table-fit.spec.ts's own "table" measurement (real Forge, real route) |
| --- | --- | --- |
| 1280×800 | **713px** | `table 896x713` (alice) |
| 1366×768 | **681px** | `table 982x681` (bob) |

The viewport minus `.live`'s height is the header: 800−713=87, 768−681=87 — the
SAME gap at both sizes, as expected (`AppHeader` plus its `2rem` top margin is a
fixed-height row, not proportional). `table-fit.spec.ts` (lane E's, run under the
heavy lock, not edited) independently measuring the identical heights, from a
REAL Forge match on the REAL route, is the strongest confirmation this harness's
numbers are not an artifact of the stand-in.

**The room frame does not change this**, in this fixture: `.wp-room-chrome-frame`
is a ROW flex (content | chat aside), so it costs the table WIDTH, not height.
Built with `<RoomChrome>` wrapping `MatchScreen`, `.live` still measured 713px at
1280×800 — same as with no room chrome at all.

### The `dvh` regression — measured, before and after this follow-up's fix

Selector and method as above (`.live__step`, `getBoundingClientRect()`), through
the SAME real-component harness (`.live` = 713px at 1280×800, 681px at 1366×768):

| viewport | rail bottom (`dvh`, buggy) | controls top (`[data-testid="live-buttons"]`) | overlap |
| --- | --- | --- | --- |
| 1280×800 | 586.02px | 562.70px | **23.31px** |
| 1366×768 | 564.91px (computed; see note) | 541.27px | **~23.64px** |

(1366×768's "before" row is the formula's own arithmetic, not a separate browser
measurement — the mechanism is identical at both sizes, `35dvh` always equalling
`0.35 × viewport height` regardless of `.live`, and 1280×800's row IS a direct
measurement, reproduced live.)

After switching `--rail-row-h` to read `--live-h` (`.live`'s own measured height,
see "The fix" above):

| viewport | rail bottom | controls top | clearance |
| --- | --- | --- | --- |
| 1280×800 | 555.56px | 562.70px | **7.14px clear** |
| 1366×768 | 534.45px | 541.27px | **6.81px clear** |

Row heights stayed pixel-identical in and out of combat throughout (e.g.
1280×800: 16.953125px × 8 out of combat, × 13 in combat) — the ORIGINAL claim
this lane item is about is unaffected by which quantity `--rail-row-h` is 35% of;
only the ABSOLUTE size, and so the overlap risk, depended on it.

### The container-query idea (`container-type: size` + `cqh`) — tried, and abandoned

The manager's suggested alternative was tested directly (injected via
`page.evaluate`, no rebuild needed to check): `container-type: size` makes
`cqh` mean "1% of the nearest such container's height" on ANY descendant,
exactly as `dvh` means "1% of the viewport" — which would fix the resolution
bug the same way `dvh` does, but scoped to a container instead of the viewport.

It does not work here. `.shell` (`screens.css`, not this lane's) is
`margin: 0 auto` with no explicit `width`; as a flex item of `.shell--match`'s
parent it does NOT stretch cross-axis because an auto margin on that axis beats
`align-items: stretch` by spec, so `.shell--match`'s width is ordinarily a
shrink-to-fit of its content (measured, with no container query at all, at
**234px** in this fixture's early-game state — a pre-existing characteristic of
the real route, not something this lane introduced, and orthogonal to the
height question since the rail/controls/log are positioned by `right`/`top`
rather than by `.live`'s width). `container-type: size` makes a box's content
invisible to this exact computation — sizing containment is defined as "behaves
as if the element had no content" for anything measuring it from outside AND
for the element's own content-based sizing. Tried at three points in the
ancestor chain, each measured directly:

| `container-type: size` applied to | `.live` width after |
| --- | --- |
| `.live` itself | **0px** |
| `.cardtable-chrome__content` (a safe-looking ancestor: width 1280px, stretched, no auto margins of its own) | **0px** |
| `.cardtable-chrome` (the outermost chrome) | **0px** |

Every placement collapses `.live` to zero width — exactly the "disturb `.live`'s
layout" the brief asked to rule out before using it, confirmed rather than
assumed. The chosen fix (`--live-h`, a `ResizeObserver`-measured length) touches
no `container-type`/`contain` property anywhere, so it carries none of this risk.

### The `useEffect` → `useLayoutEffect` race — found by re-running the real e2e spec

The first cut of `--live-h` used a plain `useEffect`. Against `e2e/w31.spec.ts`'s
own "same row height" test (unmodified, real Forge, rebuilt first), three runs:
**1 passed, 2 failed** — worse than the ORIGINAL bug's own 2px-tolerance failure
rate on this build. Diagnosis: `useEffect` runs AFTER the browser has already
painted. The test's "outside" baseline is read on the very first frame the board
draws — before a passive effect has necessarily run — so it could still be
reading `--live-h`'s `100dvh` FALLBACK (declared on `.live`, see "The fix"), while
the "inside combat" sample is read much later, after the effect has long since
set the real 713px value. That reintroduces exactly the cross-state mismatch this
whole item exists to remove, just from a different cause (a stale fallback on one
side, not a rounding error on both).

Switching to `useLayoutEffect` — synchronous, after the DOM is updated but
BEFORE the browser paints — removes the window entirely: the real value is set
before the first paint the test (or a player) could ever observe. Re-run after
rebuilding:

| build | runs | result | exit code |
| --- | --- | --- | --- |
| `--live-h`, `useEffect` | 3 | 1 passed, 2 failed | 1 |
| `--live-h`, `useLayoutEffect` | 5 (individual) + 5 (`--repeat-each=5`, one invocation) | **10/10 passed** | 0 |
| `e2e/table-fit.spec.ts` (both tests — the full-match sampler and the static/crowded-canvas probe), `useLayoutEffect` build | 2 | **2/2 passed** | 0 |

(Between the two `useLayoutEffect` batches, one ad hoc individual run — outside
the official `--repeat-each=5` invocation reported above, run while this lane's
own measurement tooling was still being refined — showed one failure whose exact
assertion numbers were lost to a concurrent lane's run overwriting the same
shared `e2e/.run/test-results/` directory before they could be read. It is
**not** reproduced in the clean 10/10 above, which is the count this report
stands on; flagged here rather than dropped, per "unverified: say so.")

## For lane E

- Selector for the per-row height: `.live__step` (unchanged selector, inside
  `[data-testid="live-phases"] .live__steps`).
- Expected height: **identical** between the out-of-combat and in-combat
  samples — not "within 1px", exactly equal (both read the same
  `--rail-row-h` custom property, now off `--live-h`, a length). A 1px
  tolerance comfortably holds; the actual achieved difference is 0px, both
  viewports, confirmed again on the final (`--live-h` + `useLayoutEffect`)
  build.
- `e2e/w31.spec.ts`'s existing assertion already reads `Math.max(...)` of each
  state's `.live__step` heights and compares `insideRow` vs `outsideRow` — that
  shape doesn't need to change, only the tolerance (`toBeLessThanOrEqual(2)` →
  `toBeLessThanOrEqual(1)`, per the brief).
- On the FINAL build (`--live-h`, `useLayoutEffect`): `e2e/w31.spec.ts`'s "same
  row height" test is **10/10** (5 individual runs + one `--repeat-each=5`
  invocation) and `e2e/table-fit.spec.ts` (both its tests) is **2/2** — both
  read, not edited, by this lane; see "Follow-up" above for the full counts
  and exit codes.
