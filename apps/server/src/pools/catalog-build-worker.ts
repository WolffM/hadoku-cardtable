/**
 * `runBuildCatalog` on a worker thread: the entry `refresh.ts`'s `buildInWorker` starts, bundled
 * beside the server as `dist/catalog-build-worker.js` (`package.json`'s `build`).
 *
 * The build reads the whole Scryfall bulk file (~190 MB) as one string and parses it: measured
 * 2026-11-10 at a 1.9 s single block and ~0.9–1.5 GB of heap. On the server's own thread that froze
 * every socket for that long, twice a day on PPE. Here it costs the worker's own heap, freed
 * when the worker exits.
 *
 * One message back, then the thread ends: `{ ok: true, result }` or `{ ok: false, message }`.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { runBuildCatalog, type RunBuildCatalogOptions } from '@hadoku/carddata';

const port = parentPort;
if (port === null) throw new Error('catalog-build-worker runs only as a worker thread');

try {
	const result = await runBuildCatalog(workerData as RunBuildCatalogOptions);
	port.postMessage({ ok: true, result });
} catch (err) {
	port.postMessage({ ok: false, message: (err as Error).message });
}
