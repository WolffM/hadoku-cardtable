/**
 * A seat at a match from the command line — a real socket.io client speaking
 * the same contract a browser does. For local testing, where every browser tab
 * is the same `local-dev` participant (see `../socket.ts`, "Identity"): a Node
 * client CAN set `x-user-id` on its handshake, so it is a second person.
 *
 *   pnpm --filter @hadoku/server exec tsx src/play/dev/seat.ts --match m-0123456789ab \
 *     [--server http://127.0.0.1:9008] [--user bob] [--ok] [--answer yes|no]
 *
 *   --ok       press OK whenever this seat's OK button is enabled (plays first,
 *              keeps the hand, passes priority) — keeps a game moving
 *   --answer   answer every showConfirmDialog this way; without it, asks are
 *              printed and left open
 *
 * Only works against a server with the bare-local hatch open
 * (`CARDTABLE_INSECURE_NO_EDGE_AUTH=1`, no `EDGE_AUTH_SECRET`), which is the only
 * configuration that believes an `x-user-id` it did not get from the edge.
 */

import { io } from 'socket.io-client';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const matchId = arg('match');
if (matchId === undefined) {
	console.error('usage: seat.ts --match <matchId> [--server URL] [--user NAME] [--ok] [--answer yes|no]');
	process.exit(2);
}
const server = arg('server') ?? 'http://127.0.0.1:9008';
const user = arg('user') ?? 'cli';
const pressOk = process.argv.includes('--ok');
const answer = arg('answer');

const socket = io(server, {
	path: '/socket.io/',
	transports: ['polling'],
	extraHeaders: { 'x-user-id': `cli-seat-${user}` },
	reconnection: false,
});

let seat: number | null = null;
let playerId: number | null = null;

function send(frame: Record<string, unknown>): void {
	socket.emit('forge:c2s', { matchId, frame });
}

function show(seq: number, frame: Record<string, unknown>): void {
	const method = String(frame.method);
	const brief =
		method === 'showPromptMessage'
			? JSON.stringify(frame.message)
			: method === 'updateButtons'
				? `[${String(frame.label1)}${frame.enable1 === true ? '' : ' (off)'}] [${String(frame.label2)}${frame.enable2 === true ? '' : ' (off)'}]`
				: frame.kind === 'ask'
					? `${String(frame.callId)} ${JSON.stringify(frame.message ?? frame.question ?? frame.title ?? '')}`
					: '';
	console.log(`#${seq} ${String(frame.kind)} ${method} ${brief}`);
}

socket.on('connect', () => {
	socket.timeout(15_000).emit('forge:join', { matchId }, (err: Error | null, ack: Record<string, unknown>) => {
		if (err !== null || 'error' in ack) {
			console.error('join failed:', err?.message ?? ack.error);
			process.exit(1);
		}
		seat = ack.seat as number;
		playerId = ack.playerId as number;
		const cursor = ack.cursor as { seq: number } | null;
		console.log(`joined ${matchId} as seat ${seat} (Forge player ${playerId}); snapshot: ${(ack.frames as unknown[]).length} frames, cursor ${cursor?.seq ?? 'none'}`);
	});
});

socket.on('forge:s2c', (envelope: { cursor: { seq: number }; frame: Record<string, unknown> }) => {
	const { frame } = envelope;
	show(envelope.cursor.seq, frame);
	if (pressOk && frame.method === 'updateButtons' && frame.enable1 === true) {
		setTimeout(() => send({ kind: 'act', method: 'selectButtonOk' }), 250);
	}
	if (answer !== undefined && frame.kind === 'ask' && frame.method === 'showConfirmDialog') {
		send({ kind: 'reply', callId: frame.callId, method: 'showConfirmDialog', result: answer === 'yes' });
		console.log(`  answered ${String(frame.callId)}: ${answer}`);
	}
	if (answer !== undefined && frame.kind === 'ask' && frame.method === 'tempShowZones') {
		// "I showed you those zones" — what Forge's own clients answer.
		send({ kind: 'reply', callId: frame.callId, method: 'tempShowZones', result: frame.zonesToUpdate });
		console.log(`  acknowledged ${String(frame.callId)}: zones shown`);
	}
});

socket.on('connect_error', (err) => {
	console.error('connect failed:', err.message);
	process.exit(1);
});
socket.on('disconnect', (reason) => {
	console.log(`disconnected: ${reason}`);
	process.exit(0);
});
