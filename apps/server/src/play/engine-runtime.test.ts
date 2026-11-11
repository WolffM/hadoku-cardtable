import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultJava, makeFifos, openJvmIo } from './engine-runtime.ts';

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch tree with an executable `java` (and `javac`) at each of `jdks`' bin dirs. */
function tree(...jdks: string[]): string {
	const root = mkdtempSync(join(tmpdir(), 'default-java-'));
	made.push(root);
	mkdirSync(join(root, 'home'));
	for (const jdk of jdks) {
		mkdirSync(join(root, jdk, 'bin'), { recursive: true });
		for (const tool of ['java', 'javac']) {
			writeFileSync(join(root, jdk, 'bin', tool), '#!/bin/sh\n');
			chmodSync(join(root, jdk, 'bin', tool), 0o755);
		}
	}
	return root;
}

describe('defaultJava', () => {
	it('follows the java on PATH to the JDK it links into, so javac is found beside it', () => {
		const root = tree('jdk');
		mkdirSync(join(root, 'usr-bin'));
		symlinkSync(join(root, 'jdk', 'bin', 'java'), join(root, 'usr-bin', 'java'));
		const java = defaultJava({ HOME: join(root, 'home'), PATH: [join(root, 'empty'), join(root, 'usr-bin')].join(':') });
		expect(java).toBe(join(root, 'jdk', 'bin', 'java'));
	});

	it('prefers JAVA_HOME over PATH', () => {
		const root = tree('home-jdk', 'path-jdk');
		const java = defaultJava({ HOME: join(root, 'home'), JAVA_HOME: join(root, 'home-jdk'), PATH: join(root, 'path-jdk', 'bin') });
		expect(java).toBe(join(root, 'home-jdk', 'bin', 'java'));
	});

	it('ignores a user-local ~/.local/opt JDK: the fleet manages the JDK on PATH (D14, amended)', () => {
		const root = tree('home/.local/opt/jdk-21.0.1', 'fleet-jdk');
		mkdirSync(join(root, 'usr-local-bin'));
		symlinkSync(join(root, 'fleet-jdk', 'bin', 'java'), join(root, 'usr-local-bin', 'java'));
		const java = defaultJava({ HOME: join(root, 'home'), PATH: join(root, 'usr-local-bin') });
		expect(java).toBe(join(root, 'fleet-jdk', 'bin', 'java'));
	});

	it('is a bare java only when there is none to find', () => {
		const root = tree();
		expect(defaultJava({ HOME: join(root, 'home'), PATH: join(root, 'nowhere') })).toBe('java');
	});
});

describe("openJvmIo's stdin", () => {
	it('never blocks on a fifo nobody drains, and delivers every line in order once someone does', async () => {
		const run = mkdtempSync(join(tmpdir(), 'jvm-io-'));
		made.push(run);
		makeFifos(run);
		const logged: Record<string, unknown>[] = [];
		const io = openJvmIo(run, (e) => logged.push(e));
		// 400 KiB, past any fifo's buffer, with no reader: a JVM that died before reading its stdin.
		const sent = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(1019)}`);
		for (const line of sent) io.write(line);
		// Still here, and the event loop still turns.
		await new Promise<void>((r) => setImmediate(r));
		expect(logged.map((e) => e.evt)).toEqual(['bridge-stdin-full']);

		// Now the JVM reads (its own, separate open of the fifo).
		const reader = openSync(join(run, 'in.fifo'), constants.O_RDONLY | constants.O_NONBLOCK);
		const want = sent.map((l) => `${l}\n`).join('');
		const chunks: Buffer[] = [];
		let got = 0;
		const buf = Buffer.alloc(65536);
		await vi.waitFor(
			() => {
				for (;;) {
					let n = 0;
					try {
						n = readSync(reader, buf);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
					}
					if (n <= 0) break;
					chunks.push(Buffer.from(buf.subarray(0, n)));
					got += n;
				}
				expect(got).toBe(want.length);
			},
			{ timeout: 10_000, interval: 10 },
		);
		closeSync(reader);
		io.close();
		expect(Buffer.concat(chunks).toString()).toBe(want);
		expect(logged.map((e) => e.evt)).toEqual(['bridge-stdin-full', 'bridge-stdin-drained']);
	});
});
