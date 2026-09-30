# P6: one page boundary (lane L)

Measured in headless Chromium against a production build of this worktree (`vite build`, `base: /cardtable/`), route `#/match/m-probe` inside the watchparty room chrome (`/session/whoami` answered as a friend so `RoomChrome` mounts; the match socket has no server, so the table is the `Connecting…` state). Edges are `getBoundingClientRect()` left/right in CSS px.

- **table** = `.live` (the canvas box the board fills; `.board` is a flex child of it with the same left and right edges).
- **header** = `.app-header` (inset `2rem` by `chrome.css`).
- **chat** = watchparty's `.wp-room-chrome` aside (`flex: 0 0 20rem`, at the end of `.wp-room-chrome-frame`).
- **before** = the same page with lane L's two rules overridden back to their old values (`.cardtable-chrome__content` padding 0, `.shell--match` side padding 8px); **after** = as shipped.

| viewport | variant | header L | header R | table L | table R | chat L | chat R | table L minus header L | chat R minus header R |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1280x800 | before | 32 | 1248 | 8 | 952 | 960 | 1280 | -24 | 32 |
| 1280x800 | after | 32 | 1248 | 32 | 928 | 928 | 1248 | 0 | 0 |
| 1366x768 | before | 32 | 1334 | 8 | 1038 | 1046 | 1366 | -24 | 32 |
| 1366x768 | after | 32 | 1334 | 32 | 1014 | 1014 | 1334 | 0 | 0 |

Reading it: before, the table began 24px outside the bar (x=8 against x=32) and the chat ran to the viewport's right edge, 32px beyond the bar's right end (1280 against 1248; 1366 against 1334). After, the table's left edge and the chat's right edge are the header's own, at both sizes, and nothing scrolls sideways (`scrollWidth` equals the viewport).

## What changed, and the chat's edge

`live.css` only. `.cardtable-chrome__content:has(.shell--match)` gets `padding-inline: 2rem` (the bar's number), and `.shell.shell--match` loses its 8px side padding. The chat's edge CAN be moved from our CSS without a rule on watchparty's class: `.wp-room-chrome` is `flex: 0 0 20rem` with no margin, a flex item of `.wp-room-chrome-frame { width: 100%; display: flex }`, and that frame is 100% of `.cardtable-chrome__content`, so insetting the content block insets the frame and therefore the chat. Nothing needs to be filed upstream for this half.

## Cost, for lane E

The table is 64px narrower in a room: 944 to 896 at 1280 wide and 1030 to 982 at 1366. `e2e/table-fit.spec.ts` asserts `live.width >= viewport - 320 - 24` and its comment says 944/1030 (the 16px shell padding); the new widths are `viewport - 320 - 64`. That spec is lane E's file; the assertion and the comment need the new number.

## Not measured

A live board (no Forge server in this probe), so the screenshot shows the `Connecting…` table with the control cluster, not cards. The board is a child of `.live` and inherits its edges. Screenshots: `p6-boundary-1280x800.png`, `p6-boundary-1366x768.png` (after state). Raw numbers: `p6-raw.json`.
