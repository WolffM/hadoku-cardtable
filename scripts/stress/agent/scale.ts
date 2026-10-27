/**
 * ForgeScale (`scripts/stress/src/ForgeScale.java`) inside a hosting slice,
 * through the real host agent (`apps/agent`): hosting-test-plan.md §A's load.
 *
 * The agent launches any main class the coordinator ships as its `bridge`
 * artifact, so ForgeScale runs exactly as a bridge JVM would: the same
 * artifacts checked by sha256, the same leaf cgroup, the same pre-touched
 * `-Xms` = `-Xmx`, and its stdout relayed over the signed relay. Every RESULT
 * line is printed here as it arrives; the run ends with the JVM's exit.
 *
 *   AGENT_KEY_FILE=<signing.key> apps/server/node_modules/.bin/tsx scripts/stress/agent/scale.ts \
 *     <node> <label> <xmxMb> [-Dstress.k=v ...]
 *
 * Environment: JAR, RES, JDK as `scripts/stress/run.sh`; STAGE, its `build-stage` output
 * (ForgeScale's classes, cube names and decks in `$STAGE/scale`); AGENT_PORT (7621).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { packBase, packDir, pushRuntime } from '../../../apps/server/src/play/remote/artifacts.js';
import { AgentClient } from '../../../apps/server/src/play/remote/client.js';
import { AGENT_PORT, HOST_ID, privateKeyFrom } from '../../../apps/server/src/play/remote/wire.js';

const [node, label, xmx, ...props] = process.argv.slice(2);
if (!node || !label || !xmx || !HOST_ID.test(label)) {
	console.error('usage: scale.ts <node> <label> <xmxMb> [-Dstress.k=v ...]');
	process.exit(2);
}
const env = process.env;
const jdk = env.JDK ?? join(homedir(), '.local/opt/jdk-21.0.12.1+1');
const stage = join(env.STAGE ?? join(homedir(), '.cache/lane-stress/stage'), 'scale');
if (!existsSync(join(stage, 'ForgeScale.class'))) throw new Error(`no ForgeScale in ${stage}: run scripts/stress/run.sh build-stage`);
const cache = join(homedir(), '.cache', 'cardtable', 'agent-artifacts');
const client = new AgentClient({ url: `http://${node}:${env.AGENT_PORT ?? AGENT_PORT}`, key: privateKeyFrom(readFileSync(env.AGENT_KEY_FILE ?? '', 'utf8')) });

const base = await packBase({ java: join(jdk, 'bin', 'java'), jar: env.JAR ?? '', res: env.RES ?? '' }, cache);
const scale = await packDir(cache, 'scale', `${stage}\n${statSync(join(stage, 'ForgeScale.class')).mtimeMs}`, stage, []);
const runtime = await pushRuntime(client, { files: { ...base, bridge: scale }, main: 'ForgeScale' }, (e) => console.error(JSON.stringify(e)));
await client.connect();

const hostId = `${label}-${Date.now()}`;
let taken = 0;
const done = new Promise<string>((resolve) =>
	client.register(hostId, {
		line: (off, line) => {
			if (off <= taken) return;
			taken = off;
			if (line.startsWith('RESULT') || line.startsWith('[stress]')) console.log(line);
		},
		exit: resolve,
		resumeFrom: () => taken,
	}),
);
// The run dir's `bridge` link is the shipped stage: its cube names, and its decks when it has them.
const decks = existsSync(join(stage, 'decks')) ? ['-Dstress.deckDir=bridge/decks'] : [];
client.send({
	op: 'launch',
	hostId,
	xmxMb: Number(xmx),
	artifacts: runtime.artifacts,
	main: runtime.main,
	jvmFlags: ['-Dstress.series=series.tsv', '-Dstress.cubeNames=bridge/cube-names.txt', ...decks, ...props],
	forgePreferences: {},
});
console.error(`launched ${hostId} on ${node}`);
console.error(`exit: ${await done}`);
client.close();
