import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultJava } from './local-jvm.ts';

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

	it('prefers the user-local Temurin over both (D14)', () => {
		const root = tree('home/.local/opt/jdk-21.0.1', 'home-jdk');
		const java = defaultJava({ HOME: join(root, 'home'), JAVA_HOME: join(root, 'home-jdk'), PATH: '' });
		expect(java).toBe(join(root, 'home/.local/opt/jdk-21.0.1', 'bin', 'java'));
	});

	it('is a bare java only when there is none to find', () => {
		const root = tree();
		expect(defaultJava({ HOME: join(root, 'home'), PATH: join(root, 'nowhere') })).toBe('java');
	});
});
