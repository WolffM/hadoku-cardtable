/**
 * `devkit.config.json`: everything the devkit knows about one app, at the root of its repo.
 *
 *   node packages/devkit/src/config.ts [--root <repo>] check          # validate, print the resolved config
 *   node packages/devkit/src/config.ts [--root <repo>] get <a.b.c>    # one value, as the shell reads it
 *   node packages/devkit/src/config.ts [--root <repo>] shell          # `DK_*=…` lines for `eval` (lib.sh)
 *
 * The root is `--root`, else `$DEVKIT_ROOT`, else the git checkout the working directory is in.
 * Paths may start with `~/`; a relative path is relative to the repo root. App-only steps (a
 * game's art rows, its proof's test selection) are hooks: paths to the app's own scripts, which
 * the devkit runs at a fixed point and never names. A repo leaves a block out to skip what it
 * drives: no `proof` and prove-and-land lands without one; no `ledger` and nothing numbers rows.
 *
 * `build-version.ts` reads the two fields it needs without this module, because the server
 * bundles it; every other tool loads the config here, through the schema.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

export const CONFIG_FILE = 'devkit.config.json';

const text = (what: string) => z.string({ error: `${what}: a string is required` }).min(1, { error: `${what}: must not be empty` });
const pathField = (what: string) => text(`${what} (a path; "~/" and repo-relative are fine)`);
const port = (what: string) =>
	z.number({ error: `${what}: a port number is required` }).int().min(1, { error: `${what}: not a port` }).max(65535, { error: `${what}: not a port` });
const regex = (what: string) =>
	text(what).refine(
		(s) => {
			try {
				new RegExp(s);
				return true;
			} catch {
				return false;
			}
		},
		{ error: `${what}: not a valid regular expression` },
	);

export const ConfigSchema = z
	.strictObject({
		$comment: z.string().optional(),
		appId: z
			.string({ error: 'appId: a string is required, e.g. "cardtable"' })
			.regex(/^[a-z][a-z0-9-]*$/, { error: 'appId: lower-case letters, digits and dashes, starting with a letter (e.g. "cardtable")' }),
		repo: z.string({ error: 'repo: the GitHub "owner/name" is required' }).regex(/^[\w.-]+\/[\w.-]+$/, { error: 'repo: write it as "owner/name", e.g. "WolffM/hadoku-cardtable"' }),
		envPrefix: z
			.string({ error: 'envPrefix: required, e.g. "CARDTABLE" (overrides are read as <envPrefix>_CLAIMS, <envPrefix>_VERSION, …)' })
			.regex(/^[A-Z][A-Z0-9_]*$/, { error: 'envPrefix: upper-case letters, digits and underscores, e.g. "CARDTABLE"' }),
		stateDir: pathField('stateDir'),
		claimsFile: pathField('claimsFile').optional(),
		scratchDir: pathField('scratchDir'),
		nodeBin: pathField('nodeBin'),
		trees: z.strictObject(
			{ deploy: pathField('trees.deploy'), ppe: pathField('trees.ppe').optional() },
			{ error: 'trees: { "deploy": <prod tree>, "ppe"?: <PPE tree> } is required' },
		),
		ci: z.strictObject(
			{ workflow: text('ci.workflow (e.g. "ci.yml")'), name: text('ci.name (the workflow\'s name, e.g. "CI")'), checkJob: text('ci.checkJob (the job a deploy waits on)') },
			{ error: 'ci: { "workflow", "name", "checkJob" } is required' },
		),
		proof: z
			.strictObject({
				workflow: text('proof.workflow (e.g. "forge.yml")'),
				maxInFlight: z.number({ error: 'proof.maxInFlight: a number is required' }).int().positive({ error: 'proof.maxInFlight: at least 1' }),
				select: pathField('proof.select').optional(),
			})
			.optional(),
		releases: z.strictObject({ dir: pathField('releases.dir') }, { error: 'releases: { "dir": <release notes dir> } is required' }),
		ledger: pathField('ledger').optional(),
		land: z.strictObject(
			{
				lock: pathField('land.lock'),
				devVault: pathField('land.devVault'),
				linkDeps: pathField('land.linkDeps').optional(),
				unsetEnv: z.array(text('land.unsetEnv[]')).default([]),
				botCommits: regex('land.botCommits (the subject regex of commits a land may rebase over)'),
				tests: z
					.strictObject({
						runAllList: pathField('land.tests.runAllList').optional(),
						whole: z.array(regex('land.tests.whole[]')).default([]),
						relatedOnly: z.array(regex('land.tests.relatedOnly[]')).default([]),
					})
					.default({ whole: [], relatedOnly: [] }),
				hooks: z
					.strictObject({ beforeCheck: z.array(pathField('land.hooks.beforeCheck[]')).default([]) })
					.default({ beforeCheck: [] }),
			},
			{ error: 'land: { "lock", "devVault", "botCommits", … } is required' },
		),
		telemetry: z
			.strictObject({
				service: text('telemetry.service'),
				path: z.string({ error: 'telemetry.path: required' }).regex(/^\/[^/]+$/, { error: 'telemetry.path: one segment with a leading slash, e.g. "/cardtable"' }),
				keyFile: pathField('telemetry.keyFile'),
				outDir: pathField('telemetry.outDir').optional(),
				backupJob: text('telemetry.backupJob'),
				battletestJob: text('telemetry.battletestJob').optional(),
				tourUserId: text('telemetry.tourUserId').optional(),
				discordWebhookSecret: text('telemetry.discordWebhookSecret').optional(),
			})
			.optional(),
		health: z.strictObject({ prod: port('health.prod'), ppe: port('health.ppe').optional() }, { error: 'health: { "prod": <port>, "ppe"?: <port> } is required' }),
	});

type Raw = z.infer<typeof ConfigSchema>;

/** The config with every path made absolute and every default filled in. */
export interface DevkitConfig extends Omit<Raw, '$comment' | 'claimsFile' | 'telemetry'> {
	root: string;
	claimsFile: string;
	telemetry?: Omit<NonNullable<Raw['telemetry']>, 'outDir'> & { outDir: string };
}

