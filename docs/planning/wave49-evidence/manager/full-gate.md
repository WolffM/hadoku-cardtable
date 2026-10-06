# w49 manager full gate — HEAD 3541be4, run 2026-10-06 06:50–07:29Z, under heavy.lock

Scripts: CI env only (jar, res, work dir; no PROBE/DUMP). e2e = ci.yml derived forge-gated spec list + its jq; jvm = every tracked *.jvm.test.ts, --fileParallelism=false, judged by ci.yml's own judge step extracted verbatim with FULL=true.

```
lock acquired 06:50:32 HEAD 3541be4
 23:50:32 up 55 days,  8:06,  1 user,  load average: 2.28, 4.86, 7.02
playwright exit 0
{"startTime":"2026-10-06T06:50:36.042Z","duration":796372.5889999999,"expected":72,"skipped":0,"unexpected":0,"flaky":0}
e2e judge exit 0
e2e done 07:03:52
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  2 failed | 37 passed (39)
      Tests  3 failed | 101 passed (104)
vitest exit 1
true
judge exit 0
jvm done 07:28:22
1
 apps/ui/src/play/adapter.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
pw exit 1
{"startTime":"2026-10-06T07:28:25.721Z","duration":35448.967000000004,"expected":1,"skipped":0,"unexpected":1,"flaky":0}
the caster’s own thumbnail arcs to the spell it targets, drawn in a real browser: passed
the opponent sees the arc too, off the bridge’s own wire fact — she answered no ask and holds no client-side intent: failed
restored, tree clean
pw exit 0
{"startTime":"2026-10-06T07:29:09.237Z","duration":33276.921,"expected":2,"skipped":0,"unexpected":0,"flaky":0}
the caster’s own thumbnail arcs to the spell it targets, drawn in a real browser: passed
the opponent sees the arc too, off the bridge’s own wire fact — she answered no ask and holds no client-side intent: passed
all done 07:29:42
gate-all exit 0
```

jvm failures (all pinned):

- Declare Blockers, set up by a scenario, against real Forge Q12: a defender with one creature is NOT auto-passed through Declare Blockers, and can assign the block
- the fifteen prompts against a real Forge match choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityForEffect
- the fifteen prompts against a real Forge match a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway

jvm suites run:

- apps/server/src/http/library-match.jvm.test.ts: passed 31
- apps/server/src/http/library-resolve.jvm.test.ts: passed 1
- apps/server/src/play/auto-pass-land.jvm.test.ts: passed 1
- apps/server/src/play/auto.jvm.test.ts: passed 3
- apps/server/src/play/blockers.jvm.test.ts: passed 2
- apps/server/src/play/cast-hidden.jvm.test.ts: passed 4
- apps/server/src/play/endturn.jvm.test.ts: passed 1
- apps/server/src/play/lands.jvm.test.ts: passed 1
- apps/server/src/play/mulligan.jvm.test.ts: passed 2
- apps/server/src/play/phyrexian.jvm.test.ts: passed 1
- apps/server/src/play/priority.jvm.test.ts: passed 2
- apps/server/src/play/reload.jvm.test.ts: passed 1
- apps/server/src/play/scenario-ability-repeat.jvm.test.ts: passed 2
- apps/server/src/play/scenario-blockers.jvm.test.ts: failed 1, passed 1
- apps/server/src/play/scenario-combat.jvm.test.ts: passed 2
- apps/server/src/play/scenario-glen.jvm.test.ts: passed 3
- apps/server/src/play/scenario-harness.jvm.test.ts: passed 2
- apps/server/src/play/scenario-order.jvm.test.ts: passed 2
- apps/server/src/play/scenario-priority.jvm.test.ts: passed 2
- apps/server/src/play/scenario-start.jvm.test.ts: passed 2
- apps/server/src/play/scenario-targets.jvm.test.ts: passed 2
- apps/server/src/play/scenario-thoughtseize.jvm.test.ts: passed 2
- apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts: passed 1
- apps/server/src/play/seed.jvm.test.ts: passed 1
- apps/server/src/play/socket-thoughtseize.jvm.test.ts: passed 1
- apps/server/src/play/socket-two-mana-pass.jvm.test.ts: passed 1
- apps/server/src/play/target-players.jvm.test.ts: passed 2
- apps/server/src/play/two-mana-pass.jvm.test.ts: passed 1
- apps/server/src/play/w46-block-stop.jvm.test.ts: passed 2
- apps/ui/src/play/live/board-play.jvm.test.ts: passed 1
- apps/ui/src/play/live/combat-drag.jvm.test.ts: passed 1
- apps/ui/src/play/live/flow.jvm.test.ts: passed 7
- apps/ui/src/play/live/prompts.jvm.test.ts: failed 2, passed 1
- apps/ui/src/play/prompts/choose-x.jvm.test.ts: passed 1
- apps/ui/src/play/prompts/confirm.jvm.test.ts: passed 1
- apps/ui/src/play/prompts/offboard.jvm.test.ts: passed 3
- apps/ui/src/play/prompts/sanctum-worldbreaker.jvm.test.ts: passed 4
- apps/ui/src/play/prompts/search.jvm.test.ts: passed 1
- apps/ui/src/play/prompts/worldbreaker.jvm.test.ts: passed 2

e2e specs:

specs: arrow.spec.ts

pnpm run check (no jar env) at 3541be4: exit 0 — Test Files 105 passed | 41 skipped (146); Tests 4271 passed | 109 skipped (4380)
