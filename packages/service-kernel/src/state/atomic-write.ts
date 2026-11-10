/** Write JSON to `target` atomically: a temp file beside it, synced, then renamed over it. */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
	await mkdir(join(target, '..'), { recursive: true });
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tmp, 'w');
	try {
		await handle.writeFile(JSON.stringify(data, null, 2));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, target);
}
