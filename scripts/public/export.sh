#!/usr/bin/env bash
# Copy a snapshot of this repo into a clone of the public one and commit it.
#
#   bash scripts/public/export.sh <public clone dir> [ref, default origin/main]
#
# This repo stays private and keeps the whole history. The public repo gets
# one commit per export: the tree at <ref>, less everything `exclude.txt`
# names, with the forge submodule pinned at the same commit. It never pushes; push the clone yourself after reading the commit.
#
# Refuses a snapshot that would carry an image file, since image bytes never
# enter either repo (AGENTS.md).

set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <public clone dir> [ref]" >&2
  exit 2
fi

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
target=$(cd "$1" && pwd)
ref=${2:-origin/main}

if [ ! -d "$target/.git" ]; then
  echo "export: $target is not a git clone" >&2
  exit 2
fi
if [ -n "$(git -C "$target" status --porcelain)" ]; then
  echo "export: $target has uncommitted changes" >&2
  exit 2
fi

sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
forge=$(git -C "$repo" ls-tree "$sha" forge | awk '$2 == "commit" { print $3 }')
if [ -z "$forge" ]; then
  echo "export: $ref has no forge submodule entry" >&2
  exit 1
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
git -C "$repo" archive "$sha" | tar -x -C "$stage"

while IFS= read -r path; do
  case "$path" in '' | '#'*) continue ;; esac
  rm -rf "${stage:?}/$path"
done < "$repo/scripts/public/exclude.txt"

images=$(find "$stage" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.avif' \) -printf '%P\n')
if [ -n "$images" ]; then
  echo "export: refusing, the snapshot carries image files:" >&2
  echo "$images" >&2
  exit 1
fi

# git archive writes the submodule as an empty directory; the gitlink is staged below.
rmdir "$stage/forge"
rsync -a --delete --exclude=/.git --exclude=/forge "$stage/" "$target/"

# An empty directory where the submodule goes, as a fresh clone has it.
mkdir -p "$target/forge"
git -C "$target" add -A
git -C "$target" update-index --add --cacheinfo "160000,$forge,forge"
if git -C "$target" diff --cached --quiet; then
  echo "export: nothing changed since the last snapshot"
  exit 0
fi
git -C "$target" commit -q -m "Snapshot of hadoku-cardtable ${sha:0:12}"
echo "export: committed $(git -C "$target" rev-parse --short HEAD) in $target (from ${sha:0:12}, forge ${forge:0:12}); not pushed"
