#!/bin/bash
# Entry point: the devkit's land.sh (packages/devkit/src/lanes/), run with this repo's devkit.config.json.
exec env DEVKIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)" bash "$(dirname "$0")/../packages/devkit/src/lanes/land.sh" "$@"
