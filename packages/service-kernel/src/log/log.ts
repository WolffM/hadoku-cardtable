/**
 * The server's log line: one JSON object on stdout with a timestamp, the
 * service that wrote it, then the entry's own fields. pm2 keeps stdout, and
 * every reader of these logs greps for `svc`.
 */

export type JsonLog = (entry: Record<string, unknown>) => void;

export function jsonLogger(svc: string): JsonLog {
	return (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), svc, ...entry }));
}
