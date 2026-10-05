# §U evidence — the format tab selector

Operator, 2026-10-05: *"i'll need a tab selector at the top for picking the format as well obviously."*

Screenshots were taken against the real built UI and server (`e2e/harness.ts`, a per-lane run — not the
shared `heavy.lock` harness a `.spec.ts` file owns), one browser as the room's leader (`e2e-alice`), via
the Playwright MCP tool. PNGs live only in scratch
(`/tmp/claude-1000/w48/U/screenshots/`) — never committed, per `CLAUDE.md`'s image-bytes rule.

**Taken before T's Modern/Legacy deck data had landed** (only T's format-aware tools and interface —
`FormatFamily`, `formatIdOf`, the two-arg `poolFixturePath` — had landed in the shared worktree). The
catalog at screenshot time still held only the nine Standard power-summer eras, so the Modern and Legacy
tabs are shown with an empty era list, which is the CORRECT state for "a tab whose family has no eras
yet" (`erasOf` answers `[]`, proven directly in `constructed.test.ts`'s `erasOf` unit tests). The
mechanism — tabs, grouping, browsing-without-committing, the leader/non-leader split — is what these
screenshots prove; the Modern/Legacy CONTENT is proven once T's data lands (see the e2e section below).

## 01-standard-tab.png

A freshly created room, the leader's "Your deck" card. Three tabs — **Standard** (active, filled blue),
**Modern**, **Legacy** — sit directly under the "Matched Standard" label, above the era `<select>`. No
"Drafted pool" tab, because this room has no pod. The Standard tab opens on the room's own default era,
`2016-07-22 — Standard (EMN)` (the newest Standard era — `room/lobby.ts`'s `newestFormat()`), with its
set-symbol row (Keyrune glyphs) underneath and the full legal deck list below that. No explanatory text
anywhere near the tabs — the active/inactive colouring is the only signal, same rule every other control
on this card follows.

## 02-modern-tab.png

Clicked "Modern". The tab bar re-renders with Modern active (blue) and Standard/Legacy inactive. The
`<select>` is empty — `erasOf(formats, 'modern')` correctly answers no options, because the real catalog
at this point has no Modern era. Nothing else moved: the deck list below still shows the room's actual
(Standard) pool, because switching tabs only BROWSES which eras the select offers — nothing is sent to
the server until an option is chosen. This is the "browsing vs committing" behaviour item 1 asks for
implicitly ("the selected tab shows only that format's eras") without asking tab-switching itself to
move the room.

## 03-legacy-tab.png

Same proof for Legacy: tab active, empty select (no Legacy eras yet), room's pool and deck list
unchanged.

## 05-modern-tab-real.png, 06-legacy-tab-real.png, 07-legacy-set-row-capped.png

Re-shot after `T.landed` and after the placeholder-option fix below, against the real 31-era catalog.
05 and 06: Modern and Legacy tabs active, each correctly showing NOTHING selected (the room is still on
its Standard era) rather than the tab's first option wrongly highlighted. 07: a real Legacy era picked
(`legacy-2005-08-20`, Legacy (9ED)) — the deck list shows actual transcribed Legacy 2005 decks, and the
set-symbol row is visibly capped (see the correction section below for the exact count).

## 04-nonleader-fixed.png

A second browser, cookied as a different friend (`e2e-bob`), joined the same room. Confirmed
programmatically and visually: `format-tabs` does not exist at all for a non-leader
(`page.getByTestId('format-tabs')` count is `0`) — not a disabled tab bar, no control at all, exactly
item 1's *"only the leader can change it. Everyone else sees the fixed value, as today"*. The fixed
`<span data-testid="format-fixed">` reads `2015-07-17 — Standard (ORI)`, which is the era the leader had
just picked moments before in the SAME session (see "real pick" below) — proving the non-leader's fixed
view follows the room's actual record, not a stale default.

## A real pick, proven against the server (not just a screenshot)

Driven via the Playwright MCP tool (`mcp__playwright__browser_run_code_unsafe`), not a `.spec.ts` file
(that proof is `e2e/w48-format-tabs.spec.ts`, see below):

- On the Standard tab, the `<select>`'s options were read back: `2016-07-22`, `2015-07-17`, …,
  `2008-07-25` — **newest year first**, confirming `erasOf`'s sort.
- `select.selectOption('2015-07-17')` was pressed. After the round trip, `select.inputValue()` read back
  `2015-07-17` — the LEADER's own control reflects the value the SERVER is holding, not an optimistic
  local write.
- The second browser (bob, opened immediately after) read `2015-07-17 — Standard (ORI)` off the room
  record fresh from `GET /api/tables/rooms/:roomId` — the same value, from a browser that pressed
  nothing. The pick reached the server.

## The era's set-symbol row (manager's note): Legacy's 100+ sets

Legacy never rotates, so Forge's own `Sets:` line for a Legacy era is its entire set history up to that
date, confirmed against `forge/forge-gui/res/formats/Archived/Legacy/*.txt`: the 2016-07-22 file (the
newest year this wave's Legacy eras reach) lists **161** comma-separated set codes on its `Sets:` line
(`grep '^Sets:' Legacy/2016-07-22.txt | tr ',' '\n' | wc -l`); the newest archived file on disk today
(2026) lists 324. Both are far past the dozen or so a Standard era's own `sets` list carries. **Chosen:
cap the row at the newest 40 sets**
(`apps/ui/src/screens/ConstructedScreen.tsx`'s `MAX_POOL_SETS`), taking the LAST 40 entries of
`format.sets` rather than a random sample — Forge's `Sets:` line is oldest-first (verified against the
same archived files), so the newest sets are the trailing ones. `groupSetsByBlock` still runs on the
capped list, so the row keeps its block grouping; it just stops growing without bound as more Legacy
eras are added. Not yet visually confirmed against a REAL 100+-set Legacy era (none exists in the
catalog at the time of these screenshots) — only unit-tested in shape (`PoolSets` slices before
grouping). Re-screenshot once L's Legacy decks land, if the manager wants the capped row seen rather
than reasoned about.

## The e2e spec: `e2e/w48-format-tabs.spec.ts`

One leader browser, no second friend needed (the non-leader case is proven by `rooms.test.ts` and
`constructed.test.ts`, not duplicated here): creates a room, asserts the tab bar opens on Standard
(the room's own default), reads the Standard era list (newest first), switches to Modern and asserts its
list is non-empty and different from Standard's, switches to Legacy and asserts every option's id starts
with `legacy-`, picks the first Legacy option, and — after a hard page reload, from a clean read of the
room — asserts the `<select>` still reads that id AND the tab bar re-opens on Legacy. Also asserts every
off-host request the page made (the deck list's card art) landed on an excused host
(`cdn.hadoku.me`/`cards.scryfall.io`), the same pattern `room-mode.spec.ts` and `draft.spec.ts` use.

**Run once against the real (pre-landing) catalog**, to prove the spec itself and the tab mechanism work
end to end before Modern/Legacy data existed: it failed exactly where expected —
`expect(modernOptions.length).toBeGreaterThan(0)` — with everything before that line green (room
creation, the tab bar rendering, Standard defaulting and listing newest-first). That is the same proof
the screenshots above give, from the harness rather than the MCP tool.

## After `T.landed` (31 eras: Standard 2003-2016, Modern 2012-2016, Legacy 2005-2016)

**A real flake found and fixed.** Three CLI runs against the real 31-era catalog: run 1 failed at the
post-reload assertion (`expected "legacy-2016-07-22", received "2016-07-22"`), run 2 passed. Root-caused
with the Playwright MCP tool, reproducing the exact sequence by hand: `select.selectOption(chosen)` sets
the native `<select>`'s DOM value directly, which satisfies a `toHaveValue` assertion whether or not
React's `onChange` fired — and the harness's own `server.jsonl` showed, for the failing run, **no PATCH
request at all**: the click set the DOM but never told the server, so the pre-reload check passed on a
value that was never sent, and the reload read back the room's true (unchanged) pool. Not a product bug —
`apps/ui/src/screens/ConstructedScreen.tsx`'s `onChange` handler is unconditional and the same pattern
`table-fit.spec.ts`/`play.spec.ts` already drive successfully elsewhere in this app. Fixed in the SPEC
(`e2e/w48-format-tabs.spec.ts`, mine): the pick now retries `selectOption` until a matching
`PATCH …/api/rooms/:id → 200` response is actually observed (`page.waitForResponse`), up to 5 attempts,
and asserts that happened before trusting the DOM value.

**After the fix: 3 consecutive green runs, no SKIPPED**, each `1 passed`:

```
✓ w48-format-tabs.spec.ts:54:1 › the leader switches Standard → Modern → Legacy and picking a Legacy era moves the room (3.3s)
  1 passed (6.0s)
✓ w48-format-tabs.spec.ts:54:1 › the leader switches Standard → Modern → Legacy and picking a Legacy era moves the room (3.5s)
  1 passed (6.1s)
✓ w48-format-tabs.spec.ts:54:1 › the leader switches Standard → Modern → Legacy and picking a Legacy era moves the room (2.9s)
  1 passed (5.3s)
```

This is now true end-to-end proof against the real 31-era catalog: Standard defaults correctly (14 eras
on offer), Modern lists 5 eras different from Standard's, Legacy lists 12 eras all prefixed `legacy-`,
picking the newest Legacy era (`legacy-2016-07-22`) actually moves the room (PATCH 200), and a hard
reload reads that same id back from the server with the Legacy tab re-opened — not Standard.

## CORRECTION: the "flake" above was a real product bug, found by the manager

The manager caught what the retry-loop fix above had papered over. `ConstructedScreen.tsx`'s
`<select value={poolId}>`: on a tab that does not contain the room's actual era (Modern/Legacy while the
room sits on Standard), `poolId` matches none of that tab's `<option>`s, and a native `<select>` in that
state falls back to showing its FIRST option as already selected — the browser's own behaviour, nothing
React does on purpose. So a leader browsing Legacy saw Legacy's newest era drawn as chosen, and clicking
that exact option fired no `change` event at all, because as far as the browser was concerned nothing
had changed. The retry loop in the spec was hiding this by trying `selectOption` up to 5 times until one
attempt happened to land on an option that WAS a real change (anything but the first). **Fixed in the
product, not the test**: `apps/ui/src/screens/ConstructedScreen.tsx` now computes `poolOnTab` (exported
as `poolIsOnTab`, next to `erasOf`) and, when the room's era is not one of the active tab's options,
renders a disabled, hidden, EMPTY placeholder `<option>` as the select's value — no text, so no
explanatory UI — making every real era on that tab a genuine change regardless of position. The spec's
retry loop is gone; it is a single `selectOption` again, now a real action.

**New unit test** (`constructed.test.ts`, `poolIsOnTab` describe block): confirms true when the room's
era is on the tab (including the draft tab matched by pod id), false when browsing a different family —
explicitly including the tab's own FIRST (newest) era, which is the exact case that was silently broken.
**Mutation-tested**: `poolIsOnTab` reverted to always return `true` → 3 tests failed (2 direct unit tests
+ the "offers the pods… without making one the default era" integration test, which now also asserts the
placeholder leads the option list and `select.value === ''` when switching off the pod's own tab);
restored → all 80 tests in the file pass.

**07-legacy-set-row-capped.png**: picked `legacy-2005-08-20` (the oldest, biggest-set Legacy era) —
the select correctly shows it chosen (no placeholder once a real pick is made), the deck list shows
REAL Legacy 2005 decks (Wake, UG Madness, Goblins, Tooth and Nail, …), and the set-symbol row is capped:
`data-sets` has exactly **40** codes (`MAX_POOL_SETS`), confirmed by reading the attribute directly, not
just counted glyphs on screen.

**Final verification after the product fix** (all against the real 31-era catalog, rebuilt dist):
- `pnpm run check`: exit 1, same single expected red (`apps/ui/src/play/live/parity.test.ts`, w46's).
  Tests: 1 failed | 4193 passed | 106 skipped (4300).
- `e2e/w48-format-tabs.spec.ts`: **3 consecutive green runs, no SKIPPED** (`1 passed`, 2.5-2.7s each),
  with the single `selectOption` (no retry loop).
