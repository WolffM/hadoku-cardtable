// A stand-in for `bridge/PlayBridge.java --host <hostId>` that speaks only its line protocol —
// `warm`, then any number of `start`s addressed to the host, a `ready` per match, a match's
// `stop` answered by `stopped`, the host's `stop` ending the JVM, and `match` on every line both
// ways — so `host.test.ts` can exercise the coordinator (placement, routing, a JVM that dies,
// re-attach) in CI, where there is no Java. It plays no Magic. The real bridge is exercised by
// the jar suites.
//
// FAKE_BRIDGE_MODE=die exits at once, like a JVM that cannot boot.
// FAKE_BRIDGE_MODE=refuse refuses every `start`, as the bridge refuses a config it cannot host.
// FAKE_BRIDGE_ALIVE_MS=<ms> says `alive` that often, as the real bridge does every 2 s.
// FAKE_BRIDGE_DEAF_STOP=1 never answers a match's `stop`.
import { createInterface } from 'node:readline';

if (process.env.FAKE_BRIDGE_MODE === 'die') process.exit(3);

const args = process.argv.slice(2);
const hostId = args[args.indexOf('--host') + 1];
const matches = new Set();

const out = (match, line) => process.stdout.write(`${JSON.stringify({ ...line, match })}\n`);

// The real bridge's liveness thread starts before Forge boots, so its first line is `alive`, not `warm`.
out(hostId, { t: 'alive' });
out(hostId, { t: 'warm', bootMs: 1 });
const aliveMs = Number(process.env.FAKE_BRIDGE_ALIVE_MS ?? 0);
if (aliveMs > 0) setInterval(() => out(hostId, { t: 'alive' }), aliveMs);

const lines = createInterface({ input: process.stdin });
lines.on('line', (text) => {
	const cmd = JSON.parse(text);
	if (cmd.match === hostId) {
		if (cmd.t === 'stop') process.exit(0);
		if (cmd.t !== 'start') process.exit(4);
		if (process.env.FAKE_BRIDGE_MODE === 'refuse') {
			out(hostId, { t: 'rejected', message: 'java.lang.IllegalArgumentException: no deck', command: text.slice(0, 200) });
			return;
		}
		matches.add(cmd.config.matchId);
		out(cmd.config.matchId, { t: 'ready', forgePort: 0, bootMs: 1, startMs: 1, seats: [] });
		return;
	}
	if (!matches.has(cmd.match)) {
		out(hostId, { t: 'rejected', message: `no match "${cmd.match}" is hosted here`, command: text.slice(0, 200) });
		return;
	}
	if (cmd.t === 'stop') {
		if (process.env.FAKE_BRIDGE_DEAF_STOP === '1') return;
		matches.delete(cmd.match);
		out(cmd.match, { t: 'stopped' });
		return;
	}
	// Echo, so a test can see a command reached the right match.
	out(cmd.match, { t: 'rejected', message: 'echo', command: cmd.t });
});
lines.on('close', () => process.exit(0));
