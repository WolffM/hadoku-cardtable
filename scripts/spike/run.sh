#!/usr/bin/env bash
#
# Wave 1, lane B -- TeaVM WASM GC go/no-go spike driver.
#
# Everything this script builds happens OUTSIDE the repo:
#   $SPIKE_CACHE/forge                 a copy of the vendored clone (never the original)
#   $SPIKE_CACHE/teavm-spike-target    the overlay's Maven build directory
# forge/ in the repo is a stock upstream clone and stays byte-for-byte pristine
# (decision D2). Nothing here writes to it.
#
# Prerequisites, both user-local, no sudo (decision D14):
#   $JDK_HOME    a real JDK -- the host ships only openjdk-21-jre, which has no
#                javac and no lib/ct.sym, so --release 17 fails
#   $MVN_HOME    Apache Maven; upstream Forge ships no mvnw
# Run `./run.sh bootstrap` to install both.
#
# Usage:
#   ./run.sh bootstrap        install Maven + a JDK under ~/.local, no sudo
#   ./run.sh copy-forge       copy the vendored clone into the cache
#   ./run.sh build-forge      stock `mvn install -pl forge-core,forge-game -am`
#   ./run.sh gen-controller   regenerate SpikePlayerController.java
#   ./run.sh jvm [MainClass]  JVM baseline run          (default spike.SpikeMain)
#   ./run.sh wasm [MainClass] TeaVM WASM GC compile + run under Node
#   ./run.sh all              everything above, in order
#   ./run.sh verify-pristine  prove the vendored clone is unmodified

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_DIR="$REPO_ROOT/scripts/spike"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w1-spike}"
VENDORED_FORGE="${VENDORED_FORGE:-$HOME/repos/hadoku-cardtable/forge}"
FORGE_COPY="$SPIKE_CACHE/forge"
BUILD_DIR="$SPIKE_CACHE/teavm-spike-target"

MAVEN_VERSION="${MAVEN_VERSION:-3.9.16}"
MVN_HOME="${MVN_HOME:-$HOME/.local/opt/apache-maven-$MAVEN_VERSION}"
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"

MAIN_CLASS_DEFAULT="spike.SpikeMain"

