# Request to hadoku-watchparty: drop the header's page-wide `:has()`

**From:** hadoku-cardtable
**Status:** request / not yet agreed
**Asking for:** `room-chrome.css` (`@wolffm/watchparty-ui@0.42.13`) to stop asking the whole page whether a
room frame follows the header:

```css
.app-header:has(~.wp-room-chrome-frame, ~* .wp-room-chrome-frame) { margin-bottom: 0 }
```

**Why:** a `:has()` with a sibling-then-descendant argument is checked again on every change in everything
after the header — the whole page below it. In a card game that is every frame. Chrome's selector stats over
two seconds of a six-creature attack (`e2e/combat-perf.spec.ts` in hadoku-cardtable, 2026-10-23): this rule
was re-matched 98 times and each match restyled the header (`Affected by :has()::HEADER class='app-header'`).
Cardtable removed its own page-level `:has()` rules the same day for the same reason, which halved its style
matching in combat; this one is the last, and it is in your sheet.

**What would do instead**, any of:

- a class or attribute the room frame's host sets (cardtable already marks its page frame with
  `data-room-frame` while `RoomChrome` is drawn, so `.cardtable-chrome[data-room-frame] > .app-header` would
  work for us today — but the rule belongs to your sheet, so a hook of your own is better);
- `RoomChrome` setting the header's margin itself while it is mounted;
- or simply no rule, and each host owning its header's margin.

**Not asking for** any change to the margin you get: the header still sits flush on the room frame.
