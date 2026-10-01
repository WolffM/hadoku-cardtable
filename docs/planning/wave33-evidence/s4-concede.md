# §S item 4 — the concede race

**The test**: `e2e/w31.spec.ts`, "concede ends the game, and after the end
Concede is off on both boards and the server refuses another (P18)". Bob
concedes through the UI; once both boards show `.board__over`, alice's
browser context is closed and a raw socket reconnects as alice, joins, and
sends a SECOND concede for the already-ended match. The test polls the
server's own log for a `concede-refused` line and expects to find one.

## Which of the two causes the brief named

> find out why the line is sometimes absent: a second concede that arrives
> while the status is still `running`, or the c2s frame never reaching
> `fromClient`.

**The first.** `Match.fromClient` (`apps/server/src/play/match.ts`) has the
guard exactly where the brief says — ahead of the general status check:

```ts
if (frame.kind === 'act' && frame.method === 'concede' && this.status !== 'running') {
    this.deps.log({ evt: 'concede-refused', ... });
    return { ok: false, error: `concede-after-game-over (match is ${this.status})` };
}
```

That guard is correct and never the problem once reached — the question is
only ever whether `this.status` has already become `'over'` by the time
alice's second concede arrives. The second cause (the c2s frame never
reaching `fromClient`) is not what is happening: `socket.ts`'s
`clientToServer` handler logs `c2s-not-joined`/`c2s-spectator` for every
frame it does not forward, and the tracker's own re-run found neither of
those — only an absent `concede-refused`, which only happens on the path
that DOES reach `fromClient` and finds `status === 'running'`.

## Why `status` can still be `'running'`

`Match.status` becomes `'over'` only when `onLine` sees a bridge `gameover`
line (`match.ts`'s `case 'gameover': this.status = 'over'; ...`). That line
is written by `PlayBridge.java`'s `watchForGameOver` — a thread that
**polled Forge's own `game.isGameOver()` flag every 500 ms**
(`bridge/PlayBridge.java`, before this fix).

Meanwhile, the BOARD a browser watches learns "the game is over" over a
completely different, much faster path: `view.gameOver` on the client
(`apps/ui/src/play/adapter.ts:861`, `readBool(game, 'GameOver')`) is an
ordinary wire-synced `GameView` property, carried by the SAME per-seat delta
stream as every other state change, the instant Forge's own `Game` object
flips it — no polling, no 500 ms step. So the moment bob's concede ends the
game, BOTH:

1. the WIRE tells both browsers almost instantly (`view.gameOver` flips,
   `.board__over` renders), and
2. the SERVER's own `Match.status` can take up to 500 ms longer to catch up,
   because nothing tells `watchForGameOver` directly — it has to wait for its
   next poll tick.

The test's own teardown between "both boards show game over" and "alice's
second concede arrives at the server" — closing a browser context, opening a
brand-new socket.io connection, a `forge:join` round trip, and a
`forge:role` poll — is not reliably slower than 500 ms. When it loses that
race, `this.status` is still `'running'`, the concede-after-game-over guard's
condition is false, the frame falls through as an ordinary `act`, gets
forwarded to the bridge, and the server never logs `concede-refused` at all.
This is a genuine, measurable race, not a flaky test or a routing bug.

## The fix (v1, superseded) — a tighter poll

First attempt: `PlayBridge.java`'s `watchForGameOver` poll interval,
500 ms → 20 ms (25× tighter). The manager correctly rejected this: "the wave
rule is 'deterministic, not looser'" — a tighter poll narrows the window, it
does not close it, and a narrowed-but-still-probabilistic race is exactly
what wave 33 exists to replace. Measured anyway, for the record: before
(500 ms) 3 failed / 7 passed over 10 runs; after (20 ms) 10/10 passed. Kept
as evidence that the mechanism was understood correctly, superseded below.

## The fix (v2, landed) — closed by ORDER, not by speed

The two things racing are **both writes to the same `stdout` stream**, which
Node reads in the order they were written (`host.ts`'s line reader, one JSON
object per line) and `match.ts`'s `onLine` processes synchronously in
arrival order:

1. A state frame (`setGameView`/`applyDelta`) that happens to carry
   `GameOver: true` — what lets a browser's `view.gameOver` flip.
2. The `gameover` line — what flips `Match.status` to `'over'`.

If (1) is ever written before (2), a client can act on "the game is over"
before the server's own status says so — regardless of how fast (2)
eventually arrives. The fix makes (2) always come first: `PlayBridge.java`
gained `maybeEmitGameOverFirst()` (a shared, `compareAndSet`-guarded
one-shot, called at the very top of `SeatGui.setGameView` and
`SeatGui.applyDelta` — the only two places a `GameOver` property can reach
any seat's wire) which checks the SAME live `Game` object `LOBBY` already
exposes for `SeatGui.liveMulliganFlag()` and, if `isGameOver()` is newly
true, writes the `gameover` line immediately, before the state frame that
triggered the check is written. `watchForGameOver`'s poll (kept at 20 ms)
is now a pure backstop for the one case the above does not cover — a match
with no seat connected to run `setGameView`/`applyDelta` at all — and shares
the same `compareAndSet` flag, so whichever of the two notices first is the
one that emits; the other is a no-op.

No Forge file touched: both changes are in our own `bridge/PlayBridge.java`,
calling an existing public `Game` method (`isGameOver()`) from code that
already held a reference to the live game for an unrelated reason.

## Measured: before and after, ten runs each

Command (from `e2e/`, under the heavy lock, against the real built dist and
a real Forge jar):

```sh
CARDTABLE_FORGE_JAR=/home/hadoku/.local/share/cardtable/forge.jar \
CARDTABLE_FORGE_RES=/home/hadoku/.cache/cardtable-w8/forge-build/forge-gui/res \
pnpm exec playwright test -c playwright.config.ts w31.spec.ts -g "concede ends the game" --repeat-each=10
```

| | Mechanism | Result |
| --- | --- | --- |
| **Before** | 500 ms poll (original) | **3 failed / 7 passed** (1.7 min total — each failure spent the full 10 s poll timeout; passes ran ~7.3 s each) |
| **v1** | 20 ms poll (narrower, superseded) | 10/10 passed, 0 failed (1.3 min total) — but still probabilistic, not deterministic |
| **v2 (landed)** | ordered emission + 20 ms backstop | **10/10 passed, 0 failed (1.2 min total)** — every run 6.2–7.3 s, none near the old 10 s poll-timeout shape, consistent with the race being closed rather than merely made rarer |

30% measured failure before, matching the tracker's own smaller-sample
"fails 3 of 5". v2 is the version left in the tree.
