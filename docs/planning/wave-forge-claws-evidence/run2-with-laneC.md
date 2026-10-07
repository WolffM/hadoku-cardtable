# Run 37574482895 (forge-claws-proof @ 8cf04b0 = wave 65a389c + B's forge.yml) — the first run with lane C

## forge-jvm on warm-claw-9 — SUCCESS
```
Runner name: 'warm-claw-9-hadoku-cardtable'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:04:15 up 8 days, 10:56,  0 users,  load average: 0.02, 0.06, 0.76
Mem:           32003        2749       14632        1308       16384       29254
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > [nightly] choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityFor
 Test Files  1 failed | 40 passed (41)
      Tests  1 failed | 107 passed (108)
   Duration  1412.39s (transform 3.81s, setup 0ms, collect 12.26s, tests 1385.92s, environment 5.16s, prepare 3.07s)
```

## forge-e2e on jit-claw-8 — the same two main reds as hokon
```
Runner name: 'jit-claw-8-hadoku-cardtabl-j112640228761-r37574482895-1791349448'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "::notice::this run's ports: server=$SERVER play-server=$PLAY_SERVER edge=$EDGE play-edge=$PLAY_EDGE"
##[notice]this run's ports: server=38033 play-server=44775 edge=45663 play-edge=37393
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:04:26 up 16 days,  4:57,  0 users,  load average: 0.56, 0.21, 1.04
  1) play.spec.ts:659:1 › two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope 
  2) table-fit.spec.ts:721:1 › a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window 
  87 passed (16.1m)
```
