/**
 * Getting a draft out to a room — one payload per person, never one for all.
 *
 * **This is the lane's one mistake that matters.** `broadcastToRoom` takes a
 * single payload and hands the same bytes to everybody; for a draft that means
 * seat 3's pack arriving at seat 5's browser, where declining to render it is
 * not privacy. `emitPerRecipient` exists precisely so that the payload is BUILT
 * per recipient, and `viewForClient` is the builder: their own seat's pack and
 * pool, or — for a person holding no seat — the one seat they watch.
 *
 * There is no function in this file that takes a `DraftView` and sends it to a
 * room. That is deliberate — the only way to emit a view here is to name whose
 * view it is, and the hidden-information tests assert over whole serialised
 * payloads that no other seat's cards appear anywhere in them.
 *
 * ## The emit policy
 *
 * `safeEmit` drops low-priority events when a socket's write buffer is deep.
 * A draft envelope is not one of those: dropping a state update leaves a client
 * permanently behind with no signal, and the cursor is what would have let it
 * notice. So the channel is declared high priority and nothing is droppable —
 * which is also the package's default for an unclassified event, stated here
 * rather than relied upon.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { emitPerRecipient, safeEmit, type EmitPolicy } from '@wolffm/rooms-server';
import {
	DRAFT_CHANNEL,
	stateMessage,
	updateMessage,
	type CubeMeta,
	type ServerMessage,
} from '@hadoku/shared';

import {
	viewForClient,
	type DraftApp,
	type DraftClient,
	type DraftRoom,
} from './draftRooms.js';

export type EmitLog = (line: Record<string, unknown>) => void;

/** 512 KiB of backlog before anything is even considered droppable. */
const BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;

export function draftEmitPolicy(log: EmitLog): EmitPolicy {
	return {
		thresholdBytes: BACKPRESSURE_THRESHOLD_BYTES,
		highPriority: new Set([DRAFT_CHANNEL.serverToClient]),
		lowPriorityOrder: [],
		onDrop: (info) => log({ evt: 'emit-drop', ...info }),
		onError: (info) => log({ evt: 'emit-error', event: info.event, socketId: info.socketId }),
	};
}

/** Send one envelope to one socket. Used for answers only that socket asked for. */
export function sendTo(socket: Socket, message: ServerMessage, policy: EmitPolicy): void {
	safeEmit(socket, DRAFT_CHANNEL.serverToClient, message, policy);
}

/** One step of the stream to everyone in the room. */
export function emitDraftUpdate(io: SocketIOServer, room: DraftRoom, policy: EmitPolicy): number {
	return emitPerRecipient<DraftApp, DraftClient, ServerMessage>(
		io,
		room,
		DRAFT_CHANNEL.serverToClient,
		(client) => updateMessage(viewForClient(room, client)),
		policy,
	);
}

/**
 * The join answer: a baseline for the arrival, a step for everyone already here.
 *
 * Two message types in one pass rather than two passes, because the payload has
 * to be built per recipient either way and the joiner is the only one who needs
 * a baseline. Sending everyone a `state` would work and would also reset seven
 * cursors to say one seat filled.
 */
export function emitJoinSnapshot(
	io: SocketIOServer,
	room: DraftRoom,
	joinerClientId: string,
	cube: CubeMeta | undefined,
	policy: EmitPolicy,
): number {
	return emitPerRecipient<DraftApp, DraftClient, ServerMessage>(
		io,
		room,
		DRAFT_CHANNEL.serverToClient,
		(client) => {
			const view = viewForClient(room, client);
			return client.clientId === joinerClientId ? stateMessage(view, cube) : updateMessage(view);
		},
		policy,
	);
}
