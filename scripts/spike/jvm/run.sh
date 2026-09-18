#!/usr/bin/env bash
#
# hadoku-cardtable Wave 9, lane D — O3: one JVM per match, or one hosting many?
#
# MEASURES; does not build Forge. Nothing here runs Maven. The only thing it
# compiles is scripts/spike/jvm/src, against a prebuilt fat jar plus the stock
# forge-gui-desktop test-classes (for HeadlessGuiDesktop), into WORK_DIR. So the
# only writes into FORGE_DIR are the ones `stage` makes when it creates it.
#
# FORGE_DIR must still be a COPY and never the repo's vendored forge/ submodule
# (D2/O1: pinned at 2ad70eb4, byte-for-byte). The guards are copied from
# scripts/spike/tierc/run.sh rather than sourced, so this lane's files do not
# couple to Wave 7's — and they are not weakened: need_forge_dir resolves
# symlinks with `pwd -P`, assert_forge_pristine checks for target/ dirs AND
# asks git, because Forge's own .gitignore covers `target` and git alone
# reported "pristine" through the whole Wave 6 incident.
#
# Usage:
#   FORGE_DIR=~/.cache/cardtable-w9-d/forge ./run.sh <mode> [args]
#
#   stage                 cp -a the fat jar, test-classes and forge-gui/res from
#                         SRC_FORGE (a prebuilt tree, read-only) into FORGE_DIR
#   shared <N> [reps]     ONE JVM hosting N concurrent matches        -> out/shared.tsv
#   many <N> [reps]       N JVMs, one match each, all at once         -> out/many.tsv
#   matrix                shared and many for N in $NS, $REPS reps each
#   floor                 smallest -Xmx that completes N matches      -> out/floor.tsv
#   rounds                one JVM, N=4, 8 rounds: is memory given back? -> out/rounds.tsv
#   server-idle [reps]    our fork's `forge server`, idle, listening  -> out/server-idle.tsv
#   singleton             two stock UnifiedNetworkHarness matches in ONE JVM
#   kill-shared <N>       SIGKILL a JVM hosting N matches mid-match   -> out/blast.tsv
#   kill-many <N>         SIGKILL 1 of N one-match JVMs mid-match     -> out/blast.tsv
#   oom-shared <N> <xmx>  N matches in one JVM with a heap too small  -> out/blast.tsv
#   guard-test            point FORGE_DIR at the vendored forge/ and prove refusal
#   verify-pristine       assert the vendored forge/ is untouched
#
# Every TSV row carries the host context it was measured under (nproc, free
# MemAvailable and swap, 1-minute load average): lanes A and C start their own
# JVMs on this host during the wave, and a number without its load is not a
# number.
#
# Environment:
#   FORGE_DIR   Required. A Forge tree with forge-gui-desktop/target/<fat jar>,
#               forge-gui-desktop/target/test-classes and forge-gui/res.
#   SRC_FORGE   `stage` source. Default ~/.cache/cardtable-w8/forge-build (our
#               fork at 2ad70eb4, built by Wave 8). Only ever read.
#   JAVA_HOME   A JDK 21 (needs javac). Default: ~/.local/opt/jdk-21* (D14) —
#               `java` on PATH is a Debian JRE with no javac.
#   WORK_DIR    Scratch. Default ~/.cache/cardtable-w9-d/work.
#   OUT_DIR     Default scripts/spike/jvm/out — COMMITTED, because /tmp is tmpfs.
#               Transcripts are .txt, never .log: .gitignore has a bare `*.log`.
#   XMX_ONE     -Xmx for a one-match JVM. Default 512m: upstream's own choice
#               for exactly this shape (MultiProcessGameExecutor.java passes
#               -Xmx512m to each per-game JVM), and 2x the measured floor — `floor`
#               finishes one match at 256m.
#   XMX_SHARED  -Xmx for a JVM hosting N. Default 1g: 2.6x the measured floor
#               for N=8 (`floor` finishes eight at 384m; 256m OOMs one of them),
#               so it never constrains N<=8. heap-after-GC does not depend on
#               -Xmx; RSS does, which is why both are reported.
#   NS, REPS    matrix parameters. Default "1 2 4 8", 3.
#   JVM_FLAGS   extra JVM flags appended to every measured run.
#
set -euo pipefail

