import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DRAFTBOT_PIN, packDir, prepareDraftbot } from './artifacts.js';
import type { AgentClient } from './client.js';
import { RemoteJvmLauncher, type RemoteRuntime } from './launcher.js';
import { sha256Hex } from './wire.js';

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory worth a few hundred ms of `tar -czf`: incompressible bytes. */
function bigDir(): { dir: string; cache: string } {
	const root = mkdtempSync(join(tmpdir(), 'ct-pack-'));
	scratch.push(root);
	const dir = join(root, 'res');
	mkdirSync(dir);
	for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.bin`), randomBytes(4 << 20));
	return { dir, cache: join(root, 'cache') };
}

// Prod's v0.53.0 restart (2026-11-06 16:00Z) packed the new pin's `res` with a blocking `tar`:
// 12.5 s in which nothing else on the server ran.
describe('packDir', () => {
	it('packs off the event loop, and claws connecting at once share one pack', async () => {
		const { dir, cache } = bigDir();
		// Ticks while the tarball is still being written: none at all if `tar` holds the event loop.
		let ticks = 0;
		const clock = setInterval(() => {
			if (existsSync(cache) && readdirSync(cache).some((f) => f.endsWith('.part'))) ticks += 1;
		}, 2);
		const [a, b] = await Promise.all([packDir(cache, 'res', 'id-1', dir, []), packDir(cache, 'res', 'id-1', dir, [])]);
		clearInterval(clock);
		expect(ticks, 'timers ran while tar did').toBeGreaterThan(3);
		expect(b).toEqual(a);
		expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
		expect(readdirSync(cache).sort()).toEqual([`${a.file.split('/').at(-1)}`, `${a.file.split('/').at(-1)}.sha256`]);
		// Packed once: the next ask reads the sha file.
		await expect(packDir(cache, 'res', 'id-1', dir, [])).resolves.toEqual(a);
	});

	it('a failed tar leaves no part file, and says why', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ct-pack-'));
		scratch.push(root);
		await expect(packDir(join(root, 'cache'), 'res', 'id-2', join(root, 'missing'), [])).rejects.toThrow(/^tar /);
		expect(readdirSync(join(root, 'cache'))).toEqual([]);
	});
});

/** The parts of an `AgentClient` a launcher uses, recording what it sends. */
function fakeClient(): { client: AgentClient; sent: { op: string }[] } {
	const sent: { op: string }[] = [];
	const client = {
		lost: null,
		send: (m: { op: string }) => sent.push(m),
		register: () => {},
		unregister: () => {},
	} as unknown as AgentClient;
	return { client, sent };
}

const RUNTIME: RemoteRuntime = { artifacts: { jdk: 'a', jar: 'b', res: 'c', bridge: 'd' }, main: 'Main' } as RemoteRuntime;

describe('RemoteJvmLauncher', () => {
	it('attaches at once while the runtime is still on its way, and launches only once it is there', async () => {
		const { client, sent } = fakeClient();
		let arrive = (_: RemoteRuntime): void => {};
		const launcher = new RemoteJvmLauncher(client, new Promise<RemoteRuntime>((r) => (arrive = r)));
		launcher.attach('h-adopted');
		launcher.launch('h-new', { xmxMb: 512 });
		await Promise.resolve();
		expect(sent.map((m) => m.op)).toEqual(['attach']);
		arrive(RUNTIME);
		await new Promise((r) => setImmediate(r));
		expect(sent).toMatchObject([{ op: 'attach' }, { op: 'launch', hostId: 'h-new', artifacts: RUNTIME.artifacts, main: 'Main' }]);
	});

	it('a launch released before the runtime arrives is never sent', async () => {
		const { client, sent } = fakeClient();
		let arrive = (_: RemoteRuntime): void => {};
		const launcher = new RemoteJvmLauncher(client, new Promise<RemoteRuntime>((r) => (arrive = r)));
		launcher.launch('h-new', { xmxMb: 512 }).release();
		arrive(RUNTIME);
		await new Promise((r) => setImmediate(r));
		expect(sent.map((m) => m.op)).toEqual(['release']);
	});

	it('a runtime the agent could not be given ends the launch with why', async () => {
		const { client, sent } = fakeClient();
		const launcher = new RemoteJvmLauncher(client, Promise.reject(new Error('claw-9 cannot be given this server\'s pin: disk full')));
		const exited = new Promise<string>((r) => launcher.launch('h-new', { xmxMb: 512 }).onExit(r));
		await expect(exited).resolves.toBe("the agent could not be given this server's runtime: claw-9 cannot be given this server's pin: disk full");
		expect(sent).toEqual([]);
	});
});

/** A draft bot repo in miniature: both packages with nothing to install, one weight file and its checksum. */
function draftbotRepo(): { repo: string; commit: string; cache: string } {
	const root = mkdtempSync(join(tmpdir(), 'ct-draftbot-'));
	scratch.push(root);
	const repo = join(root, 'repo');
	for (const pkg of ['utils', 'recommenderService']) {
		mkdirSync(join(repo, 'packages', pkg), { recursive: true });
		writeFileSync(join(repo, 'packages', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }));
		writeFileSync(join(repo, 'packages', pkg, 'package-lock.json'), JSON.stringify({ name: pkg, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: pkg, version: '1.0.0' } } }));
	}
	writeFileSync(join(repo, 'packages', 'recommenderService', 'w.bin'), 'weights');
	writeFileSync(join(repo, 'packages', 'recommenderService', 'WEIGHTS.sha256'), `${sha256Hex('weights')}  w.bin\n`);
	const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
	git('init', '--quiet');
	git('add', '.');
	git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'draftbot');
	return { repo, commit: git('rev-parse', 'HEAD'), cache: join(root, 'cache') };
}

describe('the draft bot artifact', () => {
	it('is pinned to a full commit', () => {
		expect(DRAFTBOT_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it('prepares the pinned commit once, whole, with no .git, shared by everyone asking at once', async () => {
		const { repo, commit, cache } = draftbotRepo();
		const [a, b] = await Promise.all([prepareDraftbot(cache, { repo, commit }), prepareDraftbot(cache, { repo, commit })]);
		expect(b).toBe(a);
		expect(a).toBe(join(cache, commit));
		expect(readdirSync(cache)).toEqual([commit]);
		expect(existsSync(join(a, '.git'))).toBe(false);
		expect(readFileSync(join(a, 'packages', 'recommenderService', 'w.bin'), 'utf8')).toBe('weights');
		expect(await prepareDraftbot(cache, { repo, commit })).toBe(a);
	});

	it('keeps nothing when a step fails: weights that do not match their checksum', async () => {
		const { repo, cache } = draftbotRepo();
		writeFileSync(join(repo, 'packages', 'recommenderService', 'w.bin'), 'tampered');
		execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'tampered']);
		const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
		await expect(prepareDraftbot(cache, { repo, commit })).rejects.toThrow(new RegExp(`^draftbot ${commit.slice(0, 12)}: sha256sum`));
		expect(readdirSync(cache)).toEqual([]);
	});
});
