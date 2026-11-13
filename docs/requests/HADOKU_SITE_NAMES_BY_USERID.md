# Request to hadoku_site: a batch userId → display name route for servers

**From:** hadoku-cardtable
**To:** hadoku_site
**Date:** 2026-11-01
**Re:** IDENTITY_MODEL R4 / R12, cardtable#25
**Status:** done. hadoku_site#504 added `name` to `_avatar/resolve` (`ResolvedPerson`, `@wolffm/prefs-client` 1.1.20); cardtable uses it in `packages/game-server/src/people.ts` (2026-11-05, #27).

## The gap

R12 has shared state (a room, a draft pod, a tournament's standings) name a person by their
opaque userId and nothing else, and R4 has the name **looked up when shown**. A server today can
look up only:

- an **avatar** by userId: `POST /prefs/api/v1/_avatar/resolve`, ≤ 100 ids, service tier
  (`workers/prefs-api/src/routes/avatar.ts`, `@wolffm/prefs-client/avatar` `resolveAvatars`);
- a **name** only for a person who is making a request right now: `X-User-Name` on that request,
  or `/session/whoami` with a key the server holds.

`GET /session/identity/resolve` goes the other way (name → userId, one at a time). There is no
userId → name route a server can call (checked 2026-11-01: `route-tiers.ts`, `key-admin.ts`,
`workers/shared/identity.ts`; `registryNameMap` needs a `SESSIONS_KV` binding a Node server cannot
have, and IDENTITY_MODEL advises against granting one).

So a view of people who are not connected cannot name them without a stored copy. In cardtable
that is: a saved room's members after a restart, a finished draft pod's seats, and the
Tournaments tab's past standings (`tournaments.json`, which today stores a `names` map — the
R12 deviation this route would let us delete).

## The ask

**Preferred (cheapest): add `name` to `_avatar/resolve`.** Checked twice on 2026-11-01: prefs-api
already resolves userId → name internally, through a cached `registryNameMap` in
`workers/prefs-api/src/routes/games.ts:79-86`, but no route returns it by userId. The avatar
resolve route (`routes/avatar.ts:412`) is already the right gate and shape (service tier, ≤ 100
userIds, offline people, erased = default answer), so `ResolvedAvatar` gaining `name: string | null`
gives a server a roster's faces and names in one call. If a separate route fits better, the shape
below is the same idea:

```
POST /session/identity/names      (service tier; an allow list per app if you prefer)
  { "userIds": ["<uuid>", …] }    ≤ 100, deduped
→ { "names": { "<uuid>": "Hadoku" | null, … } }    every id answered; null = no name, erased or unknown
```

Same shape and limits as `_avatar/resolve`, so a server resolves a roster's names and faces in
two parallel calls, and an erased account comes back as `null` rather than a 404, which is what
makes "an id that no longer resolves to anyone" (R12's erase story) render as a plain unnamed
seat. A `@wolffm/prefs-client` (or session-client) helper alongside `resolveAvatars` would be
welcome but is not needed.

## Caching is yours

The operator, 2026-11-01: *"data always keep userid. when retrieved and displayed, we can do whoami
calls to lookup their user data when it is needed. i do expect hadoku_site to build some resilient
and intelligent caching for whoami calls."* So this is a **whoami by userId**: cardtable stores
only userIds and calls this route every time it shows people, with no cache of its own. Resilient
caching (and whatever invalidation a rename or an erase needs) lives behind the route, once, for
every app, not in each consumer.

## What cardtable does meanwhile

Stored state keeps only userIds. Until this route exists, a name is shown only for someone the
server can see on a live request (`X-User-Name` on their own request or socket); anyone else shows
unnamed. When the route lands, cardtable calls it at display time and that gap closes.
