#!/usr/bin/env bash
#
# Wave 14, lane A -- TeaVM against the Forge CLIENT, not the engine.
#
# D7 (scripts/spike/run.sh, docs/spikes/teavm-go-no-go.md) linked forge-core +
# forge-game -- the ENGINE -- and died on 30 missing APIs. The engine does not
# need to be in a browser; it runs on the host in a real JVM. This driver asks the
# question nobody asked: what does the CLIENT reach?
#
# Everything happens OUTSIDE the repo (decision D2):
#   $SPIKE_CACHE/forge                 a copy of the vendored clone
#   $SPIKE_CACHE/client-wasm-target    this overlay's Maven build directory
# forge/ is never built in and never modified.
#
# The toolchain is deliberately off PATH (D14): Temurin JDK 21 and Maven 3.9.16
# under ~/.local/opt. `which mvn` finds nothing; that is not a missing
# toolchain.
#
# Usage:
#   ./run.sh copy-forge          copy the vendored clone into the cache
#   ./run.sh build-forge         mvn install -pl forge-gui-mobile -am
#   ./run.sh link [MainClass]    TeaVM link attempt; writes the missing-API list
#   ./run.sh missing [MainClass] re-print the last missing-API list, with counts
#   ./run.sh all                 copy-forge, build-forge, link every entry point
#   ./run.sh verify-pristine     prove the vendored clone is unmodified
#
# Entry points:
#   clientspike.ViewLayerMain        trackable view layer only, no libGDX
#   clientspike.UpdatePhaseMain      one protocol method: the shortest route to Game
#   clientspike.GuiSurfaceMinusMain  IGuiGame's 106 methods minus the eight below
#   clientspike.GuiSurfaceMain       all 106, i.e. the whole inbound surface
#   clientspike.NetClientMain        the above plus NetGameController's 15 outbound

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w14a-spike}"
VENDORED_FORGE="${VENDORED_FORGE:-$HOME/repos/hadoku-cardtable/forge}"
FORGE_COPY="$SPIKE_CACHE/forge"
BUILD_DIR="$SPIKE_CACHE/client-wasm-target"

MVN_HOME="${MVN_HOME:-$HOME/.local/opt/apache-maven-3.9.16}"
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"

MAIN_DEFAULT="clientspike.GuiSurfaceMain"
ENTRIES=(clientspike.ViewLayerMain clientspike.UpdatePhaseMain
         clientspike.GuiSurfaceMinusMain clientspike.GuiSurfaceMain clientspike.NetClientMain)

