/**
 * What a host agent needs to run this coordinator's bridge: the JDK, the Forge
 * jar (the pin), a trimmed `res` and the compiled bridge, each packed once from
 * what the local `JvmHostConfig` already points at and named by its sha256.
 * The agent checks every byte against that name before it keeps it
 * (`apps/agent/src/store.ts`), so its code never comes from a path CI can write.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { bridgeLaunch, type JvmHostConfig } from '../host.js';
import type { AgentClient } from './client.js';
import type { RemoteRuntime } from './launcher.js';
import { ARTIFACT_KINDS, sha256Hex, type ArtifactKind, type ArtifactSet } from './wire.js';

/** Forge `res` subtrees the bridge never reads (as `scripts/stress/run.sh` trims them). */
export const RES_EXCLUDES = ['adventure', 'music', 'skins'];
/** JDK parts a running JVM never reads. */
export const JDK_EXCLUDES = ['jmods', 'lib/src.zip', 'man', 'demo'];

function hashFile(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(file)
			.on('data', (c) => hash.update(c))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/** `tar`, off the event loop: a new pin's `res` takes it ~12 s on hokon. */
function tarInto(part: string, dir: string, excludes: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const tar = spawn('tar', ['-czf', part, ...excludes.map((e) => `--exclude=${basename(dir)}/${e}`), '-C', dirname(dir), basename(dir)], { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		tar.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
		tar.on('error', (err) => reject(new Error(`tar ${dir}: ${err.message}`)));
		tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar ${dir}: ${stderr.trim() || `exit ${String(code)}`}`))));
	});
}

/** Packs in flight, by tarball: every claw connects at once, and they share one. */
const packing = new Map<string, Promise<{ file: string; sha: string }>>();

/**
 * `dir` as a gzipped tarball with one top directory, kept in `cache` under a
 * name for `identity` (a tarball's own bytes vary with mtimes, so the identity
 * is what decides it, not the bytes).
 *
 * Never synchronous: prod's v0.53.0 restart (2026-11-06 16:00Z) packed the new pin's `res` with a
 * blocking `tar` for 12.5 s, and nothing else on the server ran until it was done.
 */
export function packDir(cache: string, kind: string, identity: string, dir: string, excludes: string[]): Promise<{ file: string; sha: string }> {
	const file = join(cache, `${kind}-${sha256Hex(identity).slice(0, 32)}.tgz`);
	const shaFile = `${file}.sha256`;
	if (existsSync(file) && existsSync(shaFile)) return Promise.resolve({ file, sha: readFileSync(shaFile, 'utf8').trim() });
	const inFlight = packing.get(file);
	if (inFlight !== undefined) return inFlight;
	const part = `${file}.part`;
	const packed = (async () => {
		mkdirSync(cache, { recursive: true });
		try {
			await tarInto(part, dir, excludes);
		} catch (err) {
			rmSync(part, { force: true });
			throw err;
		}
		renameSync(part, file);
		const sha = await hashFile(file);
		writeFileSync(shaFile, `${sha}\n`);
		return { file, sha };
	})().finally(() => packing.delete(file));
	packing.set(file, packed);
	return packed;
}

export interface PackedRuntime {
	files: Record<ArtifactKind, { file: string; sha: string }>;
	main: string;
}

/** The JDK, the jar and its trimmed `res`: what every remote JVM runs on, whatever its main class. */
export async function packBase(config: Pick<JvmHostConfig, 'java' | 'jar' | 'res'>, cache: string): Promise<Omit<PackedRuntime['files'], 'bridge'>> {
	const jar = { file: config.jar, sha: await hashFile(config.jar) };
	const jdkHome = realpathSync(dirname(dirname(config.java)));
	const jdk = await packDir(cache, 'jdk', `${jdkHome}\n${statSync(join(jdkHome, 'release')).mtimeMs}`, jdkHome, JDK_EXCLUDES);
	// `res` moves with the pin: the jar's sha names the build it belongs to.
	const res = await packDir(cache, 'res', `${realpathSync(config.res)}\n${jar.sha}`, realpathSync(config.res), RES_EXCLUDES);
	return { jdk, jar, res };
}

/** Pack (once) everything a remote `--host` bridge JVM runs on. */
export async function packRuntime(config: JvmHostConfig, cache: string, log: (entry: Record<string, unknown>) => void = () => {}): Promise<PackedRuntime> {
	const bridge = bridgeLaunch(config, log);
	if (bridge.how !== 'compiled') throw new Error('the bridge did not compile here; a remote JVM needs its classes');
	const [cp, main] = bridge.args.slice(1) as [string, string];
	const classes = cp.split(':')[0] as string;
	return { files: { ...(await packBase(config, cache)), bridge: await packDir(cache, 'bridge', classes, classes, []) }, main };
}

/** Push and install whatever of `runtime` the agent lacks. Returns what launches name. */
export async function pushRuntime(client: AgentClient, runtime: PackedRuntime, log: (entry: Record<string, unknown>) => void = () => {}): Promise<RemoteRuntime> {
	const status = await client.call<{ artifacts: Record<ArtifactKind, { sha: string }[]> }>('GET', '/status');
	const artifacts = {} as ArtifactSet;
	for (const kind of ARTIFACT_KINDS) {
		const { file, sha } = runtime.files[kind];
		artifacts[kind] = sha;
		if (status.artifacts[kind].some((e) => e.sha === sha)) continue;
		const started = Date.now();
		await client.call('PUT', `/blob/${sha}`, { file, sha });
		await client.call('POST', '/install', { kind, sha });
		log({ evt: 'agent-artifact', agent: client.url.host, kind, sha, bytes: statSync(file).size, ms: Date.now() - started });
	}
	return { artifacts, main: runtime.main };
}
