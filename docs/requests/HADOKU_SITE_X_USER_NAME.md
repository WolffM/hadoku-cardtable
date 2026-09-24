# To hadoku_site: inject `X-User-Name` beside `X-User-Id`

**Ask:** on routes with `injectUserId`, also set `X-User-Name` from the same
registry record, with the same trust rule — exclusively edge-injected, any
client-supplied value stripped first.

## Why

cardtable's room roster shows who is at the table. The server-side caller is
built from your headers, and the only identity you inject is `X-User-Id` —
which the registry doc explicitly calls **"opaque, not a UUID… do not parse
it."** So the roster read like:

```
2a25151a-5ec8-4a1e-8212-f2a34aa2491c
```

The operator's reaction: *"come on man. GUIDs for names? hideous. surely you
can use the proper display name."*

The display name already exists where the injection happens.
`whoamiHandler` returns `record?.name`, and the injection site in
`workers/edge-router/src/proxy.ts` holds the **same record** at the moment it
sets `X-User-Id`:

```ts
if (injectUserId) {
    headers.delete('X-User-Id');
    const keyForRegistry = resolvedSessionKey ?? c.req.header('X-User-Key') ?? null;
    if (keyForRegistry) {
        const record = await getKeyRecord(keyForRegistry, c.env);
        if (record?.userId) {
            headers.set('X-User-Id', record.userId);
        }
    }
}
```

So the ask is, in the same block:

```ts
headers.delete('X-User-Name');          // with the X-User-Id strip above
if (record?.userId) {
    headers.set('X-User-Id', record.userId);
    if (record.name) headers.set('X-User-Name', record.name);
}
```

`null` (a key issued but never named, per `whoamiHandler`'s own comment) simply
omits the header — the consumer falls back to a word, not an identifier.

## Notes

- **No extra KV read.** The record is already fetched for `X-User-Id`; this is
  one more header off data in hand.
- **Display names are unique among live keys** (`isNameTaken`,
  `updateOwnNameHandler`), so they are safe as roster labels.
- **It is a display string, not an identity.** Consumers must keep keying by
  `X-User-Id`; cardtable's participant ids are unchanged. We treat the header
  as exactly as forgeable as `X-User-Id` — stripped client-side unless the edge
  vouched — and sanitize it in the same class on receipt.
- Our consumer half is ready and held: `apps/server/src/edge-auth.ts` gains
  `userNameOf()` with the same strip rule as `x-user-id`, and `callerOf` in
  `http/rooms.ts` uses it (fallback `'friend'`) instead of `userIdOf(req)`.

— hadoku-cardtable tracker, 2026-09-24
