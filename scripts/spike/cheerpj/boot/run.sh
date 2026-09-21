#!/usr/bin/env bash
#
# Wave 16, lane A -- make the CheerpJ boot reach Forge's home screen EVERY time.
#
# Wave 15 got Forge's real match UI painting in a browser, but only about half
# of its cold boots reached the card database; the rest went silent inside the
# unpack of res-boot.zip into CheerpJ's IndexedDB-backed /files/ mount. This
# driver exists to find out why, fix it, and prove the fix by un-fixing it.
#
# Self-contained, like every other lane's driver: its OWN cache ($SPIKE_CACHE,
# default ~/.cache/w16a-boot) and its OWN port ($PORT, default 8744), because
# other lanes drive CheerpJ in this same worktree at the same time. It READS
# scripts/spike/cheerpj/serve.mjs (Range support -- CheerpJ will not start
# without it) and the wave-15 artifacts it stages from, and writes to neither.
#
# Nothing here writes inside the repo or inside forge/ (decision D2), and
# nothing here builds Forge: the patched jar and res-boot.zip are wave 15's,
# staged by `./run.sh stage` from lane D's cache.
#
# The toolchain is off $PATH on purpose (decision D14): Temurin JDK 21 lives
# under ~/.local/opt and `which javac` finding nothing is not a missing JDK.
#
# Usage:
#   ./run.sh build                compile the Bootstrap fork, stamp a build id
#   ./run.sh stage                copy wave 15's forge.jar + res-boot.zip in
#   ./run.sh serve                foreground static server on $PORT
#   ./run.sh boot                 ONE cold boot, JSON to stdout
#   ./run.sh batch <n> <label>    n cold boots, a tally, and per-run JSON
#   ./run.sh unpackrate <n> <lbl> n runs x BOOT_REPEAT unpacks, no Forge boot:
#                                 the high-power version of the same question
#
# Knobs (all read as environment variables, all recorded in the run JSON):
#   BOOT_FIX=off|preload|flush|preload,flush
#                          the thing under test. off == wave 15's unpacker,
#                          line for line. Matched with `contains`, so the two
#                          fixes compose.
#   BOOT_BATCH=64          entries per yield, when BOOT_FIX contains flush
#   BOOT_SETTLE_MS=1       sleep per yield, when BOOT_FIX contains flush
#   BOOT_PERSIST=0|1       request navigator.storage.persist() before the boot
#   BOOT_WDMS=5000         Java watchdog tick; 0 disables it
#   BOOT_VERBOSE_FROM=-1   print one line per zip entry from this index on
#   BOOT_STALL_MS=75000    no console output for this long == STALL
#   BOOT_BUDGET_MS=480000  absolute per-run ceiling
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$(cd "$HERE/.." && pwd)"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w16a-boot}"
WWW="$SPIKE_CACHE/www"
PORT="${PORT:-8744}"
RUNS="$SPIKE_CACHE/runs"

# Wave 15 lane D's artifacts: the PATCHED Forge jar (lane B's patches 0001-0003
# plus lane D's) and the res slice a match needs. This lane changes the
# unpacker, not Forge, so rebuilding Forge here would only add a way for the two
# waves' numbers to stop being comparable.
#
# They are SNAPSHOTTED into $SPIKE_CACHE/frozen first, and every run stages from
# the snapshot. That is not tidiness: lane D's cache is live while this lane
# runs, and $SRC_WWW/forge.jar changed size (39,686,585 -> 39,686,151 bytes)
# between two `cp`s ninety seconds apart on 2026-09-20. A rate measured across
# a moving jar is not a rate. `FORCE=1 ./run.sh stage` re-takes the snapshot.
SRC_JAR="${BOOT_SRC_JAR:-$HOME/.cache/w15d-firstpaint/forge-patched/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar}"
SRC_ZIP="${BOOT_SRC_ZIP:-$HOME/.cache/w15d-firstpaint/www/res-boot.zip}"
FROZEN="$SPIKE_CACHE/frozen"

