# Handoff: give this to a Claude session in `hadoku-watchparty`

**Filed 2026-09-30 by the cardtable tracker.** One person on two browsers turns
into two people in the room, and the second browser renames the account for
good. Everything below comes from watchparty's own production log and source
at `f54f34b9`. Nothing here was inferred from cardtable's side.

```sh
cd /home/hadoku/repos/hadoku-watchparty && claude
```

> Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/WATCHPARTY_SAME_ACCOUNT_TWO_CONNECTIONS.md`
> and fix it. Work in your own worktree
> (`git worktree add .claude/worktrees/same-account -b same-account origin/main`):
> two other sessions are live in this repo's main checkout, and wave 3
> (`w3-manager`) is in flight. None of the files below are wave 3's. Publish
> `@wolffm/watchparty-ui`, push to main, and report the published version plus
> each done-when with its evidence. Don't ask questions.

---

## 1. What the operator saw

On a cardtable match (`#/match/m-4c9483b3ec01`, room
`cardtable-m-4c9483b3ec01`), the operator signed in on a second browser with
the **same** key. The room chrome's roster then read:

```
3 online
[cleric] Heiter
[rogue]  Hadoku
[herald] Himmel
```

There were two people: Hadoku (the operator) and Heiter (a friend). The
operator was listed twice, and one of the two entries had been renamed to
**Himmel**, which is herald's default display name.

## 2. What the log shows

This is `~/.pm2/logs/watchparty-out.log`, times UTC, filtered to that room.
Identity was resolved correctly the whole time: **both browsers are
`fk:6c0ce5b433732b8d` at `account` tier.**

```
18:23:22 join             1tbY8w…  fk:6c0ce5…  Hadoku  rogue    ← browser 1
18:23:46 join             lklfTK…  fk:b74c01…  Heiter  cleric   ← the friend
   … browser 1 reconnects twice, keeps Hadoku/rogue (tHBb1r… is still live) …
19:41:27.777 join         3eL544…  fk:6c0ce5…  Hadoku  sage     ← browser 2; rogue is held by browser 1, so the server auto-assigns sage
19:41:27.964 identity_update 3eL544…           Hadoku  herald
19:41:27.966 identity_update 3eL544…           Himmel  herald   ← custom name replaced by a character default
19:42:26 join             Xm32bD…  fk:6c0ce5…  Himmel  herald   ← browser 2 reconnects, now sends Himmel itself
19:55:08 join             8o6AS8…  fk:6c0ce5…  Himmel  herald
```

`identity_update` is logged only **after** the server applies a change
(`apps/server/src/ws/presence.ts:100`). The rename therefore landed, and
`setClientName` at `:76` recorded it against the participant.

## 3. The three defects

### D1: an account competes with itself for its own sprite

A sprite claim belongs to a **connection**, so a second connection from the
same participant is refused the sprite that participant already holds. The
path:

- `apps/server/src/ws/join.ts:218-225`: the join's requested sprite fails
  `claimSprite`, and the server auto-assigns the first free one (`sage`).
- `apps/server/src/ws/presence.ts:81-90`: a later `identity_update` asking for
  `rogue` gets `conflict / sprite_taken`. That is emitted at debug level, which
  is why it is absent from the log above.

The fix: a sprite held by the **same `participantId`** is not taken. The second
connection gets the same sprite. Release has to be reference-counted, so the
sprite goes back to the pool only when that participant's last connection
leaves. `claimSprite` wraps `claimAvatar` in `packages/rooms-server`, so decide
whether the rule belongs in the package or in watchparty's wrapper, and say
which you chose.

### D2: the `sprite_taken` retry renames the person and saves the rename to their account

`apps/ui/src/lib/socket.ts:570-587`: on `sprite_taken`, the client picks the
next free character and calls `setIdentity(displayNameFor(c), c)`. That
**discards a custom name**. The `presence` handler 200 lines further down
(`:368-383`) preserves custom names explicitly; this path never learned to.

It is also **persisted to the account**:

- `setIdentity` (`apps/ui/src/lib/store.ts:247-253`) calls `savePref('name')` and
  `savePref('sprite')`.
