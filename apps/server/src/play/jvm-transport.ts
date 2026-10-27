/** One `--host` bridge JVM's line protocol, wherever the JVM runs. */
export interface JvmTransport {
	/** The JVM's host id: what `--host <hostId>` was given. */
	readonly hostId: string;
	/** One protocol line (JSON, no newline) to the JVM's stdin. Lines are delivered in order. */
	send(line: string): void;
	/** Every stdout line, in order. One listener; set before the first line can arrive. */
	onLine(listener: (line: string) => void): void;
	/** The JVM, or the link to it, is gone for good. Fires once. Lines after it are dropped. */
	onExit(listener: (reason: string) => void): void;
	/** End the JVM now. Idempotent. Fires onExit. */
	kill(): void;
	/** Let go without killing (coordinator restart); a later `attach` takes it back. */
	release(): void;
}

export interface JvmLauncher {
	/** Boot a new `--host` JVM. Its first line is `warm` (or it exits). */
	launch(hostId: string, opts: { xmxMb: number }): JvmTransport;
	/** JVMs still running from an earlier coordinator. */
	running(): Promise<string[]>;
	/** Take one back. Lines it printed while nobody was attached are replayed first, in order. */
	attach(hostId: string): JvmTransport;
}