MODE="${1:-}"
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-$HOME/.cache/cardtable-w9-d/work}"
OUT_DIR="${OUT_DIR:-$SPIKE_DIR/out}"
SRC_FORGE="${SRC_FORGE:-$HOME/.cache/cardtable-w8/forge-build}"
XMX_ONE="${XMX_ONE:-512m}"
XMX_SHARED="${XMX_SHARED:-1g}"
NS="${NS:-1 2 4 8}"
REPS="${REPS:-3}"
JVM_FLAGS="${JVM_FLAGS:-}"

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1 || true)"
fi
if [[ -z "$JAVA_HOME" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "No JDK 21. Set JAVA_HOME to one with bin/javac (see D14)." >&2
  exit 2
fi
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"

# ---- guards (copied from scripts/spike/tierc/run.sh, not weakened) ----------

need_forge_dir() {
  if [[ -z "${FORGE_DIR:-}" ]]; then
    echo "FORGE_DIR is not set. Point it at a COPY of Forge — NOT the repo's vendored forge/." >&2
    exit 2
  fi
  mkdir -p "$FORGE_DIR"
  # `pwd -P`: this is a STRING comparison, and from a git worktree the logical
  # path of forge/ never equals the main checkout's. That hole put six target/
  # dirs into the vendored tree on 2026-09-16.
  FORGE_DIR="$(cd "$FORGE_DIR" && pwd -P)"
  local vendored
  vendored="$(cd "$SPIKE_DIR/../../.." && pwd -P)/forge"
  if [[ -e "$vendored" ]] && [[ "$FORGE_DIR" == "$(cd "$vendored" && pwd -P)" ]]; then
    echo "FORGE_DIR is the vendored forge/ tree (resolved: $FORGE_DIR)." >&2
    echo "Refusing: it must stay pristine." >&2
    exit 2
  fi
}

assert_forge_pristine() {
  local vendored dirty targets
  vendored="$(cd "$SPIKE_DIR/../../.." && pwd -P)/forge"
  [[ -d "$vendored" ]] || { echo "no vendored forge/ to check"; return 0; }
  dirty="$(git -C "$vendored" status --porcelain | wc -l)"
  targets="$(find "$vendored" -name target -type d 2>/dev/null | wc -l)"
  if [[ "$dirty" -ne 0 || "$targets" -ne 0 ]]; then
    echo "forge/ is NOT pristine: $dirty tracked changes, $targets target/ dirs." >&2
    find "$vendored" -name target -type d 2>/dev/null >&2
    return 1
  fi
  echo "forge/ pristine: 0 tracked changes, 0 target/ dirs (both checked)."
  echo "forge/ HEAD $(git -C "$vendored" rev-parse HEAD)"
}

# ---- plumbing ---------------------------------------------------------------

fatjar()       { echo "$FORGE_DIR/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar"; }
testclasses()  { echo "$FORGE_DIR/forge-gui-desktop/target/test-classes"; }

check_staged() {
  [[ -f "$(fatjar)" && -d "$(testclasses)/forge/net" && -d "$FORGE_DIR/forge-gui/res/cardsfolder" ]] || {
    echo "FORGE_DIR=$FORGE_DIR is not staged. Run '$0 stage' first." >&2
    exit 1
  }
}

compile_spike() {
  local out="$WORK_DIR/classes"
  rm -rf "$out"; mkdir -p "$out"
  # -Werror: a warning here is a bug (working agreement), not noise.
  "$JAVAC" -Werror -Xlint:all,-processing,-classfile,-serial -cp "$(fatjar):$(testclasses)" \
    -d "$out" "$SPIKE_DIR"/src/*.java >&2
}

# Forge resolves res/ relative to the working directory (no "git" in the
# version string -> getAssetsDir() is ""), and user/cache dirs from
# forge.profile.properties in the working directory. One run dir per JVM, so N
# concurrent JVMs never share a profile or a cache.
stage_run_dir() {
  local run="$1"
  rm -rf "$run"
  mkdir -p "$run/user/decks/constructed" "$run/cache"
  ln -s "$FORGE_DIR/forge-gui/res" "$run/res"
  cat > "$run/forge.profile.properties" <<EOF
userDir=$run/user/
cacheDir=$run/cache/
decksDir=$run/user/decks/
decksConstructedDir=$run/user/decks/constructed/
EOF
}

host_ctx() {
  local avail swapt swapf
  avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  swapt=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
  swapf=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
  printf 'nproc=%s\tmem_avail_mb=%s\tswap_used_mb=%s\tload1=%s' \
    "$(nproc)" "$avail" "$(( (swapt - swapf) / 1024 ))" "$(cut -d' ' -f1 /proc/loadavg)"
}

# RESULT key=value line -> TSV row with a header, given a fixed key list.
KEYS="shape n rep xmx_mb gc jvms exit ok failed init_ms ready_uptime_ms heap_idle_mb heap_idle_committed_mb rss_idle_mb pss_idle_mb play_wall_ms match_ms_median match_ms_max heap_peak_used_mb heap_peak_committed_mb heap_held_mb heap_held_committed_mb rss_held_mb pss_held_mb rss_hwm_mb heap_released_mb gc_count gc_ms wall_ms nproc mem_avail_mb swap_used_mb load1 outcomes"

tsv_header() { echo "$KEYS" | tr ' ' '\t'; }

# kv_to_row "<k=v\tk=v...>"
kv_to_row() {
  awk -v keys="$KEYS" -v line="$1" 'BEGIN{
    n=split(line, parts, "\t"); for(i=1;i<=n;i++){ p=index(parts[i],"="); if(p>0) kv[substr(parts[i],1,p-1)]=substr(parts[i],p+1) }
    m=split(keys, ks, " "); out=""; for(i=1;i<=m;i++){ v=(ks[i] in kv)?kv[ks[i]]:"-"; out=out (i>1?"\t":"") v } print out }'
}

ensure_tsv() { [[ -s "$1" ]] || tsv_header > "$1"; }

# launch_one <tag> <xmx> <n-matches> [extra -D...]  -> runs in background, sets LAUNCHED_PID.
# NOT called as $(launch_one ...): a command substitution is a subshell, and a
# JVM started there is not a child of this shell, so `wait` cannot reap it.
# Transcript: $WORK_DIR/$tag/stdout.txt; GC log: $WORK_DIR/$tag/gc.txt
launch_one() {
  local tag="$1" xmx="$2" n="$3"; shift 3
  local run="$WORK_DIR/$tag"
  stage_run_dir "$run"
  # shellcheck disable=SC2086
  ( cd "$run" && exec "$JAVA" \
      -Djava.awt.headless=true -Dsentry.dsn= \
      -Xmx"$xmx" -Xlog:gc:file="$run/gc.txt" \
      -Djvm.matches="$n" -Djvm.readyFile="$run/ready" \
      $JVM_FLAGS "$@" \
      -cp "$(fatjar):$(testclasses):$WORK_DIR/classes" spike.jvm.MatchLoad \
      > "$run/stdout.txt" 2> "$run/stderr.txt" ) &
  LAUNCHED_PID=$!
}

result_of() { grep -m1 '^RESULT' "$WORK_DIR/$1/stdout.txt" | cut -f2- || true; }

keep_gc_log() {  # keep ONE representative GC log per configuration, small text
  mkdir -p "$OUT_DIR/gc"
  cp "$WORK_DIR/$1/gc.txt" "$OUT_DIR/gc/$2.txt"
}

# ---- modes ------------------------------------------------------------------

do_stage() {
  need_forge_dir
  local src
  src="$(cd "$SRC_FORGE" && pwd -P)"
  [[ "$src" != "$FORGE_DIR" ]] || { echo "SRC_FORGE and FORGE_DIR are the same tree." >&2; exit 2; }
  mkdir -p "$FORGE_DIR/forge-gui-desktop/target" "$FORGE_DIR/forge-gui"
  cp -a "$src/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar" \
        "$src/forge-gui-desktop/target/test-classes" "$FORGE_DIR/forge-gui-desktop/target/"
  cp -a "$src/forge-gui/res" "$FORGE_DIR/forge-gui/"
  echo "staged $FORGE_DIR from $src (HEAD $(git -C "$src" rev-parse HEAD 2>/dev/null || echo '?'))"
  sha256sum "$(fatjar)"
}

# shared <N> <rep>: one JVM, N matches.
run_shared() {
  local n="$1" rep="$2" tag="shared-n$1-r$2" pid rc t0 t1 ctx kv
  ctx="$(host_ctx)"
  t0=$(date +%s%N)
  launch_one "$tag" "$XMX_SHARED" "$n"; pid=$LAUNCHED_PID
  set +e; wait "$pid"; rc=$?; set -e
  t1=$(date +%s%N)
  kv="$(result_of "$tag")"
  [[ "$rep" == 1 ]] && keep_gc_log "$tag" "$tag"
  kv_to_row "shape=shared	n=$n	rep=$rep	jvms=1	exit=$rc	wall_ms=$(( (t1-t0)/1000000 ))	$ctx	$kv"
}

# many <N> <rep>: N JVMs at once, 1 match each. One row per JVM, plus a SUM row.
run_many() {
  local n="$1" rep="$2" pids=() rcs=() i t0 t1 ctx
  ctx="$(host_ctx)"
  t0=$(date +%s%N)
  for ((i=0; i<n; i++)); do launch_one "many-n$n-r$rep-j$i" "$XMX_ONE" 1; pids+=("$LAUNCHED_PID"); done
  for ((i=0; i<n; i++)); do set +e; wait "${pids[$i]}"; rcs+=($?); set -e; done
  t1=$(date +%s%N)
  [[ "$rep" == 1 ]] && keep_gc_log "many-n$n-r$rep-j0" "many-n$n-r$rep-j0"
  for ((i=0; i<n; i++)); do
    kv_to_row "shape=many-jvm$i	n=$n	rep=$rep	jvms=$n	exit=${rcs[$i]}	wall_ms=$(( (t1-t0)/1000000 ))	$ctx	$(result_of "many-n$n-r$rep-j$i")"
  done
}

# Sum the per-JVM rows of one `many` rep into a single comparable row.
sum_many() {
  awk -F'\t' -v n="$1" -v rep="$2" '
    FNR==1 { for(i=1;i<=NF;i++) col[$i]=i; next }
    $col["n"]==n && $col["rep"]==rep && $col["shape"] ~ /^many-jvm/ {
      k++; ok+=$col["ok"]; fl+=$col["failed"]; bad+=($col["exit"]!=0)
      rss_idle+=$col["rss_idle_mb"]; pss_idle+=$col["pss_idle_mb"]; heap_idle+=$col["heap_idle_mb"]
      heap_held+=$col["heap_held_mb"]; rss_held+=$col["rss_held_mb"]; pss_held+=$col["pss_held_mb"]
      hwm+=$col["rss_hwm_mb"]; peak+=$col["heap_peak_used_mb"]; comm+=$col["heap_held_committed_mb"]
      if ($col["init_ms"]>init) init=$col["init_ms"]; if ($col["ready_uptime_ms"]>ready) ready=$col["ready_uptime_ms"]
      if ($col["match_ms_max"]>mmax) mmax=$col["match_ms_max"]; med[k]=$col["match_ms_median"]
      wall=$col["wall_ms"]; ctx=$col["nproc"] "\t" $col["mem_avail_mb"] "\t" $col["swap_used_mb"] "\t" $col["load1"]
      xmx=$col["xmx_mb"]; gc=$col["gc"]
    }
    END { if (!k) exit 1
      for (i=2;i<=k;i++) { v=med[i]; j=i-1; while (j>0 && med[j]+0>v+0) { med[j+1]=med[j]; j-- } med[j+1]=v }  # mawk: no asort
      mm=med[int((k+1)/2)]
      printf "many-SUM\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%s\t%s\t%d\t-\t%d\t%d\t-\t%s\t%s\t%d\t-\t%d\t%d\t%d\t%d\t%d\t-\t-\t-\t%s\t%s\t-\n",
        n, rep, xmx, gc, k, bad, ok, fl, init, ready, heap_idle, rss_idle, pss_idle, mm, mmax, peak, heap_held, comm, rss_held, pss_held, hwm, wall, ctx
    }' "$3"
}

do_shared() { local n="$1" reps="${2:-$REPS}" f="$OUT_DIR/shared.tsv"; ensure_tsv "$f"
  for ((r=1; r<=reps; r++)); do run_shared "$n" "$r" | tee -a "$f"; done; }

do_many() { local n="$1" reps="${2:-$REPS}" f="$OUT_DIR/many.tsv"; ensure_tsv "$f"
  for ((r=1; r<=reps; r++)); do run_many "$n" "$r" | tee -a "$f"; sum_many "$n" "$r" "$f" | tee -a "$f"; done; }

do_matrix() {
  for n in $NS; do do_shared "$n"; do_many "$n"; done
}

# floor: halve the heap until N matches no longer finish. -XX:+ExitOnOutOfMemoryError
# is NOT set here — the point is to see where it breaks, and the OOM transcript
# is the evidence.
do_floor() {
  local f="$OUT_DIR/floor.tsv" n xmx tag pid rc kv
  ensure_tsv "$f"
  for n in 1 4 8; do
    for xmx in 1024m 768m 512m 384m 320m 256m; do
      tag="floor-n$n-$xmx"
      launch_one "$tag" "$xmx" "$n" -Djvm.timeoutSec=240; pid=$LAUNCHED_PID
      set +e; wait "$pid"; rc=$?; set -e
      kv="$(result_of "$tag")"
      kv_to_row "shape=floor	n=$n	rep=1	jvms=1	exit=$rc	$(host_ctx)	xmx_mb=${xmx%m}	$kv" | tee -a "$f"
      grep -m1 -h 'OutOfMemoryError' "$WORK_DIR/$tag/stdout.txt" "$WORK_DIR/$tag/stderr.txt" 2>/dev/null | sed "s/^/  [$tag] /" || true
    done
  done
}

do_rounds() {
  local f="$OUT_DIR/rounds.tsv" tag pid rc
  tag="rounds-n4"
  launch_one "$tag" "$XMX_SHARED" 4 -Djvm.rounds=8; pid=$LAUNCHED_PID
  set +e; wait "$pid"; rc=$?; set -e
  { echo -e "exit\tmatches_per_round\trounds\tok\tfailed\theap_idle_mb\theap_released_by_round_mb\trss_released_by_round_mb\trss_hwm_final_mb\t$(host_ctx | sed 's/=[^\t]*//g')"
    result_of "$tag" | tr '\t' '\n' | awk -F= -v rc="$rc" -v ctx="$(host_ctx)" '{kv[$1]=substr($0,index($0,"=")+1)}
      END{ n=split(ctx,c,"\t"); cs=""; for(i=1;i<=n;i++){split(c[i],p,"="); cs=cs "\t" p[2]}
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s%s\n", rc, kv["matches"], kv["rounds"], kv["ok"], kv["failed"], kv["heap_idle_mb"], kv["heap_released_by_round_mb"], kv["rss_released_by_round_mb"], kv["rss_hwm_final_mb"], cs }'
  } | tee -a "$f"
}

# server-idle: the per-JVM floor of the thing lane A would actually spawn —
# our fork's `forge server` (DedicatedServer), card DB loaded, Netty bound,
# nobody connected. Sampled from outside via /proc/<pid>.
do_server_idle() {
  local reps="${1:-$REPS}" f="$OUT_DIR/server-idle.tsv" r run pid port t0 up rss pss hwm heap
  [[ -s "$f" ]] || echo -e "rep\txmx\tlisten_ms\trss_mb\tpss_mb\thwm_mb\theap_used_after_gc_kb\theap_committed_kb\texit\tnproc\tmem_avail_mb\tswap_used_mb\tload1" > "$f"
  for ((r=1; r<=reps; r++)); do
    run="$WORK_DIR/server-idle-r$r"; stage_run_dir "$run"
    port=$(( 47000 + RANDOM % 2000 ))
    t0=$(date +%s%N)
    # shellcheck disable=SC2086
    ( cd "$run" && exec "$JAVA" -Djava.awt.headless=true -Xmx"$XMX_ONE" $JVM_FLAGS \
        -jar "$(fatjar)" server -p "$port" -t 60 > "$run/stdout.txt" 2> "$run/stderr.txt" ) &
    pid=$!
    up=""
    for _ in $(seq 1 600); do
      if grep -q 'Dedicated server listening' "$run/stdout.txt" 2>/dev/null; then up=$(( ($(date +%s%N)-t0)/1000000 )); break; fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    [[ -n "$up" ]] || { echo "server never listened (rep $r); see $run/stdout.txt" >&2; kill -9 "$pid" 2>/dev/null || true; exit 1; }
    sleep 3   # let the post-bind allocation settle before sampling
    "$JAVA_HOME/bin/jcmd" "$pid" GC.run > /dev/null
    sleep 1
    rss=$(awk '/^VmRSS:/{print int($2/1024)}' "/proc/$pid/status")
    hwm=$(awk '/^VmHWM:/{print int($2/1024)}' "/proc/$pid/status")
    pss=$(awk '/^Pss:/{print int($2/1024)}' "/proc/$pid/smaps_rollup")
    "$JAVA_HOME/bin/jcmd" "$pid" GC.heap_info > "$run/heap_info.txt"
    heap=$(grep -m1 -oE 'total [0-9]+K, used [0-9]+K' "$run/heap_info.txt")
    [[ "$r" == 1 ]] && { mkdir -p "$OUT_DIR"; cp "$run/heap_info.txt" "$OUT_DIR/server-idle-heap_info.txt"; }
    kill -TERM "$pid"
    set +e; wait "$pid"; rc=$?; set -e
    echo -e "$r\t$XMX_ONE\t$up\t$rss\t$pss\t$hwm\t$(echo "$heap" | sed -E 's/total ([0-9]+)K, used ([0-9]+)K/\2\t\1/')\t$rc\t$(host_ctx | sed -E 's/[a-z_0-9]+=//g')" | tee -a "$f"
  done
}

# singleton: can ONE JVM host two networked matches through Forge's own server?
do_singleton() {
  local run="$WORK_DIR/singleton" rc
  stage_run_dir "$run"
  set +e
  ( cd "$run" && "$JAVA" -Djava.awt.headless=true -Dsentry.dsn= -Xmx"$XMX_SHARED" \
      -cp "$(fatjar):$(testclasses):$WORK_DIR/classes" spike.jvm.TwoNetMatches ) > "$OUT_DIR/singleton.txt" 2>&1
  rc=$?
  set -e
  echo "TwoNetMatches exit=$rc" | tee -a "$OUT_DIR/singleton.txt"
}

wait_ready() {  # wait_ready <tag> : until the JVM has launched its matches
  local i
  for i in $(seq 1 600); do [[ -f "$WORK_DIR/$1/ready" ]] && return 0; sleep 0.05; done
  echo "never became ready: $1" >&2; return 1
}

blast_row() {  # blast_row <experiment> <victim-or-dash> <tag> <exit>
  local tag="$3" matches_line
  matches_line="$(grep -h '^MATCH ' "$WORK_DIR/$tag/stdout.txt" 2>/dev/null | cut -d' ' -f2- | paste -sd';' || true)"
  echo -e "$1\t$2\t$tag\t$4\t$(grep -c '^MATCH ' "$WORK_DIR/$tag/stdout.txt" 2>/dev/null || true)\t$(grep -cE '^MATCH .* (win|draw)@' "$WORK_DIR/$tag/stdout.txt" 2>/dev/null || true)\t${matches_line:--}\t$(grep -m1 -ohE 'java.lang.OutOfMemoryError[^\n]*' "$WORK_DIR/$tag/stdout.txt" "$WORK_DIR/$tag/stderr.txt" 2>/dev/null | head -1 || true)"
}
blast_header() { local f="$OUT_DIR/blast.tsv"; [[ -s "$f" ]] || echo -e "experiment\tvictim\tjvm\texit\tmatches_reported\tmatches_finished\tper_match\toom" > "$f"; }

# kill-shared N: one JVM, N matches, SIGKILL once the matches are running.
do_kill_shared() {
  local n="$1" rep="${2:-1}" tag pid rc
  blast_header
  tag="kill-shared-n$n-r$rep"
  launch_one "$tag" "$XMX_SHARED" "$n"; pid=$LAUNCHED_PID
  wait_ready "$tag"; sleep 0.3
  kill -9 "$pid"
  set +e; wait "$pid"; rc=$?; set -e
  blast_row "kill-shared-n$n" "the-jvm" "$tag" "$rc" | tee -a "$OUT_DIR/blast.tsv"
}

# kill-many N: N one-match JVMs; SIGKILL jvm 0 once every JVM has started.
do_kill_many() {
  local n="$1" rep="${2:-1}" pids=() i rc
  blast_header
  for ((i=0; i<n; i++)); do launch_one "kill-many-n$n-r$rep-j$i" "$XMX_ONE" 1; pids+=("$LAUNCHED_PID"); done
  for ((i=0; i<n; i++)); do wait_ready "kill-many-n$n-r$rep-j$i"; done
  sleep 0.3
  kill -9 "${pids[0]}"
  for ((i=0; i<n; i++)); do
    set +e; wait "${pids[$i]}"; rc=$?; set -e
    blast_row "kill-many-n$n" "j0" "kill-many-n$n-r$rep-j$i" "$rc" | tee -a "$OUT_DIR/blast.tsv"
  done
}

# oom-shared N XMX: a heap that fits fewer than N matches. No ExitOnOutOfMemoryError:
# we want to see which matches the OOM lands in, not a clean exit.
do_oom_shared() {
  local n="$1" xmx="$2" rep="${3:-1}" tag pid rc
  blast_header
  tag="oom-shared-n$n-$xmx-r$rep"
  launch_one "$tag" "$xmx" "$n" -Djvm.timeoutSec=240; pid=$LAUNCHED_PID
  set +e; wait "$pid"; rc=$?; set -e
  blast_row "oom-shared-n$n-$xmx" "-" "$tag" "$rc" | tee -a "$OUT_DIR/blast.tsv"
  cp "$WORK_DIR/$tag/stdout.txt" "$OUT_DIR/$tag.txt"
}

# guard-test: point FORGE_DIR at the vendored tree through BOTH spellings (the
# worktree's logical path, and the resolved one) and require exit 2 from the
# guard with nothing started. need_forge_dir exits before any java or cp runs.
do_guard_test() {
  local vendored rc before after err refused
  vendored="$(cd "$SPIKE_DIR/../../.." && pwd)/forge"
  before="$(find "$vendored" -name target -type d | wc -l)"
  err="$WORK_DIR/guard-test.stderr.txt"
  # The symlink is the spelling that got through on 2026-09-16: a string compare
  # of logical paths never matched, so the resolve (`pwd -P`) is what is tested.
  ln -sfn "$vendored" "$WORK_DIR/forge-symlink-to-vendored"
  for spelling in "$vendored" "$(cd "$vendored" && pwd -P)" "$vendored/../forge" "$WORK_DIR/forge-symlink-to-vendored"; do
    for mode in stage shared; do
      set +e
      FORGE_DIR="$spelling" bash "$SPIKE_DIR/run.sh" "$mode" 1 1 > /dev/null 2> "$err"
      rc=$?
      grep -q 'Refusing: it must stay pristine' "$err"
      refused=$?
      set -e
      echo "FORGE_DIR=$spelling $mode -> exit=$rc refused-by-guard=$([[ $refused -eq 0 ]] && echo yes || echo NO)   [expected exit=2, yes]"
      [[ "$rc" -eq 2 && "$refused" -eq 0 ]] || { echo "GUARD DID NOT REFUSE $spelling ($mode)" >&2; return 1; }
    done
  done
  after="$(find "$vendored" -name target -type d | wc -l)"
  echo "target/ dirs in vendored forge/: before=$before after=$after"
  assert_forge_pristine
}

mkdir -p "$WORK_DIR" "$OUT_DIR"

case "$MODE" in
  stage)           do_stage ;;
  guard-test)      do_guard_test ;;
  verify-pristine) assert_forge_pristine ;;
  shared|many|matrix|floor|rounds|server-idle|singleton|kill-shared|kill-many|oom-shared)
    need_forge_dir; check_staged; compile_spike
    shift
    case "$MODE" in
      shared)      do_shared "$@" ;;
      many)        do_many "$@" ;;
      matrix)      do_matrix ;;
      floor)       do_floor ;;
      rounds)      do_rounds ;;
      server-idle) do_server_idle "$@" ;;
      singleton)   do_singleton ;;
      kill-shared) do_kill_shared "$@" ;;
      kill-many)   do_kill_many "$@" ;;
      oom-shared)  do_oom_shared "$@" ;;
    esac ;;
  *) echo "Unknown mode '$MODE'. See the header of $0." >&2; exit 2 ;;
esac
