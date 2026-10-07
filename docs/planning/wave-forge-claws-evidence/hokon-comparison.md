# hokon, old forge.yml, main — the comparison runs

## 37566400825 (a7dd8b2, push) forge-e2e 03:24→03:43, forge-jvm 03:43→04:01 (serial after e2e)
```
echo "::notice::heavy.lock acquired after $(( $(date +%s) - waited )) s"
echo "host at start: $(uptime)"; free -m | sed -n 2p
##[notice]heavy.lock acquired after 312 s
host at start:  20:49:16 up 56 days,  5:05,  1 user,  load average: 21.83, 16.26, 14.47
 ❯ apps/ui/src/play/live/prompts.jvm.test.ts (3 tests | 1 failed | 1 skipped) 32062ms
 Test Files  5 failed | 35 passed | 1 skipped (41)
      Tests  4 failed | 65 passed | 39 skipped (108)
 FAIL  apps/ui/src/play/live/flow.jvm.test.ts > wave 20 lane B: turns that flow, against a real Forge match
 FAIL  apps/server/src/play/auto-pass-land.jvm.test.ts > wave 35 §S follow-up: a spell resolves unattended for the seat holding only lands, against real Forge > seat 1 holds only untapped lands while
 FAIL  apps/server/src/play/scenario-blockers.jvm.test.ts > Declare Blockers, set up by a scenario, against real Forge > Q12: a defender with one creature is NOT auto-passed through Declare Blockers, 
 FAIL  apps/server/src/play/scenario-thoughtseize.jvm.test.ts > R4: casting Thoughtseize, against real Forge > the land is never a legal choice: picking the land is refused by Forge itself
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway
 Test Files  5 failed | 35 passed | 1 skipped (41)
      Tests  4 failed | 65 passed | 39 skipped (108)
{
  "failed, not pinned": [
    "R4: casting Thoughtseize, against real Forge the land is never a legal choice: picking the land is refused by Forge itself"
  ],
  "skipped, not pinned": [
    "wave 20 lane B: turns that flow, against a real Forge match Forge's own re-ask of the one ability is answered server-side: one click, one ask, the player sees neither",
    "wave 20 lane B: turns that flow, against a real Forge match a card with one ability asks nothing — the offer arrives and is answered without a prompt",
    "wave 20 lane B: turns that flow, against a real Forge match a creature with no responses resolves with ZERO clicks from either player",
    "wave 20 lane B: turns that flow, against a real Forge match a one-land Preordain reaches the stack with no prompt drawn at all",
    "wave 20 lane B: turns that flow, against a real Forge match a refused click is rare, and never the last word",
    "wave 20 lane B: turns that flow, against a real Forge match a turn never advances past a main phase unattended",
    "wave 20 lane B: turns that flow, against a real Forge match full control restores the stop the one-ability shortcut removed"
  ]
}
```

## 37572150239 (9265ced, push) forge-e2e 04:44→05:12
```
echo "::notice::heavy.lock acquired after $(( $(date +%s) - waited )) s"
echo "host at start: $(uptime)"; free -m | sed -n 2p
##[notice]heavy.lock acquired after 508 s
host at start:  21:52:46 up 56 days,  6:09,  1 user,  load average: 17.40, 17.27, 16.83
  1) play.spec.ts:659:1 › two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope 
  2) table-fit.spec.ts:721:1 › a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window 
  3) w32.spec.ts:106:1 › the turn reads Start with no name under it (Q1); End Turn passes skipped phases at once, the preference is scoped to the End Turn seat (Q5) 
  85 passed (19.4m)
```

## 37572150239 (9265ced, push) forge-jvm 05:12→05:30, serial after e2e on the same host
```
echo "::notice::heavy.lock acquired after $(( $(date +%s) - waited )) s"
echo "host at start: $(uptime)"; free -m | sed -n 2p
##[notice]heavy.lock acquired after 289 s
host at start:  22:17:18 up 56 days,  6:33,  1 user,  load average: 16.90, 18.36, 18.93
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway
 FAIL  apps/server/src/play/auto.jvm.test.ts > wave 19 lane C against a real Forge match > records what #16 and #22 actually carry: a prose Yes/No with no cost, and a two-source payment with no plan
 FAIL  apps/server/src/play/auto.jvm.test.ts > wave 19 lane C against a real Forge match > records the window item 6 is: {R} with one red source among two lands
 Test Files  2 failed | 38 passed | 1 skipped (41)
      Tests  3 failed | 73 passed | 32 skipped (108)
   Duration  798.41s (transform 1.53s, setup 0ms, collect 5.41s, tests 785.55s, environment 2.42s, prepare 1.54s)
{
  "failed, not pinned": [
    "wave 19 lane C against a real Forge match records the window item 6 is: {R} with one red source among two lands",
    "wave 19 lane C against a real Forge match records what #16 and #22 actually carry: a prose Yes/No with no cost, and a two-source payment with no plan"
  ]
}
```
