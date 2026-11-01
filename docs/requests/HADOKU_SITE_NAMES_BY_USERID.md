# Request to hadoku_site: a batch userId → display name route for servers

**From:** hadoku-cardtable
**To:** hadoku_site
**Date:** 2026-11-01
**Re:** IDENTITY_MODEL R4 / R12, cardtable#25
**Status:** open. Not a blocker: cardtable names only who it has seen, meanwhile.

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

## What cardtable does meanwhile

An in-memory userId → name map, fed from `X-User-Name` on every vouched request and socket
handshake, never written to disk. Someone not seen since the last restart shows unnamed. When
this route exists, the map becomes a cache in front of it and history views name everyone.
