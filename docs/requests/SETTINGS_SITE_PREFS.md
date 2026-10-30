# Request to hadoku_site (+ hadoku-task): your character in the account settings, and a shared `games` prefs row

**From:** hadoku-cardtable, 2026-10-30
**Owner of the change:** `@wolffm/task-ui-components`'s `ConnectedSettings`
(`hadoku-task/task-ui-components`), with the prefs contract in hadoku_site
(`packages/prefs-client`, `workers/prefs-api`).
**Status:** request / not yet agreed.
**Companion:** `SETTINGS_WATCHPARTY_SLOT.md` (watchparty's half).

## What the operator decided

Two people could not find cardtable's settings mid-match: they hid behind your own avatar. The
operator, 2026-10-30:

> *"the right way to do this is to have hadoku_site prefs handle as much as possible. I think
> moving out the avatar stuff into their ui is pretty clean. then, we can utilize the generic
> 'site settings' section that already exists in that settings modal and shove everything in
> there. … if we can move avatar to top level prefs, and stuff like music volume and checkboxes to
> site-level prefs that's pretty clean."*

So there is one settings popout, `ConnectedSettings`. It holds the person (yours), and under
"App preferences" (its `children` slot) the game (ours). Two things on your side make that work.

## 1. A character row in `ConnectedSettings`

**Today:** the character ("sprite", the fleet's `avatarId`) is chosen in watchparty's chat
column (`apps/ui/src/components/CharacterModal.tsx`) and saved in watchparty's own prefs row:
`appId: 'watchparty'`, field `sprite`, user scope (`apps/ui/src/lib/store.ts:265-270`). Cardtable
and bomberman both read it from there (`apps/ui/src/room/avatar.ts` in each repo). So a character
can only be chosen inside a watchparty room, even though three apps use it.

**Ask:** make the character part of the person:

- A row in `ConnectedSettings`, beside the display name, that opens the character grid.
- Its value kept in a platform-wide row, the way theme already is (`'portfolio'`), or in
  `whoami` beside the name. The field stays an `avatarId` string, `z.string().min(1).max(32)`,
  as `rooms-protocol` already types it.
- The art stays watchparty's: the picker needs the character list and its URL rule
  (`watchparty/apps/ui/src/lib/characters`). Whether that list moves to a shared package or
  `ConnectedSettings` takes it as a prop is your call.

What cardtable does once it ships: read the platform-wide value instead of `appId: 'watchparty'`
(one constant in `apps/ui/src/room/avatar.ts`).

## 2. A shared `games` prefs row

Cardtable now keeps master **mute** and **volume** in `appId: 'games'`, fields `muted: boolean`
and `volume: number` (0..1), **device scope** (the right volume belongs to the speakers, not the
account). Landed in `e47dc2de` (`apps/ui/src/sound/mute.ts`). The game's own levels stay in
`cardtable-sound`.

**Ask:**

- Record `games` as a platform row whose fields are shared by every hadoku game, so the next
  game adopts it instead of inventing its own. Bomberman still keeps `bomberman.volume` in
  localStorage (`hadoku-bomberman/apps/ui/src/game/audio.ts:43`).
- Add it to whatever list of app ids prefs-api or the fleet docs keep. The API accepts any
  `[a-z0-9-]+` id today (`workers/prefs-api/src/routes/prefs.ts:48`), so nothing is blocked.

## Not asking for

- A change to `AppHeader` or its `children` slot. Cardtable puts its own panel in that slot
  (`apps/ui/src/App.tsx`), which is exactly what the slot is for.
- Room-level rules. Those stay in the room, since they're the room's and not a person's.
