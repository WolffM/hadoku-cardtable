# U — `board-play.jvm.test.ts` (unowned): red, stop-and-report

One of the three unowned jar suites the brief names to check (`:498`, which reads `live-button-ok`).
Red, with the jar env (`w38run`, `--fileParallelism=false`,
`CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w38-U/work`):

```
FAIL apps/ui/src/play/live/board-play.jvm.test.ts > playing by clicking the board, against a real Forge
  match > a player plays a land and casts spells — one targeted — by clicking their own board
Error: a seat to reach its own main phase: not done in 120 s
seat 0: turn 0 -, inputLive true, ask none, prompt "Waiting for B...", …
seat 1: turn 0 -, inputLive true, ask none, prompt "B, you have won the coin toss.\n\nWould you like to
  play or draw?", …
```

Seat 1 is parked on the coin toss's own Play/Draw question for the whole 120 s budget; seat 0 never
reaches its main phase because the match never gets past it.

**Not this lane's bug.** `grep -n "live-play-or-draw|PlayOrDrawPrompt|chooseStartingPlayer" board-play.jvm.test.ts
game-driver.ts` is empty in both files — this suite's own click driver (`step()`, `:424-538`) only ever
answers a blocking `ask` (via `answerOpenPrompt`, itself unowned) or presses `live-button-ok` when
Forge has enabled it. The coin toss is neither: it is not an `ask` (no `callId`), and
`live-button-ok` stays deliberately disabled while `isPlayOrDrawPrompt`/`playOrDraw` is true — true
since wave 35 R2 moved the coin toss off the bar, unchanged by this lane (`LiveBoard.tsx`'s
`disabled={… || playOrDraw || confirmPrompt}` reads the same today as before this lane's edits; only
the OK label text changed, not this condition). Nothing in `apps/server/src/play/auto.ts` or `match.ts`
auto-answers the coin toss either (`grep -n "'Play'|'Draw'|chooseStartingPlayer"` in both: empty).

So this driver has no path at all to click `live-play-or-draw-play`/`live-play-or-draw-draw`, and
never did — the gap predates wave 38 (R2 is wave 35) and this lane's three files
(`ConfirmPrompt.tsx`/`DialogPrompts.tsx`/the two touched `match.ts` comments) do not touch the coin
toss's detection (`isPlayOrDrawPrompt`, unchanged logic, only relocated into the merged file) or its
disabled condition. Confirms the same pattern as `prompts.jvm.test.ts`'s two reds
(`U-prompts-jvm-red.md`): a jar suite silently broken before this wave, invisible because — per the
retro this wave answers — none of the 32 jar suites run in CI.

**Not fixed here.** A fix means teaching `board-play.jvm.test.ts`'s own `step()` (or `game-driver.ts`,
also unowned) to click the coin toss, which is outside this lane's files
(`docs/planning/wave38-2026-10-03.md`'s §U row). Per this lane's own brief: "A red in one of those
[the three unowned jar suites] is a stop-and-report, not an edit." Reported here.
