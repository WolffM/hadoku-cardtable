import { generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AGENT_PORT, DRAFTBOT_MB, DRAFTBOT_PATH, EMPTY_SHA, RELAY_PROTOCOL, ReplayGuard, SKEW_MS, checkRequest, openFrame, privateKeyFrom, publicPemOf, sha256Hex, signFrame, signRequest, sliceNeedMb, type ToAgent } from './wire.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const T = 1_800_000_000_000;

const req = (headers: Record<string, string>, method = 'GET', path = '/status') => ({ method, path, headers });

describe('signed requests', () => {
	it('accepts the coordinator, once', () => {
		const guard = new ReplayGuard(() => T);
		const h = { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) };
		expect(checkRequest(publicKey, guard, req(h), T)).toBeNull();
		expect(checkRequest(publicKey, guard, req(h), T + 1)).toBe('replayed signature');
	});

	it('refuses an unsigned request, as loopback CI would send it', () => {
		expect(checkRequest(publicKey, new ReplayGuard(), req({}), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, new ReplayGuard(), req({ 'x-agent-ts': String(T), 'x-agent-body': EMPTY_SHA }), T)).toBe('unsigned');
	});

	it('refuses a bad signature: another key, another path, another body, garbage', () => {
		const g = new ReplayGuard();
		expect(checkRequest(publicKey, g, req({ ...signRequest(other.privateKey, 'GET', '/status', EMPTY_SHA, T) }), T)).toBe('bad signature');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) }, 'POST', '/install'), T)).toBe('bad signature');
		const body = sha256Hex('{"kind":"jar"}');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T), 'x-agent-body': body }), T)).toBe('bad signature');
		expect(checkRequest(publicKey, g, req({ 'x-agent-ts': String(T), 'x-agent-body': EMPTY_SHA, 'x-agent-sig': 'AAAA' }), T)).toBe('bad signature');
	});

	it('refuses a stale timestamp either side of the agent clock', () => {
		const g = new ReplayGuard();
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T - SKEW_MS - 1) }), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T + SKEW_MS + 1) }), T)).toBe('stale or missing x-agent-ts');
		expect(checkRequest(publicKey, g, req({ ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T - SKEW_MS + 1) }), T)).toBeNull();
	});

	it('forgets a signature only after it could no longer pass the skew check', () => {
		let now = T;
		const g = new ReplayGuard(() => now);
		const h = { ...signRequest(privateKey, 'GET', '/status', EMPTY_SHA, T) };
		expect(checkRequest(publicKey, g, req(h), now)).toBeNull();
		now = T + SKEW_MS;
		expect(checkRequest(publicKey, g, req(h), now)).toBe('replayed signature');
		now = T + 2 * SKEW_MS + 1;
		expect(checkRequest(publicKey, g, req(h), now)).toBe('stale or missing x-agent-ts');
	});
});

describe('relay frames', () => {
	const m = { op: 'line' as const, h: 'h1', line: '{"t":"start","match":"m1","config":{"a":"b\\n"}}' };

	it('open in order, in their own session only', () => {
		const f1 = signFrame(privateKey, 'nonce-a', 1, m);
		expect(openFrame(publicKey, 'nonce-a', 1, f1)).toEqual({ m });
		expect(openFrame(publicKey, 'nonce-a', 2, f1)).toEqual({ error: 'frame 1, expected 2' });
		expect(openFrame(publicKey, 'nonce-b', 1, f1)).toEqual({ error: 'bad frame signature' });
	});

	it('refuses a tampered body or another key', () => {
		const f = signFrame(privateKey, 'n', 1, m);
		expect(openFrame(publicKey, 'n', 1, f.replace('m1', 'm2'))).toEqual({ error: 'bad frame signature' });
		expect(openFrame(publicKey, 'n', 1, signFrame(other.privateKey, 'n', 1, m))).toEqual({ error: 'bad frame signature' });
		expect(openFrame(publicKey, 'n', 1, '{"m":{"op":"kill","h":"h1"}}')).toEqual({ error: 'malformed frame' });
	});
});

