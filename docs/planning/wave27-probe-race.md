# The `play.spec.ts` probe race, diagnosed — there is no probe race

Wave 27 §E. Wave 26's manager reported a race around `e2e/play.spec.ts`'s
`showConfirmDialog` probe and did not diagnose it; the tracker carried it as
*"the `play.spec.ts` probe race is undiagnosed"*.

**It is not a race in the probe.** It is two separate defects in the SPEC, one
of which hid the other so completely that the reported error named a line that
had not failed. Both are fixed in `e2e/play.spec.ts`. The probe itself never
lost a race in 26 measured matches.

Written as docs rather than left in a scratch log because `/tmp` on this host is
tmpfs and every log cited below dies with the next reboot. The commands are all
here; re-run them.

## 0. How every run below was produced

```sh
export PATH="/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
cd <worktree>/e2e
CARDTABLE_FORGE_JAR=/home/hadoku/.cache/cardtable-w8/forge-build/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar \
CARDTABLE_FORGE_RES=/home/hadoku/.cache/cardtable-w8/forge-build/forge-gui/res \
  pnpm exec playwright test -c playwright.config.ts play.spec.ts
```
under `flock -x /tmp/claude-1000/w27/forge.lock`, one run at a time. A "loaded"
run is the same command with 16 `while :; do :; done` shells running beside it on
a 12-core host — wave 26's condition (six lanes plus a manager), and the only
condition in which this fails at all.

Every run was real, not skipped: `grep -c SKIPPED` is 0, and the 26 runs whose
evidence survives carry 26 **distinct** match ids (`m-944e48d43d18`,
`m-98e62c90d8cf`, …) and their own `jvmsReaped` pids.

## 1. The failure rate

| condition | runs | red | the failing line, every time |
| --- | --- | --- | --- |
| idle host | **20** | **0** | — |
| 16 CPU burners | **15** | **10** | `expect(boardAfter).toBe(boardBefore)` |

So: green 20/20 quiet, red 10/15 contended, and **always the same assertion** —
never the probe, never the reply, never a snapshot. Load does not make a rare
interleaving likelier here; it changes how the drag phase above ends (§3).

## 2. Defect one — the probe promise that eats the real error

This is what wave 26 actually saw. The log (`/tmp/claude-1000/w26-mgr-play.txt`,
34.0 s, 1 failed / 1 passed):

```
Error: apiRequestContext.post: Request context disposed.
Call log:
  - → POST http://127.0.0.1:19128/cardtable/api/play/matches/m-b6514f807b7c/probe
    - content-length: 57
    - cookie: cardtable_e2e_session=alice
  1415 |     const probe = (seat: number, message: string) =>
  1416 |       alice!.context.request
> 1417 |         .post(`${origin}${PREFIX}/api/play/matches/${matchId}/probe`, …)
    at probe (…/e2e/play.spec.ts:1417:10)
    at …/e2e/play.spec.ts:1434:24
```

`content-length: 57` identifies it without the stack trace:
`{"seat":0,"message":"e2e probe: alice, across a refresh"}` is 57 bytes and
bob's message is 79. So **alice's probe request was still in flight when the
test ended.**

### Why that error appears instead of the real one

A probe is raised and left floating while the spec presses the button that
answers it. `playwright-core@1.62.1`:

- `coreBundle.js:26202` — `context.once(BrowserContext.Events.Close, () => this._disposeImpl())`.
  A browser-context-bound `APIRequestContext` is disposed when **the context
  closes**, and by nothing else.
- `coreBundle.js:25759-25764` — `_disposeImpl` emits `Events.Dispose`.
- `coreBundle.js:26113-26117` — every in-flight request listens for it and
  `reject(new TargetClosedError('Request context disposed.'))`.

`play.spec.ts`'s `finally` closes alice's context (`await f.context.close()`),
so if the try threw before `await aliceProbe`, that close rejects a promise
nobody is awaiting. Playwright takes the unhandled rejection as the test's error
**and aborts the test there — inside the `finally`**. Everything after the close
is skipped: bob's context, `stack.stop()`, `jvmFates`, the JVM reaper, and
`play-summary.json`. And because the `finally` never returns, the original
exception never propagates, so it is never reported at all.

### Proven on a fixture, both directions

`/tmp/claude-1000/w27/E/fixture/mask.spec.ts` — a server that accepts and never
answers, one floating `context.request.post`, a `throw` in the try, a `finally`
that closes the context and then logs twice.

