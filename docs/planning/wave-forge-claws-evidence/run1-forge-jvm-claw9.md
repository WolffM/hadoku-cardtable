# Run 37570892785 (forge-claws-proof, first green-bundle run) — forge-jvm on warm-claw-9, excerpts

```
Runner name: 'warm-claw-9-hadoku-cardtable'
forge-bundle: BUILD: pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6 not cached (or incomplete), building
forge-bundle: mvn build finished in 68s
forge-bundle: BUILD finished in 100s total (mvn 68s of it); bundle size 504M at /home/hadoku/.cache/cardtable-forge/e5db05107cb6ce3f5cf2dae338f062b5316a68f6
echo "host at start: $(uptime)"; free -m | sed -n 2p
host at start:  21:21:15 up 8 days, 10:13,  0 users,  load average: 1.59, 0.66, 0.71
Mem:           32003        2565       14820        1280       16352       29438

 FAIL  apps/ui/src/play/live/flow.jvm.test.ts > wave 20 lane B: turns that flow, against a real Forge match
 FAIL  apps/server/src/play/blockers.jvm.test.ts > a real attack at a seat, against real Forge > Q12: a seat attacked while it holds a summoning-sick creature is offered the block, and can make it
 FAIL  apps/server/src/play/cast-hidden.jvm.test.ts > a cast stays hidden until it is on the stack (V3), against real Forge > manual payment, one land tap at a time (Doom Blade, {1}{B}, two Swamps) �
 FAIL  apps/server/src/play/cast-hidden.jvm.test.ts > a cast stays hidden until it is on the stack (V3), against real Forge > cancel AFTER tapping the first of two lands, before the second — the opp
 FAIL  apps/server/src/play/priority.jvm.test.ts > what the caster is shown after casting, against real Forge > casts a spell and reports who holds priority and which stop fired
 FAIL  apps/server/src/play/priority.jvm.test.ts > what the caster is shown after casting, against real Forge > Q7: "Select target spell" with one spell on the stack is a getChoices with min 0, which 
 FAIL  apps/server/src/play/scenario-targets.jvm.test.ts > targets on the wire, set up by a scenario, against real Forge > the auto-target arrow: TargetCards is on the wire for a mandatory single-targ
 FAIL  apps/server/src/play/scenario-targets.jvm.test.ts > targets on the wire, set up by a scenario, against real Forge > Q18 evidence: an activated ability on the stack is identified by its SOURCE P
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > combat and targets: showConfirmDialog, openZones, assignGenericAmount, assignCombatDamage, getAbilit
 FAIL  apps/ui/src/play/live/prompts.jvm.test.ts > the fifteen prompts against a real Forge match > [nightly] choices: confirm, order, tempShowZones, getChoices, showInputDialog, chooseSingleEntityFor
 Test Files  6 failed | 35 passed (41)
      Tests  9 failed | 92 passed | 7 skipped (108)
   Duration  1578.83s (transform 3.73s, setup 0ms, collect 12.07s, tests 1552.49s, environment 5.17s, prepare 3.08s)

390:     → ENOENT: no such file or directory, open '/tmp/claude-1000/w40-A/measure-manual-pay-tap1.json'
392:     → ENOENT: no such file or directory, open '/tmp/claude-1000/w40-A/measure-manual-pay-cancel.txt'
528:     → ENOENT: no such file or directory, open '/tmp/claude-1000/S/q17-run.txt'
530:     → ENOENT: no such file or directory, open '/tmp/claude-1000/S/q7-run.txt'
608:     → ENOENT: no such file or directory, open '/tmp/claude-1000/S/q12-run.txt'
619:     → ENOENT: no such file or directory, open '/tmp/claude-1000/w33-S/auto-target-stackitem.json'
621:     → ENOENT: no such file or directory, open '/tmp/claude-1000/w33-Q18/glint-hawk-stackitem.json'
1022:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/S/q12-run.txt'
1034:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/w40-A/measure-manual-pay-tap1.json'
1046:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/w40-A/measure-manual-pay-cancel.txt'
1058:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/S/q17-run.txt'
1070:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/S/q7-run.txt'
1082:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/w33-S/auto-target-stackitem.json'
1094:Error: ENOENT: no such file or directory, open '/tmp/claude-1000/w33-Q18/glint-hawk-stackitem.json'

# the judge object
{
  "failed, not pinned": [
    "a cast stays hidden until it is on the stack (V3), against real Forge cancel AFTER tapping the first of two lands, before the second — the opponent never sees the name",
    "a cast stays hidden until it is on the stack (V3), against real Forge manual payment, one land tap at a time (Doom Blade, {1}{B}, two Swamps) — the opponent sees nothing between taps",
    "a real attack at a seat, against real Forge Q12: a seat attacked while it holds a summoning-sick creature is offered the block, and can make it",
    "targets on the wire, set up by a scenario, against real Forge Q18 evidence: an activated ability on the stack is identified by its SOURCE PERMANENT, still on the battlefield",
    "targets on the wire, set up by a scenario, against real Forge the auto-target arrow: TargetCards is on the wire for a mandatory single-target spell",
    "the fifteen prompts against a real Forge match combat and targets: showConfirmDialog, openZones, assignGenericAmount, assignCombatDamage, getAbilityToPlay",
    "what the caster is shown after casting, against real Forge Q7: \"Select target spell\" with one spell on the stack is a getChoices with min 0, which onlyAnswer rightly leaves",
    "what the caster is shown after casting, against real Forge casts a spell and reports who holds priority and which stop fired"
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
