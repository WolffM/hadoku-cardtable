#!/usr/bin/env bash
#
# B1 of docs/planning/hosting-test-plan.md: an 8 h soak with churn, as a
# transient systemd --user SERVICE on a claw (not a scope), so it outlives the
# ssh session that started it. Needs `run.sh stage <claw>` first and linger on
# the claw (`loginctl show-user $USER -p Linger`).
#
# Usage:
#   soak.sh start <claw> [hours]   start; prints the unit name
#   soak.sh status <claw>          the unit's state and the last series rows
#   soak.sh collect <claw> <dir>   copy every soak's series, result and stderr into <dir>
#   soak.sh stop <claw>            stop every soak unit (the run dir is kept)
#
# The JVM is capped like a planned hosting slice (CPUS, MEM, XMX; default
# 4 CPUs / 3 GB / 2200m) and runs N paced matches back to back (default 48, 40 %
# human-vs-human), forcing a full GC every 5 min so the series' live_after_gc_mb
# column is the heap floor. Pass: heap floor, threads, metaspace and classes flat
# after warm-up (`series.tsv`; `soak-summary.py` reads it).
set -euo pipefail

claw=${2:?usage: soak.sh start|status|collect|stop <claw> ...}
CPUS=${CPUS:-4} MEM=${MEM:-3G} XMX=${XMX:-2200m} N=${N:-48} HVH=${HVH:-0.4}

case $1 in
	start)
		hours=${3:-8}
		ssh -o BatchMode=yes "$claw" bash -s -- "$CPUS" "$MEM" "$XMX" "$N" "$HVH" "$hours" <<'REMOTE'
set -euo pipefail
cpus=$1 mem=$2 xmx=$3 n=$4 hvh=$5 hours=$6
base=$HOME/.cache/cardtable-stress
unit=breakit-soak-$(date +%s)
run=$base/runs/$unit
mkdir -p "$run/user/preferences" "$run/user/decks/constructed" "$run/cache" "$run/tmp"
ln -s "$base/res" "$run/res"
cp -r "$base/decks" "$run/decks"
cp "$base/cube-names.txt" "$run/"
printf 'userDir=%s/user/\ncacheDir=%s/cache/\ndecksDir=%s/user/decks/\ndecksConstructedDir=%s/user/decks/constructed/\n' "$run" "$run" "$run" "$run" > "$run/forge.profile.properties"
nproc=$(nproc)
systemd-run --user --unit="$unit" --quiet --working-directory="$run" \
	-p MemoryMax="$mem" -p MemorySwapMax=0 -p CPUQuota=$(( cpus * 100 ))% -p AllowedCPUs=$(( nproc - cpus ))-$(( nproc - 1 )) \
	-p RuntimeMaxSec=$(( hours * 3600 + 900 )) \
	-p StandardOutput=file:"$run/result.txt" -p StandardError=file:"$run/stderr.txt" \
	"$HOME/.local/opt/jdk-21.0.12.1+1/bin/java" -Djava.awt.headless=true -Djava.io.tmpdir="$run/tmp" -Xmx"$xmx" -XX:+UseG1GC \
	-Dstress.series="$run/series.tsv" -Dstress.mode=paced -Dstress.decks=cube -Dstress.matchCapSec=3600 \
	-Dstress.matches="$n" -Dstress.hvh="$hvh" -Dstress.durationSec=$(( hours * 3600 )) -Dstress.liveGcSec=300 \
	-cp "$base/classes:$base/forge.jar" ForgeScale
echo "$unit $run"
REMOTE
		;;
	status)
		ssh -o BatchMode=yes "$claw" 'for u in $(systemctl --user list-units --all --plain --no-legend "breakit-soak-*" | cut -d" " -f1); do systemctl --user show "$u" -p ActiveState -p Result -p ExecMainStatus -p MemoryCurrent; done; for r in ~/.cache/cardtable-stress/runs/breakit-soak-*; do echo "$r"; tail -n 2 "$r/series.tsv" 2>/dev/null || echo "(no series yet)"; done'
		;;
	collect)
		out=${3:?usage: soak.sh collect <claw> <dir>}
		mkdir -p "$out"
		rsync -a --include='breakit-soak-*/' --include='series.tsv' --include='result.txt' --include='stderr.txt' --exclude='*' \
			"$claw:.cache/cardtable-stress/runs/" "$out/"
		ls "$out"
		;;
	stop)
		ssh -o BatchMode=yes "$claw" 'systemctl --user stop "breakit-soak-*"'
		;;
	*) echo "unknown command $1" >&2; exit 2 ;;
esac
