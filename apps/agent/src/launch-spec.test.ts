/**
 * `LaunchSpec` (`wire.ts`) carries only `hostId`, `artifacts` and `runtime` now — the flat
 * `xmxMb`/`main`/`jvmFlags`/`forgePreferences` fields it once also carried, and `runtimeOf`'s
 * fallback onto them, are both gone. That is safe with no install ordering between server and
 * agent: `runtime` was additive for one rollout first, so every agent already in the fleet read
 * `spec.runtime` in preference to the flat fields whenever one was sent, flat fields present or
 * not — dropping the flat fields from what a new server sends changes nothing those agents do. A
 * new agent (built after this drop) only ever meets a server that still sends `runtime`.
 *
 * This replaces `launch-compat.test.ts`'s old→new case (there is no more "old shape" a `LaunchSpec`
 * can even type-check as). What it proved for the other direction — today's `runtime`-carrying spec
 * still launching on an agent built BEFORE `runtime` existed (commit `170e6826c`) — was checked by
 * hand against that commit's `apps/agent` extracted verbatim, not committed here (a path outside
 * this repo is not something CI or another checkout can run); see the lane closing note that ran it
 * for its output and mutation count. That check does not need repeating: nothing on any claw runs
 * a build that old any more.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openFrame, signFrame, type ArtifactSet, type LaunchSpec, type ToAgent } from '@hadoku/host-wire';
import { jvmArgs, type Installed } from './jvm.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const artifacts: ArtifactSet = { jdk: 'jdk-sha', jar: 'jar-sha', res: 'res-sha', bridge: 'bridge-sha' };
const installed: Installed = { java: '/jdk/bin/java', jar: '/at/jar', res: '/at/res', bridge: '/at/bridge' };

const spec: LaunchSpec = {
	hostId: 'h-spec',
	artifacts,
	runtime: { kind: 'jvm', xmxMb: 1024, main: 'PlayBridge', jvmFlags: ['-XX:+ExitOnOutOfMemoryError'], forgePreferences: { UI_SELECT_FROM_CARD_DISPLAYS: 'false' } },
};

/** Sign `spec` as the coordinator would, then open it as an agent would: the real wire, round-tripped. */
function roundTrip(s: LaunchSpec): LaunchSpec {
	const nonce = 'launch-spec-test-nonce';
	const m: ToAgent = { op: 'launch', ...s };
	const line = signFrame(privateKey, nonce, 1, m);
	const opened = openFrame(publicKey, nonce, 1, line);
	if ('error' in opened) throw new Error(opened.error);
	if (opened.m.op !== 'launch') throw new Error(`expected a launch frame, got ${opened.m.op}`);
	return opened.m;
}

describe('LaunchSpec carries only runtime now', () => {
	it('launches off runtime alone, over the real signer and verifier', () => {
		const args = jvmArgs('/run/launch-spec', roundTrip(spec), installed, null);
		// A real argv, not an empty fallback: the heap flags and main are in it.
		expect(args).toContain('-Xmx1024m');
		expect(args).toContain('-XX:+ExitOnOutOfMemoryError');
		expect(args).toContain('PlayBridge');
		expect(args.at(-1)).toBe('h-spec');
	});
});
