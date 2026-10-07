# Run 37582515279 — the first on-main run under the new forge.yml (push b79e398 = wave 54's ui 0.32.40 / server 0.32.16), push mode

## forge-e2e
```
Runner name: 'jit-claw-8-hadoku-cardtabl-j112665714340-r37582515279-1791355149'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "::notice::this run's ports: server=$SERVER play-server=$PLAY_SERVER edge=$EDGE play-edge=$PLAY_EDGE"
##[notice]this run's ports: server=46353 play-server=33961 edge=42531 play-edge=39875
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  23:39:28 up 16 days,  6:32,  0 users,  load average: 0.16, 0.14, 0.36
  1) w46-attack.spec.ts:165:1 › dragging Memnite onto Jace attacks the planeswalker; a lasting arrow joins them through declare-blockers and is gone by Main 2 
  1 failed
  90 passed (17.6m)
##[error]Process completed with exit code 1.
{
  "choice": {
    "decks": [
      {
      },
      {
      }
    ],
```

## forge-jvm
```
Runner name: 'warm-claw-9-hadoku-cardtable'
forge-bundle: HIT: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 already cached at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  23:39:13 up 8 days, 12:31,  0 users,  load average: 1.09, 0.30, 1.99
 FAIL  apps/server/src/play/socket-two-mana-pass.jvm.test.ts > a 2-mana cast with lands left over, over the real socket path, against real Forge > Goblin Piker resolves over the real socket, both seat
 FAIL  apps/ui/src/play/live/board-play.jvm.test.ts > playing by clicking the board, against a real Forge match > a player plays a land and casts spells — one targeted — by clicking their own boar
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > a reveal: the label carries Forge's "(id)", and the card's own facts are in the browser anyway
 Test Files  3 failed | 37 passed | 1 skipped (41)
      Tests  3 failed | 73 passed | 32 skipped (108)
   Duration  968.20s (transform 3.73s, setup 0ms, collect 12.16s, tests 941.67s, environment 5.22s, prepare 3.05s)
##[error]the jvm report does not match the pinned lists (see the object above)
##[error]Process completed with exit code 1.
{
  "failed, not pinned": [
    "a 2-mana cast with lands left over, over the real socket path, against real Forge Goblin Piker resolves over the real socket, both seats having pressed nothing since the cast"
  ]
}
```

