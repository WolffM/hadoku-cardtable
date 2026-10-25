#!/usr/bin/env bash
#
# Forge scale runs on the claws — docs/planning/forge-hosting-plan.md §3.
#
# Never runs a load on hokon (production). hokon only compiles ForgeScale.java
# with javac (no Maven) and rsyncs it, with prod's pinned jar and a trimmed
# copy of res/, to ~/.cache/cardtable-stress on each claw.
#
# Usage:
#   run.sh stage <claw>...                     copy jar, res, classes, decks
#   run.sh run <claw> <tsv> <label> <cpus> <memmax> <xmx> [-Dstress.k=v ...]
#                                             one capped JVM; appends one TSV row
#   run.sh fetch-decks <claw>                 copy the claw's built cube decks back
#   run.sh clean <claw>...                    delete the claw copy
#
# <cpus> caps the run with AllowedCPUs (the highest-numbered <cpus> CPUs) and
# CPUQuota=<cpus>*100%; <memmax> is the scope's MemoryMax. The JVM reads both
# (availableProcessors, and so Forge's attack pool, follows the cap). Every row
# carries the claw's CI state — Runner.Worker count, load average and
# MemAvailable — before AND after the run: a number without its load is not a
# number.
#
# Environment: JAR (prod's pin), RES (read-only Forge res), JDK (a JDK 21).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
JDK=${JDK:-$HOME/.local/opt/jdk-21.0.12.1+1}
JAR=${JAR:-$HOME/.local/share/cardtable/jars/c83701093637dda4bdd420c9457cdee821a54fd0.jar}
RES=${RES:-/home/hadoku/srv/hadoku-cardtable/forge/forge-gui/res}
STAGE=${STAGE:-$HOME/.cache/lane-stress/stage}
CUBE=${CUBE:-$HERE/../../apps/server/pools/cubes/mtgo-vintage-cube-2025-04.json}
DECKS=${DECKS:-$HERE/decks}
REMOTE='.cache/cardtable-stress'

build() {
	mkdir -p "$STAGE/classes"
	"$JDK/bin/javac" -proc:none -Xlint:-options -cp "$JAR" -d "$STAGE/classes" "$HERE/src/ForgeScale.java"
	cp "$JAR" "$STAGE/forge.jar"
	python3 -I -c 'import json,sys; [print(c["name"]) for c in json.load(open(sys.argv[1]))["cards"]]' "$CUBE" > "$STAGE/cube-names.txt"
}

stage() {
	build
	for c in "$@"; do
		ssh -o BatchMode=yes "$c" "mkdir -p ~/$REMOTE"
		rsync -a --delete "$STAGE/classes" "$STAGE/forge.jar" "$STAGE/cube-names.txt" "$c:$REMOTE/"
		rsync -a --delete --exclude adventure --exclude music --exclude skins "$RES/" "$c:$REMOTE/res/"
		if compgen -G "$DECKS/*.dck" > /dev/null; then
			rsync -a --delete "$DECKS/" "$c:$REMOTE/decks/"
		fi
		echo "staged $c"
	done
}

ctx() { # <claw> -> runners load1 avail_mb
	ssh -o BatchMode=yes "$1" 'echo "$(pgrep -fc "[R]unner.Worker" || true) $(cut -d" " -f1 /proc/loadavg) $(( $(awk "/MemAvailable/{print \$2}" /proc/meminfo) / 1024 ))"'
}

