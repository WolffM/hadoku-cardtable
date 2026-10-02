# Request to `hadoku-watchparty`: let a RoomChrome host collapse and resize the chat

**Filed 2026-10-02 by the cardtable tracker. Status: request, not yet sent.**

```sh
cd /home/hadoku/repos/hadoku-watchparty && claude
```

> Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/WATCHPARTY_CHAT_COLLAPSE.md` and do it. Work
> in your own worktree; other agents are live in this repo. Publish `@wolffm/watchparty-ui`, land on
> main, confirm the deploy, remove the worktree, and report the version. Don't ask questions.

## What the operator asked

Cardtable's play-test, 2026-10-02: *"chat should be collapsable, just like it already is in watchparty.
it should also be drag-to-resizable."*

## What exists

Watchparty's own app collapses its chat (`toggleChatCollapsed` in `apps/ui/src/lib/store.ts`). The
`RoomChrome` export that cardtable mounts (`dist/room-chrome.d.ts`) takes `roomKey`, `serverOrigin`,
`userType`, `userId`, `sessionId`, `theme`, `name`, `onLeave`, `debug` and `children`: nothing for
collapse or width, and the chrome does not render the collapse control.

## The ask

1. **Collapse**, inside `RoomChrome`: the same control watchparty's own chat has, a collapsed state that
   gives the host's `children` the freed width, remembered per viewer the way watchparty already
   remembers it.
2. **Drag to resize** the chat's width, with a sensible minimum and maximum, remembered per viewer.
3. Both work without the host passing anything. If a host needs to know (to re-measure its own layout),
   an optional `onLayoutChange?: (state: { collapsed: boolean; width: number }) => void` prop.

## Done when

- A host mounting `RoomChrome` with no new props gets a collapsible, resizable chat; a test for each.
- Published `@wolffm/watchparty-ui` version reported; cardtable bumps to it (its bot auto-updates
  `@wolffm/*`, so it may arrive on its own).
- Deployed, with the running commit named.
