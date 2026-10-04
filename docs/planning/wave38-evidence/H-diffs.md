# H — reconciling the 16 duplicated e2e helpers into `e2e/play/board.ts`

Commit 1 only: `e2e/play/board.ts` exists with one implementation of each helper
listed in the wave file. No caller changed yet — this records what each pair of
copies actually did, and which behaviour `board.ts` kept, so step 2 (switching
callers) is a mechanical import swap rather than a second round of reading.

## Identical copies — no decision needed

- **`stackCount`** — byte-identical across `w33.spec.ts`, `w34.spec.ts`,
  `w35.spec.ts`, `w36.spec.ts`.
- **`livePrompt`** — byte-identical in `w34.spec.ts` and `w35.spec.ts`.
- **`clickOnce`** — byte-identical in `w33.spec.ts` and `w34.spec.ts`.
- **`serverLog`** — identical body in `play.spec.ts`, `w31.spec.ts`,
  `w32.spec.ts`, and `w34.spec.ts`; only the parameter's type annotation
  differs (`PlayStack`, imported from `play/harness.ts`, in the first three; a
  structural `{ serverLogFile: string }` in `w34.spec.ts`). Kept `PlayStack` —
  used by 3 of the 4 copies, and a `PlayStack` satisfies the structural type
  anyway, so nothing that typed against the looser shape needs to change.
- **`roomIdFromHash`** — identical logic in `draft.spec.ts` and
  `room-mode.spec.ts`, except the timeout: `draft.spec.ts` uses its own
  `UI_TIMEOUT = 30_000`, `room-mode.spec.ts` hardcodes `20_000`. Kept
  `30_000` (`ROOM_HASH_TIMEOUT` in `board.ts`) — the more lenient of the two,
  and the one three other call sites (`createRoom`'s own `waitForURL`,
  `enter.ts`'s room wait, `arrow.spec.ts`'s room wait) already use.

## `offered` — one real behaviour difference, both sides checked against their callers

- `w31.spec.ts`, `w33.spec.ts`, `w35.spec.ts`, `w36.spec.ts` (all mine) and
  `w34.spec.ts` (not mine, lane E switches it after this commit): identical —
  takes a `Page`, returns the `data-selectable` ids **sorted ascending**.
- `arrow.spec.ts` (mine): took a `Friend`, not a `Page`, and did **not** sort.
  Checked both call sites (`arrow.spec.ts:322,490`): one only tests
  `.length >= 2`, the other only `.toContain(id)` — neither depends on order.
  `board.ts` keeps the majority shape (`Page`, sorted); `arrow.spec.ts`'s two
  call sites become `offered(alice.page)` / `offered(f.page)` in step 2.

## `promptMethod` — kept the shared shape over `arrow.spec.ts`'s own

- `arrow.spec.ts` (mine): `promptMethod(f: Friend)`, reads every `live-prompt`
  element's `data-method` and returns `showing[0] ?? null` in one
  `evaluateAll`.
- `w34.spec.ts` (not mine): `promptMethod(page: Page)`, built on a separate
  `livePrompt(page)` locator — check `.count()`, then read the first element's
  attribute directly (two round trips instead of one `evaluateAll`, but the
  same result for the one-prompt-at-a-time case every caller actually hits).
  `w35.spec.ts` has the same shape under the name `promptMethodOf` (not
  merged — different name, so the duplicate-helper check does not flag it;
  left alone this wave).
- Kept the `w34.spec.ts` shape, built on the shared `livePrompt`, since that
  is also what `w35.spec.ts`'s near-identical `promptMethodOf` already does.
  `arrow.spec.ts`'s two call sites become `promptMethod(f.page)` in step 2.

## `castCard` / `clickHandCard` — reconciled with `e2e/play/hands.ts`'s `clickCard`

- `w33.spec.ts` and `w34.spec.ts` both define `clickHandCard` + `castCard`
  with identical shapes, but one real difference: `w33.spec.ts`'s
  `clickHandCard` moves the mouse to the battlefield centre with
  `{ steps: 5 }` (an animated move); `w34.spec.ts`'s does the same move in one
  jump, no `steps`.
- `play/hands.ts`'s own `clickCard` (the third, independent implementation of
  this exact settle) does the single jump on purpose, and its module header
  has the measured reason: an animated move's intermediate pointer positions
  can themselves cross into the battlefield before the final, row-correct
  point is reached, so the EARLY (wrong-row) position is what the cast-lift
  gesture records — a real regression `hands.ts` hit and fixed. `w33.spec.ts`'s
  `{ steps: 5 }` is the older, already-diagnosed-as-wrong shape.
