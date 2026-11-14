#!/bin/bash
# Entry point: the devkit's daily.sh (packages/devkit/src/telemetry/), run with this repo's devkit.config.json.
exec env DEVKIT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)" bash "$(dirname "$0")/../../packages/devkit/src/telemetry/daily.sh" "$@"
