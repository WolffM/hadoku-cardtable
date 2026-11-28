/**
 * SIGUSR1 opens the inspector, as it does in any node process, but on a free loopback port rather
 * than node's fixed 9229, which another process on the host may already hold (a workerd did,
 * so the default SIGUSR1 opened nothing). The port is in the log's `inspector-open` line; the next
 * SIGUSR1 closes it. This is how a running server's heap is profiled without a restart (pre-prod
 * 2026-11-28: a heap climbing ~12 MB/min under the soak). Loopback only: whoever can signal the
 * process could already attach to it as the same user.
 */
import * as inspector from 'node:inspector';

export function toggleInspector(log: (entry: Record<string, unknown>) => void): void {
	if (inspector.url() !== undefined) {
		inspector.close();
		log({ evt: 'inspector-closed' });
		return;
	}
	inspector.open(0, '127.0.0.1');
	log({ evt: 'inspector-open', url: inspector.url() });
}
