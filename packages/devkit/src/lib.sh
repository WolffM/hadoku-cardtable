# Sourced by every devkit shell script: finds a Node that runs .ts (24+), then reads the repo's
# devkit.config.json through config.ts (the schema) into `DK_*` variables.
#
#   . "$(dirname "$0")/../lib.sh"; devkit_load        # in a script one directory below src/
#
# The repo is $DEVKIT_ROOT (an app's entry point sets it to its own checkout), else the checkout
# the working directory is in. A config that does not validate stops the script with its issues.
# shellcheck shell=bash
DK_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The first Node >= 24: $DEVKIT_NODE, the one on PATH, then fnm's newest. A cron's PATH and a
# host's /usr/local/bin node can be older, and an older one cannot run the .ts files.
dk_pick_node() {
  local n major
  for n in ${DEVKIT_NODE:-} "$(command -v node || true)" \
    $(ls -d "$HOME"/.local/share/fnm/node-versions/v*/installation/bin/node 2>/dev/null | sort -rV); do
    [ -x "$n" ] || continue
    major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [ "$major" -ge 24 ] && { echo "$n"; return 0; }
  done
  echo "devkit: no Node 24 or newer found (set DEVKIT_NODE)" >&2
  return 1
}

devkit_load() {
  local root vars
  DK_NODE=$(dk_pick_node) || exit 2
  root=${DEVKIT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}
  [ -n "$root" ] || { echo "devkit: not in a git checkout; set DEVKIT_ROOT to the repo that holds devkit.config.json" >&2; exit 2; }
  vars=$("$DK_NODE" "$DK_SRC/config.ts" --root "$root" shell) || exit 2
  eval "$vars"
  # The scripts this one runs read the same repo's config.
  export DEVKIT_ROOT=$DK_ROOT DEVKIT_NODE=$DK_NODE
}

# An override named after the app: `dk_env CLAIMS` reads $<envPrefix>_CLAIMS.
dk_env() { local v="${DK_ENV_PREFIX}_$1"; printf '%s' "${!v:-}"; }
