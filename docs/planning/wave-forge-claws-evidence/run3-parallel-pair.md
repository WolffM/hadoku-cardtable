# Runs 37576542577 (3a, forge-claws-proof) and 37576544917 (3b, forge-claws-proof-2) @ 8cf04b0 — dispatched together 05:29Z

Scheduling: 3a jvm → jit-claw-8; 3a e2e → warm-claw-9; 3b e2e → jit-claw-9; 3b jvm → jit-claw-9. Three heavy jobs on claw-9 at once.

## run3a-forge-jvm
```
Runner name: 'jit-claw-8-hadoku-cardtabl-j112646615899-r37576544917-1791350963'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:29:35 up 16 days,  5:22,  0 users,  load average: 0.17, 1.00, 2.22
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > [nightly] choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityFor
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway
 Test Files  1 failed | 40 passed (41)
      Tests  2 failed | 106 passed (108)
   Duration  868.95s (transform 1.36s, setup 0ms, collect 6.65s, tests 853.30s, environment 3.08s, prepare 1.97s)
```

## run3a-forge-e2e
```
Runner name: 'warm-claw-9-hadoku-cardtable'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "::notice::this run's ports: server=$SERVER play-server=$PLAY_SERVER edge=$EDGE play-edge=$PLAY_EDGE"
##[notice]this run's ports: server=41937 play-server=34175 edge=44173 play-edge=42969
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:29:47 up 8 days, 11:21,  0 users,  load average: 0.58, 1.70, 2.45
  1) play.spec.ts:659:1 › two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope 
  2) table-fit.spec.ts:721:1 › a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window 
  3) w33.spec.ts:208:1 › Q12 — a seat with one creature gets the block window, can assign it, and it is highlighted selectable 
  3 failed
  80 passed (34.9m)
##[error]Process completed with exit code 1.
{
  "choice": {
    "format": "2003-09-01",
    "decks": [
      {
        "id": "power-2003-1-marco-blume-wake",
        "name": "Wake (Marco Blume)",
        "cards": 26
      },
      {
        "id": "power-2003-2-michael-groves-ug-madness",
        "name": "UG Madness (Michael Groves)",
```

## run3b-forge-e2e
```
Runner name: 'jit-claw-9-hadoku-cardtabl-j112646643865-r37576544917-1791350979'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "::notice::this run's ports: server=$SERVER play-server=$PLAY_SERVER edge=$EDGE play-edge=$PLAY_EDGE"
##[notice]this run's ports: server=36585 play-server=40345 edge=39169 play-edge=39717
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:30:11 up 8 days, 11:22,  0 users,  load average: 4.17, 2.45, 2.68
  1) play.spec.ts:659:1 › two friends play one Forge match: seats, prompts from both sides, a refresh with a question open, the board agrees with the server, isolation per envelope 
  2) table-fit.spec.ts:721:1 › a live match fits 1280×800 and 1366×768 in every frame: no page scroll, the button bar always home, a prompt inside the window 
  3) w35.spec.ts:190:1 › the swallowed press — casting Ponder under Full Control, one OK click at "Stack: 1 to Resolve" is never dropped 
  3 failed
  86 passed (35.6m)
##[error]Process completed with exit code 1.
{
  "choice": {
    "format": "2003-09-01",
    "decks": [
      {
        "id": "power-2003-1-marco-blume-wake",
        "name": "Wake (Marco Blume)",
        "cards": 26
      },
      {
        "id": "power-2003-2-michael-groves-ug-madness",
        "name": "UG Madness (Michael Groves)",
```

## run3b-forge-jvm
```
Runner name: 'jit-claw-9-hadoku-cardtabl-j112646643793-r37576544917-1791350979'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  22:29:54 up 8 days, 11:21,  0 users,  load average: 2.48, 2.05, 2.56
 FAIL  apps/server/src/play/target-players.jvm.test.ts > a target selection names the players it accepts, against real Forge > Doom Blade (target nonblack creature) names no player
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > [nightly] choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityFor
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway
 Test Files  2 failed | 39 passed (41)
      Tests  3 failed | 105 passed (108)
   Duration  2233.95s (transform 4.51s, setup 0ms, collect 19.37s, tests 2191.83s, environment 7.95s, prepare 5.09s)
##[error]the jvm report does not match the pinned lists (see the object above)
##[error]Process completed with exit code 1.
{
  "failed, not pinned": [
    "a target selection names the players it accepts, against real Forge Doom Blade (target nonblack creature) names no player"
  ]
}
```

