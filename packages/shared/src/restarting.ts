/*
 * The server is about to restart on purpose (a deploy's SIGTERM), told to every
 * socket just before it closes them, so a client can tell a planned drop from a
 * lost connection and say "Updating…" rather than "Reconnecting…" while it
 * comes back. No payload: the event is the whole message.
 */
export const SERVER_RESTARTING_EVENT = 'server:restarting';
