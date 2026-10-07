# Lane A — local proof and cold-build numbers

Cold BUILD measurements (clone + mvn package forge-gui-desktop -am), from forge.yml proof
dispatch logs, before lane A's verify_jar step (which then failed on missing `unzip`,
so none of these reached the final jar copy / res copy / atomic mv):

run 37569234311 (forge-claws-proof), pin e5db05107cb6ce3f5cf2dae338f062b5316a68f6:
  forge-e2e  job 112623907206  runner jit-claw-8-hadoku-cardtabl-...  clone ~16s  mvn 141s
  forge-jvm  job 112623907246  runner jit-claw-9-hadoku-cardtabl-...  clone ~26s  mvn 102s
  (manager's message cites "clone 30s, mvn 141s, runner jit-claw-9" for this run — matching
   the forge-jvm job's clone-to-mvn-start gap closely enough; both jobs in this run are the
   same cold-build measurement set)

run 37569441429 (forge-claws-proof-2), same pin:
  forge-e2e  job 112624533225  runner warm-claw-9-hadoku-cardtable   clone ~36s  mvn 67s
  forge-jvm  job 112624533237  runner jit-claw-8-hadoku-cardtabl-... clone ~0s   mvn 44s

All four: mvn package finished in 44-141s against a cold ~/.m2 (well under the wave file's
10-20 min estimate for the maven phase alone). None reached `verify_jar` success, so the
remaining bundle work (jar verification, forge-gui/res copy ~462MB/55k files, atomic mv,
per-pin flock release) is still UNMEASURED end to end. Budget below carries headroom for
that unmeasured remainder and should be re-measured off a real green run.