/** The repo root: `$DEVKIT_ROOT`, else the checkout `cwd` is in. */
export function findRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	if (env.DEVKIT_ROOT) return resolve(env.DEVKIT_ROOT);
	try {
		return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		throw new Error(`devkit: ${cwd} is not in a git checkout; set DEVKIT_ROOT to the repo that holds ${CONFIG_FILE}`);
	}
}

/** Each issue as a line a person can act on: the file, the field, what is wrong. */
export function describeIssues(file: string, error: z.ZodError): string {
	return error.issues
		.map((i) => {
			const at = i.path.join('.');
			const msg = i.code === 'unrecognized_keys' ? `unknown field(s) ${i.keys.map((k) => `"${k}"`).join(', ')}: not part of the devkit config (a typo?)` : i.message;
			return `  ${file}: ${at && !msg.startsWith(at) ? `${at}: ` : ''}${msg}`;
		})
		.join('\n');
}

/** Validates `raw` (the parsed JSON) and resolves it against `root`. Throws with every issue listed. */
export function parseConfig(raw: unknown, root: string, file = join(root, CONFIG_FILE)): DevkitConfig {
	const got = ConfigSchema.safeParse(raw);
	if (!got.success) throw new Error(`devkit: ${file} is not a valid devkit config:\n${describeIssues(file, got.error)}`);
	const { $comment: _comment, ...c } = got.data;
	const abs = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(root, p));
	const stateDir = abs(c.stateDir);
	return {
		...c,
		root,
		stateDir,
		claimsFile: abs(c.claimsFile ?? join(stateDir, 'claims.tsv')),
		scratchDir: abs(c.scratchDir),
		nodeBin: abs(c.nodeBin),
		trees: { deploy: abs(c.trees.deploy), ...(c.trees.ppe ? { ppe: abs(c.trees.ppe) } : {}) },
		proof: c.proof && { ...c.proof, ...(c.proof.select ? { select: abs(c.proof.select) } : {}) },
		releases: { dir: abs(c.releases.dir) },
		ledger: c.ledger && abs(c.ledger),
		land: {
			...c.land,
			lock: abs(c.land.lock),
			devVault: abs(c.land.devVault),
			linkDeps: c.land.linkDeps && abs(c.land.linkDeps),
			tests: { ...c.land.tests, runAllList: c.land.tests.runAllList && abs(c.land.tests.runAllList) },
			hooks: { beforeCheck: c.land.hooks.beforeCheck.map(abs) },
		},
		telemetry: c.telemetry && { ...c.telemetry, keyFile: abs(c.telemetry.keyFile), outDir: abs(c.telemetry.outDir ?? join(stateDir, 'telemetry')) },
	};
}

