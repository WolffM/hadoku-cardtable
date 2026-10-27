/**
 * The artifacts a JVM runs on: the JDK, the Forge jar, a trimmed `res` and the
 * compiled bridge, each named by its sha256 and checked against it before it is
 * kept. The coordinator pushes them (`PUT /blob/<sha>`), so no path CI can
 * write ever becomes code the agent runs (forge-hosting-plan §6).
 *
 *   blobs/<sha>              what arrived, verified
 *   <kind>/<sha>/            a tarball kind, unpacked (jdk, res, bridge)
 *   artifacts.json           { kind: [{ sha, at }] }, newest last
 *
 * A jar is used as its blob. Each kind keeps its two most recent installs
 * (and anything a live JVM still runs on); older ones are deleted.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { ARTIFACT_KINDS, SHA256, type ArtifactKind, type ArtifactSet } from '../../server/src/play/remote/wire.ts';

export const KEEP_PER_KIND = 2;

/** sha256 of a file, streamed: a JDK tarball is too big to hold in the slice. */
export function hashFile(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(file)
			.on('data', (c) => hash.update(c))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')));
	});
}

type Manifest = Record<ArtifactKind, { sha: string; at: number }[]>;

export class Store {
	private readonly blobs: string;
	private readonly manifestFile: string;

	constructor(
		private readonly home: string,
		private readonly now: () => number = Date.now,
	) {
		this.blobs = join(home, 'blobs');
		this.manifestFile = join(home, 'artifacts.json');
		mkdirSync(this.blobs, { recursive: true });
	}

	/** Stream a blob in; it is kept only if its bytes hash to `sha`. */
	async put(sha: string, body: Readable): Promise<void> {
		if (!SHA256.test(sha)) throw new Error('blob name is not a sha256');
		const part = join(this.blobs, `${sha}.part`);
		const hash = createHash('sha256');
		const out = createWriteStream(part);
		await new Promise<void>((resolve, reject) => {
			body.on('data', (c: Buffer) => {
				hash.update(c);
				out.write(c);
			});
			body.on('error', reject);
			body.on('end', () => out.end(resolve));
		});
		const got = hash.digest('hex');
		if (got !== sha) {
			rmSync(part, { force: true });
			throw new Error(`blob hashed to ${got}, not ${sha}`);
		}
		renameSync(part, join(this.blobs, sha));
	}

	has(sha: string): boolean {
		return existsSync(join(this.blobs, sha));
	}

	/**
	 * Make blob `sha` usable as a `kind`. The blob is hashed again first: a file
	 * on disk is not trusted because it was trusted when it arrived. A tarball's
	 * blob is deleted once unpacked.
	 */
	async install(kind: ArtifactKind, sha: string, inUse: ArtifactSet[] = []): Promise<string> {
		if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`unknown artifact kind ${kind}`);
		if (!SHA256.test(sha)) throw new Error('not a sha256');
		const at = this.path(kind, sha);
		if (this.installed(kind, sha) === null || !existsSync(at)) {
			const blob = join(this.blobs, sha);
			if (!existsSync(blob)) throw new Error(`no blob ${sha}`);
			const got = await hashFile(blob);
			if (got !== sha) {
				rmSync(blob, { force: true });
				throw new Error(`blob ${sha} on disk hashes to ${got}; deleted`);
			}
			if (kind !== 'jar') {
				await this.unpack(blob, at);
				// The unpacked tree is what runs; the tarball would only double the disk it takes.
				rmSync(blob, { force: true });
			}
		}
		const manifest = this.manifest();
		manifest[kind] = [...manifest[kind].filter((e) => e.sha !== sha), { sha, at: this.now() }];
		this.writeManifest(manifest);
		this.prune(kind, inUse);
		return at;
	}

	/** Where an installed artifact is, or null when it is not installed. */
	installed(kind: ArtifactKind, sha: string): string | null {
		return this.manifest()[kind].some((e) => e.sha === sha) ? this.path(kind, sha) : null;
	}

	list(): Manifest {
		return this.manifest();
	}

	private path(kind: ArtifactKind, sha: string): string {
		return kind === 'jar' ? join(this.blobs, sha) : join(this.home, kind, sha);
	}

	/** Keep the newest `KEEP_PER_KIND` of `kind` and whatever a live JVM runs on. */
	private prune(kind: ArtifactKind, inUse: ArtifactSet[]): void {
		const manifest = this.manifest();
		const entries = manifest[kind];
		const keep = new Set([...entries.slice(-KEEP_PER_KIND).map((e) => e.sha), ...inUse.map((a) => a[kind])]);
		for (const e of entries) {
			if (keep.has(e.sha)) continue;
			rmSync(join(this.home, kind, e.sha), { recursive: true, force: true });
			rmSync(join(this.blobs, e.sha), { force: true });
		}
		manifest[kind] = entries.filter((e) => keep.has(e.sha));
		this.writeManifest(manifest);
	}

	private manifest(): Manifest {
		const empty = Object.fromEntries(ARTIFACT_KINDS.map((k) => [k, []])) as unknown as Manifest;
		if (!existsSync(this.manifestFile)) return empty;
		return { ...empty, ...(JSON.parse(readFileSync(this.manifestFile, 'utf8')) as Partial<Manifest>) };
	}

	private writeManifest(m: Manifest): void {
		const tmp = `${this.manifestFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(m));
		renameSync(tmp, this.manifestFile);
	}

	/** A gzipped tarball with one top directory, unpacked into `into` whole or not at all. */
	private unpack(blob: string, into: string): Promise<void> {
		const next = `${into}.next`;
		rmSync(next, { recursive: true, force: true });
		mkdirSync(next, { recursive: true });
		return new Promise((resolve, reject) => {
			const tar = spawn('tar', ['-xzf', blob, '-C', next, '--strip-components=1', '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
			let err = '';
			tar.stderr.on('data', (c: Buffer) => (err += c.toString()));
			tar.on('error', reject);
			tar.on('exit', (code) => {
				if (code !== 0) {
					rmSync(next, { recursive: true, force: true });
					return reject(new Error(`tar exited ${code}: ${err.trim()}`));
				}
				rmSync(into, { recursive: true, force: true });
				renameSync(next, into);
				resolve();
			});
		});
	}

	/** Bytes held, for status. */
	size(sha: string): number {
		return statSync(join(this.blobs, sha)).size;
	}
}
