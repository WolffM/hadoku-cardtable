# Request to hadoku-watchparty: let a host read the viewer's selected avatar

**From:** hadoku-cardtable
**Status:** request / not yet agreed
**Asking for:** a typed way for a `RoomChrome` host to learn (a) which character
the viewer picked, (b) which characters the room's other members picked, and (c)
the URL that draws one. Three values, all of which `room-chrome.js` already
computes and none of which is on its public surface.

**Not asking for:** a new socket event, a new server route, or any change to how
the picker works. Everything below already exists inside the bundle; the ask is
an export.

**Builds on** `WATCHPARTY_ROOM_MODULE.md` §1, which already says *"Same for
identity: `spriteId` generalises to `avatarId`, and `CHARACTER_ORDER` moves out of
the module (it's a watchparty asset list, not a room concept) into config the host
app supplies."* This is that paragraph, narrowed to the one thing a host needs
before the extraction lands, and with the evidence attached.

---

## Why you're getting this

Our operator, after a play test on 2026-09-28: *"i noticed you're still not
pulling in the watchparty selected avatars. why not?"*

Fair question, and the answer is not "we forgot". `@wolffm/rooms-protocol@0.39.8`
already carries the field — `RosterIdentity`, `LocalIdentity` and
`IdentityReassert` in `dist/resync.d.ts:77-88`, all typed `avatarId?: string |
null` — and our own room snapshot has persisted it since it was written
(`packages/room-store/src/snapshot.ts`, the field at `:63` and `:268`, the write
at `:236`, the parse at `:380`). The protocol half of this is done and it is
yours.

What is missing is the one hop where the value would enter our app. We mount
`RoomChrome` (`apps/ui/src/room/RoomShell.tsx`) and it owns the picker, the
store and the socket — so it is the only thing on the page that knows the answer.
And `@wolffm/watchparty-ui@0.39.8` ships exactly two `.d.ts` files, **neither of
which contains the string `avatar` or `sprite`**:

```sh
# from a checkout with the package installed
W=node_modules/@wolffm/watchparty-ui
grep -ril 'avatar\|sprite' $W/dist --include='*.d.ts'   # no output, exit 1
grep -rl  'sprite'         $W/dist --include='*.js'     # room-chrome.js + 2 chunks
```

`RoomChromeProps` is `roomKey`, `serverOrigin`, `userType`, `userId`, `sessionId`,
`theme`, `onLeave`, `debug`, `children`. That is the whole surface, and none of it
answers "who is this person wearing".

## What we did instead, and why we would rather not have

We shipped it anyway, by reading the values out of your bundle and restating them.
`apps/ui/src/room/avatar.ts` is the whole of it, and every constant in it quotes
the shipped 0.39.8 code it came from:

| What we need | What we do today | Derived from |
| --- | --- | --- |
| the viewer's avatar id | read `localStorage['prefs-cache:<userId>:watchparty'].blob.sprite` | `Vt()`, `nt()`, and `se = createPrefsClient({ appId: "watchparty", schema: Or })` where `Or` declares `sprite: z.string().optional()` |
| skip it mid-sign-in | mirror your own guard: refuse when `hadoku_session_id` is set and the userId is `public`/empty | `Yt()` |
| the image | `` `${serverOrigin}/media/sprites/square_${id}.png` `` | `Ee()` |
| the bound | 1–32 characters, not an enum | `sprite: z.string().min(1).max(32)` on your join and identity payloads |

Three things are wrong with that, in increasing order of how much we mind:

1. **It is your private storage layout.** We are reading another app's prefs
   cache row by key. It is the same user, the same origin and the same fleet, and
   your own boot read (`nt("watchparty")`) does exactly this — but it is not a
   contract, and a rename inside the SDK's cache envelope breaks us silently, in
   the "nobody has a face" direction that nothing reds.
2. **It is one load behind.** The cache is a write-through of your prefs row, so a
   viewer who has never opened the chrome on this browser has no row and no
   avatar until their second visit. A live accessor has no such window.
3. **It cannot see anybody else.** Your roster has every member's `sprite`
   (`roster[clientId].sprite`); the prefs row has only the viewer's own. So we can
   draw the local player's face and nobody else's from your side — the other
   seats reach us the long way round, through each of their own browsers
   asserting to our server.

## What would replace all of it

Any one of these; the first is the smallest.

**1. Identity out of the chrome (what we actually need).** A callback prop, so the
host learns the viewer's identity when it resolves and when it changes:

```ts
interface RoomChromeProps {
  // …existing props…
  /** The viewer's identity as the chrome resolved it, on mount and on change. */
  onIdentity?(identity: { name?: string | null; avatarId?: string | null }): void;
}
```

`avatarId`, not `sprite`, because that is the name `@wolffm/rooms-protocol`
already uses and the name our store already persists — you convert at the one
place you already convert, where `resolveIdentityReassert` is called as
`{ name: n.name, avatarId: n.sprite }`. `null` and absent both reaching us is
fine: we fold them to the same thing and say so.

**2. The roster too, if it is cheap.** The same callback shape keyed by member, or
a second `onRoster`. This is the one that would let a host draw every seat's face
without a round trip through our own server, and it is the difference between
"the avatars work" and "the avatars work for whoever is looking".

**3. The sprite URL as a function.** `avatarUrl(avatarId, serverOrigin)`, exported.
`Ee()` with its arguments made explicit. This one is nearly free and it removes
the one line of ours most likely to rot, because `square_` is a file-naming
convention and not an API.

A `CHARACTER_IDS` export (`sage`, `herald`, `cleric`, `knight`, `mage`, `brawler`,
`wanderer`, `rogue`) would be welcome but is **not** part of the ask — we
deliberately do not validate against it, so that a ninth character you add
reaches our seats instead of being dropped by a list we forgot to update.

## What we are not asking you to worry about

- **Our own wire.** We carry the id from our room member to our table view
  ourselves (`apps/server/src/room/lobby.ts`, `apps/server/src/http/routes.ts`),
  and we normalise the three states of `avatarId?: string | null` to two before
  anything draws. That is ours and it is done.
- **Whether the value is trustworthy.** We accept it from the browser, and the
  row it lands on is a ParticipantId derived from the edge's headers, so the worst
  a caller can do is draw the wrong face on their own seat. No credential rides
  this field and we would not want one to.
- **`debug: true`.** We know it publishes `__ZUSTAND_STORE__` and that the value is
  reachable through it. We are not going to ship a product path that depends on a
  debug handle, so please do not count that as the accessor.

## Until then

`apps/ui/src/room/avatar.ts` and `avatar.test.ts` are the only two files that know
any of this, on purpose: the tests assert the derivations as executable claims, so
a package bump that moves the cache key or the sprite path fails there rather than
quietly drawing nobody. When an accessor lands, both files shrink to an import and
the tests become redundant, which is the outcome we want.
