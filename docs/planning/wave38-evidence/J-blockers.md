# J — `scenario-blockers` Q12: a flake the test cannot fix, written up for w39

**Status: not fixed. It goes to w39's engine wave.** The block input opens for the defender and then
closes with nobody pressing anything. Neither the test nor the server's own decision log presses it.

## Rate, on HEAD of the wave worktree (`w38`, alone, `--fileParallelism=false`, `w38run`)

| run | log | Q10 | Q12 |
| --- | --- | --- | --- |
| 1 | `/tmp/claude-1000/w38-J/blockers-run1.log` | pass | **fail**: timed out waiting for the block-assignment input |
| 2 | `/tmp/claude-1000/w38-J/blockers-run2.log` | pass | **fail**: same |
| 3 | `/tmp/claude-1000/w38-J/blockers-run3.log` | pass | pass |
| 4 | the full serial run, `/tmp/claude-1000/w38-J/full-run.log` | pass | **fail**: same |

That is 3 of 4 (2 of 3 alone). w37 measured 3/5 and 4/5 (`wave37-evidence/A-repro.md` §7). The brief asked for 10
runs and the host budget allowed 3, plus one in the full run.

## What the wire shows (run 2)

Run 1 printed too little. Before run 2 I widened the failure message (the change below), so a timeout
now prints every prompt, button and offer either seat was sent, plus every `auto-*`/`ask-*` decision
the server logged. Saved: `/tmp/claude-1000/w38-J/evidence/q12-run2-trail.txt`. The part after the
mulligan:

```
s0 showPromptMessage "Priority: A … Declare Attackers Step"   s0 updateButtons OK enable1=false
s1 showPromptMessage "Priority: B … Declare Attackers Step"   s1 updateButtons OK enable1=false
s1 setHighlighted
s1 setWeaklySelectable [90]                         <- Forge offers the scripted creature
s1 updateButtons OK enable1=true
s1 showPromptMessage "Select creatures to block Memnite (85) or select another attacker…"
s0 showPromptMessage "Priority: A … Declare Blockers Step"   <- the block input has already closed
s0 updateButtons OK enable1=true
s1 showPromptMessage "Priority: B … Declare Blockers Step"
server decisions (whole match):
 auto-passed seat 0 Declare Attackers Step
 auto-passed seat 1 Declare Attackers Step
 auto-passed seat 0 Declare Blockers Step
```

- **Forge did offer the blocker**: `setWeaklySelectable [90]` with OK live. The old "zero candidates"
  bug (`wave33-evidence/s3-blockers.md`) is not this.
- **The test pressed nothing for seat 1.** `passDeclareAttackers` presses only seat 0, and only on an
  enabled Declare Attackers priority OK. Seat 0's OK there was sent disabled, because the server had
  already passed it (`attackStopIsTheDeclaration`, `f7ad0b8`). So the test pressed nothing at all
  after the mulligan.
- **The server logged no press for seat 1 after its Declare Attackers pass.** `match.ts` commands
  `selectButtonOk` in exactly two places, `maybeAutoPass` (`:1601`, logs `auto-passed`) and
  `maybeAutoPay` (`:1626`, logs `auto-paid`). Neither logged anything for seat 1 at the block input.
- The block input still closed with no blocker declared, inside one 25 ms poll of the test.

## Lead (not verified)

The only press in flight for seat 1 is the server's own `auto-passed` OK for its **Declare Attackers**
priority window. If Forge had already moved seat 1 past that window by the time the act reached the
bridge, the stale OK lands on the next input. That next input is the block input, and OK there means
"declare no blockers". That would also explain why it is a race (2/3, 3/5, 4/5) and not a constant.

I could not tell from the wire whether that priority window was real, which would make it a server
race, or a transient that the scenario landing produces, which would make it a harness artefact. That
needs the bridge's input queue (`PlayBridge.java`) and `match.ts`'s pass ordering, and both are engine,
untouched this wave.

## Test change made (diagnostics only, no behaviour)

`apps/server/src/play/scenario-blockers.jvm.test.ts`: the Q12 wait rethrows its timeout with
`frameTrail(s)` attached. Nothing is retried, no timeout is raised, and nothing is swallowed. The
error is rethrown with more text.

## CI consequence

It is pinned by full name on `forge-jvm`'s `known_flaky` list in `ci.yml`. It passes some runs, so
`known_failing` would red the job on every green run. On `known_flaky` a pass and a failure are both
accepted, and the guard reds only if the test disappears from the report. Take it off the list in the
same commit that fixes the race.
