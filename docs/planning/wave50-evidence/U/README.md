# Wave 50 §U — the sound builder screen

Operator, 2026-10-05: *"somewhat concerned about this being an artifact rather than a real thing on my
site. maybe create a configuration builder that is admin-gated that i can reach on the deployed
site? that way everything is running on my ecosystem"*.

`#/sounds` is now a route in the real built app. It renders `SoundBuilder`, a React port of
`docs/handoff/snapshot/builder.html`, talking to lane S's real `/api/sounds/*` router through
`apps/ui/src/sound/builderClient.ts`. No audio ships in the bundle; everything is fetched from the
server's own data directory.

## What was ported, and kept identical to the artifact (Settled)

- the bin holds the keepers as dense pill rows, one row per sound, grouped by section/sub-section
  exactly as `stage-builder.py` ordered them;
- click a pill to hear it and pick it up; click a cell to drop it there; Esc puts it down;
- **no "holding" banner** — nothing shifts on pick-up, nothing announces it in words;
- a cell with more than one take plays one at random on its own ▶ and never repeats the take before
  it (`pickRandom`, unit-tested directly — see `apps/ui/src/sound/builderClient.test.ts`);
- a placed pill plays on click, `×` removes it, and dragging moves a pill between the bin and a cell
  or between two cells;
- a mono colour identity's Land cell is labelled with its basic land name (Plains/Island/Swamp/
  Mountain/Forest) when empty;
- "Play a sample turn" sequences the selected identity's four paradigms plus nine events on the
  artifact's own timeline (0 ms–6200 ms), through an 8-voice pool so cues overlap;
- no explanatory UI text anywhere on the page beyond the title "Sound Builder" itself.

## The gate

