# Lane L — wave 36 §L (T4 bar half, T2, T5)

All three land in `apps/ui/src/play/live/LiveBoard.tsx` + `live.css`, proven in
`LiveBoard.test.ts`. `pnpm --filter @hadoku/ui exec vitest run src/play/live/LiveBoard.test.ts`:
**149/149 green**, including the 34 pre-existing `live-button-ok`/`live-button-cancel` uses T4
touches.

## T4 — every yes/no confirm is the pop-up, never the control bar

Operator: *"i hate yes/no on control bar. should always be the big pop up."*

Shape 1 (lane G): `isConfirmPrompt(bar)` + `ConfirmPrompt` in `apps/ui/src/play/prompts/
ConfirmPrompt.tsx`. L's wiring (`LiveBoard.tsx`):

- `confirmPrompt = !spectator && !askOpen && !playOrDraw && isConfirmPrompt(bar)`.
- the control bar's OK gets `|| confirmPrompt` in its own `disabled`; `showsSecondButton` gets
  `&& !confirmPrompt` — same treatment R2 (the coin toss) already has, so the bar draws neither
  button while the pop-up is up.
- rendered in the decision area as `<div data-testid="live-confirm-host"><ConfirmPrompt .../></div>`,
  `onYes`/`onNo` wired to `pressButton(match, 'ok' | 'cancel')` — the one sender every other control
  already uses.

**Proof, real engine** (lane G's `apps/ui/src/play/prompts/confirm.jvm.test.ts`, re-run here against
the real jar after L's wiring landed): `isConfirmPrompt against a real Forge match: mulligan, a
shockland's pay-life, and a priority pass > ... PASS` (10.4s, real JVM, real scenario state —
Keep/Mulligan and a shockland's pay-2-life both satisfy it; an ordinary priority pass does not).

**Proof, this lane's own tests** (`LiveBoard.test.ts`, describe `T4 — every yes/no confirm is the
pop-up, never the control bar`, 6 cases):

- shockland's "pay 2 life?" (Yes/No) → `live-confirm-host` + `prompt-confirm-yes`/`-no` render with
  Forge's own words; the bar's OK is disabled, Cancel does not render; clicking Yes sends
  `selectButtonOk`.
- the No side sends `selectButtonCancel`.
- the mulligan's Keep/Mulligan renders the same pop-up with Forge's own words.
- an ordinary priority pass (OK/End Turn) stays on the bar; the pop-up never opens.
- a mana payment (Auto/Cancel) stays off the pop-up (`AUTO_PAY_LABEL` excluded).
- the coin toss keeps `PlayOrDrawPrompt`; the two pop-ups are mutually exclusive by construction.

**Mutation count**: forcing `confirmPrompt` to `false` → 3 of the 6 fail (the three that assert the
pop-up renders and sends); forcing it to `true` → 3 of the 6 fail (the negative-space guards) **plus
6 pre-existing tests** (`Forge asks with buttons…` ×2, `§A.6/item 16` ×2, `R5` ×2) — confirming the
34 existing button-testid uses actually exercise this wiring, not merely tolerate it. Restored: 149/149.

## T2 — a calm "waiting for the other player"

Operator's ask (T2, ledger): a clear, calm indicator whenever the opponent holds priority or is
answering a question, gone the moment it is the viewer's move.

`isWaitingForOpponent(match)` (`LiveBoard.tsx`, exported): Forge parks each seat's own thread on its
own input only — this client never sees the opponent's ask, buttons or prompt (see the module
header, "Which player is 'me'"). So the only honest signal is the negative space of the viewer's OWN
three: an open ask, a mana payment, or `bar.enable1`. `bar.enable1` specifically (not `bar !== null`):
`pressButton` resets it to `false` the instant it sends, so a stale enabled bar never reads as "my
move" after the press lands.

Rendered as `<p data-testid="live-waiting"><span class="live__waiting-dot"/>Waiting for
{opponent's name}…</p>`, same perch/treatment as the existing spectator banner (out of flow,
centred, `pointer-events: none`); calm on purpose — no colour change, only the dot's own slow
breathing (`prefers-reduced-motion` turns it off).

**Proof** (`LiveBoard.test.ts`, describe `T2 — a calm "waiting for the other player"`, 8 cases): up
by default and names the opponent; gone the instant OK is enabled; comes back the moment
`pressButton` resets `enable1`; gone while an ask is open even with a stale enabled bar; gone during
a mana payment; never for a spectator; never once the game has ended; never before the match has a
view at all.

**Mutation count**: reverting the whole T2 change (production code only, test file untouched) →
**11 of 149 fail** (8 new T2 cases + 1 pre-existing "Concede is in the cluster" children-list
assertion updated to expect the new element + 2 of the T5 cases below, which share the revert
window). Restored: 149/149.

## T5 — the current phase's highlight is stronger on the rail

`.live__step[data-current]` (`live.css`) gets a tinted background
(`color-mix(in srgb, var(--accent) 16%, transparent)`) and an inset accent bar
(`box-shadow: inset 3px 0 0 0 var(--accent)`) — a `box-shadow`, not a `border`, so the row still
shares `--rail-row-h` exactly with every other row (wave 33 §L1's own guarantee: a border would add
to the box model one row and not its neighbours). The existing text treatment (`font-weight: 600`,
`color: var(--accent-ink)`) is unchanged — this is additive.

**Proof** (`LiveBoard.test.ts`, describe `T5 — the current phase's highlight on the rail is
stronger`, 4 cases): the declaration is present and reads theme tokens only (no raw colour); it is a
`box-shadow` not a `border`; the text treatment is unchanged; a real rendered rail still carries
exactly one `data-current` row for the highlight to land on.

**Mutation count**: reverting the CSS rule alone → 2 of 4 fail (the two that assert the new
declaration exists); the other 2 assert pre-existing/unrelated facts and correctly stay green.
Restored: 149/149.

## Testids added or changed

- `live-waiting` (new) — the T2 indicator.
- `live-confirm-host` (new) — the T4 pop-up's host, same pattern as `live-play-or-draw-host`.
- `prompt-confirm-yes` / `prompt-confirm-no` (new, lane G's `ConfirmPrompt.tsx`) — the pop-up's own
  two buttons.
- `live-button-ok` / `live-button-cancel` — unchanged testids, narrower circumstances (never drawn
  while `confirmPrompt` or `playOrDraw` is true).

## Not touched

`apps/ui/src/play/prompts/ConfirmPrompt.tsx`, `.test.ts`, `.jvm.test.ts` are lane G's — read only,
not edited. `Board.tsx`, `adapter.ts`, `board.css`, `Board.test.ts`, `play/live/parity.test.ts` are
lane B's, in flight; `pnpm run check` on the full repo shows 3 failures, all in those two files
(`Board.test.ts` ×2, `parity.test.ts` ×1) — none touch anything this lane owns and none are caused by
this lane's changes (verified: this lane never edits `Board.tsx`/`adapter.ts`/`board.css`).
