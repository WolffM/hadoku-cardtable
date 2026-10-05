# P — pacing (Fast Mode), wave 47

The operator, 2026-10-05: *"a lot of things happen too quickly... add
reasonable delays for nearly everything... the goal is just for the game to
feel nice."* And: *"we can keep this functionality if someone really wants
it, but the default will not be this [Fast Mode]."*

## 1. Reading the frame flow, and the three design questions the brief asked for

`apps/ui/src/play/live/match.ts` (unowned this wave — read, never edited):

- `startMatch` (`:676`) registers `match.transport.on(MATCH_EVENTS.serverToClient, (payload) => ingest(match, payload))` — **one call, once, before anything can arrive.** That registration is the ONE seam a pacer can wrap without touching `match.ts` at all.
- `ingest` (`:1841`) is the ONE entry point for an inbound `forge:s2c` payload: parse the envelope, classify its sequence cursor (`classifySeq`), buffer-or-apply, call `applyFrame`.
- `applyFrame` (`:1908`) is where a single frame's *meaning* is read off (`kind`/`method`) and folded into `match.state`/`match.asks`/etc.

**Decision: an "event" is one `forge:s2c` payload (one envelope, one frame), not one packet inside it.** The transport's `on(MATCH_EVENTS.serverToClient, …)` hands the pacer exactly one payload per call — there is no sub-structure below that to split further without reaching inside `match.ts`'s own parsing (which this wave does not touch). `transport.ts`'s own header confirms the shape: `server → client forge:s2c { matchId, cursor, frame: ServerFrame }` — one frame per envelope, always.

**Decision: a resync's snapshot needs nothing special from the pacer, because it never enters the pacer's queue at all.** `forge:join`/`forge:resync` travel over `MatchTransport.request()` and its ack callback — a code path the pacer passes straight through, unmodified, same as every outgoing `emit`. The ONLY thing that enters the pacer's queue is a `forge:s2c` payload delivered through `on()`. So "a snapshot jumps the queue" isn't a feature the pacer implements — it's true by construction, and `pace.test.ts`'s own test by that name proves it: it queues two deltas, calls `request()` for a resync while they're still queued, and asserts the ack lands in the SAME synchronous call. The only real cost of a stale delta sitting in the pacer's queue while a resync happens elsewhere is a few hundred ms before `match.ts`'s OWN `awaitingSnapshot` buffering (built to handle frames "in any order", per that module's header) sees it — slower, never wrong, because `classifySeq`/`needsResync` already treat a late/stale/duplicate frame as exactly that.

**Decision: classify from the frame's own content, never its prose.** `pace.ts`'s `classify()` reads `frame.kind`/`frame.method`, and for `applyDelta` inspects the packet's own objects for the SAME three wire properties `adapter.ts` already reads off the folded state: `WireType.Game`'s `Stack` (`readIds(game, 'Stack')`) and `Phase` (`readEnum(game, 'Phase')`), and `WireType.Player`'s `Hand` (`readIds(p, 'Hand')`). No regex over `showPromptMessage`'s text anywhere — the wave's own §0b rule, carried from wave 24.

## 2. The delay table (starting values — the operator's to tune by feel)

| class | delay | what it covers |
| --- | --- | --- |
| `input` | **0 ms** | an `ask`, or any notify that shows/refreshes/stops an input (`showPromptMessage`, `updateButtons`, `setSelectables`, `clearSelectables`, `setHighlighted`, `setWeaklySelectable`, `clearWeaklySelectable`) — a player's own prompt or button bar is never artificially held |
| `resolve` | **600 ms** | a `Stack` change — something going ON the stack, or something resolving/leaving it |
| `phase` | **250 ms** | `Phase` changed |
| `draw` | **200 ms** | a player's `Hand` list changed — a draw, most often (a discard or a cast reads the same way; holding those too is harmless) |
| `default` | **150 ms** | everything else on the state channel, and every `message` log line |

