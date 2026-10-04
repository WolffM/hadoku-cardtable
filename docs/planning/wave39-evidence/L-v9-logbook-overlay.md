# L — V9: the logbook is an overlay over the main view

Operator (playtest 6): *"the log is shown over the main screen, not confined to the left side
bar."* Settled in the wave file: *"the log is an overlay over the main view, not a left
side-bar. It must not take pointer events from the board when closed, and must not cover the
control bar."*

## What changed

`apps/ui/src/play/live/live.css`, `.live__logbook`:

- `width: 15rem` deleted. `right: calc(var(--live-rail-w) + var(--live-gutter) + 6px)` added —
  the panel now reaches from the board's left edge (`left: 6px`, unchanged) across to just short
  of the rail-and-controls gutter, instead of stopping at a fixed narrow width. Because the
  control cluster (`.live__buttons`) and the phase rail (`.live__phases`) both already live in
  that same gutter (`right: var(--live-gutter)`), the one measurement keeps the open panel off
  the control bar without a second number to keep in sync with it.
- New rule `.live__logbook:not([hidden]) { pointer-events: auto; }`. The base rule keeps
  `pointer-events: none`. Collapsed, the panel is `display: none` (existing `[hidden]` rule) and
  so is never a pointer target regardless; open, it needs to accept the pointer so the list can
  be scrolled and a card name can be hovered.
- `.live__log` (the `<ul>`): `justify-content: flex-end` + `overflow: hidden` replaced with
  `overflow-y: auto; overflow-x: hidden; flex: 1 1 0;` — the list is now the scroll owner inside
  the panel's fixed-height box, rather than clipping silently.

`apps/ui/src/play/live/LiveBoard.tsx`:

- New `logListRef` (a ref on the `<ul className="live__log">`) and an effect that sets
  `el.scrollTop = el.scrollHeight` whenever the panel is open and `match.says.length` changes —
  keeps the newest line in view on open and on every new line that arrives while open.

Test ids are unchanged: `live-logbook`, `live-log`, `live-says`, `live-turn` all still resolve to
the same elements in the same relative structure.

## Unit tests

`apps/ui/src/play/live/LiveBoard.test.ts`, `describe('the controls are a cluster over the board,
not a bar under it')`:

- `the logbook is a wide overlay over the main view, starting at the left edge` — asserts
  `position: absolute`, `left: 6px`, no fixed `width`, `right: calc(var(--live-rail-w) +
  var(--live-gutter) + 6px)`, `top: 6px`, `bottom: 6px`, no `max-height`, `overflow: hidden` (the
  panel itself still clips as a last resort), `z-index: 1`.
- `the logbook takes no pointer events while closed, and is interactive while open` — asserts the
  base rule has `pointer-events: none` and `.live__logbook:not([hidden])` has `pointer-events:
  auto`.
- `the log list is the scroll owner, and opening it scrolls to the newest line` — sends 5 then 6
  `message` lines, opens the panel, and asserts the stylesheet gives `.live__log` `overflow-y:
  auto` and `flex: 1 1 0` (a bounded, scrolling box). jsdom gives every element zero scroll
  dimensions, so the actual scroll POSITION cannot be asserted end to end in this suite — only
  that the effect runs without throwing against a real ref and the CSS contract it depends on is
  in place.
- `every slot in it is a fixed track...` (existing test, updated): `.live__log`'s declarations
  now assert `overflow-y: auto` instead of `overflow: hidden`.

Run from the worktree root: **266/266 passed, exit 0**.

## Live frame (viewed, not committed — `/tmp/claude-1000/w39-L/`)

Rendered the real `LiveBoard` against the committed replay fixture (the same capture
`LiveBoard.test.ts` itself replays) via `apps/ui/src/play/live/harness.html?match=<id>&server=<url>`
under a `vite` dev server, driven with the Playwright MCP tools at 1280×800. (First attempt hit a
transient `rolldown-vite` dev-server bug — "Missing field `moduleType`" from the react-refresh
plugin on a secondary HTML entry, unrelated to this change; a `vite build` of `harness.html`
served statically worked cleanly and is what the screenshots below are from.)

- **`frame-closed.png`**: the board full-width, nothing from the logbook visible or intercepting
  the pointer — the control cluster (Untap/Upkeep/.../OK/Full control/Concede), the phase rail,
  and the log's own toggle button all sit in the right-hand gutter, unobstructed.
- **`frame-open.png`**: clicking the log toggle opens a wide panel covering the left ~90% of the
  view (`getBoundingClientRect()` on `live-logbook`: `{left:6, top:6, right:1160, bottom:794}` at
  this 1280×800 window) — clearly an overlay over the main view, not a narrow sidebar. The
  control cluster, phase rail and log button all stay fully visible and clickable in the
  untouched right-hand gutter (`live-buttons` spans roughly `x:1162` to `x:1274` at this width —
  2px clear of the logbook's right edge, matching the `calc()` in the stylesheet). Ten `message`
  lines are shown, newest (`played Lightning Bolt`) at the bottom and already in view with no
  manual scrolling, coloured by kind (`paid …` full ink, `played …` blue with an underlined
  hoverable card name, `full control on/off` faint italic, `auto-passed …` default dim) — the
  existing per-kind colouring (wave 28 §A.11) is untouched by this change. The board's own cards
  are hidden behind the opaque panel while it is open (`background: var(--bg-raised)`, not
  transparent) — expected for an overlay that covers the main view, not a side panel that shares
  it. The stack and its targeter arrow (lane A's own overlay root, z-index 2) still draw ON TOP
  of the open logbook (z-index 1), as before.

## For lane E

- `live-log`, `live-logbook`, `live-says`, `live-turn` resolve to the same elements as before;
  nothing here changes how a spec FINDS them.
- A spec that measured the logbook's box (none currently do, per the wave file's blast-radius
  table) would see a much wider box than before: `width: 15rem` is gone, replaced by `right:
  calc(var(--live-rail-w) + var(--live-gutter) + 6px)`.
- A spec that asserted the logbook has `pointer-events: none` unconditionally would now be wrong
  while the panel is OPEN — it is `auto` then, specifically so the list can be scrolled and a
  logged card name can be hovered. Closed, `pointer-events: none` (and `display: none`) still
  hold exactly as before.
- No readers of `live-log`/`live-logbook`/`live-says`/`live-turn` exist yet in `play.spec`, `w31`
  or `w35` R11 that assert geometry or pointer-events (checked by reading each); they read text
  content only, which is unaffected.