use_toolchain() {
    if [[ ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- run './run.sh bootstrap'" >&2
        exit 1
    fi
    if [[ ! -x "$MVN_HOME/bin/mvn" ]]; then
        echo "no Maven at \$MVN_HOME=$MVN_HOME -- run './run.sh bootstrap'" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$MVN_HOME/bin:$PATH"
}

cmd_bootstrap() {
    mkdir -p "$HOME/.local/opt" "$HOME/.local/bin" "$SPIKE_CACHE"

    if [[ ! -x "$MVN_HOME/bin/mvn" ]]; then
        local url="https://dlcdn.apache.org/maven/maven-3/$MAVEN_VERSION/binaries/apache-maven-$MAVEN_VERSION-bin.tar.gz"
        curl -fsSL -o "$SPIKE_CACHE/maven.tar.gz" "$url"
        curl -fsSL -o "$SPIKE_CACHE/maven.tar.gz.sha512" "$url.sha512"
        (cd "$SPIKE_CACHE" && echo "$(cat maven.tar.gz.sha512)  maven.tar.gz" | sha512sum -c -)
        tar -xzf "$SPIKE_CACHE/maven.tar.gz" -C "$HOME/.local/opt"
        ln -sf "$MVN_HOME/bin/mvn" "$HOME/.local/bin/mvn"
    fi
    "$MVN_HOME/bin/mvn" -v

    # the host has openjdk-21-jre only: no javac, no lib/ct.sym, so
    # `--release 17` fails with "release version 17 not supported".
    if [[ -z "$JDK_HOME" || ! -x "$JDK_HOME/bin/javac" ]]; then
        curl -fsSL -o "$SPIKE_CACHE/jdk21.tar.gz" \
            "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
        tar -xzf "$SPIKE_CACHE/jdk21.tar.gz" -C "$HOME/.local/opt"
        JDK_HOME="$(ls -d "$HOME"/.local/opt/jdk-21* | head -1)"
    fi
    "$JDK_HOME/bin/javac" -version
}

cmd_copy_forge() {
    if [[ ! -d "$VENDORED_FORGE" ]]; then
        echo "no vendored clone at $VENDORED_FORGE" >&2
        exit 1
    fi
    mkdir -p "$SPIKE_CACHE"
    rm -rf "$FORGE_COPY"
    cp -a "$VENDORED_FORGE" "$FORGE_COPY"
    du -sh "$FORGE_COPY"
}

cmd_build_forge() {
    use_toolchain
    ( cd "$FORGE_COPY" && time mvn install -pl forge-core,forge-game -am -DskipTests )

    # Forge uses ${revision} CI-friendly versioning WITHOUT flatten-maven-plugin,
    # so the installed child POMs name their parent as forge:forge:${revision}
    # literally and are unresolvable by any downstream project. Shim the local
    # repository rather than patch forge/.
    local repo="${MAVEN_REPO_LOCAL:-$HOME/.m2/repository}"
    local shim='$'"{revision}"
    mkdir -p "$repo/forge/forge/$shim"
    cp "$repo/forge/forge/2.0.15-SNAPSHOT/forge-2.0.15-SNAPSHOT.pom" \
       "$repo/forge/forge/$shim/forge-$shim.pom"
    rm -f "$repo/forge/forge/$shim/forge-$shim.pom.lastUpdated"
}

spike_classpath() {
    use_toolchain
    ( cd "$SPIKE_DIR/teavm" && mvn -q dependency:build-classpath \
        -Dmdep.outputFile="$BUILD_DIR/cp.txt" >/dev/null )
    echo "$BUILD_DIR/classes:$(cat "$BUILD_DIR/cp.txt")"
}

cmd_gen_controller() {
    use_toolchain
    ( cd "$SPIKE_DIR/teavm" && mvn -q compile )
    java -cp "$(spike_classpath)" "$SPIKE_DIR/gen-controller-stub.java" \
        "$SPIKE_DIR/teavm/src/main/java/spike/SpikePlayerController.java"
}

cmd_jvm() {
    use_toolchain
    local main="${1:-$MAIN_CLASS_DEFAULT}"
    ( cd "$SPIKE_DIR/teavm" && mvn -q -Dspike.mainClass="$main" \
        -Dexec.args="$FORGE_COPY/forge-gui/res" compile exec:java )
}

cmd_wasm() {
    use_toolchain
    local main="${1:-$MAIN_CLASS_DEFAULT}"
    ( cd "$SPIKE_DIR/teavm" && mvn -Pteavm -Dspike.mainClass="$main" process-classes )
    ls -l "$BUILD_DIR/wasm/spike.wasm"
    node "$SPIKE_DIR/run-wasm.mjs" "$BUILD_DIR/wasm"
}

cmd_verify_pristine() {
    echo "git -C $VENDORED_FORGE status --porcelain:"
    git -C "$VENDORED_FORGE" status --porcelain
    echo "(empty above == unmodified)"
    git -C "$VENDORED_FORGE" log -1 --format='HEAD %H %s'
}

cmd_all() {
    cmd_bootstrap
    cmd_copy_forge
    cmd_build_forge
    cmd_gen_controller
    cmd_jvm
    cmd_wasm
    cmd_verify_pristine
}

case "${1:-all}" in
    bootstrap)       cmd_bootstrap ;;
    copy-forge)      cmd_copy_forge ;;
    build-forge)     cmd_build_forge ;;
    gen-controller)  cmd_gen_controller ;;
    jvm)             shift; cmd_jvm "$@" ;;
    wasm)            shift; cmd_wasm "$@" ;;
    verify-pristine) cmd_verify_pristine ;;
    all)             cmd_all ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
