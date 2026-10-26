#!/usr/bin/env bash
# C6 of docs/planning/hosting-test-plan.md: the work dir's filesystem fills mid-match.
# Run as `unshare -rm bash c6-disk-full.sh <e2e dir>` after the env block in breakit.spec.ts's
# header: the user + mount namespace lets a 300 MB tmpfs sit over e2e's play-work root for this
# run only, with no root and nothing visible outside it.
set -euo pipefail
cd "${1:?usage: unshare -rm bash c6-disk-full.sh <e2e dir>}"
mkdir -p .run/play-work
mount -t tmpfs -o size=300m tmpfs .run/play-work
timeout 900 npx playwright test zz-breakit.spec.ts -g "C6 "
