/**
 * The `/health` body, hadoku health v1: `status` ("ok" | "degraded"), `service`
 * (this app's id in hadoku_site's scripts/child-apps.json) and `commit` (the git
 * sha of the running code). mgmt-api's deploy probe compares `commit` with the
 * sha it just deployed, so it must be the checkout's HEAD, never a guess.
 */

import { execFileSync } from 'node:child_process';

/** The commit, or null plus why it could not be read. Never a placeholder sha. */
export type Commit = { commit: string; commit_error?: undefined } | { commit: null; commit_error: string };

/**
 * `git rev-parse HEAD` in `repoRoot`, read once at boot by the caller: a deploy
 * restarts the process, so the checkout cannot move under a running server.
 * Each instance reads its OWN checkout (cardtable and cardtable-ppe are two).
 */
export function readCommit(repoRoot: string): Commit {
	try {
		const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 5_000,
		}).trim();
		if (/^[0-9a-f]{40,64}$/.test(sha)) return { commit: sha };
		return { commit: null, commit_error: `git rev-parse HEAD in ${repoRoot} printed ${JSON.stringify(sha.slice(0, 80))}, not a sha` };
	} catch (err) {
		const stderr = (err as { stderr?: unknown }).stderr;
		const why = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : err instanceof Error ? err.message : String(err);
		return { commit: null, commit_error: `git rev-parse HEAD in ${repoRoot} failed: ${why.slice(0, 200)}` };
	}
}

/**
 * The instance's child-apps id, from the prefix the edge serves it under:
 * `/cardtable` is `cardtable`, `/cardtable-ppe` is `cardtable-ppe`. Both
 * instances run this same code, and the prefix is the one setting that
 * child-apps.json gives each of them differently.
 */
export function serviceIdOf(basePrefix: string): string {
	return basePrefix.replace(/^\/+|\/+$/g, '') || 'cardtable';
}

export interface HealthInput {
	service: string;
	commit: Commit;
	/** The base-path verdict (`base-path.ts`); `ok: false` is the one not-ready state. */
	bundle: { ok: boolean; reason: string };
}

/** The HTTP status and body `/health` answers. */
export function healthResponse({ service, commit, bundle }: HealthInput, now = new Date()): { code: number; body: Record<string, unknown> } {
	const body: Record<string, unknown> = {
		status: bundle.ok ? 'ok' : 'degraded',
		service,
		commit: commit.commit,
		...(commit.commit === null ? { commit_error: commit.commit_error } : {}),
		...(bundle.ok ? {} : { reason: `the UI bundle is not servable (bundle: ${bundle.reason})` }),
		bundle: bundle.reason,
		timestamp: now.toISOString(),
	};
	return { code: bundle.ok ? 200 : 503, body };
}