FORGE_JAR_FOR_CP="${CARDTABLE_FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}"
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"
PW_CORE="${PW_CORE:-$(ls -d "$HOME"/repos/hadoku-cardtable/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core 2>/dev/null | tail -1)}"

use_toolchain() {
    if [[ -z "$JDK_HOME" || ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- look in ~/.local/opt (decision D14)" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$PATH"
}

cmd_build() {
    use_toolchain
    [[ -f "$FORGE_JAR_FOR_CP" ]] || { echo "no Forge jar at $FORGE_JAR_FOR_CP (needed only as a compile classpath)" >&2; exit 1; }
    rm -rf "$SPIKE_CACHE/classes"
    mkdir -p "$SPIKE_CACHE/classes" "$WWW" "$RUNS"

    # A build id derived from the SOURCES. Trap 7 of the handoff: when a result
    # comes back unchanged, prove the thing you changed was the thing that ran.
    # The id is stamped into the page URL and appears in every run's JSON, so a
    # batch can be tied to a build after the fact.
    local srchash
    srchash="$(cat "$HERE"/java/spike/*.java "$HERE/index.html" "$HERE/boot.mjs" | sha1sum | cut -c1-10)"
    local buildid="$(date -u +%Y%m%dT%H%M%SZ)-$srchash"

    # --release 17: CheerpJ 4.3 refuses class files above major 61 and Forge is
    # built at 17 (forge/pom.xml:27). -cp the Forge jar: Bootstrap reflects onto
    # forge.view.Main.
    javac --release 17 -nowarn -cp "$FORGE_JAR_FOR_CP" -d "$SPIKE_CACHE/classes" "$HERE"/java/spike/*.java
    echo "javac exit=$?"
    "$JAVA_HOME/bin/jar" --create --file "$WWW/boot.jar" -C "$SPIKE_CACHE/classes" .
    cp -f "$HERE/index.html" "$WWW/index.html"
    printf '%s' "$buildid" > "$WWW/BUILDID"
    echo "BUILDID=$buildid"
    ls -l --time-style=full-iso "$WWW/boot.jar" "$WWW/index.html"
    echo "source mtimes (must PRE-date the jar above):"
    ls -l --time-style=full-iso "$HERE"/java/spike/*.java "$HERE/index.html"
    echo "class file major version (must be 61):"
    "$JAVA_HOME/bin/javap" -verbose -cp "$SPIKE_CACHE/classes" spike.Bootstrap | grep -E '^  major'
}

cmd_stage() {
    mkdir -p "$WWW" "$FROZEN"
    if [[ ! -f "$FROZEN/forge.jar" || ! -f "$FROZEN/res-boot.zip" || "${FORCE:-0}" == "1" ]]; then
        [[ -f "$SRC_JAR" ]] || { echo "no Forge jar at $SRC_JAR -- set BOOT_SRC_JAR" >&2; exit 1; }
        [[ -f "$SRC_ZIP" ]] || { echo "no res-boot.zip at $SRC_ZIP -- set BOOT_SRC_ZIP" >&2; exit 1; }
        cp -f "$SRC_JAR" "$FROZEN/forge.jar"
        cp -f "$SRC_ZIP" "$FROZEN/res-boot.zip"
        echo "snapshot taken from:"; echo "  $SRC_JAR"; echo "  $SRC_ZIP"
    else
        echo "using existing snapshot in $FROZEN (FORCE=1 to re-take)"
    fi
    cp -f "$FROZEN/forge.jar" "$WWW/forge.jar"
    cp -f "$FROZEN/res-boot.zip" "$WWW/res-boot.zip"
    ls -l --time-style=full-iso "$WWW"
    echo "the exact artifacts every number in docs/spikes/cheerpj-boot.md is against:"
    sha1sum "$WWW/forge.jar" "$WWW/res-boot.zip"
    # The home screen needs lane D's FView patch. Without it the boot reaches
    # `Read cards:` and then dies constructing the bazaar panel, which would
    # make a "reached the card database" run look like a reached-home-screen
    # one. Read the jar, not the build log.
    echo "patch proof -- FView must NOT reference VBazaarUI (expect 0):"
    "$JDK_HOME/bin/javap" -p -c -cp "$WWW/forge.jar" forge.view.FView 2>/dev/null | grep -c 'VBazaarUI' || true
}

require_staged() {
    local f
    for f in index.html boot.jar forge.jar res-boot.zip BUILDID; do
        [[ -f "$WWW/$f" ]] || { echo "not staged: $WWW/$f missing -- ./run.sh build && ./run.sh stage" >&2; exit 1; }
    done
    [[ -n "$PW_CORE" && -d "$PW_CORE" ]] || { echo "no playwright-core (\$PW_CORE=$PW_CORE)" >&2; exit 1; }
}

start_server() {
    node "$SHARED/serve.mjs" "$WWW" "$PORT" >"$SPIKE_CACHE/server.log" 2>&1 &
    SRV=$!
    trap 'kill '"$SRV"' 2>/dev/null || true' EXIT
    local i
    for i in $(seq 1 60); do
        if curl -fs -o /dev/null "http://127.0.0.1:$PORT/index.html"; then return 0; fi
        sleep 0.2
    done
    echo "server never answered on port $PORT -- see $SPIKE_CACHE/server.log" >&2; exit 1
}

# The query string. ALWAYS wipe=1: a run that is not provably cold measures
# nothing (wave 15 lane B was bitten by a warm /files/ reported as a cold boot).
boot_qs() {
    local build; build="$(cat "$WWW/BUILDID")"
    local props="user.dir=/files/|user.home=/files|forge.assetsDir=/files/"
    props="$props|spike.bootFix=${BOOT_FIX:-off}"
    props="$props|spike.wdMs=${BOOT_WDMS:-5000}"
    props="$props|spike.verboseFrom=${BOOT_VERBOSE_FROM:--1}"
    props="$props|spike.batch=${BOOT_BATCH:-64}"
    props="$props|spike.settleMs=${BOOT_SETTLE_MS:-1}"
    props="$props|spike.repeat=${BOOT_REPEAT:-1}"
    # %7C for the separator, %3D for the '=' inside each pair, so neither is
    # eaten by URLSearchParams before the page splits on '|'.
    local enc; enc="$(printf '%s' "$props" | sed -e 's/=/%3D/g' -e 's/|/%7C/g')"
    printf 'build=%s&wipe=1&persist=%s&w=1280&h=800&args=%s&props=%s' \
        "$build" "${BOOT_PERSIST:-0}" \
        "/app/res-boot.zip%7C/files/%7C${BOOT_MAIN:-forge.view.Main}" "$enc"
}

cmd_boot() {
    require_staged
    start_server
    mkdir -p "$RUNS"
    PW_CORE="$PW_CORE" node "$HERE/boot.mjs" "http://127.0.0.1:$PORT/index.html?$(boot_qs)" \
        --ready "${BOOT_READY:-Read cards:}" \
        --stall "${BOOT_STALL_MS:-75000}" --budget "${BOOT_BUDGET_MS:-480000}" "$@"
}

# n cold boots under one server, one tally line each, a summary at the end.
# Every run's JSON is kept: a rate with no per-run evidence behind it is a
# number nobody can check.
cmd_batch() {
    local n="${1:?usage: batch <n> <label>}"
    local label="${2:?usage: batch <n> <label>}"
    shift 2            # anything left is forwarded to boot.mjs
    require_staged
    start_server
    local dir="$RUNS/$label"
    rm -rf "$dir"; mkdir -p "$dir"
    local build; build="$(cat "$WWW/BUILDID")"
    {
        echo "label=$label n=$n build=$build"
        echo "fix=${BOOT_FIX:-off} batch=${BOOT_BATCH:-64} settleMs=${BOOT_SETTLE_MS:-1} persist=${BOOT_PERSIST:-0}"
        echo "wdMs=${BOOT_WDMS:-5000} verboseFrom=${BOOT_VERBOSE_FROM:--1} stallMs=${BOOT_STALL_MS:-75000} budgetMs=${BOOT_BUDGET_MS:-480000}"
        echo "repeat=${BOOT_REPEAT:-1} main=${BOOT_MAIN:-forge.view.Main} ready=${BOOT_READY:-Read cards:} extra=$*"
        echo "started=$(date -u +%FT%TZ) load=$(cut -d' ' -f1-3 /proc/loadavg)"
    } | tee "$dir/META.txt"

    local i ok=0 stall=0 other=0 rc
    for i in $(seq 1 "$n"); do
        local t0; t0=$(date +%s)
        set +e
        PW_CORE="$PW_CORE" node "$HERE/boot.mjs" "http://127.0.0.1:$PORT/index.html?$(boot_qs)" \
            --ready "${BOOT_READY:-Read cards:}" \
            --stall "${BOOT_STALL_MS:-75000}" --budget "${BOOT_BUDGET_MS:-480000}" \
            --out "$dir/run-$(printf %02d "$i").json" "$@" \
            >/dev/null 2>"$dir/run-$(printf %02d "$i").err"
        rc=$?
        set -e
        local t1; t1=$(date +%s)
        local j="$dir/run-$(printf %02d "$i").json"
        local outcome last load
        outcome="$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.outcome)' "$j" 2>/dev/null || echo "NO-JSON")"
        last="$(node -e 'const r=require(process.argv[1]);process.stdout.write(String(r.lastWatchdog||r.lastLine||""))' "$j" 2>/dev/null || echo "")"
        load="$(cut -d' ' -f1 /proc/loadavg)"
        case "$outcome" in
            READY) ok=$((ok + 1)) ;;
            STALL) stall=$((stall + 1)) ;;
            *)     other=$((other + 1)) ;;
        esac
        printf 'run %02d/%s rc=%s %-6s %4ss load=%s  %s\n' \
            "$i" "$n" "$rc" "$outcome" "$((t1 - t0))" "$load" "${last:0:110}" | tee -a "$dir/TALLY.txt"
    done
    {
        echo "---"
        echo "label=$label n=$n READY=$ok STALL=$stall OTHER=$other"
        echo "failures k=$((stall + other))  rate=$(awk -v k=$((stall + other)) -v n="$n" 'BEGIN{printf "%.2f", k/n}')"
        echo "finished=$(date -u +%FT%TZ) load=$(cut -d' ' -f1-3 /proc/loadavg)"
    } | tee -a "$dir/TALLY.txt"
}

# The high-power variant of `batch`: each run unpacks the archive BOOT_REPEAT
# times and never boots Forge, so one browser launch buys R times the write
# operations -- the thing the race is per -- for about 1.3x the wall clock of a
# single full boot. See the spike.repeat comment in Bootstrap.java for why the
# per-boot rate is too low to test a fix against directly.
cmd_unpackrate() {
    BOOT_MAIN=none \
    BOOT_REPEAT="${BOOT_REPEAT:-5}" \
    BOOT_READY='BOOT ALLDONE' \
    cmd_batch "$@" --home 0x0
}

cmd_serve() { exec node "$SHARED/serve.mjs" "$WWW" "$PORT"; }

case "${1:-boot}" in
    build) shift || true; cmd_build "$@" ;;
    stage) shift || true; cmd_stage "$@" ;;
    boot)  shift || true; cmd_boot "$@" ;;
    batch) shift || true; cmd_batch "$@" ;;
    unpackrate) shift || true; cmd_unpackrate "$@" ;;
    serve) shift || true; cmd_serve "$@" ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
