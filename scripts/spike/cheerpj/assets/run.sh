#!/usr/bin/env bash
#
# Wave 15, lane B -- assets and the filesystem. This lane's OWN driver.
#
# Nothing here writes inside the repo or inside forge/ (decision D2). Everything
# it builds lands in $SPIKE_CACHE (default ~/.cache/w15b-assets) and the static
# site it serves is assembled there from copies. The patched Forge sources are a
# COPY of the vendored tree with this directory's patches applied; forge/ itself
# is never touched and `git submodule status forge` must be unchanged after any
# run here.
#
# The toolchain is off $PATH on purpose (decision D14): Temurin JDK 21 and Maven
# 3.9.16 under ~/.local/opt. `which javac` finding nothing is not a missing
# toolchain. Probes compile at --release 17: CheerpJ 4.3 refuses class files
# above major 61 and Forge itself is built at 17 (forge/pom.xml:27).
#
# Usage:
#   ./run.sh zip               build cardsfolder.zip from the vendored res tree
#   ./run.sh pristine          rsync a pristine COPY of forge/ into $SPIKE_CACHE
#   ./run.sh mkpatch           regenerate patches/ from the edited copy
#   ./run.sh build             compile the probes, stage the static site
#   ./run.sh probe-zip [small|full]   THE GATE: does java.util.zip work on /app/?
#   ./run.sh probe-xstream     the wall after the card data, isolated
#   ./run.sh patch             fresh copy + apply this lane's patches
#                              PATCH_SET='000[13]*' applies only those
#   ./run.sh patch-check       prove every patch reapplies from a fresh copy
#   ./run.sh build-forge       maven-build the PATCHED copy into a fat jar
#   ./run.sh stage-forge       stage the patched jar + res subset into www/
#   ./run.sh boot              run the patched Forge jar straight off /app/
#   ./run.sh bootzip           build res-boot.zip (the res slice a match needs)
#   ./run.sh boot-files        unpack res into /files/, then run Forge
#                              BOOT_WIPE=1 clears IndexedDB first (a cold run)
#                              BOOT_MARKER= runs on past the card load
#   ./run.sh serve             foreground static server on $PORT
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$(dirname "$HERE")"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w15b-assets}"
WWW="$SPIKE_CACHE/www"
PORT="${PORT:-8742}"

FORGE_SRC="${CARDTABLE_FORGE_SRC:-$HOME/repos/hadoku-cardtable/forge}"
FORGE_RES="${CARDTABLE_FORGE_RES:-$FORGE_SRC/forge-gui/res}"
FORGE_JAR="${CARDTABLE_FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}"
PRISTINE="$SPIKE_CACHE/forge-pristine"
WORK="$SPIKE_CACHE/forge-patched"
REPO="$(cd "$HERE/../../../.." && pwd)"

JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"
MVN_HOME="${MVN_HOME:-$(ls -d "$HOME"/.local/opt/apache-maven-* 2>/dev/null | head -1)}"
PW_CORE="${PW_CORE:-$(ls -d "$HOME"/repos/hadoku-cardtable/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core 2>/dev/null | tail -1)}"