use_toolchain() {
    if [[ ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- see scripts/spike/run.sh bootstrap" >&2
        exit 1
    fi
    if [[ ! -x "$MVN_HOME/bin/mvn" ]]; then
        echo "no Maven at \$MVN_HOME=$MVN_HOME -- see scripts/spike/run.sh bootstrap" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$MVN_HOME/bin:$PATH"
}

cmd_copy_forge() {
    [[ -d "$VENDORED_FORGE" ]] || { echo "no vendored clone at $VENDORED_FORGE" >&2; exit 1; }
    mkdir -p "$SPIKE_CACHE"
    rm -rf "$FORGE_COPY"
    cp -a "$VENDORED_FORGE" "$FORGE_COPY"
    du -sh "$FORGE_COPY"
}

cmd_build_forge() {
    use_toolchain
    # The exit code is checked EXPLICITLY, and loudly.
    #
    # This used to be a bare `( cd ... && mvn install ... )` subshell, and on
    # 2026-09-20 a Checkstyle failure in forge-gui-mobile made maven print
    # BUILD FAILURE while this function returned 0. `link` then ran against the
    # PREVIOUS jar and reported a missing-API count for code that had not been
    # built — a number that looked like a result and meant nothing. It was
    # caught only because the jar's mtime did not match the edit.
    #
    # A measurement harness that silently measures a stale artifact is worse
    # than one that crashes, so this refuses to continue.
    local rc=0
    ( cd "$FORGE_COPY" && mvn install -pl forge-gui-mobile -am -DskipTests ) || rc=$?
    if (( rc != 0 )); then
        echo "" >&2
        echo "BUILD FAILED (mvn exit $rc). NOT installing, NOT measuring." >&2
        echo "Anything you link now would measure the previously installed jar." >&2
        return "$rc"
    fi

    # Forge uses ${revision} CI-friendly versioning without flatten-maven-plugin,
    # so the installed child POMs name their parent forge:forge:${revision}
    # literally. Shim the local repository rather than patch forge/ (see D7).
    local repo="${MAVEN_REPO_LOCAL:-$HOME/.m2/repository}"
    local shim='$'"{revision}"
    mkdir -p "$repo/forge/forge/$shim"
    cp "$repo/forge/forge/2.0.15-SNAPSHOT/forge-2.0.15-SNAPSHOT.pom" \
       "$repo/forge/forge/$shim/forge-$shim.pom"
    rm -f "$repo/forge/forge/$shim/forge-$shim.pom.lastUpdated"
}

log_for()     { echo "$SPIKE_CACHE/link-${1}.log"; }
missing_for() { echo "$SPIKE_CACHE/missing-${1}.txt"; }

# TeaVM reports an unresolved reference as
#   [ERROR] Method a.b.C.d()V was not found
#   [ERROR] Class a.b.C was not found
#   [ERROR] Field a.b.C.e was not found
# and repeats it once per call site. One line per distinct API is what we count.
extract_missing() {
    local log="$1"
    # grep exits 1 on a clean link; that is a result, not a script failure.
    grep -oE '(Method|Class|Field) [^ ]+ was not found' "$log" \
        | sed -E 's/ was not found$//' \
        | sort -u || true
}

cmd_link() {
    use_toolchain
    local main="${1:-$MAIN_DEFAULT}"
    local target="${SPIKE_TARGET_TYPE:-WEBASSEMBLY_GC}"
    local profiles="teavm${SPIKE_EXTRA_PROFILES:+,$SPIKE_EXTRA_PROFILES}"
    local tag="${main##*.}${target:+.$target}${SPIKE_EXTRA_PROFILES:+.$SPIKE_EXTRA_PROFILES}"
    local log; log="$(log_for "$tag")"
    local rc=0

    # TeaVM writes nothing on link errors; delete the previous entry point's
    # artifact so "artifact: none written" below cannot report a stale one.
    rm -f "$BUILD_DIR/wasm/client.wasm"

    ( cd "$SPIKE_DIR" && mvn -P"$profiles" \
        -Dspike.mainClass="$main" \
        -Dspike.targetType="$target" \
        process-classes ) > "$log" 2>&1 || rc=$?

    echo "=== $main ($target) -> exit $rc"
    extract_missing "$log" > "$(missing_for "$tag")"
    echo "distinct missing APIs: $(wc -l < "$(missing_for "$tag")")"
    echo "log:     $log"
    echo "missing: $(missing_for "$tag")"
    if [[ -f "$BUILD_DIR/wasm/client.wasm" ]]; then
        echo "artifact: $(stat -c%s "$BUILD_DIR/wasm/client.wasm") B"
    else
        echo "artifact: none written"
    fi
    return $rc
}

cmd_missing() {
    local tag="${1:-GuiSurfaceMain.WEBASSEMBLY_GC}"
    local f; f="$(missing_for "$tag")"
    [[ -f "$f" ]] || { echo "no such list: $f -- run ./run.sh link first" >&2; exit 1; }
    cat "$f"
    echo "--- $(wc -l < "$f") distinct"
}

cmd_all() {
    cmd_copy_forge
    cmd_build_forge
    local e rc
    for e in "${ENTRIES[@]}"; do
        rc=0
        cmd_link "$e" || rc=$?
        echo "(exit $rc)"
        echo
    done
    cmd_verify_pristine
}

cmd_verify_pristine() {
    echo "git -C $VENDORED_FORGE status --porcelain:"
    git -C "$VENDORED_FORGE" status --porcelain
    echo "(empty above == unmodified)"
    git -C "$VENDORED_FORGE" log -1 --format='HEAD %H %s'
}

case "${1:-all}" in
    copy-forge)      cmd_copy_forge ;;
    build-forge)     cmd_build_forge ;;
    link)            shift; cmd_link "$@" ;;
    missing)         shift; cmd_missing "$@" ;;
    all)             cmd_all ;;
    verify-pristine) cmd_verify_pristine ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