- `savePref` (`apps/ui/src/lib/preferences.ts:243`) calls
  `watchpartyPrefs.save()` with no scope.
- The `@wolffm/prefs-client` `SaveOptions` doc reads: *"Default: 'user'"*.

So one retry on one browser rewrote the operator's saved name and sprite
everywhere. The fix:

- **Never replace a custom name here.** Apply the same `isCharacterName` rule
  the presence handler uses.
- **An automatic reassignment is not a choice.** It must not be written to
  `user`-scope prefs. Only a pick the person makes in the character modal is
  a preference.

Once D1 is fixed this path should almost never run for one person on two
browsers. It still runs for two different people who want the same sprite, and
they must not lose their names either.

### D3: the roster counts connections, not people

`listPresence` (`apps/server/src/rooms/store.ts:294-300`) emits one row per
client, and the UI keys the roster by `client_id` (`socket.ts:355-365`,
`apps/ui/src/components/Roster.tsx`). Two tabs make two rows, and the header
says "3 online" for two people.

The fix: one row per participant. `participantId` is already treated as
loggable (`join.ts:210` logs it as *"a digest, not the key"*), so grouping on it
server-side is the obvious shape. Keep the per-client map internally: votes,
readiness and leadership are all keyed by `clientId` and must not change
meaning. Anything the client finds by its own socket id (`myEntry` at
`socket.ts:256` and `:672`, and the presence handler's `roster[myId]`) has to keep
finding itself, so decide how a grouped row tells a client "this is you".

**Not a defect, for the avoidance of doubt:** `ephemeral`-tier participants
(no key, no device id) key on the socket id, so they are one row per
connection by construction, and that is correct.

## 4. Repair: the operator's account already holds the bad values

After the fix ships, the operator's `watchparty` prefs row (user
`de5c2a05-…-fd69`) very likely still says `name: "Himmel"`, `sprite:
"herald"`, because of D2. The server's per-participant name store also has
`Himmel` for `fk:6c0ce5…` until the room is forgotten. Say what you found and
what you did about it. If you cannot read the row, say so, and the operator
will re-pick in the character modal. Do not write another user's row.

## 5. Done when

Each item names the artifact that proves it.

1. **D1, server test** in `apps/server/test/` (next to `join.test.ts` and
   `identity-persistence.test.ts`): one participant joins on two sockets.
   - The second socket gets the same sprite with no `sprite_taken`.
   - Closing either socket leaves the sprite claimed.
   - Closing both releases it.
   - Mutation-tested: revert the fix and the test fails, restore it and it
     passes. Give the counts.
2. **D2, UI test** under `apps/ui/src/lib/__tests__/`: a `sprite_taken` retry
   with a custom name set:
   - keeps the custom name;
   - makes no `user`-scope `save()` call.
   Mutation-tested, same shape.
3. **D3, server test**: two sockets for one participant plus one for another
   gives presence with **2** rows. The existing presence and identity suites
   stay green.
4. **An end-to-end test with two browser contexts on one key** in `e2e/`:
   - roster count 1;
   - the name the account had before the second browser joined is unchanged
     on both;
   - both show the same sprite.
5. **Published:** `@wolffm/watchparty-ui` at a version above `0.39.8`
   (cardtable pins `0.39.8` in `apps/ui/package.json`). If D1 or D3 lands in
   `packages/rooms-server`, publish that too. Report both versions.
6. **Deployed:** watchparty's pm2 process restarted after the install, with the
   running commit named.

## 6. Out of scope, and why

- **Cardtable's side stays in cardtable** (tracked on its board for wave 31):
  - its `POST /<matchId>/identity` avatar assert 404s, because it is sent with
    the match id where the room id belongs;
  - `apps/ui/src/room/avatar.ts` reads the chosen avatar only from this
    browser's prefs cache.

  Cardtable will bump to your new `watchparty-ui` version itself; do not edit
  cardtable.
- **Identity derivation is correct.** Both browsers resolved to the same
  `account`-tier participant. Do not touch `deriveParticipantId`.
