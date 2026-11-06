/**
 * `JvmLauncher` for `--host` JVMs on one claw's host agent: the remote half of
 * `../jvm-transport.ts`. Placement chooses the claw; this only talks to it.
 */

import { BRIDGE_JVM_FLAGS, FORGE_PREFERENCES } from '../host.js';
import type { JvmLauncher, JvmTransport } from '../jvm-transport.js';
import type { AgentClient, FrameSink } from './client.js';
import type { ArtifactSet } from './wire.js';

/** What every JVM this launcher starts runs on (`artifacts.ts` `pushArtifacts`). */
export interface RemoteRuntime {
	artifacts: ArtifactSet;
	main: string;
}

class RemoteTransport implements JvmTransport, FrameSink {
	/** The byte offset just past the last line delivered: lines at or before it are repeats. */
	private taken = 0;
	private done = false;
	private lineListener: (line: string) => void = () => {};
	private exitListener: (reason: string) => void = () => {};

	constructor(
		readonly hostId: string,
		private readonly client: AgentClient,
	) {}

	send(line: string): void {
		if (!this.done) this.client.send({ op: 'line', h: this.hostId, line });
	}
	onLine(listener: (line: string) => void): void {
		this.lineListener = listener;
	}
	onExit(listener: (reason: string) => void): void {
		this.exitListener = listener;
	}
	/** The agent kills it and answers with its exit, which fires `onExit`; a lost link fires it too. */
	kill(): void {
		if (!this.done) this.client.send({ op: 'kill', h: this.hostId });
	}
	/** Released, or exited: nothing more goes to the agent for it. */
	get finished(): boolean {
		return this.done;
	}
	release(): void {
		if (this.done) return;
		this.done = true;
		this.client.unregister(this.hostId);
		this.client.send({ op: 'release', h: this.hostId, off: this.taken });
	}

	line(off: number, line: string): void {
		if (this.done || off <= this.taken) return;
		this.taken = off;
		this.lineListener(line);
	}
	exit(reason: string): void {
		if (this.done) return;
		this.done = true;
		this.exitListener(reason);
	}
	resumeFrom(): number {
		return this.taken;
	}
}

export class RemoteJvmLauncher implements JvmLauncher {
	private readonly runtime: Promise<RemoteRuntime>;

	/**
	 * `runtime` may still be on its way to the agent (`connectRemoteHost`): a launch waits for it,
	 * and attaching to a JVM already running there never does.
	 */
	constructor(
		private readonly client: AgentClient,
		runtime: RemoteRuntime | Promise<RemoteRuntime>,
	) {
		this.runtime = Promise.resolve(runtime);
	}

	launch(hostId: string, opts: { xmxMb: number }): JvmTransport {
		const t = this.transport(hostId);
		this.runtime.then(
			(runtime) => {
				if (t.finished) return;
				if (this.client.lost !== null) {
					t.exit(`agent unavailable: ${this.client.lost}`);
					return;
				}
				this.client.send({
					op: 'launch',
					hostId,
					xmxMb: opts.xmxMb,
					artifacts: runtime.artifacts,
					main: runtime.main,
					jvmFlags: [...BRIDGE_JVM_FLAGS],
					forgePreferences: { ...FORGE_PREFERENCES },
				});
			},
			(err: unknown) => t.exit(`the agent could not be given this server's runtime: ${(err as Error).message}`),
		);
		return t;
	}

	running(): Promise<string[]> {
		return this.client.running();
	}

	attach(hostId: string): JvmTransport {
		const t = this.transport(hostId);
		this.client.send({ op: 'attach', h: hostId });
		return t;
	}

	private transport(hostId: string): RemoteTransport {
		const t = new RemoteTransport(hostId, this.client);
		this.client.register(hostId, t);
		return t;
	}
}