run() {
	local claw=$1 tsv=$2 label=$3 cpus=$4 mem=$5 xmx=$6
	shift 6
	local props=("$@")
	local pre post hostinfo res dur
	pre=$(ctx "$claw")
	hostinfo=$(ssh -o BatchMode=yes "$claw" 'echo "$(nproc) $(awk "/MemTotal/{printf \"%d\", \$2/1048576}" /proc/meminfo)"')
	dur=600
	for p in "${props[@]}"; do case $p in -Dstress.durationSec=*) dur=${p#*=};; esac; done
	echo "[$(date -u +%TZ)] $claw $label cpus=$cpus mem=$mem xmx=$xmx ${props[*]} (pre: runners load avail = $pre)" >&2
	# The remote side: a fresh run dir (Forge resolves res/ against the cwd), then
	# one JVM in a capped user scope, killed by timeout(1) if it overruns.
	res=$(ssh -o BatchMode=yes "$claw" bash -s -- "$cpus" "$mem" "$xmx" "$dur" "$label" "${props[@]}" <<'REMOTE'
set -euo pipefail
cpus=$1 mem=$2 xmx=$3 dur=$4 label=$5; shift 5
base=$HOME/.cache/cardtable-stress
run=$base/runs/$label-$(date +%s)
mkdir -p "$run/user/preferences" "$run/user/decks/constructed" "$run/cache" "$run/tmp"
ln -s "$base/res" "$run/res"
[ -d "$base/decks" ] && cp -r "$base/decks" "$run/decks"
cp "$base/cube-names.txt" "$run/"
printf 'userDir=%s/user/\ncacheDir=%s/cache/\ndecksDir=%s/user/decks/\ndecksConstructedDir=%s/user/decks/constructed/\n' "$run" "$run" "$run" "$run" > "$run/forge.profile.properties"
n=$(nproc); first=$(( n - cpus )); last=$(( n - 1 ))
cd "$run"
set +e
systemd-run --user --scope --quiet -p MemoryMax="$mem" -p MemorySwapMax=0 -p CPUQuota=$(( cpus * 100 ))% -p AllowedCPUs=$first-$last \
	timeout --kill-after=30 $(( dur + 240 )) \
	"$HOME/.local/opt/jdk-21.0.12.1+1/bin/java" -Djava.awt.headless=true -Djava.io.tmpdir="$run/tmp" -Xmx"$xmx" \
	-Dstress.series="$run/series.tsv" "$@" -cp "$base/classes:$base/forge.jar" ForgeScale > "$run/result.txt" 2> "$run/stderr.txt"
rc=$?
set -e
r=$(grep '^RESULT' "$run/result.txt" || true)
oom=$(cat "$run/stress.log" "$run/stderr.txt" 2>/dev/null | grep -c 'OutOfMemoryError' || true)
last=$(tail -1 "$run/series.tsv" 2>/dev/null | cut -f1,2,4,8)
echo "rc=$rc	oom_lines=$oom	series_last=${last//	/,}	rundir=$run	${r#RESULT	}"
REMOTE
) || true
	post=$(ctx "$claw")
	local hdr=("ts" "claw" "nproc" "mem_gb" "label" "cap_cpus" "cap_mem" "xmx" "runners_pre" "load_pre" "avail_mb_pre" "runners_post" "load_post" "avail_mb_post")
	local vals=("$(date -u +%FT%TZ)" "$claw" $hostinfo "$label" "$cpus" "$mem" "$xmx" $pre $post)
	# key=value pairs -> columns, in the order the harness printed them
	local IFS=$'\t'
	local kv=($res)
	unset IFS
	local k v
	for pair in "${kv[@]}"; do
		k=${pair%%=*}; v=${pair#*=}
		hdr+=("$k"); vals+=("$v")
	done
	if [ ! -s "$tsv" ]; then (IFS=$'\t'; echo "${hdr[*]}") > "$tsv"; fi
	(IFS=$'\t'; echo "${vals[*]}") >> "$tsv"
	(IFS=$'\t'; paste <(printf '%s\n' "${hdr[@]}") <(printf '%s\n' "${vals[@]}") | grep -E '^(label|rc|matches|mode|completed|failed|capped|cpu_s_per_match_min|cores_busy|ai_p50_ms|ai_p95_ms|ai_p99_ms|ai_timeouts|act_p99_ms|gc_pct|live_heap_median_mb|live_heap_per_match_mb|rss_peak_mb|runners_pre|runners_post|load_pre|load_post)\b' | tr '\n' ' ') >&2
	echo >&2
}

fetch_decks() {
	mkdir -p "$DECKS"
	local d
	d=$(ssh -o BatchMode=yes "$1" 'ls -td ~/.cache/cardtable-stress/runs/*/decks | head -1')
	rsync -a "$1:$d/" "$DECKS/"
	ls "$DECKS"
}

clean() {
	for c in "$@"; do ssh -o BatchMode=yes "$c" "rm -rf ~/$REMOTE" && echo "cleaned $c"; done
}

cmd=${1:?usage: run.sh stage|run|fetch-decks|clean ...}
shift
case $cmd in
	stage) stage "$@" ;;
	run) run "$@" ;;
	fetch-decks) fetch_decks "$@" ;;
	clean) clean "$@" ;;
	*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
