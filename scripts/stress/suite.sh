#!/usr/bin/env bash
#
# The forge-scale test suites (docs/planning/forge-hosting-plan.md §3), as run
# for docs/spikes/forge-scale.md. Each appends rows to <out>/<suite>.tsv via
# run.sh. Caps follow the lane's etiquette while CI shares the claw: claw-9 at
# most 4 CPUs / 6 GB, every other claw 2 CPUs / 1.5 GB.
#
# Usage: suite.sh <suite> <claw> <out-dir>
#   t9       calibration: the fixed-seed full-speed cube set at N=1 and N=2, 2 CPUs
#   t2       CPU knee: full-speed AI-vs-AI at 1/2/4 CPUs, N rising per core count
#   t1       density: paced (one human-paced seat vs AI), N = 8, 16, 32, 64, 128
#   t1small  density inside a 2 CPU / 1.5 GB cap: N = 4, 8, 16, 32
#   t4       bad neighbour: N paced matches, then the same N beside one slot
#            playing AI-vs-AI from a stalled crowded board (forge#3410)
#
# Full-box suites, for a leased claw only (no CI on it). CPUS, MEM and XMX
# size the run (default: the whole box, the JVM heap at ~85% of MEM):
#   t2full   CPU knee at CPUS cores: full-speed, N in $NS
#   t1full   density at CPUS cores: paced, N in $NS
#   t3       mix at N=$N paced matches: 30/60/100% vs-AI (the rest human-vs-human)
#   t6       OOM: N=$N paced matches in a heap too small, -XX:+ExitOnOutOfMemoryError
#   t7       GC: N=$N paced matches under G1, Serial and generational ZGC
#
# Failure isolation (docs/planning/hosting-test-plan.md §B), inside a 4 CPU /
# 3 GB slice like a planned hosting slice, N=${N:-16} paced matches each:
#   b3       a baseline, then one slot's AI throwing a real StackOverflowError,
#            then an engine exception, each beside the N-1 others
#   b2       a hung AI beside N-1 others: one spinning on the CPU (no interrupt
#            reaches it), one blocked (an interrupt does), one forge#3410 board
#   b4       OOM: a heap too small with and without -XX:+ExitOnOutOfMemoryError,
#            then a cgroup MemoryMax below the heap (the kernel kills it)
#   b5       AI cutoffs on every scan (Game.AI_TIMEOUT=0): live eval threads
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
suite=$1 claw=$2 out=$3
mkdir -p "$out"
box_cpus=$(ssh -o BatchMode=yes "$claw" nproc)
box_mb=$(ssh -o BatchMode=yes "$claw" "awk '/MemTotal/{print int(\$2/1024)}' /proc/meminfo")
CPUS=${CPUS:-$box_cpus}
MEM=${MEM:-$(( box_mb - 2048 ))M}
XMX=${XMX:-$(( (box_mb - 2048) * 85 / 100 ))m}
R() { "$HERE/run.sh" run "$claw" "$out/$suite.tsv" "$@"; }
FULL=(-Dstress.mode=full -Dstress.decks=cube -Dstress.matchCapSec=600)
PACED=(-Dstress.mode=paced -Dstress.decks=cube -Dstress.matchCapSec=3600)

