/** Prints this tree's build version (packages/devkit/src/release/build-version.ts). apps/server's build writes it to dist/version.txt. */
import { fileURLToPath } from 'node:url';

import { buildVersion } from '../../packages/devkit/src/release/build-version.ts';

process.stdout.write(`${buildVersion(fileURLToPath(new URL('../..', import.meta.url)))}\n`);