| mode | reported error | `finally` ran to the end? |
| --- | --- | --- |
| floating (wave 26's shape) | `apiRequestContext.post: Request context disposed.` | **no** — second log never printed |
| one `.catch()` attached | `THE REAL FAILURE — this is the error a reader needs to see` | **yes** |

Logs: `fixture-floating.log`, `fixture-guarded.log`. One `.catch()` is the whole
difference between a diagnosable red and a destroyed one.

### The fix, and what it also recovers

`probe()` now folds a failed request into DATA — `{ status: 0, body: { error } }`
— so it cannot reject, and the existing
`expect(…).toMatchObject({ status: 200, body: { answer: true } })` reports a
probe that never came back as the probe's own failure. Confirmed on the reds:
run 21 onward wrote `play-summary.json` **and reaped its Forge JVM**
(`jvmsReaped: [{"pid":1299182,…}]`) on a failing run, which wave 26's shape
could not do. A red that leaks a `-Xmx1g` JVM and writes no evidence is worse
than a red.

`apps/ui/src/play/live/prompts.jvm.test.ts` drives the same probe and needed no
change — that is where the answer was. `Match.probe`
(`apps/server/src/play/match.ts:656`) returns a promise that only ever
**resolves**, `{ error: 'probe timed out' }` included, so its floating handle
cannot reject. The in-process suite had the safe shape all along; only the HTTP
route's caller did not.

## 3. Defect two — the board equality was comparing the mouse position

With the mask off, all ten reds are one assertion and one diff: `boardBefore`
carries **five extra lines**, a second copy of one battlefield card, which
`boardAfter` does not have.

```
- Seachrome Coast
- Land
- Seachrome Coast enters tapped unless you control two or fewer other lands.
- : Add  or .
- SOM R
```

Four questions, each answered from a run rather than from the source:

1. **Did the card leave the hand?** No. Instrumented (`run29`–`run31`): alice's
   hand is `[40,3,47,37,2,48]` on the page before the reload, on the page after
   it, in the server's fold before, and in the server's fold after — all four
   identical. `serverAgreesWith: "both (the hand is not what differs)"`.
2. **Is the page still settling?** No. A poll that re-read the board every
   100 ms for 10 s (`run27`–`run31`: 91–96 reads, `boardSettleMs` ≈ 10 000) never
   saw the two agree. The difference is permanent, so waiting for it is a
   band-aid on the wrong hypothesis — it was mine, and the data killed it.
3. **Where is the extra copy?** Not in any zone: a dump of every
   `[data-board-card]` after the reload finds exactly one Seachrome Coast, on the
   battlefield. The extra copy carries no `data-board-card` at all.
4. **So what is it?** The inspector. Dumped straight from the page
   (`diag-run34.json`, `diag-run35.json`), `[data-board-overlay]`:

   ```
   before: <div class="inspect" data-inspect="" aria-hidden="true"
            style="left: 169.906px; top: 129.678px; width: 264px;">
            <article class="card"><img class="card__art" …
   after:  (empty)
   ```

   `apps/ui/src/play/inspect/index.ts` (wave 20 §D) clones a hovered card's
   `CardTile` into lane A's `[data-board-overlay]`, which is the **last element
   of `<section class="board" aria-label="Game board">`**
   (`apps/ui/src/play/Board.tsx:1698`). So it is inside the element the spec
   reads with `innerText`, and it is why the five lines land at the very end of
   `boardBefore`, after the last hand card.

**A preview is pointer state, not board state.** The drag phase above leaves the
pointer wherever its last drop put it — over one of the viewer's own permanents
— and `pointerover` opens the preview. A reloaded page has had no pointer event
over it and therefore *cannot* have one. The equality was asserting that the
mouse comes back where it was, which is neither true nor interesting.

Load matters only because it changes the game: the loaded reds cast nothing and
reached turn 9, so the last drop lands somewhere else than on a quiet host.

### The fix

The pointer is moved off the board and the preview is asserted **gone** at both
moments, before each read:

```ts
await alice.page.mouse.move(0, 0);
await expect(alice.page.locator('[data-board-overlay] [data-inspect]')).toHaveCount(0);
```

The board comparison itself is untouched: byte for byte, the whole board,
nothing excluded and no tolerance. An inspector that stopped dismissing now
fails on its own assertion, saying so, instead of turning up as a mystery diff
in the board's text.

## 4. What the probe was cleared of, with numbers

The wave file offered three candidates. All three are ruled out **by
measurement**, not by reading:

| candidate | evidence |
| --- | --- |
| the probe's ask against the game's own asks | `summary.probeWindows` records, at the instant each probe is raised, every ask each browser is still holding. Across **26 runs × 2 probes** it is `[]` for both seats, every time. There was no other ask to race. The spec's own `every ask answered` assertion two lines earlier is why |
| the reply against a snapshot | bob's probe answered `true` — **against Forge's default of No, so only the click can have produced it** — in **26 of 26** runs, including all ten reds. Alice's answered `true` in **15 of 15** runs that reached her click; the ten reds never reached it, and that is §3's assertion failing, not a reply going missing |
| the probe against `unambiguousPayment: 'forgeAuto'` | the shortcut answers a *payment*; a payment and a probe are different calls on different threads and the probe carries no cost. `probeWindows` shows nothing else open on either seat at either probe. No run recorded an `auto-paid` interleaved with a probe |

## 5. Two things about the probe that are true and worth writing down

Both read from source, and **neither was observed to misbehave** — recorded so
the next reader does not have to re-derive them.

- **The probe runs on its own thread and the seat's does not serialise with it.**
  `PlayBridge.probe` (`apps/server/src/play/bridge/PlayBridge.java:1667-1690`)
  starts a daemon thread `bridge-probe` and calls the SERVER-side
  `RemoteClientGuiGame.showConfirmDialog` from it. That method is the bare
  `sendAndWait` — no trackable-graph walk — and Forge documents exactly that
  distinction: *"`sync*` requires the game thread because the trackable graph is
  single-mutator; the bare variants skip the walk and are safe from any thread"*
  (`RemoteClientGuiGame.java:53-55`). So Forge itself sanctions the probe's
  shape. The ask still reaches the browser down the seat's single client thread
  (`SeatGui.ui`), which is why a seat's stream pauses behind an open ask.
- **`GuiGameEvent`'s id is a non-atomic static counter.** `private static int
  staticId = 0; … this.id = staticId++;`
  (`forge-gui/src/main/java/forge/gamemodes/net/event/GuiGameEvent.java:7-14`),
  and `RemoteClient.sendAndWait` keys its `ReplyPool` on that id
  (`RemoteClient.java:129-152`). Two threads constructing an event at the same
  moment can mint the same id; if both are `sendAndWait` **to the same client**,
  one reply can be delivered to the wrong waiter. The probe is the only second
  concurrent `sendAndWait` caller this product has. This is a latent hazard in
  upstream Forge, it is the one thing here that could produce a genuine probe
  race, and **it has not been seen**: 26/26 probes answered correctly. If a probe
  ever hangs or returns the wrong boolean, start here.

## 6. Can the probe be made deterministic? Yes, and it already is

The lane was told to say so if it could not be. It can: nothing about the probe
was non-deterministic. What was non-deterministic was a spec assertion that
depended on the pointer's resting place, and a helper that destroyed the
evidence whenever anything above it failed. Both are now closed, and the
instruments a future red needs (`probeWindows`, `refreshBoard`, a
`play-summary.json` that is written even on a failing run) are in the spec.

The recipe for reproducing any of this is §0 plus 16 burners. On an idle host it
will not fail, which is exactly why it sat undiagnosed for a wave.

## 7. Mutation-tested, on `e2e/play.spec.ts` itself, under 16 burners

Both fixes were reverted in turn and the spec re-run under the same load. The
restored spec is the `fix40`–`fix45` row.

| spec | runs | red | what it reported |
| --- | --- | --- | --- |
| **restored** (both fixes) | 6 | **0** | — |
| **mutation A** — both `noPreview(…)` calls removed, `.catch` kept | 3 | **2** | `expect(boardAfter).toBe(boardBefore)`, the five preview lines |
| **mutation B** — A, plus the `.catch` removed (wave 26's exact shape) | 3 | **3** | `apiRequestContext.post: Request context disposed.` at the probe |

Mutation B reproduces wave 26's red **and both of its side effects**, checked
rather than assumed:

- **No evidence file.** Each of B's three runs left a `play-summary.json` whose
  `matchId` is `m-fdd726175317` — the *previous* run's match. The `finally` never
  reached the write. Mutation A's reds, by contrast, wrote a summary whose
  `matchId` is their own.
- **A leaked Forge JVM per run.** After B's three runs, three `-Xmx1g` bridge
  JVMs were still alive, standing in `e2e/.run/play-work/stack-{qv0Hqs,bhqGCK,OBtjZQ}/spare-*`,
  their timestamps matching B's three runs one for one. `stack.reap()` is two
  statements past the abort. Killed by hand (SIGTERM is ignored; the harness's
  own `reapJvms` correctly uses SIGKILL).

That is the same signature the wave-26 tracker found on the host at close and
attributed to a cancelled CI run. A cancelled job does leak this way — but so
did every masked red of this spec, and that is now fixed rather than tidied up
after.
