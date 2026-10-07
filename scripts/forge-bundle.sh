#!/usr/bin/env bash
# scripts/forge-bundle.sh — resolve this checkout's Forge bundle (forge.jar +
# forge-gui/res), building and caching it per the `forge` submodule's pin if
# it is not already cached.
#
# No arguments. Run from a checkout root (it reads `git ls-tree HEAD forge`
# in the current directory). See docs/FORGE_JAR.md, "CI on the claws".
#
# Cache layout: ${CARDTABLE_FORGE_CACHE:-$HOME/.cache/cardtable-forge}/<pin>/
#   forge.jar
#   res/                 (a copy of forge-gui/res from that pin)
#   .forge-bundle-marker (written by this script; prune() only ever removes
#                          a directory that carries this marker)
#
# stdout carries EXACTLY two lines on success, and nothing else:
#   CARDTABLE_FORGE_JAR=<abs path>
#   CARDTABLE_FORGE_RES=<abs path>
# Every log line (HIT/BUILD, timing, bundle size, every error) goes to
# stderr. Exit is non-zero on any failure, with the reason on stderr: a
# missing pin, a fetch failure, a build failure, a jar that fails
# verification, or a res/ without cardsfolder/.

set -euo pipefail

FORGE_BUNDLE_REMOTE="${FORGE_BUNDLE_REMOTE:-https://github.com/WolffM/forge.git}"
KEEP_PINS=3

log() { printf 'forge-bundle: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not on PATH: $1"
}

# ── jar verification ────────────────────────────────────────────────────────
# Mirrors docs/FORGE_JAR.md step 3: the fork carries exactly two commits on
# top of upstream (strip Sentry, implement `forge server`), and a jar built
# from the wrong tree fails quietly rather than with a build error — so this
# greps the compiled class instead of trusting the checkout.
#
# The claws have no `unzip` and almost certainly no `strings` on PATH — only
# hokon is guaranteed to carry them. So the class is extracted by whichever
# of three tools is actually present, in order: `unzip -p` (streams it
# straight out), the JDK's own `jar` tool (every claw has it via the jdk21
# label; `jar xf` extracts relative to cwd, so it runs inside its own temp
# dir with an absolute jar path), then `python3`'s zipfile module. Dying with
# all three named beats a cryptic failure from whichever one happened to be
# tried last.
extract_main_class() {
  local jar="$1" dest="$2" extract_dir extract_base

  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$jar" forge/view/Main.class >"$dest" 2>/dev/null && return 0
  fi

  if command -v jar >/dev/null 2>&1; then
    extract_base="${SCRATCH_BASE:-${TMPDIR:-$CACHE_ROOT/.scratch}}"
    mkdir -p "$extract_base"
    extract_dir=$(mktemp -d "$extract_base/forge-bundle-extract.XXXXXX")
    if (cd "$extract_dir" && jar xf "$jar" forge/view/Main.class) >/dev/null 2>&1 \
      && [ -f "$extract_dir/forge/view/Main.class" ]; then
      cp "$extract_dir/forge/view/Main.class" "$dest"
      rm -rf "$extract_dir"
      return 0
    fi
    rm -rf "$extract_dir"
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("forge/view/Main.class"))' "$jar" >"$dest" 2>/dev/null && return 0
  fi

  log "cannot extract forge/view/Main.class to verify it: none of unzip, jar, python3 is on PATH (or all failed)"
  return 1
}

verify_jar() {
  local jar="$1" class_file extract_base

  extract_base="${SCRATCH_BASE:-${TMPDIR:-$CACHE_ROOT/.scratch}}"
  mkdir -p "$extract_base"
  class_file=$(mktemp "$extract_base/forge-bundle-mainclass.XXXXXX")

  if ! extract_main_class "$jar" "$class_file"; then
    rm -f "$class_file"
    return 1
  fi

  # Printable-byte runs, one per line — equivalent to `strings` for finding
  # an exact token like "server" in a class file full of binary bytecode.
  if ! tr -c '[:print:]' '\n' <"$class_file" | grep -qx server; then
    log "jar verification failed: forge/view/Main.class does not contain the string 'server' (wrong build, or forge server was not implemented in this tree)"
    rm -f "$class_file"
    return 1
  fi
  if tr -c '[:print:]' '\n' <"$class_file" | grep -qi sentry; then
    log "jar verification failed: forge/view/Main.class still contains 'sentry' — the Sentry DSN was not stripped from this tree"
    rm -f "$class_file"
    return 1
  fi
  rm -f "$class_file"
  return 0
}

is_complete() {
  [ -f "$JAR" ] && [ -d "$RES/cardsfolder" ]
}

# ── prune ───────────────────────────────────────────────────────────────────
# Keep the newest KEEP_PINS bundles (by marker mtime) under the cache root,
# plus whichever pin this run is serving even if it falls outside that
# window. Only ever touches a directory that carries OUR marker file — never
# something else living under the cache root.
prune() {
  local d candidates=() newest_first keep=() kept=0 serving_kept=0 k is_kept

  for d in "$CACHE_ROOT"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    [ -f "$d/.forge-bundle-marker" ] || continue
    candidates+=("$d")
  done
  [ "${#candidates[@]}" -gt 0 ] || return 0

  newest_first=$(
    for d in "${candidates[@]}"; do
      printf '%s\t%s\n' "$(stat -c %Y "$d/.forge-bundle-marker" 2>/dev/null || echo 0)" "$d"
    done | sort -rn | cut -f2
  )

  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ "$kept" -lt "$KEEP_PINS" ]; then
      keep+=("$d")
      kept=$((kept + 1))
    fi
  done <<<"$newest_first"

  for k in "${keep[@]}"; do
    [ "$k" = "$BUNDLE_DIR" ] && serving_kept=1
  done
  if [ "$serving_kept" -eq 0 ] && [ -f "$BUNDLE_DIR/.forge-bundle-marker" ]; then
    keep+=("$BUNDLE_DIR")
  fi

  for d in "${candidates[@]}"; do
    is_kept=0
    for k in "${keep[@]}"; do
      [ "$k" = "$d" ] && is_kept=1 && break
    done
    if [ "$is_kept" -eq 0 ]; then
      log "prune: removing $(basename "$d") (older than the newest $KEEP_PINS pins, and not the pin being served)"
      rm -rf "$d"
    fi
  done
}