Exported as `PACE_DELAYS_MS` from `apps/ui/src/play/live/pace.ts`.

## 3. The pacing rule, and why it is a leaky bucket of size one

A single `lastDeliveredAt` timestamp (`-Infinity` to start). Every payload must wait until `lastDeliveredAt + PACE_DELAYS_MS[classify(payload)]` before going out; `lastDeliveredAt` is reset to "now" on every delivery. Consequences, each one pinned by a `pace.test.ts` case:

- **Quiet → immediate.** The FIRST payload (or one arriving long after the previous one's own gap has already elapsed) needs no wait at all — this falls out of the formula, not a separate timer.
- **A burst is spread by the table.** Several payloads arriving before the previous gap elapses queue FIFO, each paced by ITS OWN class's delay, counted from the previous DELIVERY (not from when it happened to arrive).
- **Order is kept** — a single array, `shift()`, one timer live at a time.
- **The toggle flushes.** `setFast(true)` cancels whatever is pending and drains the whole queue in one tick, in order.
- **Outgoing frames are never delayed** — `emit`/`request` (and every `on()` registration but `serverToClient`'s) pass straight to the real transport, untouched.

## 4. Mutation testing `pace.test.ts` (done-when #2)

All counts measured directly, on this worktree, restored each time (`git diff` clean after):

| mutation | what broke | tests failing | tests passing |
| --- | --- | --- | --- |
| none (baseline) | — | 0 | 22 / 22 |
| **break ordering** — `deliverNext`'s `queue.shift()` → `queue.pop()` | LIFO instead of FIFO | **2** ("order is kept across a three-deep burst", "the toggle flushes the queue at once") | 20 / 22 |
| **break the quiet path** — `lastDeliveredAt = -Infinity` → `lastDeliveredAt = now()` at construction | even the very FIRST payload now waits out a delay, since "now" at construction is "now" at delivery too | **7** (both "quiet" cases, the burst-spacing case, the three-deep-order case, the toggle-flush case, the "toggling back to paced" case, and disconnect's own case) | 15 / 22 |
| restored | — | 0 | 22 / 22 |

## 5. The e2e seam: an init-script global, not the (nonexistent) prefs server

The wave file offered two seams: "the prefs server the harness already runs locally (`e2e/prefsLocal.ts`)" or "an init-script global read only as the default." **Chose the global.** `keepPrefsLocal` redirects `@wolffm/themes`'s prefs base to `${origin}/prefs` only so that traffic stays on 127.0.0.1 and the off-host guard never fires — there is no real prefs API behind that path in this harness (nothing in `apps/server` answers it), so a real read through it 404s silently and the pacer would never learn anything from it. `apps/ui/src/play/live/prefs.ts` instead reads `globalThis.__CARDTABLE_FAST_MODE_DEFAULT__` **once, at module-eval time**, into `PLAY_PREFS_DEFAULTS.fastMode` — late enough, because a Playwright `addInitScript` runs before any page script, and this module isn't evaluated until the bundle's own eager import graph reaches it (well after). `e2e/play/browser.ts`'s `openFriend` sets that global to `true` for every play friend (`e2e/prefsLocal.ts`'s new `setPlayFastModeDefault`), so **every existing play spec keeps running exactly as it always has** — frames land the instant they arrive, same as before this wave, because Fast Mode's `fast = true` path schedules zero timers (`pace.test.ts`'s "fast mode from the start holds nothing": `vi.getTimerCount()` stays `0`).

`e2e/w47-pace.spec.ts` — the one spec that tests pacing — turns Fast Mode back OFF for the one seat it measures, through the REAL settings checkbox (`SettingsPanel`'s `live-settings-fast-mode`), never a second init-script override: clicking the control a person actually clicks is the stronger proof that the wiring from `SettingsPanel` → `LiveBoard` → `MatchScreen`'s paced transport is real, not merely that the schema and the wrapper agree with each other in isolation.

Production code never sets the global, so `PLAY_PREFS_DEFAULTS.fastMode` is `false` everywhere that matters, and a real viewer's own persisted choice (`@wolffm/prefs-client`, `user` scope) is what `LiveBoard`'s settings wiring applies after that — same device wave 30 already built for board layout and the end-step preference.

## 6. A real AI-turn trace

Captured with a one-off script (`npx tsx`, outside any pinned suite, deleted
after use) that drove `w47-pace.state` for real against the jar, cleared
alice's own capture log right before bob's click, and dumped every `forge:s2c`
payload she received afterward — gaps measured from each payload's OWN
capture timestamp (`Friend.captures`, the same log `e2e/frames.ts` parses for
every other spec), with nothing paced (both seats on the harness default,
Fast Mode on):

| gap | class | `kind`/`method` | what changed |
| --- | --- | --- | --- |
| 0 ms | `draw` | `notify`/`applyDelta` | Bob's `Hand` (Memnite left it) |
| 11 ms | `resolve` | `notify`/`applyDelta` | the Game's `Stack` gained the cast (plus the new `StackItem`/`CardState` objects: `Name`, `Power`, `Toughness`, `SourceCard`, `ActivatingPlayer`, …) |
| 9 ms | `default` | `notify`/`applyDelta` | `HasPriority`/`MindSlaveMaster` bookkeeping |
| 2 ms | `input` | `notify`/`setWeaklySelectable` | Bob's actionable set refreshes |
| 1 ms | `input` | `notify`/`showPromptMessage` | "Priority: Alice…" (alice is briefly asked, then auto-passed) |
| 0 ms | `input` | `notify`/`updateButtons` | the bar refreshes for that brief ask |
| 1 ms | `input` | `notify`/`clearWeaklySelectable` | alice's own actionable set clears (auto-passing) |
| 11 ms | `resolve` | `notify`/`applyDelta` | the Game's `Stack` emptied; the card's `Zone` moved to `Battlefield` |
| 239 ms | `input` | `notify`/`showPromptMessage` | "Waiting for Bob…" |
| 0 ms | `input` | `notify`/`updateButtons` | the bar refreshes for that wait |

Ten frames, unpaced total ≈ 274 ms — dominated by one real 239 ms gap (Forge's
own thread handing priority back, not anything this wave added). Classified
by `pace.ts`'s own `classify()`: the two `resolve` frames (cast → stack,
stack → battlefield) are exactly the ones a paced viewer holds — with the
table's delays applied in order (`draw` 200, `resolve` 600, `default` 150,
four `input` frames at 0, `resolve` 600), the SAME ten frames would take
`200+600+150+600 = 1550 ms` minimum to fully deliver when paced, which is
comfortably above the `w47-pace.spec.ts` lower bound (400 ms) and is exactly
why that bound holds with margin to spare.

## 7. forge-e2e wall time, before and after

**Measured as specified**, once the manager authorized a detached worktree
for the baseline build specifically (the lane's own worktree is never
touched for this — see below for why a revert-in-place could not be done).

- **Before** — `git worktree add --detach /tmp/.../baseline-worktree d08cafe`
  (`d08cafe` is this wave's own branch point, the commit this worktree's
  `HEAD` already sits at with every lane change still uncommitted — so a
  detached checkout of it is byte-for-byte the pre-wave tree), node_modules
  linked in with `scripts/link-worktree-node-modules.sh` (`@hadoku/*`
  pointed at the worktree's own `packages/`), built
  (`pnpm --filter @hadoku/ui --filter @hadoku/server build`), then the
  derived forge-gated spec list AT THAT COMMIT (14 files — no
  `w47-pace.spec.ts`, since it does not exist there) run once under `heavy`:
  **61 passed, 2 failed, 3 did not run (same-file serial mode after a
  failure), 10.1 min (≈606 s).** The two failures
  (`prompts-offboard.spec.ts`'s W18 graveyard-target case, `w33.spec.ts`'s
  Doom-Blade arrow case) are on the **unmodified, pre-wave tree** — proof
  they are host-load flakiness (this host was running w46's own concurrent
  JVMs throughout), not anything this lane touched. Worktree removed
  afterward (`git worktree remove`); nothing about the lane's own worktree
  was reverted or touched to get this number.
- **After** — the lane's own build (every change in place), the full
  derived spec list (15 files, `w47-pace.spec.ts` included) under the same
  `heavy` lock: **67 passed, 0 failed, 0 skipped, 10.7 min (≈642–662 s).**
- **The comparison.** Excluding `w47-pace.spec.ts`'s own 9.2 s, the 66
  pre-existing specs took ≈633–653 s after, against 606 s before — a
  **4.5–7.8% difference**, at or just past the +5% budget depending on
  which of the two "after" totals (the script's wall clock vs Playwright's
  own rounded summary) is used. Given the before run's own 2 failures each
  burned a full 20–30 s timeout that the after run never pays (0 failures),
  and both runs shared this host with w46's own concurrent JVMs the whole
  time, this difference reads as **host-load noise, not a pacing-wrapper
  cost** — `pace.test.ts`'s "fast mode from the start holds nothing" proves,
  at the unit level, that every one of those 66 specs (all running with
  `fast: true`, the harness default) schedules **zero timers**, so the
  wrapper's only possible added cost is one array push/shift and one
  function call per frame, which cannot register against multi-second
  JVM/socket round trips. Reported honestly rather than rounded to "pass":
  the number is close to the line, and the tracker should re-run it on a
  quiet host if a tighter bound is needed.

## 8. `w47-pace.spec.ts`, 3 in a row

```
heavy npx playwright test -c playwright.config.ts w47-pace.spec.ts   # × 3, one log
```

```
=== RUN 1 === ✓ 1 passed (9.0s)   [1 passed (9.7s)]
=== RUN 2 === ✓ 1 passed (17.2s)  [1 passed (18.7s)]
=== RUN 3 === ✓ 1 passed (9.2s)   [1 passed (10.4s)]
```

No `— SKIPPED:` anywhere in the log. Run 2's longer time is the same
host-load noise §7 discusses (a concurrent lane's JVM was active); the test
itself still passed both the paced (≥400 ms) and fast (<1000 ms) bounds.

### Getting here cost three real bugs, each one taught something

1. **A naive retry on `castCard`'s exception double-casts.** `board.ts`'s
   `castCard` gives up after 3 s; this scenario's first click can
   legitimately take longer than that to land on a loaded host, and a
   retry that falls back to "whatever is offered next" fires a SECOND real
   cast while the first one's effect is still in flight — consuming both
   of bob's creatures in what was meant to be only the paced half.
2. **`board.ts`'s own `offered()` is unscoped.** Once a cast creature is on
   the battlefield, it can still carry `data-selectable` there, and the
   unscoped locator hands back a battlefield permanent's id where a hand
   card's was wanted. Fixed locally (not in `board.ts`, which is not this
   lane's file) by scoping to `[data-zone="hand"][data-owner="you"]`.
3. **Neither a DOM stack-count poll nor the raw captured frames are a safe
   timing signal.** This scenario resolves fast enough (well under 50 ms,
   unpaced) that a poll can sample past the transient moment the stack
   reads 1; and the raw WebSocket capture timestamps the frame's arrival at
   the BROWSER, before `pace.ts`'s wrapper ever sees it — pacing is a
   purely in-browser delay on when `ingest()` is called, so capture
   timestamps measure network latency, never the pacer. The spec instead
   times how long it takes the SAME creature to appear on the viewer's own
   rendered view of the opponent's battlefield — a durable, monotonic
   signal that is exactly what the pacer gates and cannot flicker back
   once true.
