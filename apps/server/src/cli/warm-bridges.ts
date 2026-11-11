/**
 * Compile both Java bridges into the shared cache before a deploy stops the
 * server, so the new server finds them compiled instead of running `javac` on
 * its boot path.
 *
 * A bridge's cache directory is keyed by the bridge sources, the jar and the
 * java binary (`bridgeVersion`), never by the tree it was compiled from, so a
 * compile from the deploy's build-aside tree is the one the swapped-in server
 * launches. Measured on PPE 2026-11-06 05:52Z: a deploy that changed
 * `PlayBridge.java` spent 2.1 s (PoolService) + 3.5 s (PlayBridge) of its boot
 * in `javac`, while players waited.
 *
 * The jar is `CARDTABLE_FORGE_JAR` when set, else the jar built for this
 * tree's `forge` pin — the same `~/.local/share/cardtable/jars/<pin>.jar`, with
 * `forge.jar` beside it as the fallback, that hadoku_site's wrapper resolves.
 * With no jar or no `javac` it says so and exits 0: a build on a machine
 * without Forge (CI, a claw, `pnpm dev`) is not a failed build.
 *
 *   tsx src/cli/warm-bridges.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultJava } from '../play/engine-runtime.js';
import { bridgeLaunch, defaultBridgeCache, defaultBridgeSource } from '../play/local-jvm.js';
import { defaultPoolServiceSource } from '../pools/forge.js';

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The jar the wrapper will start this tree's server with. */
export function pinnedJar(tree: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.CARDTABLE_FORGE_JAR) return env.CARDTABLE_FORGE_JAR;
	const jars = join(env.HOME ?? '', '.local', 'share', 'cardtable');
	try {
		const pin = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD:forge'], { encoding: 'utf8' }).trim();
		const pinned = join(jars, 'jars', `${pin}.jar`);
		if (existsSync(pinned)) return pinned;
	} catch {
		// Not a git tree, or no forge submodule recorded: only the fallback can apply.
	}
	const fallback = join(jars, 'forge.jar');
	return existsSync(fallback) ? fallback : null;
}

function main(): void {
	const say = (entry: Record<string, unknown>) => console.log(JSON.stringify({ svc: 'warm-bridges', ...entry }));
	const jar = pinnedJar(TREE);
	if (jar === null) return say({ evt: 'skipped', why: 'no Forge jar for this tree' });
	const base = { java: process.env.CARDTABLE_JAVA ?? defaultJava(), jar: resolve(jar), bridgeCache: defaultBridgeCache() };
	for (const bridgeSource of [defaultBridgeSource(), defaultPoolServiceSource()]) {
		const { how } = bridgeLaunch({ ...base, bridgeSource }, say);
		say({ evt: 'bridge', source: bridgeSource, how });
	}
}

if (import.meta.main) main();