`SoundBuilder` fetches `GET /api/sounds/assignments` and renders **nothing** — not a greyed-out
grid, not a message — until it has seen `canEdit === true` from the server. There is no link to
`#/sounds` anywhere else in the app (confirmed by grep: no `routeHash({ kind: 'sounds' })` call
outside `route.ts` itself and `App.tsx`'s switch). `canEdit` is computed server-side from the
edge-stamped tier (`rankOf(tierOf(req)) >= rankOf('admin')`); the client never computes or guesses
it.

A failed save (`client.save` returning `null`) leaves the optimistic value on screen and adds
`data-unsaved` to that one cell — a border colour change (`--color-warning`), no text — per the
house rule against explanatory UI prose.

## Screenshots (described in words; PNGs stay in scratch per the evidence policy)

Taken against the real e2e harness (admin identity, synthetic 2-take catalogue), saved to
`/tmp/claude-1000/w50-U/desktop-1440.png` and `/tmp/claude-1000/w50-U/phone-390.png` — never
committed.

- **Desktop, 1440×900 (full page).** A header strip: "Sound Builder", the three counts
  ("1/148 cells", "1 placed", "2 keepers"), and the sample-turn control group on the right. Below it,
  two panes: the bin on the left (one `LIBRARY` section, one sound "w50 test" with pills `a`
  highlighted blue/placed and `b` plain) and the matrix on the right — 27 colour-identity rows
  grouped under MONO/GUILDS/SHARDS/WEDGES/FOUR OR MORE/COLOURLESS headers, each row showing its
  Mana-font pips (the real glyphs, not drawn discs — D20), five paradigm columns, with the five mono
  rows' Land column showing "Plains"/"Island"/"Swamp"/"Mountain"/"Forest" as a hint. The White row's
  Spell cell holds the placed pill ("w50 test · a ✕") beside its ▶ random-play button. Below the
  colour matrix, an Events table (13 rows, name + description + an empty sounds cell each), then
  "Last sample turn" with an empty log. No horizontal scrollbar on the page; the matrix table has its
  own internal one (not visible at this width, since 820px+ shows the full matrix).
- **Phone, 390×844 (full page, after a reload).** The layout drops to one column: header fields
  wrap (title, counts, then the sample-turn row, then the status area), the bin sits above the matrix
  instead of beside it, and the matrix's own table scrolls horizontally INSIDE its bordered box —
  the "Artifact creature" and "Artifact" columns, and the Events table's second column, run off the
  visible edge of that box. Measured directly in the page
  (`document.documentElement.scrollWidth - document.documentElement.clientWidth`): **0** — the page
  itself never scrolls sideways, only the matrix's own wrapper does, which is the same trick the
  artifact used (`.tw { overflow-x: auto }`). The placed pill from the desktop run is still there
  after the reload, proving the save is server-hosted and not local component state.

## e2e: `e2e/w50-sound-builder.spec.ts`

Builds a tiny synthetic catalogue (2 "takes" that are a few deterministic placeholder bytes — **not
real audio, and no `ffmpeg` dependency**, see below) directly into `e2e/.run/data/sounds/` — the
harness leaves `CARDTABLE_SOUNDS_DIR` unset, so the server's default
(`resolve(logDir, '../data/sounds')`, `logDir` = `<RUN_DIR>/logs`) resolves there. One spec, one test:

- a **friend** first gets a page proven to have actually rendered the app (`AppHeader`'s "Card Table"
  heading, visible on every route), THEN is shown to have no editor at all (no "Sound Builder"
  heading, no `[data-cell]`) — the two-step order matters, because the bare absence check alone would
  also pass on a blank or crashed tab. The friend's own `GET /api/sounds/assignments` is also asserted
  to answer `canEdit: false` directly, so the gate is pinned at the server, not only at what the
  screen chose not to draw;
- an **admin** sees the real editor, places a take by click, and the placement survives a full page
  reload (the round trip through the real server, not local state). The reloaded placed pill is
  clicked too (a second code path, `onPlayPill`, not the bin's pick-up click);
- a `page.on('pageerror')` collector on the admin page is asserted empty at the end — both plays ran
  against bytes that are not real audio, and neither reached an uncaught page-level exception, because
  `createAudioPool`'s `catch` holds (`builderClient.ts`).

**No `ffmpeg` dependency, by design.** CI runs this spec on the fleet's claws (`ci.yml`'s "E2E — two
friends draft one pod" job), not on hokon, and nothing establishes those runners carry `ffmpeg` — a
spec that shells out to generate a silent Opus file would turn main red on a missing binary that has
nothing to do with the product. The spec asserts PLACEMENT and PERSISTENCE, never playback or
decoding, so `Buffer.from('w50 placeholder take a')` behind a real `.ogg`-shaped path proves exactly
as much as a real encoded file would for this test's purpose. Verified directly: one run with `ffmpeg`
removed from `PATH` entirely (`command -v ffmpeg` confirmed failing first) — still green.

**This host runs a concurrent self-hosted CI job that binds the harness's default ports
(19008/19108)**, so every run used `CARDTABLE_E2E_EDGE_PORT=19508` / `CARDTABLE_E2E_SERVER_PORT=19608`
— an environment workaround for this host, not a code change.

**Run WITHOUT `flock -x heavy.lock`, on the manager's instruction.** The spec needs no Forge and no
shared port, so it does not need the lock; a first attempt queued behind another wave's full gate run
for 36+ minutes before the manager killed it and said to stop using the lock for this spec. Three
consecutive runs, from `e2e/`, no lock:

```
=== run 1 === 1 passed (2.8s)
=== run 2 === 1 passed (2.7s)
=== run 3 === 1 passed (1.9s)
```

Plus the no-`ffmpeg`-on-`PATH` run (also no lock, also green, shown above). **0 skipped in every
run** — grepped the output for `SKIPPED`/skip counts; none. The sound builder needs no Forge jar, and
the spec never calls `test.skip`.

## Unit tests

- `apps/ui/src/sound/builderClient.test.ts` — 19 tests, 0 failures. Covers `soundsClient`'s
  catalogue/assignments parsing (valid, malformed, unreachable, a cell key that is not a valid
  `CellId`), `save`'s PUT shape and its null-on-failure cases (403/400/unreachable), `takeUrl`'s two
  encoded segments, `pickRandom` (empty, singleton, 200-iteration no-repeat property, a
  deterministic-rng case), and `createAudioPool` (fetch-once + cache, round-robin across voices,
  fail-soft on a rejected fetch, no-op with zero voices).
- `apps/ui/src/screens/soundBuilder.test.ts` — 7 tests, 0 failures. Covers: a non-admin render
  (`canEdit: false`) proven empty only AFTER the load genuinely completes; admin sees the builder;
  click-pill-then-click-cell sends exactly one `PUT` with the new list; dragging a placed take to
  another cell sends two `PUT`s (source emptied, then target); `×` removes a take with one `PUT`; a
  failed save marks the cell `data-unsaved` with no extra text node; a mono identity's empty Land cell
  shows its basic land name.
- `apps/ui/src/screens/route.test.ts` — extended with `#/sounds` ↔ `{ kind: 'sounds' }` round-trip
  coverage (parse, `routeHash`, and the full round-trip list).

### Mutation-testing the non-admin test

The first version of "renders nothing for a non-admin" was vacuous: it asserted on an empty render
right after `render()` returned, which is identical to the `!loaded` pre-load state — so it passed
even with the `canEdit` gate deleted outright, since "not yet loaded" and "loaded, not admin" draw the
same (nothing). Caught and fixed: the test now uses a `deferred()` promise the test controls for
`assignments()`, a flag flipped only once that promise has actually resolved, and `await act(async ()
=> { gate.resolve(...); await gate.promise; await Promise.resolve(); await Promise.resolve(); })` to
flush the resulting `Promise.all` → component `.then` → `setLoaded`/`setCanEdit` → re-render chain
before asserting the empty page.

**Mutated** `SoundBuilder.tsx:239` `if (!loaded || !canEdit) return null;` → `if (!loaded) return
null;`, ran `soundBuilder.test.ts`: **6 passed, 1 failed** — the non-admin test failed exactly as
expected (`expected 'Sound Builder0/148 cells0 placed0 kee…' to be ''`), because once `loaded` flips
the mutant shows the whole editor regardless of `canEdit`. **Restored** the line and confirmed with
`git diff apps/ui/src/screens/SoundBuilder.tsx` — empty, byte-identical — then re-ran: **7 passed**.

Checked the other six tests the same way: every one of them calls `await screen.findByText('Sound
Builder')` (or, for the unsaved-cell case, also `await vi.waitFor(...)` on the resulting
`data-unsaved` attribute) before asserting anything that depends on the load having completed.
`findByText` genuinely polls until that text exists in the DOM, and "Sound Builder" never renders in
the pre-load state — so none of the other six can pass without the real async load actually finishing
first. None of them share the non-admin test's defect.

`pnpm run check` from the repo root: **exit 0** — typecheck (all 10 workspace packages), lint, and
`vitest run` (4317 passed, 109 skipped — the pre-existing jar-gated suites, unrelated to this lane).
Run WITHOUT `flock -x heavy.lock` (manager's instruction: use the lock only if free; it was held by
another wave's gate run at the time).

## Files changed (lane U)

- `apps/ui/src/sound/builderClient.ts` (new) + `builderClient.test.ts` (new)
- `apps/ui/src/screens/SoundBuilder.tsx` (new) + `SoundBuilder.css` (new) + `soundBuilder.test.ts` (new)
- `apps/ui/src/screens/route.ts`, `apps/ui/src/screens/route.test.ts` (the `sounds` route kind)
- `apps/ui/src/App.tsx` (the one new route case, `case 'sounds': return <SoundBuilder />;`)
- `e2e/w50-sound-builder.spec.ts` (new)
- `e2e/identities.ts`, `e2e/edge.ts` (manager-authorised: optional `tier` on an identity, one `admin`
  entry, `edge.ts` stamps `identity.tier ?? 'friend'` — every existing identity unchanged)
- `docs/planning/wave50-evidence/U/README.md` (this file)

## What could not be verified

- **Production behaviour of the admin gate against a real account's tier.** This spec proves the
  mechanism (the stand-in edge's stamped tier) end to end; whether the operator's real hadoku.me
  account resolves to `admin` at the live edge is the tracker's post-deploy check (wave file,
  "Watches the tracker holds").
- **The sample-turn audio actually overlapping audibly.** Proven by unit test (the 8-voice pool
  round-robins and caches) and by the component wiring, not by listening — there is no audio output
  in this sandbox and the synthetic takes are silent by design.
- **The full 140-take / 12-cell production catalogue.** Only a 2-take synthetic catalogue was used
  here, per the wave file's instruction that lanes never touch production's data dir; the real import
  is the tracker's post-deploy step.

## Decisions made because the brief was ambiguous

- **Test file extension.** The dispatch said "use `.tsx` for the test if it renders JSX," but the
  root `vitest.config.ts` only globs `apps/*/src/**/*.test.ts` — a `.tsx` test is silently not
  collected (this repo's own `ManaPip.test.ts`/`lobby.test.ts` headers document being bitten by this
  four times already). Followed the codebase's actual, verified convention instead:
  `soundBuilder.test.ts`, JSX via `createElement`, `// @vitest-environment jsdom` on line 1 — matching
  every existing React-rendering test in `apps/ui/src`.
- **Drag-and-drop implementation.** The artifact (and the Settled behaviour list) uses native HTML5
  drag-and-drop (`draggable`, `dragstart`/`dragover`/`drop`), which `Board.tsx`'s own in-game drag has
  since moved away from (pointer events). Kept native HTML5 DnD here, matching the artifact exactly
  and the Settled bullet ("dragging also works") rather than inventing a pointer-based drag for a
  grid that is a `<table>`, not the game board.
- **`client.save`'s optimistic-failure UI.** "Shows the cell as unsaved, without text banners" was
  read as: keep the attempted value on screen (do not silently revert a person's action) and add a
  CSS-only marker (`data-unsaved`, a border colour) rather than rolling back to the last-known-good
  list.
