/** Prints this tree's build version (build-version.ts). apps/server's build writes it to dist/version.txt. */
import { fileURLToPath } from 'node:url';

import { buildVersion } from './build-version.ts';

process.stdout.write(`${buildVersion(fileURLToPath(new URL('../..', import.meta.url)))}\n`);
