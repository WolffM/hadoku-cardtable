/** Entry point: the devkit's player.ts (packages/devkit/src/telemetry/player.ts), run with this repo's devkit.config.json. */
import { fileURLToPath } from 'node:url';

import { main } from '../../packages/devkit/src/telemetry/player.ts';

process.exit(await main(process.argv.slice(2), fileURLToPath(new URL('../..', import.meta.url))));
