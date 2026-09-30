# Request to `hadoku-watchparty`: let a host server read who is in a room, and their avatar

**Filed 2026-09-30 by the cardtable tracker.** **Status: request, not yet sent.**
The operator chose this route (w31 default D2) but has not given it to a session.
Hand it over with:

```sh
cd /home/hadoku/repos/hadoku-watchparty && claude
```

> Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/WATCHPARTY_ROSTER_FOR_HOST.md`
> and do it. Work in your own worktree; other agents are live in this repo. Publish,
> land on main, confirm the deploy, remove the worktree, and report. Don't ask
> questions.

## What the operator saw

*"i noticed only one avatar is working. watchparty by default assigns an avatar to
someone if they dont have one set in the preferences. i can see this worked
correctly outside of the game ui, but inside its showing generic nothing."*

## Why cardtable cannot fix it alone

A person with no saved avatar is given one by the server at join:
`apps/server/src/ws/join.ts` auto-assigns the first free sprite from
`CHARACTER_ORDER` (`claimSprite` / `getAvailableSprites`). That assignment exists
only in the room's in-memory `meta.avatarId`. It is **not in the account's saved
prefs**, so cardtable's read of prefs never sees it, and it is not on
`RoomChrome`'s public surface (`dist/room-chrome.d.ts` exports `RoomChrome` and
its props, nothing else). The earlier ask for a client accessor
(`WATCHPARTY_AVATAR_ACCESSOR.md`) was never agreed.

There is also no HTTP route that lists a room's members: the routes under
`apps/server/src/http/routes/playback.ts` are `snapshot` (which carries no roster,
per the comment at `apps/ui/src/lib/socket.ts:205`), `chat`, `load` and `home`.

## The ask

One **service-authenticated** route, server to server (cardtable's server calls it;
a browser never does):

`GET /api/rooms/:id/roster` returns
`{ members: [{ client_id, user_id | null, name, sprite_id | null }] }`, one row per
connection, built from `listPresence` (`rooms/store.ts:294`) plus the account's
`user_id`.

**`user_id` is the point, and it is the part I could not verify.** Cardtable's
player ids and watchparty's differ: the same person is `fk:4372dd…` in cardtable's
log and `fk:6c0ce5…` in watchparty's, because each hashes under its own domain string
(`hadoku.cardtable.participant.v1` here). So a roster keyed by watchparty's
`participant_id` is useless to us. The edge stamps `X-User-Id` (the registry's stable
id, `hadoku_site` `docs/architecture/IDENTITY_MODEL.md` R1) on both apps' requests.
`join.ts:62` already sets `socket.data.ownerUserId` in one case. **Find out whether
the connection's `X-User-Id` is available on the socket handshake and record it on the
client's meta**; if it is not, say so and propose what is.

## Done when

1. The route exists behind `serviceAuth`, with a server test for: a room with two
   connections of different accounts; one account on two connections; a member with
   no `user_id` (ephemeral). Mutation-tested, with counts.
2. Report the route's exact shape and the `@wolffm/*` versions, so cardtable can
   consume it (cardtable lane R, a follow-up to wave 31).
3. Deployed, with the running commit named.

## Not in this request

A browser-side accessor, a socket event, or any change to how the picker works.