- `board.ts`'s `clickHandCard` keeps the single jump, matching `w34.spec.ts`
  and `hands.ts`. `w33.spec.ts`'s call sites need no change in step 2 beyond
  the import swap — the behaviour change (animated → single jump) is the
  bug fix `hands.ts` already proved necessary, carried to the third copy.
- `castCard`'s hand-rolled `for (let i = 0; i < 60; i++) { waitForTimeout(50);
  … }` poll loop — identical in both copies — is rewritten as
  `expect.poll(…, { timeout: 3_000, intervals: [50] }).not.toBe(stackBefore)`,
  wrapped in a `try/catch` so the original "stuck on …" error message is kept
  on timeout.

## `says` / `enabledOk` — kept as plain copies, not a re-export

`play/scenario.ts` already exports both as one-liners, and `w35.spec.ts` and
`w36.spec.ts` already import them from there instead of defining their own —
only `w31.spec.ts` and `w32.spec.ts` (both mine) still carry local copies.
`scenario.ts` is lane E's file this wave (actively being edited for the
Ponder-race and mulligan-stall fixes), so `board.ts` does not import from it:
re-exporting a one-liner from a file another lane is mid-edit on buys nothing
and adds a cross-lane coupling for no reason. `board.ts` carries its own
byte-identical `says`/`enabledOk`; `scenario.ts`'s copies are untouched.
`w31.spec.ts`/`w32.spec.ts` switch their import source in step 2.

## `enterMatch` / `twoLegalDecks` — already centralised; re-exported, not duplicated

`play/enter.ts` (owned by nobody this wave) is already the shared home
`w31.spec.ts`, `w32.spec.ts`, `w35.spec.ts`, and `w36.spec.ts` import
`enterMatch` from. `board.ts` re-exports both from `enter.ts` rather than
writing a third copy of a ~60-line function.

Two files keep their OWN copy for now, and neither is a bug:

- **`arrow.spec.ts`** (mine): differs from `enter.ts`'s version in two real
  ways neither of which is "entering a match" itself — (a) its post-ready
  wait checks that both players' faces are on the table
  (`[data-player-face]` count 2, one of them `.seat[data-viewer]`'s own)
  instead of waiting for the turn counter's text, because the arrow test's
  own precondition is about faces being renderable targets, not about the
  turn counter; (b) it asserts the format `<select>`'s own value on alice's
  page, not just bob's `format-fixed` attribute. Step 2 keeps calling the
  shared `enterMatch` and adds these two checks as a few extra lines in
  `arrow.spec.ts` right after the call, rather than branching the shared
  helper on who needs which extra wait.
- **`table-fit.spec.ts`** (not mine — lane E switches it to `board.ts` after
  this commit lands, per the wave file's ordering). Its own copy differs
  further: it takes a `summary: Record<string, unknown>` object to log the
  deck choice and match id into, takes a screenshot of the room table
  mid-flow, and waits on battlefield/hand zone counts instead of player
  faces. Recorded here for lane E's benefit: none of that is core
  "enter a match" mechanics either, so it belongs in `table-fit.spec.ts`'s
  own test body around a call to the shared `enterMatch`, the same shape as
  `arrow.spec.ts` above — not inside the helper.

## `createRoom` — merged signatures; test-specific assertions stay in the caller

- `play.spec.ts`: `createRoom(f, name, password?)` — fills the form (no
  navigation; the caller is already on it), optionally fills a password,
  submits, and extracts the id from `f.page.url()` with a local `ROOM_URL`
  regex + `waitForURL`.
- `room-mode.spec.ts`: `createRoom(f, name, mode)` — navigates to the create
  form itself, asserts the mode radios' default state and labels BEFORE
  filling anything, picks a mode, submits, extracts the id via the shared
  `roomIdFromHash`, and asserts the actual `POST` body it captured
  (`f.creates.at(-1)`) matches what was picked.
- Merged into one `createRoom(f, name, opts?: { password?, mode? })` in
  `board.ts`. The navigation, the pre-submission radio/label assertions, and
  the post-submission network assertion are test-specific, not room-creation
  mechanics, so none of them moved into the shared helper — they stay in
  `room-mode.spec.ts`'s own test body, added back around the shared call in
  step 2. The shared helper now always extracts the id through
  `roomIdFromHash` (the same hash-parsing `room-mode.spec.ts` already used)
  instead of `play.spec.ts`'s own `ROOM_URL` regex + `waitForURL`, so
  `play.spec.ts`'s local `ROOM_URL` becomes dead code, deleted in step 2.

## Not touched this commit

`play/hands.ts`, `play/prompts.ts`, `play/confirm.ts` keep every existing
export's name and signature unchanged — `board.ts` only imports `answerPrompt`
from `prompts.ts`. No spec file's imports changed. No `*.spec.ts` file had a
line removed or added.
