/** Entry point: the devkit's credits.ts (packages/devkit/src/release/credits.ts), run with this repo's devkit.config.json. */
import { fileURLToPath } from 'node:url';

import { main } from '../../packages/devkit/src/release/credits.ts';

await main(process.argv.slice(2), fileURLToPath(new URL('../..', import.meta.url)));
