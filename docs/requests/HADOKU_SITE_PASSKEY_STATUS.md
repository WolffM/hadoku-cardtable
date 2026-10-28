# Request to hadoku_site: tell a caller whether they have a passkey

**From:** hadoku-cardtable, 2026-10-28. **Small, read-only, one field.**

## What for

The operator wants cardtable's front page to show an "Add a passkey" card to a friend who has
not registered one, and never to anyone who has. cardtable cannot tell today: `/session/whoami`
answers `userId`, `userType`, `name`, `scope` and nothing about passkeys, and the passkey store
is the edge router's own KV.

## The ask

Add a count to the caller's own `/session/whoami` answer:

```json
{ "userId": "…", "userType": "friend", "name": "…", "passkeys": 0 }
```

`passkeys` is `passkeyIdsFor(SESSIONS_KV, userId).length`
(`workers/edge-router/src/passkeys.ts:310`, the `passkeys:<userId>` index row). The caller's own
record only — no lookup of anyone else. Omit it (rather than `0`) when it cannot be read, so a KV
miss never nags someone who has one. A separate `GET /auth/passkey/status` → `{ "count": n }` is
just as good if whoami should stay lean; say which.

Please also add `passkeys?: number` to `WhoamiResult` in `@hadoku/prefs-client`, which is how
cardtable reads whoami.

## What cardtable does with it

Shows the card only when `passkeys === 0`, links it to hadoku.me's own passkey registration page
(we don't host the ceremony), and adds nothing until this ships.
