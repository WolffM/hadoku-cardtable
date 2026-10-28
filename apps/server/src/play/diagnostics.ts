/**
 * What a bridge JVM said about itself on stderr, as opposed to Forge's own log chatter. One rule for
 * both places that read a dead JVM's stderr: this machine's pool (`local-jvm.ts`, logged before a
 * clean end removes the file) and the host agent on a claw (`apps/agent`, the reason a JVM exited,
 * which becomes the failover alert's cause). Kept free of imports so the agent's bundle can take it.
 */

/** At most this many distinct diagnostic lines, each cut to {@link DIAGNOSTIC_CHARS}, logged for one JVM. */
export const DIAGNOSTICS_KEPT = 40;
const DIAGNOSTIC_CHARS = 400;
/** A line the bridge tagged as its own, or the headline of a Java throwable (`Exception in thread …`, `java.lang.X: …`). */
const DIAGNOSTIC_LINE = /^(\[bridge\]|Exception in thread |(?:[\w$]+\.)+[\w$]*(?:Exception|Error)(?::|$))/;

/**
 * What the bridge said about itself on stderr: every line it tagged `[bridge]` and the headline of every
 * Java throwable with its first frame, each kept once with how many times it came, in first-seen order.
 *
 * A clean end removes the run directory, and with it `bridge.stderr.txt`, which is where the bridge says a
 * read of Forge failed (`PlayBridge.java`'s `decoration`, `[bridge] … could not read …`). So the operator's
 * dredge window, 2026-10-23 — a prompt whose read threw and never went out — left nothing in the logs to
 * find it by. This is what is kept of it.
 */
export function bridgeDiagnostics(stderr: string): { line: string; count: number }[] {
	const seen = new Map<string, number>();
	const lines = stderr.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = (lines[i] ?? '').trimEnd();
		if (!DIAGNOSTIC_LINE.test(raw)) continue;
		const frame = raw.startsWith('[bridge]') ? undefined : lines[i + 1]?.trim();
		const line = (frame?.startsWith('at ') ? `${raw} ${frame}` : raw).slice(0, DIAGNOSTIC_CHARS);
		if (!seen.has(line) && seen.size >= DIAGNOSTICS_KEPT) continue;
		seen.set(line, (seen.get(line) ?? 0) + 1);
	}
	return [...seen].map(([line, count]) => ({ line, count }));
}
