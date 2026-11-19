# Request to `hadoku-watchparty`: the chat pane's toolbar on `RoomChrome`, with room for a host's own buttons

**From:** hadoku-cardtable · **Filed:** 2026-11-19 · **Status:** sent to a watchparty session the same day.

Hand it over with:

```sh
cd /home/hadoku/repos/hadoku-watchparty && claude
```

> Read `/home/hadoku/repos/hadoku-cardtable/.claude/worktrees/door/docs/requests/WATCHPARTY_CHAT_TOOLBAR.md`
> and do it. Work in your own worktree; other agents are live in this repo. Publish, land on main,
> confirm the deploy, remove the worktree, and report what version carries it. Don't ask questions.

## What the operator asked for

2026-11-19, of cardtable's draft, deck-building and sideboard screens:

> when in side-boarding, deckbuilding and drafting phase i would prefer if the top bar disappeared
> and we instead used the more compact view of having all the settings buttons in the chat pane.
> (watchparty already does this you can check how they organize their ui)

and, on how:

> the buttons in the top of the chat ideally would come directly from the watchparty-chatui package
> i would prefer if we handrolled as little as possible. they already have this built all we should
> really need is the ability to add custom buttons to the list (since we dont use the media loader
> button they use, and we need other stuff like the github and discord buttons.

## What exists today (read from your source at `032b2282`, and from `@hadoku/watchparty-ui@0.45.124`)

- The app's own chat pane, `apps/ui/src/components/ChatPanel.tsx`, draws the toolbar the operator
  means, inline: `div.chat-toolbar` holding Home, Select Media, `HadokuThemePicker`,
  `ConnectedSettings` (with `GameSettingsSection`) and `RosterButton`.
- The exported chrome, `apps/ui/src/roomChrome/RoomChrome.tsx` (`./room-chrome`), draws a different,
  smaller header on its rail: `RosterButton`, a spacer, an optional `Leave`, and `Hide chat`. No
  Home, no theme picker, no settings.
- `dist/room-chrome.d.ts` exports `RoomChrome` and `RoomChromeProps` and nothing else, so a host
  cannot compose the app's toolbar itself. Cardtable draws its own header for the same controls
  (`packages/game-ui/src/chrome/`), which is the hand-rolled copy the operator wants gone.

## The ask

**One toolbar component, used by both `ChatPanel` and `RoomChrome`, and a prop on `RoomChrome` that
turns it on and lets the host add to it.** Suggested shape; the names are yours:

```ts
interface RoomChromeToolbar {
  /** Home: where it goes is the host's. Absent: no Home button. */
  onHome?: () => void;
  /** The platform theme picker. Default true. */
  theme?: boolean;
  /** The fleet settings popout. `children` is the host's own section inside it (your GameSettingsSection slot). Default true. */
  settings?: boolean | { section?: ReactNode };
  /** The host's own buttons, drawn after yours and before the roster button, in the order given. */
  extra?: readonly RoomChromeToolbarButton[];
}
interface RoomChromeToolbarButton {
  id: string;
  /** The accessible name and the tooltip. */
  label: string;
  /** A 24×24 path or an element: your call, as long as it draws at your icon size and colour. */
  icon: ReactNode;
  /** One of the two: a link that opens outside, or a press. */
  href?: string;
  onPress?: () => void;
}
// RoomChromeProps gains:  toolbar?: RoomChromeToolbar   (absent: today's rail header, unchanged)
```

What matters to us, in order:

1. **It is your component, not a lookalike.** Same markup, classes and spacing as `ChatPanel`'s
   `chat-toolbar`, so a change you make to the app's toolbar reaches us on the next version.
2. **Select Media is not in it for a host.** It is watchparty's own; your app adds it through the
   same `extra` list, or keeps drawing it itself.
3. **`extra` buttons** — cardtable passes two links today (Discord, GitHub) and may add presses later.
4. **The settings popout takes a host section**, the way yours takes `GameSettingsSection`. Cardtable
   already mounts its game settings into `ConnectedSettings` in its own header; with this it would
   pass that section through.
5. **Leave and Hide chat stay** where the rail header has them, on the same row.
6. **Absent `toolbar` changes nothing**: every current consumer keeps today's header. Cardtable turns
   it on screen by screen.

## Constraints we know of

- `dist/room-chrome.d.ts` is checked on every build as the contract cardtable consumes
  (`vite.room-chrome.config.ts`'s own comment): the new props belong in it.
- The chrome must keep working with `collapsible={false}` and with the chat collapsed (the toolbar is
  then not drawn; cardtable keeps a way to reach settings on its own screen for that case and will
  ask separately if that proves awkward).
- Themes: cardtable passes `theme`; the picker must write the same shared theme prefs it writes in
  your app, nothing host-specific.

## How we will use it

`packages/game-ui/src/room/RoomShell.tsx` mounts `RoomChrome`. On the draft, deck and sideboard
screens it will pass `toolbar` and hide its own header (`packages/game-ui/src/chrome/`); the other
screens follow once the operator has seen those three.

## What we need back

The published version that carries it, and the final prop names if they differ from the sketch.
