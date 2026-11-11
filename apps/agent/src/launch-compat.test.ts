/**
 * `LaunchSpec`'s `runtime` field (`wire.ts`) is additive: a server keeps sending the flat
 * `xmxMb`/`main`/`jvmFlags`/`forgePreferences` fields it always has, and now also sends the same
 * four under `runtime`. `runtimeOf` (`wire.ts`) is the one place that picks between them, so an
 * old-shape spec (no `runtime`, as a server before this field existed sent) and a new-shape one
 * (both the flat fields and `runtime`, as this server sends) must still launch the same JVM.
 *
 * Proved over the real signer and verifier, not a hand-built object: each spec is wrapped as a
 * `{op:'launch', ...spec}` message, signed with `signFrame` as the coordinator would, and opened
 * with `openFrame` as an agent would, before either reaches `jvmArgs`.
 *
 * The other half of this — today's new-shape spec still launching on an agent built BEFORE
 * `runtime` existed (commit `170e6826c`) — was checked by hand against that commit's `apps/agent`
 * extracted verbatim (`git archive 170e6826c apps/agent apps/server/src/play/remote … | tar -x`)
 * into a scratch dir and imported by absolute path under vitest (vite's esbuild transform compiles
 * it like any other TypeScript file, parameter properties included). It is not committed as a test
 * here: a path outside this repo is not something CI or another checkout can run. See the w101
 * lane's closing note for that run's output and its mutation count.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openFrame, signFrame, type ArtifactSet, type LaunchSpec, type ToAgent } from '../../server/src/play/remote/wire.ts';
import { jvmArgs, type Installed } from './jvm.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const artifacts: ArtifactSet = { jdk: 'jdk-sha', jar: 'jar-sha', res: 'res-sha', bridge: 'bridge-sha' };
const installed: Installed = { java: '/jdk/bin/java', jar: '/at/jar', res: '/at/res', bridge: '/at/bridge' };

const oldShapeSpec: LaunchSpec = {
	hostId: 'h-compat',
	xmxMb: 1024,
	artifacts,
	main: 'PlayBridge',
	jvmFlags: ['-XX:+ExitOnOutOfMemoryError'],
	forgePreferences: { UI_SELECT_FROM_CARD_DISPLAYS: 'false' },
};

const newShapeSpec: LaunchSpec = {
	...oldShapeSpec,
	// A new server sends both: the flat fields (above, unchanged) and `runtime` (below).
	runtime: { kind: 'jvm', xmxMb: oldShapeSpec.xmxMb, main: oldShapeSpec.main, jvmFlags: oldShapeSpec.jvmFlags, forgePreferences: oldShapeSpec.forgePreferences },
};

/** Sign `spec` as the coordinator would, then open it as an agent would: the real wire, round-tripped. */
function roundTrip(spec: LaunchSpec): LaunchSpec {
	const nonce = 'compat-test-nonce';
	const m: ToAgent = { op: 'launch', ...spec };
	const line = signFrame(privateKey, nonce, 1, m);
	const opened = openFrame(publicKey, nonce, 1, line);
	if ('error' in opened) throw new Error(opened.error);
	if (opened.m.op !== 'launch') throw new Error(`expected a launch frame, got ${opened.m.op}`);
	return opened.m;
}

describe('LaunchSpec.runtime is additive (old→new, on today\'s agent)', () => {
	it('an old-shape spec (no runtime) and a new-shape spec (runtime + the flat fields) launch the same JVM', () => {
		const old = jvmArgs('/run/compat', roundTrip(oldShapeSpec), installed, null);
		const fresh = jvmArgs('/run/compat', roundTrip(newShapeSpec), installed, null);
		expect(old).toEqual(fresh);
		// And it is a real argv, not an empty fallback: the heap flags and main are in it.
		expect(old).toContain('-Xmx1024m');
		expect(old).toContain('PlayBridge');
		expect(old.at(-1)).toBe('h-compat');
	});
});
