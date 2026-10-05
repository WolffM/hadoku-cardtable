# L — W1, the coin toss and the opening mulligan show on both screens

Operator (playtest 7): *"if opponent is choosing to play/draw something needs to be showing on
the other persons screen as well. i think the coinflip prompt should be shown to both players at
once. and for the one who lost they get the waiting prompt. same for mulligan, if opponent is
chosing to mulligan we need some waiting prompt."*

**Sent back by the manager**, correctly: the first pass of this file concluded "no code changed"
because `isWaitingForOpponent`/`live__waiting` (wave 36 §L, `f6503d4`) already drew a small corner
line for every "not my move" moment, including pregame. The operator played a build that already
had that line and still filed W1 — so the small line was never what they were asking for. **That
conclusion is corrected here**: code did change this round.

## What changed

`apps/ui/src/play/live/LiveBoard.tsx`:

- **New**: `isWaitingForPregameDecision(match)` — true while `isWaitingForOpponent(match)` is true
  AND `view.turn <= 0`. Forge's own turn counter (`view.turn`, `PhaseHandler.turn` on the wire) is
  the signal, not prompt text, because **Forge sends the losing/non-deciding seat no wire text at
  all for this moment**. Checked against the real Forge source in this worktree's pinned checkout:
  `GameAction.determineFirstTurnPlayer` (`forge-game/.../GameAction.java:2384`, the
  `awaitNextInput()` call itself at `:2437`) calls
  `p.getController().awaitNextInput()` on every seat OTHER than the one being asked — but
  `AbstractGuiGame.awaitNextInput()` (`forge-gui/.../AbstractGuiGame.java:534`) is declared `final`
  and is a purely LOCAL desktop-client timer (it delays a Swing label repaint so buttons don't
  flicker); `RemoteClientGuiGame extends NetworkGuiGame extends AbstractGuiGame` cannot override a
  `final` method, there is no `ProtocolMethod` entry for it, and it never reaches our bridge's
  socket. `view.turn` is the only structural fact left: `PhaseHandler.turn` starts at `0` and is
  only ever incremented inside `advanceToNextPhase`'s `turnEnded` branch, which cannot run before
  `PhaseHandler.startFirstTurn` — called only AFTER both seats' mulligans resolve
  (`GameAction.java`'s own ordering: coin toss → `MulliganService.perform()` →
  `GameStage.Play` → `startFirstTurn`). So turn is still its initial `0` throughout the coin toss
  AND both mulligans — already the rail's own convention for "pregame" (`whoseTurnNow`'s
  `turn > 0 ? … : 'Start'`), not a new one invented for this.
- The small `live__waiting` line's render condition is now `waitingForOpponent && !pregameWait` —
  ordinary mid-game waiting (holding priority, etc.) only.
- **New** decision-area pop-up, `pregameWait && (…)`, testids `live-pregame-wait-host` /
  `live-pregame-wait`: the SAME `.live__prompt` wrapper and `.confirm`/`.confirm__message` card
  chrome (`live.css`, unchanged — these classes already existed for `ConfirmPrompt`) the winner's
  own Play/Draw and Keep/Mulligan pop-ups use. No buttons (nothing on this seat's wire to answer
  with). Message text is unchanged from the small line's own words — `Waiting for {name}…` — kept
  to the minimum the operator asked for; no second coin graphic, no invented prose.
- `pregameWait` joins `questionOpen` and `stagedHandCardId`'s blocked set, same as every other
  decision-area mount (the stack's own column compacts for it).

## Proof, real Forge, in the SAME poll window

Screenshots taken mid-run (viewed, not committed — `.png` is gitignored and no `git add -f` was
used): the instant `e2e-alice` (the coin-toss winner) sees

> e2e-alice, you have won the coin toss.
> Would you like to play or draw?
> [Play] [Draw]

in the decision area with the coin decoration, `e2e-bob` (the loser) simultaneously sees, in the
exact same screen position, the same card shape, no coin, no buttons:

> Waiting for e2e-alice…

Both captured from the SAME `expect.poll` window in the spec (the winner's Play/Draw assertion and
the loser's pop-up assertion are adjacent statements with no action between them).

`e2e/waiting.spec.ts` (rewritten this round) now asserts, in the same poll windows:

1. The instant the winner is asked Play/Draw, the loser's `live-pregame-wait` is visible and names
   the winner; the loser's OLD small line (`live-waiting`) is NOT also drawn; the winner has neither.
2. The instant either seat is asked its opening Keep/Mulligan, the OTHER seat's `live-pregame-wait`
   is visible and names the decider; no small line pregame.
3. Roles flip for the second mulligan — same shape.
4. Once both have kept and turn 1 begins, exactly one seat has the ORDINARY small `live-waiting`
   line and NEITHER seat has the pregame pop-up any more — the pop-up is pregame-only, per the
   manager's item 4.

**3 consecutive green runs** against real Forge, through `heavy`, after `pnpm --filter @hadoku/ui
--filter @hadoku/server build` (run times 9.3s, 9.5s, 9.3s). A 4th instrumented run (screenshots,
described above) also passed before the screenshot calls were removed.

```
npx playwright test -c playwright.config.ts waiting.spec.ts --reporter=list
```

## Unit tests, `LiveBoard.test.ts`

New describe block "W1 — the pregame decision-area pop-up (the coin toss, either seat's opening
mulligan)", 4 tests:

- shows the pop-up, named, while `turn === 0` and it is not the viewer's move (covers the coin
  toss and either mulligan identically — the predicate does not distinguish them, see its own note);
- the ordinary small line (not the pop-up) once turn ≥ 1;
- gone once it is the viewer's own move, even at turn 0;
- the stack band stands aside for the pop-up too.

Full `LiveBoard.test.ts` + `match.test.ts`: **275 passed, 0 failed** (271 prior + 4 new).

**Mutation test** (manual, not a permanent file change): commented out the pop-up's mount
(`{false && pregameWait && (…)}`) and reran the W1 describe block — **2 of 4 tests failed**
("shows the pop-up…" and "the stack band stands aside…", both load-bearing positive assertions);
the 2 negative-shape tests ("ordinary small line" and "gone on my own move") correctly stayed
green, since they assert absence either way. Restored the mount; reran the full suite —
**275 passed, 0 failed** again.

`tsc --noEmit` on `apps/ui`: clean. `eslint` on every file this lane touched: clean.
Repo-wide `pnpm run check` (PATH-only shell, no jar env): **exit 0, 102 files / 3394 tests passed,
0 skipped outside the 38 jar-gated files**.

## Found, NOT fixed (outside this lane's files)

Running `e2e/w36.spec.ts`'s own (pre-existing, unmodified) T2 case against the rebuilt dist shows
it now expects `live-waiting` to appear for the loser during the coin toss and both mulligans —
exactly the behaviour this wave's own brief and the manager's send-back say is wrong. It fails at
its first such assertion (`w36.spec.ts:258`); the same test's LATER assertions (the second
mulligan's wait, ~`w36.spec.ts:272`/`279`) would fail the same way once reached. Its FINAL
assertion (turn-1 priority wait, `w36.spec.ts:283`) is unaffected — that is genuinely mid-game and
still uses `live-waiting` correctly.

`e2e/w36.spec.ts` is not in this lane's owned files (`grep -rl live-waiting e2e/` finds only
`w36.spec.ts` and this lane's own `waiting.spec.ts`), so it was not edited. **Needs**: its T2 case's
three pregame assertions (coin toss + both mulligans) swapped from `getByTestId('live-waiting')` to
`getByTestId('live-pregame-wait')`; the final turn-1 assertion is already correct as written.
