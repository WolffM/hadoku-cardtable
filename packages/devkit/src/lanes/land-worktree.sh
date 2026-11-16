#!/bin/bash
# Land one worktree's branch: scripts/land.sh, run inside it, with the packages token.
#
#   bash /home/hadoku/repos/hadoku-cardtable/scripts/lanes/land-worktree.sh [--dry-run] <name|worktree path>
#
# <name> is a directory under the main checkout's .claude/worktrees/; `--dry-run` passes to land.sh,
# and prove-and-land.sh lands through here too. One
# command, so one permission rule allows it; the long form it replaces (cd into the main
# checkout for its .devvault.local.json, Node 24 on PATH, NODE_AUTH_TOKEN unset, dev-vault,
# pipefail around the tail) was a chain the permission check reads part by part.
# The vault wrapper is the config's `land.devVault`, Node its `nodeBin`; the land runs the
# worktree's own `scripts/land.sh` entry point, so a worktree lands with its own devkit.
# land.sh's exit is this script's exit: it landed only if the output says `land: pushed`.
#
# The arguments are exactly that form. Anything else (a flag after the worktree, an unknown flag,
# a second worktree) is refused with exit 2 before anything runs: a `--dry-run` this script
# did not read is a real land.
set -euo pipefail
USAGE='usage: land-worktree.sh [--dry-run] <worktree name under .claude/worktrees/ | worktree path>'
DRY=''; [ "${1:-}" = --dry-run ] && { DRY=--dry-run; shift; }
{ [ $# = 1 ] && [[ $1 != -* ]]; } || { echo "$USAGE" >&2; exit 2; }
NAME=$1
# shellcheck source=../lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"; devkit_load

# The main checkout: the git common dir's, where .devvault.local.json lives.
ROOT=$(dirname "$(git -C "$DK_ROOT" rev-parse --path-format=absolute --git-common-dir)")
case $NAME in
  /*) WT=$NAME ;;
  *) [[ $NAME =~ ^[A-Za-z0-9._-]+$ ]] || { echo "$USAGE" >&2; exit 2; }
     WT=$ROOT/.claude/worktrees/$NAME ;;
esac
git -C "$ROOT" worktree list --porcelain | grep -xF "worktree $WT" >/dev/null || { echo "land-worktree: $WT is not a worktree of $ROOT" >&2; exit 2; }

cd "$ROOT"
export PATH=$DK_NODE_BIN:$PATH
unset NODE_AUTH_TOKEN
exec node "$DK_DEV_VAULT" -- bash -c 'cd "$1" && bash scripts/land.sh $2' land-worktree "$WT" "$DRY"