export function loadConfig(root: string = findRoot()): DevkitConfig {
	const file = join(root, CONFIG_FILE);
	if (!existsSync(file)) throw new Error(`devkit: no ${CONFIG_FILE} at ${root} — every repo the devkit runs in names its app there (see packages/devkit/README.md)`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`devkit: ${file} is not JSON: ${(err as Error).message}`, { cause: err });
	}
	return parseConfig(raw, root, file);
}

const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
/** Several regexes as one ERE alternation, each grouped; empty when there are none. */
const anyOf = (xs: readonly string[]): string => xs.map((x) => `(${x})`).join('|');

/** What the shell scripts read: `DK_*` assignments, one per line, single-quoted for `eval`. Absent optional values are empty. */
export function shellVars(c: DevkitConfig): string {
	const vars: Record<string, string | number | undefined> = {
		DK_ROOT: c.root,
		DK_APP_ID: c.appId,
		DK_REPO: c.repo,
		DK_ENV_PREFIX: c.envPrefix,
		DK_STATE_DIR: c.stateDir,
		DK_CLAIMS_FILE: c.claimsFile,
		DK_SCRATCH_DIR: c.scratchDir,
		DK_NODE_BIN: c.nodeBin,
		DK_DEPLOY_TREE: c.trees.deploy,
		DK_PPE_TREE: c.trees.ppe,
		DK_CI_WORKFLOW: c.ci.workflow,
		DK_CI_NAME: c.ci.name,
		DK_CI_CHECK_JOB: c.ci.checkJob,
		DK_PROOF_WORKFLOW: c.proof?.workflow,
		DK_PROOF_MAX_IN_FLIGHT: c.proof?.maxInFlight,
		DK_PROOF_SELECT: c.proof?.select,
		DK_RELEASES_DIR: c.releases.dir,
		DK_LEDGER: c.ledger,
		DK_LAND_LOCK: c.land.lock,
		DK_DEV_VAULT: c.land.devVault,
		DK_LINK_DEPS: c.land.linkDeps,
		DK_UNSET_ENV: c.land.unsetEnv.join(' '),
		DK_BOT_COMMITS: c.land.botCommits,
		DK_TESTS_RUN_ALL: c.land.tests.runAllList,
		DK_TESTS_WHOLE: anyOf(c.land.tests.whole),
		DK_TESTS_RELATED_ONLY: anyOf(c.land.tests.relatedOnly),
		DK_HOOKS_BEFORE_CHECK: c.land.hooks.beforeCheck.join('\n'),
		DK_TELEMETRY_OUT: c.telemetry?.outDir,
		DK_TELEMETRY_KEY_FILE: c.telemetry?.keyFile,
		DK_HEALTH_PROD: c.health.prod,
		DK_HEALTH_PPE: c.health.ppe,
	};
	return Object.entries(vars)
		.map(([k, v]) => `${k}=${quote(v === undefined ? '' : String(v))}`)
		.join('\n');
}

/** A dotted path into the resolved config; objects print as JSON. */
export function getField(c: DevkitConfig, dotted: string): string {
	let at: unknown = c;
	for (const key of dotted.split('.')) {
		if (at === null || typeof at !== 'object' || !(key in at)) throw new Error(`devkit: ${CONFIG_FILE} has no "${dotted}"`);
		at = (at as Record<string, unknown>)[key];
	}
	return typeof at === 'object' ? JSON.stringify(at) : String(at);
}

function main(argv: string[]): void {
	const rootAt = argv.indexOf('--root');
	const root = rootAt === -1 ? findRoot() : resolve(argv.splice(rootAt, 2)[1]);
	const [cmd, field] = argv;
	const c = loadConfig(root);
	if (cmd === 'shell') console.log(shellVars(c));
	else if (cmd === 'get' && field) console.log(getField(c, field));
	else if (cmd === 'check') console.log(JSON.stringify(c, null, 2));
	else throw new Error('usage: config.ts [--root <repo>] check | get <a.b.c> | shell');
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		process.exit(2);
	}
}