describe('keys', () => {
	it('reads a PEM or one line of base64 PKCS#8, and gives the public PEM the build embeds', () => {
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
		const fromPem = privateKeyFrom(pem);
		const fromDer = privateKeyFrom(der);
		expect(publicPemOf(fromPem)).toBe(publicPemOf(fromDer));
		expect(publicPemOf(fromPem)).toBe(publicKey.export({ type: 'spki', format: 'pem' }).toString());
	});
});

describe('the draft bot on the wire', () => {
	it('is told what to run in a signed frame like every other order', () => {
		const line = signFrame(privateKey, 'n1', 1, { op: 'draftbot', sha: 'a'.repeat(64) });
		expect(openFrame(publicKey, 'n1', 1, line)).toEqual({ m: { op: 'draftbot', sha: 'a'.repeat(64) } });
		expect(openFrame(publicKey, 'n1', 1, line.replace('"a', '"b'))).toEqual({ error: 'bad frame signature' });
	});

	it('takes its cap out of the slice beside the JVMs and the agent', () => {
		expect(sliceNeedMb([2048])).toBe(100 + 2048 + 400);
		expect(sliceNeedMb([2048], true)).toBe(100 + 2048 + 400 + DRAFTBOT_MB);
		// A 4 GB unit still holds one 2 GB-heap JVM beside it.
		expect(sliceNeedMb([2048], true)).toBeLessThanOrEqual(4096);
	});
});

// The claws keep the agent they were last installed with, and both sides import this file, so a
// change here that is consistent on both sides passes every other test while the new server can
// no longer reach a deployed agent. These are the facts a deployed agent checks, written out.
describe('what a deployed agent speaks', () => {
	it('listens on its port, upgrades to the relay by name, and serves the draft bot at its path', () => {
		expect(AGENT_PORT).toBe(7621);
		expect(RELAY_PROTOCOL).toBe('cardtable-relay');
		expect(DRAFTBOT_PATH).toBe('/draftbot/batchdraft');
	});

	it('verifies a request signed over "<METHOD>\\n<path>\\n<ts>\\n<body sha>"', () => {
		const h = signRequest(privateKey, 'POST', '/install', EMPTY_SHA, T);
		expect(Object.keys(h).sort()).toEqual(['x-agent-body', 'x-agent-sig', 'x-agent-ts']);
		expect(verify(null, Buffer.from(`POST\n/install\n${T}\n${EMPTY_SHA}`), publicKey, Buffer.from(h['x-agent-sig'], 'base64'))).toBe(true);
	});

	it('opens a frame signed over "relay\\n<nonce>\\n<seq>\\n<JSON of m>"', () => {
		const m = { op: 'kill', h: 'h-1' } as const;
		const body = JSON.stringify(m);
		const sig = sign(null, Buffer.from(`relay\nn-1\n1\n${body}`), privateKey).toString('base64');
		expect(openFrame(publicKey, 'n-1', 1, `{"seq":1,"sig":"${sig}","m":${body}}`)).toEqual({ m });
	});

	/**
	 * `LaunchSpec` dropped its flat `xmxMb`/`main`/`jvmFlags`/`forgePreferences` fields after this
	 * pin test already existed, so nothing above needed a new literal: none of the facts this
	 * describe block pins (the port, the relay's upgrade name, the draft bot's path, either signed
	 * string format) named those fields at all. What is pinned here instead is that a `launch` frame
	 * still opens to exactly the object a coordinator built it from — `hostId`, `artifacts` and
	 * `runtime`, nothing else — over the real signer and verifier, so a future edit to `LaunchSpec`
	 * that quietly reintroduces a flat field (or drops `runtime` itself) fails this, not silently.
	 */
	it('a launch frame carries only hostId, artifacts and runtime', () => {
		const m: ToAgent = {
			op: 'launch',
			hostId: 'h-1',
			artifacts: { jdk: 'jdk-sha', jar: 'jar-sha', res: 'res-sha', bridge: 'bridge-sha' },
			runtime: { kind: 'jvm', xmxMb: 1024, main: 'PlayBridge', jvmFlags: [], forgePreferences: {} },
		};
		const line = signFrame(privateKey, 'n-launch', 1, m);
		expect(openFrame(publicKey, 'n-launch', 1, line)).toEqual({ m });
	});
});