print_result() {
  printf 'CARDTABLE_FORGE_JAR=%s\n' "$JAR"
  printf 'CARDTABLE_FORGE_RES=%s\n' "$RES"
}

# ── resolve the pin and the cache paths ─────────────────────────────────────

require_tool git
require_tool awk
require_tool flock
require_tool mktemp

PIN=$(git ls-tree HEAD forge 2>/dev/null | awk '{print $3}') || true
[ -n "${PIN:-}" ] || die "git ls-tree HEAD forge returned no pin — is the forge submodule entry missing from this commit?"

CACHE_ROOT="${CARDTABLE_FORGE_CACHE:-$HOME/.cache/cardtable-forge}"
mkdir -p "$CACHE_ROOT"
CACHE_ROOT=$(cd "$CACHE_ROOT" && pwd)

BUNDLE_DIR="$CACHE_ROOT/$PIN"
JAR="$BUNDLE_DIR/forge.jar"
RES="$BUNDLE_DIR/res"

LOCK_DIR="$CACHE_ROOT/.locks"
mkdir -p "$LOCK_DIR"
LOCKFILE="$LOCK_DIR/$PIN.lock"

# fd form only — `flock -x L -- cmd` exits 69 on hokon and runs nothing.
exec 9>"$LOCKFILE"
flock 9

if is_complete; then
  log "HIT: pin $PIN already cached at $BUNDLE_DIR"
  touch "$BUNDLE_DIR/.forge-bundle-marker" 2>/dev/null || true
  print_result
  prune
  exit 0
fi

# ── BUILD ────────────────────────────────────────────────────────────────────

log "BUILD: pin $PIN not cached (or incomplete), building"
build_start=$(date +%s)

SCRATCH_BASE="${RUNNER_TEMP:-${TMPDIR:-$CACHE_ROOT/.scratch}}"
mkdir -p "$SCRATCH_BASE"
CLONE_DIR=$(mktemp -d "$SCRATCH_BASE/forge-bundle-clone.XXXXXX")
trap 'rm -rf "$CLONE_DIR"' EXIT

require_tool git
log "cloning $FORGE_BUNDLE_REMOTE at $PIN into $CLONE_DIR"
git -C "$CLONE_DIR" init -q
git -C "$CLONE_DIR" remote add origin "$FORGE_BUNDLE_REMOTE"
if ! git -C "$CLONE_DIR" fetch --depth 1 origin "$PIN"; then
  die "failed to fetch forge pin $PIN from $FORGE_BUNDLE_REMOTE"
fi
if ! git -C "$CLONE_DIR" checkout -q FETCH_HEAD; then
  die "failed to check out forge pin $PIN after fetching it"
fi

[ -d "$CLONE_DIR/forge-gui/res/cardsfolder" ] || die "forge-gui/res has no cardsfolder/ in pin $PIN's checkout — refusing to cache a broken res"

require_tool mvn
log "running mvn package for forge-gui-desktop (a cold ~/.m2 downloads dependencies here — expected on a first build)"
mvn_start=$(date +%s)
if ! (cd "$CLONE_DIR" && mvn -q -pl forge-gui-desktop -am clean package -DskipTests -Dmaven.test.skip=true) >&2; then
  die "mvn build failed for forge pin $PIN"
fi
mvn_elapsed=$(($(date +%s) - mvn_start))
log "mvn build finished in ${mvn_elapsed}s"

JAR_SRC=""
for f in "$CLONE_DIR"/forge-gui-desktop/target/*-jar-with-dependencies.jar; do
  [ -f "$f" ] || continue
  JAR_SRC="$f"
  break
done
[ -n "$JAR_SRC" ] || die "no *-jar-with-dependencies.jar under forge-gui-desktop/target after the build"

verify_jar "$JAR_SRC" || die "jar verification failed for forge pin $PIN"

BUILD_TMP=$(mktemp -d "$CACHE_ROOT/.build-$PIN.XXXXXX")
cp "$JAR_SRC" "$BUILD_TMP/forge.jar"
cp -a "$CLONE_DIR/forge-gui/res" "$BUILD_TMP/res"
printf 'built by scripts/forge-bundle.sh\npin=%s\nbuilt_at=%s\n' "$PIN" "$(date -u +%FT%TZ)" >"$BUILD_TMP/.forge-bundle-marker"

rm -rf "$BUNDLE_DIR"
mv "$BUILD_TMP" "$BUNDLE_DIR"

rm -rf "$CLONE_DIR"
trap - EXIT

build_elapsed=$(($(date +%s) - build_start))
bundle_size=$(du -sh "$BUNDLE_DIR" 2>/dev/null | cut -f1)
log "BUILD finished in ${build_elapsed}s total (mvn ${mvn_elapsed}s of it); bundle size ${bundle_size:-?} at $BUNDLE_DIR"

print_result
prune