use_toolchain() {
    if [[ -z "$JDK_HOME" || ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- look in ~/.local/opt (D14)" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$PATH"
    if [[ -n "$MVN_HOME" && -x "$MVN_HOME/bin/mvn" ]]; then
        export PATH="$MVN_HOME/bin:$PATH"
    fi
}

# --- the gate ---------------------------------------------------------------

cmd_zip() {
    use_toolchain
    mkdir -p "$SPIKE_CACHE/zipbuild" "$WWW"
    # Forge looks for <cardsfolder>/cardsfolder.zip and reads entries whose name
    # ends .txt (CardStorageReader:310). Entry names are relative to the zip
    # root, so zip from inside res/cardsfolder. The source tree is READ-ONLY --
    # `jar --create -C` never writes into it.
    local out_small="$SPIKE_CACHE/zipbuild/cardsfolder-small.zip"
    local out_full="$SPIKE_CACHE/zipbuild/cardsfolder.zip"
    if [[ ! -d "$FORGE_RES/cardsfolder" ]]; then
        echo "no cardsfolder at $FORGE_RES/cardsfolder" >&2; exit 1
    fi
    if [[ ! -f "$out_small" ]]; then
        rm -rf "$SPIKE_CACHE/zipbuild/small"
        mkdir -p "$SPIKE_CACHE/zipbuild/small/a"
        # ~400 cards: enough to exercise the central directory and deflate, small
        # enough to answer the gate question in seconds.
        # No `find | head`: head closing the pipe SIGPIPEs find, and under
        # `set -o pipefail` that is exit 141 on a command that did its job.
        local n=0
        while IFS= read -r f; do
            cp "$f" "$SPIKE_CACHE/zipbuild/small/a/"
            n=$((n + 1))
            [[ "$n" -ge 400 ]] && break
        done < <(find "$FORGE_RES/cardsfolder/a" -name '*.txt' | sort)
        echo "staged $n card files for the small zip"
        "$JAVA_HOME/bin/jar" --create --file "$out_small" -C "$SPIKE_CACHE/zipbuild/small" .
    fi
    if [[ ! -f "$out_full" ]]; then
        # -C, not a subshell cd: this process never has its cwd inside the
        # main checkout, and jar only ever writes to --file (outside the repo).
        "$JAVA_HOME/bin/jar" --create --file "$out_full" -C "$FORGE_RES/cardsfolder" .
    fi
    ls -l "$out_small" "$out_full"
}

cmd_build() {
    use_toolchain
    [[ -f "$FORGE_JAR" ]] || { echo "no Forge jar at $FORGE_JAR" >&2; exit 1; }
    rm -rf "$SPIKE_CACHE/classes"
    mkdir -p "$SPIKE_CACHE/classes" "$WWW"
    javac --release 17 -nowarn -cp "$FORGE_JAR" -d "$SPIKE_CACHE/classes" "$HERE"/java/spike/*.java
    "$JAVA_HOME/bin/jar" --create --file "$WWW/probe.jar" -C "$SPIKE_CACHE/classes" .
    cp -f "$HERE/index.html" "$WWW/index.html"
    echo "probe class file major version:"
    "$JAVA_HOME/bin/javap" -verbose -cp "$SPIKE_CACHE/classes" spike.ZipProbe | grep -E '^  major'
}

# serve + drive. $1 = query string, rest = drive.mjs flags.
drive() {
    local query="$1"; shift
    [[ -f "$WWW/probe.jar" ]] || { echo "not staged -- ./run.sh build first" >&2; exit 1; }
    # ALWAYS re-copy the page. A ?wipe=1 run once served a staged index.html
    # older than the source, so the wipe never happened and the run reported a
    # "cold" number it had not measured. The page is 5 KB; never serve a stale one.
    cp -f "$HERE/index.html" "$WWW/index.html"
    [[ -n "$PW_CORE" && -d "$PW_CORE" ]] || { echo "no playwright-core (\$PW_CORE=$PW_CORE)" >&2; exit 1; }
    node "$SHARED/serve.mjs" "$WWW" "$PORT" >/dev/null 2>&1 &
    local srv=$!
    trap 'kill '"$srv"' 2>/dev/null || true' EXIT
    local ok=0
    for _ in $(seq 1 50); do
        if curl -fs -o /dev/null "http://127.0.0.1:$PORT/index.html"; then ok=1; break; fi
        sleep 0.2
    done
    [[ "$ok" == "1" ]] || { echo "server never came up on $PORT" >&2; exit 1; }
    PW_CORE="$PW_CORE" node "$HERE/drive.mjs" "http://127.0.0.1:$PORT/index.html?$query" "$@"
}

cmd_probe_zip() {
    local which="${1:-small}"
    local src="$SPIKE_CACHE/zipbuild/cardsfolder-small.zip"
    [[ "$which" == "full" ]] && src="$SPIKE_CACHE/zipbuild/cardsfolder.zip"
    [[ -f "$src" ]] || { echo "no zip at $src -- ./run.sh zip first" >&2; exit 1; }
    mkdir -p "$WWW"
    cp -f "$src" "$WWW/cardsfolder.zip"
    ls -l "$WWW/cardsfolder.zip"
    drive "main=spike.ZipProbe&cp=/app/probe.jar&args=/app/cardsfolder.zip" \
        --marker 'PROBE zip end' --budget 300000
}

# --- the patched fork -------------------------------------------------------

# A pristine COPY of the vendored tree, outside the repo (D2). res/ is excluded:
# 462 MB that no pom references, and the build never reads it.
cmd_pristine() {
    if [[ -d "$PRISTINE/forge-core" ]] && [[ "${FORCE:-0}" != "1" ]]; then
        echo "pristine copy already at $PRISTINE (FORCE=1 to redo)"; return 0
    fi
    rm -rf "$PRISTINE"
    mkdir -p "$PRISTINE"
    rsync -a --exclude '.git' --exclude 'res/' --exclude 'target/' "$FORGE_SRC/" "$PRISTINE/"
    du -sh "$PRISTINE"
}

cmd_patch() {
    cmd_pristine
    rm -rf "$WORK"
    cp -a "$PRISTINE" "$WORK"
    local rc=0
    shopt -s nullglob
    # PATCH_SET narrows which patches go on, so "is this one actually needed"
    # can be answered by building without it rather than by reasoning about it.
    for p in "$HERE"/patches/${PATCH_SET:-*}.patch; do
        echo "== applying $(basename "$p")"
        # GNU patch, not `git apply`: $WORK is not a git work tree, on purpose --
        # nothing under ~/.cache should be able to write a ref anywhere near
        # forge/. Exit code is read directly, never through a pipe.
        patch -p1 -d "$WORK" --batch --forward -i "$p"
        local this=$?
        echo "   exit=$this"
        [[ "$this" -eq 0 ]] || rc=$this
    done
    shopt -u nullglob
    return $rc
}

# Prove every patch reapplies from a FRESH copy, and that forge/ is untouched.
cmd_patch_check() {
    FORCE=0 cmd_patch
    local rc=$?
    echo "== all patches applied, aggregate exit: $rc"
    echo "== git submodule status forge (must be -2ad70eb4...)"
    git -C "$REPO" submodule status forge
    echo "== git status of forge/ in this worktree (must be empty)"
    git -C "$REPO" status --porcelain -- forge
    return $rc
}

# Regenerate patches/ from $WORK against $PRISTINE, after hand-editing $WORK.
cmd_mkpatch() {
    cmd_pristine
    local rel out
    while IFS='|' read -r rel out; do
        [[ -n "$rel" ]] || continue
        diff -u --label "a/$rel" --label "b/$rel" "$PRISTINE/$rel" "$WORK/$rel" \
            > "$HERE/patches/$out" || true
        wc -l "$HERE/patches/$out"
    done < "$HERE/patches/MANIFEST"
}

cmd_build_forge() {
    use_toolchain
    [[ -d "$WORK/forge-core" ]] || { echo "no patched copy -- ./run.sh patch first" >&2; exit 1; }
    command -v mvn >/dev/null || { echo "no maven on PATH after use_toolchain" >&2; exit 1; }
    local log="$SPIKE_CACHE/forge-build.log"
    # Trap 7 of the wave handoff: a wrapper's exit code is NOT maven's verdict.
    # On 2026-09-20 a wrapper returned 0 on BUILD FAILURE and the next
    # measurement silently ran against the previous jar. Read maven's own line.
    set +e
    ( cd "$WORK" && mvn -pl forge-gui-desktop -am package -DskipTests -Dmaven.test.skip=true ) > "$log" 2>&1
    local mrc=$?
    set -e
    tail -5 "$log"
    echo "maven process exit: $mrc"
    if ! grep -q '^\[INFO\] BUILD SUCCESS' "$log"; then
        echo "MAVEN DID NOT PRINT 'BUILD SUCCESS' -- see $log" >&2
        exit 1
    fi
    ls -l --time-style=full-iso "$WORK"/forge-gui-desktop/target/*jar-with-dependencies*.jar
    echo "newest patched source mtime (the jar must be NEWER than this):"
    ls -l --time-style=full-iso "$WORK/forge-core/src/main/java/forge/CardStorageReader.java" \
        "$WORK/forge-gui-desktop/src/main/java/forge/GuiDesktop.java"
}

# Stage the patched jar and the res tree Forge needs, as FILES only: /app/ has no
# directories, so every path Forge opens must be an exact one. cardsfolder and
# tokenscripts go in as zips; nothing here copies an image into the repo.
cmd_stage_forge() {
    use_toolchain
    mkdir -p "$WWW/res"
    local jar
    jar=$(ls -t "$WORK"/forge-gui-desktop/target/*jar-with-dependencies*.jar 2>/dev/null | head -1)
    [[ -n "$jar" ]] || { echo "no patched jar -- ./run.sh build-forge first" >&2; exit 1; }
    cp -f "$jar" "$WWW/forge.jar"
    echo "staged jar:"; ls -l --time-style=full-iso "$WWW/forge.jar"

    # res/, minus the two heavy trees, which go in as archives instead.
    rsync -a --delete --exclude 'cardsfolder/' --exclude 'tokenscripts/' \
        "$FORGE_RES/" "$WWW/res/"
    mkdir -p "$WWW/res/cardsfolder" "$WWW/res/tokenscripts"
    [[ -f "$SPIKE_CACHE/zipbuild/cardsfolder.zip" ]] || cmd_zip
    cp -f "$SPIKE_CACHE/zipbuild/cardsfolder.zip" "$WWW/res/cardsfolder/cardsfolder.zip"
    # CardStorageReader looks for "<dir>/cardsfolder.zip" whatever <dir> is, so
    # the token archive carries the same file name inside tokenscripts/.
    if [[ ! -f "$SPIKE_CACHE/zipbuild/tokenscripts.zip" ]]; then
        "$JAVA_HOME/bin/jar" --create --file "$SPIKE_CACHE/zipbuild/tokenscripts.zip" \
            -C "$FORGE_RES/tokenscripts" .
    fi
    cp -f "$SPIKE_CACHE/zipbuild/tokenscripts.zip" "$WWW/res/tokenscripts/cardsfolder.zip"
    du -sh "$WWW"
}

# Boot the patched Forge jar under CheerpJ.
#   user.dir   /app/  -- so a stray relative path lands on the mount
#   user.home  /files -- CheerpJ's writable IndexedDB mount; Forge's profile dirs
#                        (~/.forge) must be writable or FModel's mkdirs throws
#   forge.assetsDir    -- patch 0001
cmd_boot() {
    local budget="${BOOT_BUDGET:-300000}"
    drive "jar=/app/forge.jar&userdir=/app/&props=user.home%3D/files%7Cforge.assetsDir%3D/app/" \
        --marker 'Read cards:' --marker 'CardReader :' --budget "$budget" \
        --screenshot "$SPIKE_CACHE/boot.png"
}

# The boot archive: the slice of res/ that a MATCH needs, as one zip, to be
# unpacked into CheerpJ's writable /files/ mount by spike.Bootstrap.
#
# Left out on purpose, and each is a measured size, not a guess:
#   adventure 153M  music 17M  quest 38M   -- no match path reads them
#   languages/* except en-US (59M total)   -- cardnames-*.txt are per-locale
#   skins/* except default (18M total)     -- one skin is one skin
#   cardsfolder raw 132M                   -- goes in as its own 16M archive,
#                                             read by Forge's existing zip path
BOOT_DIRS="${BOOT_DIRS:-ai blockdata cube defaults draft editions effects formats lists setlookup sealed tutorial licenses fonts sound deckgendecks geneticaidecks conquest puzzle tokenscripts}"

cmd_bootzip() {
    use_toolchain
    local stage="$SPIKE_CACHE/bootstage"
    local out="$SPIKE_CACHE/zipbuild/res-boot.zip"
    if [[ -f "$out" && "${FORCE:-0}" != "1" ]]; then
        echo "boot zip already at $out (FORCE=1 to redo)"; ls -l "$out"; return 0
    fi
    rm -rf "$stage"
    mkdir -p "$stage/res" "$SPIKE_CACHE/zipbuild"
    local d
    for d in $BOOT_DIRS; do
        [[ -d "$FORGE_RES/$d" ]] || { echo "no res/$d -- skipping" >&2; continue; }
        rsync -a "$FORGE_RES/$d" "$stage/res/"
    done
    mkdir -p "$stage/res/skins" "$stage/res/languages" "$stage/res/cardsfolder"
    rsync -a "$FORGE_RES/skins/default" "$stage/res/skins/"
    cp -f "$FORGE_RES/languages/en-US.properties" "$stage/res/languages/"
    [[ -f "$FORGE_RES/howto.txt" ]] && cp -f "$FORGE_RES/howto.txt" "$stage/res/"
    [[ -f "$SPIKE_CACHE/zipbuild/cardsfolder.zip" ]] || cmd_zip
    cp -f "$SPIKE_CACHE/zipbuild/cardsfolder.zip" "$stage/res/cardsfolder/cardsfolder.zip"
    echo "boot stage size:"; du -sh "$stage"
    "$JAVA_HOME/bin/jar" --create --file "$out" -C "$stage" .
    ls -l "$out"
    mkdir -p "$WWW"
    cp -f "$out" "$WWW/res-boot.zip"
}

# Boot Forge through spike.Bootstrap: unpack res into /files/, then hand off to
# forge.view.Main against a filesystem that HAS directories.
#   user.home  /files      -- Forge's profile dirs (~/.forge) must be writable
#   forge.assetsDir /files/ -- patch 0001
cmd_boot_files() {
    local budget="${BOOT_BUDGET:-600000}"
    [[ -f "$WWW/res-boot.zip" ]] || { echo "no res-boot.zip -- ./run.sh bootzip first" >&2; exit 1; }
    # BOOT_MARKER overrides where the run stops: the default stops as soon as the
    # card database is in, and a later marker (or an empty one) lets Forge keep
    # going so the transcript shows what it does next.
    local marker="${BOOT_MARKER-Read cards:}"
    local extra=()
    [[ -n "$marker" ]] && extra=(--marker "$marker")
    local wipe=""
    [[ "${BOOT_WIPE:-0}" == "1" ]] && wipe="&wipe=1"
    drive "main=spike.Bootstrap&cp=/app/probe.jar:/app/forge.jar&args=/app/res-boot.zip%7C/files/%7Cforge.view.Main&userdir=/files/&props=user.home%3D/files%7Cforge.assetsDir%3D/files/$wipe" \
        "${extra[@]}" ${BOOT_TWICE:+--twice} --budget "$budget" \
        --screenshot "$SPIKE_CACHE/boot-files.png"
}

# Isolate the wall that comes AFTER the card data (see java/spike/XStreamProbe).
cmd_probe_xstream() {
    # XS_FIX=1 sets java.vm.vendor before touching XStream.
    # XS_VENDOR sets java.vm.vendor before XStream is touched.
    local a=""
    [[ -n "${XS_VENDOR:-}" ]] && a="&args=$(printf %s "$XS_VENDOR" | sed 's/ /%20/g')"
    drive "main=spike.XStreamProbe&cp=/app/probe.jar:/app/forge.jar$a" \
        --marker 'PROBE xstream end' --budget 180000
}

cmd_serve() { exec node "$SHARED/serve.mjs" "$WWW" "$PORT"; }

case "${1:-probe-zip}" in
    zip)         shift; cmd_zip "$@" ;;
    pristine)    shift; cmd_pristine "$@" ;;
    mkpatch)     shift; cmd_mkpatch "$@" ;;
    build)       shift; cmd_build "$@" ;;
    probe-zip)   shift; cmd_probe_zip "$@" ;;
    patch)       shift; cmd_patch "$@" ;;
    patch-check) shift; cmd_patch_check "$@" ;;
    build-forge) shift; cmd_build_forge "$@" ;;
    stage-forge) shift; cmd_stage_forge "$@" ;;
    boot)        shift; cmd_boot "$@" ;;
    bootzip)     shift; cmd_bootzip "$@" ;;
    boot-files)  shift; cmd_boot_files "$@" ;;
    probe-xstream) shift; cmd_probe_xstream "$@" ;;
    serve)       shift; cmd_serve "$@" ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
