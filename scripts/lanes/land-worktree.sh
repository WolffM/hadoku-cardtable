#!/bin/bash
# Land one worktree's branch: scripts/land.sh, run inside it, with the packages token.
#
#   bash /home/hadoku/repos/hadoku-cardtable/scripts/lanes/land-worktree.sh <name>
#
# <name> is a directory under .claude/worktrees/ of the checkout this script sits in. One
# command, so one permission rule allows it; the long form it replaces (cd into the main
# checkout for its .devvault.local.json, Node 24 on PATH, NODE_AUTH_TOKEN unset, dev-vault,
# pipefail around the tail) was a chain the permission check reads part by part.
# land.sh's exit is this script's exit: it landed only if the output says `land: pushed`.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NAME=${1:-}
[[ $NAME =~ ^[A-Za-z0-9._-]+$ ]] || { echo "usage: land-worktree.sh <worktree name under .claude/worktrees/>" >&2; exit 2; }
WT=$ROOT/.claude/worktrees/$NAME
git -C "$ROOT" worktree list --porcelain | grep -qxF "worktree $WT" || { echo "land-worktree: $WT is not a worktree of $ROOT" >&2; exit 2; }

cd "$ROOT"
export PATH=$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH
unset NODE_AUTH_TOKEN
exec node ../hadoku_site/scripts/secrets/dev-vault.mjs -- bash -c 'cd "$1" && bash scripts/land.sh' land-worktree "$WT"
