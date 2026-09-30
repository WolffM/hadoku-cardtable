# Handoff: give this to a Claude session in `hadoku-watchparty`

**Filed 2026-09-30 by the cardtable tracker; revised the same day after the
operator ruled on §3.** A second browser on the same account renames the
account, for good. Everything below comes from watchparty's own production log
and source at `f54f34b9`. Nothing here was inferred from cardtable's side.

The worktree is already scaffolded: branch `same-account`, with
`node_modules` resolving workspace packages to the worktree, the media links
and the vault file in place, and a green baseline. Its setup and landing rules
are in its own `docs/handoff/same-account.md` (gitignored).

```sh
cd /home/hadoku/repos/hadoku-watchparty/.claude/worktrees/same-account && claude
```

> Read docs/handoff/same-account.md, then the brief it points to, and fix it.
> Other agents are live in this repo, so stay in this worktree and on the
> `same-account` branch. Publish `@wolffm/watchparty-ui`, land on main, confirm
> the deploy, remove the worktree, and report the published version plus each
> done-when with its evidence. Don't ask questions.

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

## 3. The defect, and what is NOT one

**Operator's ruling, 2026-09-30. Settled; do not re-open:** *"it does make sense
that multiple browsers would be treated as separate entities."* A second
browser on the same account is its own roster row, and it may have its own
sprite. A roster that reads "3 online" for two people on three connections is
**correct**. What is wrong is that the second connection **renamed the
account**: *"it is pretty weird that it loaded with himmel since it recognized
my account."*

### How the rename happens

1. `apps/server/src/ws/join.ts:218-225`: the second connection's requested
   sprite (`rogue`) is held by the account's first connection, so the server
   auto-assigns the first free one (`sage`). That is fine.
2. The client then asks for its saved sprite again with an `identity_update`,
   and `apps/server/src/ws/presence.ts:81-90` answers `conflict / sprite_taken`.
   That is emitted at debug level, which is why it is absent from the log above.
3. `apps/ui/src/lib/socket.ts:570-587`: on `sprite_taken`, the client picks the
   next free character and calls `setIdentity(displayNameFor(c), c)`. That
   **replaces the account's name with the character's default.** The
   `presence` handler (`:368-383`) preserves custom names explicitly; this path
   never learned to.
4. **Then it saves the rename to the account.**
   - `setIdentity` (`apps/ui/src/lib/store.ts:247-253`) calls
     `savePref('name')` and `savePref('sprite')`.
   - `savePref` (`apps/ui/src/lib/preferences.ts:243`) calls
     `watchpartyPrefs.save()` with no scope.
   - The `@wolffm/prefs-client` `SaveOptions` doc reads: *"Default: 'user'"*.

   One retry on one browser rewrote the operator's saved name and sprite
   everywhere, and `presence.ts:76` (`setClientName`) recorded "Himmel" against
   the participant on the server too.

### What to change

- **A connection never takes a name it did not choose.** An automatic sprite
  reassignment, whether on join or on `sprite_taken`, keeps the name the
  connection already has. Apply the same `isCharacterName` rule the presence
  handler uses. A connection with no name at all may still take a character
  default, as today.
- **An automatic reassignment is not a preference.** It must not be written to
  `user`-scope prefs, and must not reach `setClientName`. Only a pick the
  person makes in the character modal is saved.
- **Stop fighting the account's other connection.** When the saved sprite is
  held by another connection of the same `participantId`, the second
  connection should accept the sprite the server gave it, not
  re-request the saved one and trip `sprite_taken`. How the client learns
  "held by me elsewhere" is your call: the server knows it (`meta.participantId`
  on both), so a distinct reason on the refusal is one option. Say which you
  chose.

Two different people who want the same sprite still go through
`sprite_taken`, and they must keep their names too.

## 4. Repair: the operator's account already holds the bad values

After the fix ships, the operator's `watchparty` prefs row (user
`de5c2a05-…-fd69`) very likely still says `name: "Himmel"`, `sprite:
"herald"`, because of the rename in §3. The server's per-participant name store also has
`Himmel` for `fk:6c0ce5…` until the room is forgotten. Say what you found and
what you did about it. If you cannot read the row, say so, and the operator
will re-pick in the character modal. Do not write another user's row.

## 5. Done when

Each item names the artifact that proves it.

1. **UI test** under `apps/ui/src/lib/__tests__/`: a `sprite_taken` retry
   while a custom name is set:
   - keeps the custom name;
   - makes no `user`-scope `save()` call.

   Mutation-tested: revert the fix and the test fails, restore it and it
   passes. Give the counts.
2. **Server test** in `apps/server/test/` (next to `join.test.ts` and
   `identity-persistence.test.ts`): one participant on two sockets.
   - The second socket keeps the name it joined with.
   - Nothing it is auto-assigned reaches `setClientName`.

   Mutation-tested, same shape.
3. **An end-to-end test with two browser contexts on one key** in `e2e/`:
   - both rows carry the name the account had before the second browser
     joined;
   - the account's saved prefs are unchanged afterwards;
   - two rows is correct, per the ruling in §3.
4. **Published:** `@wolffm/watchparty-ui` at a version above `0.39.8`
   (cardtable pins `0.39.8` in `apps/ui/package.json`). If anything lands in
   `packages/rooms-server`, publish that too. Report both versions.
5. **Deployed:** watchparty's pm2 process restarted after the install, with the
   running commit named.

## 6. Out of scope, and why

- **Cardtable's side stays in cardtable** (tracked on its board for wave 31):
  - its `POST /<matchId>/identity` avatar assert 404s, because it is sent with
    the match id where the room id belongs;
  - `apps/ui/src/room/avatar.ts` reads the chosen avatar only from this
    browser's prefs cache.

  Cardtable will bump to your new `watchparty-ui` version itself; do not edit
  cardtable.
- **Who may act in a game is cardtable's.** The operator's rule is that a second
  browser on an account that already holds a seat joins as a spectator. That
  is enforced on cardtable's match socket, not in the room chrome.
- **Identity derivation is correct.** Both browsers resolved to the same
  `account`-tier participant. Do not touch `deriveParticipantId`.