case $suite in
	t9)
		for n in 1 2; do R "t9-n$n" 2 1500M 900m "${FULL[@]}" -Dstress.matches=$n -Dstress.durationSec=180 -Dstress.liveGcSec=60; done
		;;
	t2)
		for spec in 1:1 1:2 1:4 2:2 2:4 2:8 4:4 4:8 4:16; do
			c=${spec%%:*} n=${spec##*:}
			R "t2-c$c-n$n" "$c" 6G 4500m "${FULL[@]}" -Dstress.matches=$n -Dstress.durationSec=180 -Dstress.liveGcSec=60
		done
		;;
	t1)
		for n in ${NS:-8 16 32 64 128}; do
			R "t1-n$n" 4 6G 4500m "${PACED[@]}" -Dstress.matches=$n -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=60
		done
		;;
	t1small)
		for n in ${NS:-4 8 16 32}; do
			R "t1s-n$n" 2 1500M 900m "${PACED[@]}" -Dstress.matches=$n -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=60
		done
		;;
	t4)
		n=${N:-16}
		R "t4-base-n$n" 4 6G 4500m "${PACED[@]}" -Dstress.matches=$n -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=60
		R "t4-heavy-n$n" 4 6G 4500m "${PACED[@]}" -Dstress.matches=$((n + 1)) -Dstress.heavySlots=1 -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=60
		;;
	t2full)
		for n in $NS; do R "t2f-c$CPUS-n$n" "$CPUS" "$MEM" "$XMX" "${FULL[@]}" -Dstress.matches=$n -Dstress.durationSec=${DUR:-180} -Dstress.liveGcSec=60; done
		;;
	t1full)
		for n in $NS; do R "t1f-c$CPUS-n$n" "$CPUS" "$MEM" "$XMX" "${PACED[@]}" -Dstress.matches=$n -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=60; done
		;;
	t3)
		for vsai in 30 60 100; do
			R "t3-n$N-vsai$vsai" "$CPUS" "$MEM" "$XMX" "${PACED[@]}" -Dstress.matches=$N -Dstress.hvh=$(awk -v v=$vsai 'BEGIN{print 1-v/100}') -Dstress.durationSec=${DUR:-900} -Dstress.liveGcSec=60
		done
		;;
	t6)
		R "t6-oom-n$N-$XMX" "$CPUS" "$MEM" "$XMX" "${PACED[@]}" -XX:+ExitOnOutOfMemoryError -Dstress.matches=$N -Dstress.durationSec=${DUR:-600} -Dstress.liveGcSec=30
		;;
	t7)
		for gc in "-XX:+UseG1GC" "-XX:+UseSerialGC" "-XX:+UseZGC -XX:+ZGenerational"; do
			# shellcheck disable=SC2086 # the GC flags are separate words on purpose
			R "t7-n$N-$(echo $gc | sed 's/-XX:+Use//; s/ -XX:+ZGenerational/gen/')" "$CPUS" "$MEM" "$XMX" $gc "${PACED[@]}" -Dstress.matches=$N -Dstress.durationSec=${DUR:-420} -Dstress.liveGcSec=60
		done
		;;
	b3)
		R "b3-base-n$N" 4 3G 2200m "${PACED[@]}" -Dstress.matches=$N -Dstress.durationSec=${DUR:-240} -Dstress.liveGcSec=60
		for f in soe throw; do
			R "b3-$f-n$N" 4 3G 2200m "${PACED[@]}" -Dstress.matches=$N -Dstress.fault=$f -Dstress.faultSlots=2 -Dstress.durationSec=${DUR:-240} -Dstress.liveGcSec=60
		done
		;;
	b2)
		for f in spin block; do
			R "b2-$f-n$N" 4 3G 2200m "${PACED[@]}" -Dstress.matches=$N -Dstress.fault=$f -Dstress.faultSlots=1 -Dstress.faultRescueSec=30 -Dstress.durationSec=${DUR:-240} -Dstress.liveGcSec=60
		done
		R "b2-heavy-n$N" 4 3G 2200m "${PACED[@]}" -Dstress.matches=$N -Dstress.heavySlots=1 -Dstress.durationSec=${DUR:-240} -Dstress.liveGcSec=60
		;;
	b4)
		R "b4-exit-n64-400m" 4 3G 400m "${PACED[@]}" -XX:+ExitOnOutOfMemoryError -Dstress.matches=64 -Dstress.durationSec=${DUR:-300} -Dstress.liveGcSec=30
		R "b4-noexit-n64-400m" 4 3G 400m "${PACED[@]}" -Dstress.matches=64 -Dstress.durationSec=${DUR:-300} -Dstress.liveGcSec=30
		R "b4-cgroup-n64-700M" 4 700M 2200m "${PACED[@]}" -XX:+ExitOnOutOfMemoryError -Dstress.matches=64 -Dstress.durationSec=${DUR:-300} -Dstress.liveGcSec=30
		;;
	b5)
		R "b5-cutoff0-n$N" 4 3G 2200m "${PACED[@]}" -Dstress.matches=$N -Dstress.aiTimeoutSec=0 -Dstress.durationSec=${DUR:-300} -Dstress.liveGcSec=60
		R "b5-cutoff0-full-n4" 4 3G 2200m "${FULL[@]}" -Dstress.matches=4 -Dstress.aiTimeoutSec=0 -Dstress.durationSec=${DUR:-300} -Dstress.liveGcSec=60
		;;
	*) echo "unknown suite $suite" >&2; exit 2 ;;
esac
