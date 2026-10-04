# §A — readers of `visibility.ts`'s per-seat projection (blast radius)

**No `visibility.ts` change was made** (`A-timeline.md`: measurement showed V3 already
holds). So nothing listed below needs a behavioural change; this is the grep the brief
asked for, plus what each reader actually does, plus the two named jar suites run
read-only to confirm nothing regressed.

## `e2e/` grep

```
grep -rln "isolation\|stack.*mid-cast\|opponent.*stack\|thoughtseize" e2e/
```

- `e2e/isolation.test.ts`, `e2e/isolation.ts` — the DRAFT isolation checker (a
  different module, pre-dates the play isolation one; drafting, not play). Not a
  reader of this lane's contract.
- `e2e/play/isolation.ts` — `checkPlayIsolation`, the PLAY isolation oracle. Reads
  ZONES structurally (its own header: *"a card on the stack is public too
  (`CardView.java:630-637`) and sits in no player's zone list, so it also counts as
  seen"*). It does not special-case "mid-cast" at all — it already treats
  `Stack` as public and `Hand`/`Sideboard` as private, which is exactly what
  `visibility.ts` does too. No change needed, no change possible to make here that
  this lane owns (`e2e/**` belongs to wave 39 lane E).
- `e2e/play.spec.ts` — `"isolation per envelope"` (part of the big LIVE_TITLE test)
  runs `checkPlayIsolation` at the end, over everything both browsers received the
  whole game. Same zone-structural rule; no change needed.
  - **Independent corroboration, found while reading this file (`:1271-1277`,
    §B item 5's own comment):** *"What is NOT measured is the stack: with both
    seats passing a window they can do nothing in, an uncontested spell's
    passage through it can be coalesced away before the browsers are told —
    measured over a whole recorded game, alice was sent no GameView `Stack`, no
    card in the `Stack` zone and no `… to Resolve.` prompt at all."* This is the
    CASTER's own window being coalesced away entirely in the uncontested case —
    a different mechanism from this lane's measurement, but it independently
    confirms the same shape of fact: Forge/the bridge does not push intermediate
    stack chatter speculatively. No existing e2e spec currently asserts anything
    about what the OPPONENT sees DURING a cast (only after, via the isolation
    check at the end) — consistent with `A-timeline.md`'s finding that there is
    currently nothing timing-sensitive here for an e2e spec to catch.
- `e2e/draft.spec.ts`, `e2e/w33.spec.ts`, `e2e/w34.spec.ts`, `e2e/w35.spec.ts`,
  `e2e/playwright.config.ts`, `e2e/package.json`, `e2e/tsconfig.json`,
  `e2e/make-fixture.ts`, `e2e/play/frames.ts`, `e2e/play/fixture.ts`,
  `e2e/README.md` — matched only on an unrelated word (draft isolation,
  config boilerplate, or `README.md` prose). Not readers of this contract.

**No e2e diff to hand the w39 manager.** Nothing here needed to change.

## The two jar suites the wave file names explicitly

Both are the CASTER-side Thoughtseize fold (R4: three Forge asks folded to one), not
this contract — read to confirm, run read-only (not edited; `scenario-thoughtseize.
jvm.test.ts` is lane B's file).

- **`apps/server/src/play/scenario-thoughtseize.jvm.test.ts`** — against the real jar,
  via `Match.fromClient` directly. Result: **2/2 passed**, 35.95s
  (`heavy`, `--fileParallelism=false`).
- **`apps/server/src/play/socket-thoughtseize.jvm.test.ts`** — the same scenario over
  the real socket.io path. Result: **1/1 passed**, 5.97s.

Both green, unaffected (expected: no `visibility.ts` change was made).

## A note on host load during this lane's own measurement

One jar run of this lane's own `cast-hidden.jvm.test.ts` timed out at the mulligan step
(`timed out waiting for the caster's main 1`, 112s against a 90s per-step deadline)
while `uptime` showed load average 12–17 (three other JVMs running: wave 39's e2e,
lane C's own jar suite, and the CI actions-runner's `forge-jvm` job, all sharing this
host). An immediate rerun under the same `heavy` lock, moments later, passed in 20s.
Not a product bug — logged here per the project's own "JVM suites need serial runs"
lesson (host contention produces a false timeout before any assertion runs, not a
regression).
