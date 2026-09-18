// A stand-in for `bridge/PlayBridge.java` that speaks only its line protocol —
// `warm`, `start`, `ready`, `stop`, and `match` on every line both ways — so
// `host.test.ts` can exercise the JVM pool (spare, addressing, ceiling, a spare
// that dies) in CI, where there is no Java. It plays no Magic. The real bridge
// is exercised by `jvm.test.ts`.
//
// FAKE_BRIDGE_MODE=die exits at once, like a JVM that cannot boot.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.FAKE_BRIDGE_MODE === 'die') process.exit(3);

const args = process.argv.slice(2);
const spareAt = args.indexOf('--spare');
let matchId = spareAt >= 0 ? args[spareAt + 1] : JSON.parse(readFileSync(args.at(-1), 'utf8')).matchId;
let started = spareAt < 0;

const out = (line) => process.stdout.write(`${JSON.stringify({ ...line, match: matchId })}\n`);
const ready = () => out({ t: 'ready', forgePort: 0, bootMs: 1, startMs: 1, seats: [] });

if (started) ready();
else out({ t: 'warm', bootMs: 1 });

const lines = createInterface({ input: process.stdin });
lines.on('line', (text) => {
	const cmd = JSON.parse(text);
	if (cmd.match !== matchId) {
		out({ t: 'rejected', message: `command is not for match ${matchId}`, command: text });
		return;
	}
	if (cmd.t === 'stop') process.exit(0);
	if (!started) {
		if (cmd.t !== 'start') process.exit(4);
		matchId = cmd.config.matchId;
		started = true;
		ready();
		return;
	}
	// Echo, so a test can see a command reached the right match.
	out({ t: 'rejected', message: 'echo', command: cmd.t });
});
lines.on('close', () => process.exit(0));
