/**
 * What a host agent needs to run this coordinator's bridge: the JDK, the Forge
 * jar (the pin), a trimmed `res` and the compiled bridge, each packed once from
 * what the local `JvmHostConfig` already points at and named by its sha256.
 * The agent checks every byte against that name before it keeps it
 * (`apps/agent/src/store.ts`), so its code never comes from a path CI can write.
 *
 * Beside them, the draft bot service (`draftbot.json` at the repo root pins its
 * commit): checked out and installed here once per pin, because a claw has no
 * egress, then packed and pushed the same way.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import pin from '../../../../../draftbot.json' with { type: 'json' };
import { basename, dirname, join } from 'node:path';

import { bridgeLaunch, type JvmHostConfig } from '../host.js';
import type { AgentClient } from './client.js';
import type { RemoteRuntime } from './launcher.js';
import { JVM_ARTIFACT_KINDS, sha256Hex, type ArtifactKind, type ArtifactSet, type JvmArtifactKind } from '@hadoku/host-wire';

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

/** A command, off the event loop; rejects with the tail of its stderr. */
function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
		child.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)));
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ''}: ${stderr.trim() || `exit ${String(code)}`}`))));
	});
}

/** `tar`, off the event loop: a new pin's `res` takes it ~12 s on hokon. */
const tarInto = (part: string, dir: string, excludes: string[]): Promise<void> =>
	exec('tar', ['-czf', part, ...excludes.map((e) => `--exclude=${basename(dir)}/${e}`), '-C', dirname(dir), basename(dir)]).catch((err: unknown) => {
		throw new Error(`tar ${dir}: ${(err as Error).message}`);
	});

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

export interface Packed {
	file: string;
	sha: string;
}

export interface PackedRuntime {
	files: Record<JvmArtifactKind, Packed>;
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

type Log = (entry: Record<string, unknown>) => void;
type Installed = Partial<Record<ArtifactKind, { sha: string }[]>>;

/** Push and install `packed` as `kind` unless the agent holds it already (`installed`, its `/status`). */
async function pushOne(client: AgentClient, installed: Installed, kind: ArtifactKind, { file, sha }: Packed, log: Log): Promise<void> {
	if (installed[kind]?.some((e) => e.sha === sha) === true) return;
	const started = Date.now();
	await client.call('PUT', `/blob/${sha}`, { file, sha });
	await client.call('POST', '/install', { kind, sha });
	log({ evt: 'agent-artifact', agent: client.url.host, kind, sha, bytes: statSync(file).size, ms: Date.now() - started });
}

const installedOn = async (client: AgentClient): Promise<Installed> => (await client.call<{ artifacts: Installed }>('GET', '/status')).artifacts;

/** Push and install whatever of `runtime` the agent lacks. Returns what launches name. */
export async function pushRuntime(client: AgentClient, runtime: PackedRuntime, log: Log = () => {}): Promise<RemoteRuntime> {
	const installed = await installedOn(client);
	const artifacts = {} as ArtifactSet;
	for (const kind of JVM_ARTIFACT_KINDS) {
		await pushOne(client, installed, kind, runtime.files[kind], log);
		artifacts[kind] = runtime.files[kind].sha;
	}
	return { artifacts, main: runtime.main };
}

/* ── The draft bot service ── */

/** Which draft bot ships: a commit of a git repo, from `draftbot.json`. */
export interface DraftbotPin {
	/** What `git clone` takes. */
	repo: string;
	commit: string;
}
export const DRAFTBOT_PIN: DraftbotPin = pin;

const preparing = new Map<string, Promise<string>>();

/**
 * The pinned draft bot, checked out and installed under `cache/<commit>`, once per pin: `git clone`
 * (this host's git credentials reach the private repo), `npm ci --omit=dev` in both packages, the
 * weights checked against `WEIGHTS.sha256`, `.git` dropped. Built in a `.part` directory and renamed
 * whole, so a directory there is a finished one, and two servers (prod and PPE) can race for it.
 */
export function prepareDraftbot(cache: string, p: DraftbotPin = DRAFTBOT_PIN, log: Log = () => {}): Promise<string> {
	const dir = join(cache, p.commit);
	if (existsSync(dir)) return Promise.resolve(dir);
	const inFlight = preparing.get(dir);
	if (inFlight !== undefined) return inFlight;
	const part = `${dir}.part-${process.pid}`;
	const nodeBin = dirname(process.execPath);
	const npm = existsSync(join(nodeBin, 'npm')) ? join(nodeBin, 'npm') : 'npm';
	const env = { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? '/usr/bin:/bin'}` };
	const prepared = (async () => {
		const started = Date.now();
		mkdirSync(cache, { recursive: true });
		rmSync(part, { recursive: true, force: true });
		try {
			await exec('git', ['clone', '--quiet', '--no-checkout', p.repo, part]);
			await exec('git', ['-C', part, 'checkout', '--quiet', '--detach', p.commit]);
			for (const pkg of ['packages/utils', 'packages/recommenderService']) await exec(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(part, pkg), env });
			await exec('sha256sum', ['--quiet', '-c', 'WEIGHTS.sha256'], { cwd: join(part, 'packages', 'recommenderService') });
			rmSync(join(part, '.git'), { recursive: true, force: true });
			if (existsSync(dir)) rmSync(part, { recursive: true, force: true });
			else renameSync(part, dir);
		} catch (err) {
			rmSync(part, { recursive: true, force: true });
			throw new Error(`draftbot ${p.commit.slice(0, 12)}: ${(err as Error).message}`, { cause: err });
		}
		log({ evt: 'draftbot-prepared', commit: p.commit, dir, ms: Date.now() - started });
		return dir;
	})().finally(() => preparing.delete(dir));
	preparing.set(dir, prepared);
	return prepared;
}

/** The pinned draft bot as an artifact: prepared once, packed once, shared by every claw. */
export async function packDraftbot(cache: string, p: DraftbotPin = DRAFTBOT_PIN, log: Log = () => {}): Promise<Packed> {
	const dir = await prepareDraftbot(join(cache, 'draftbot'), p, log);
	return packDir(join(cache, 'agent-artifacts'), 'draftbot', `draftbot\n${p.commit}`, dir, []);
}

/** Push and install the draft bot unless the agent holds it. Returns its sha, what `{op:'draftbot'}` names. */
export async function pushDraftbot(client: AgentClient, packed: Packed, log: Log = () => {}): Promise<string> {
	await pushOne(client, await installedOn(client), 'draftbot', packed, log);
	return packed.sha;
}
