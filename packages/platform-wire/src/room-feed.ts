/*
 * A room id: every id the lobby mints, and the only shape a route, a stream key or a watchparty
 * room key (`<app>-<id>`) accepts. The room feed's wire itself is the rooms core's
 * (`@wolffm/rooms-protocol`'s `feed.ts`).
 */
export const ROOM_ID_RE = /^[a-z0-9-]{1,40}$/;
