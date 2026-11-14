/** Entry point: the devkit's collect.ts (packages/devkit/src/release/collect.ts), run with this repo's devkit.config.json. */
import { fileURLToPath } from 'node:url';

import { main } from '../../packages/devkit/src/release/collect.ts';

await main(process.argv.slice(2), fileURLToPath(new URL('../..', import.meta.url)));
