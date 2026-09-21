# What the product board still does not handle

Wave 17, lane A, 2026-09-21. `apps/ui/src/play/live/jvm-harness.ts`,
`game-driver.ts` and `prompt-driver.ts` are test support, and twice now a
frame was handled there and nowhere in the product (the coin-toss button bar
until 2026-09-19; `setSelectables` until Wave 17). This is the diff of those
drivers against `apps/ui/src/play/live/match.ts`, taken at `42ba581`. The
list is what the waves after 17 work from.

## Harness-handled, product-missing at 42ba581

| # | frame / behaviour | state after Wave 17 |
| - | ----------------- | ------------------- |
| 1 | `setSelectables` (notify): cards, min, max | handled — `LiveMatch.selectables` |
| 2 | `clearSelectables` (notify) | handled |
| 3 | "Forge said something new" signal (the harness bumps a version on prompt, buttons, set/clear selectables) | handled — `inputLive` + per-id `spent` |
| 4 | `selectCard` (act): land, spell, attacker, blocker, target, pick | sent from a board click |
| 5 | `selectPlayer` (act): a player target | sent from a seat click |
| 6 | `showPromptMessage.card` / `.player` — the card or player the prompt is about | **dropped**; only `message` is kept |
| 7 | `updateButtons.focus1` / `.owner` — Forge's default button | **dropped** |
| 8 | idle recovery: game-driver presses OK when an act changed nothing, because Forge answers an ignored click with nothing (measured: `[]` in 3 s) | designed around: a click spends only that id |
| 9 | the "Waiting for X…" seat (`AbstractGuiGame.updatePromptForAwait`, both buttons disabled) | **unhandled** — the waiting seat's cards render clickable; clicks reach no input and are ignored |
| 10 | the outcome of every act/reply (`fromClient` verdicts) | **unhandled** — a refused act gives the player no feedback |

## Beyond the harness

- **Server→client frames the product ignores:** `message`, `showErrorDialog`,
  `afterGameEnd`, `finishGame`, `hideZones`, `restoreOldZones`,
  `applyYieldUpdate`.
- **Client→server acts the product never sends:** `useMana`, `concede`,
  `nextGameDecision`, `requestResync`, `selectAbility`. (`selectAbility` has
  no product sender on purpose: Forge's desktop sends it only from its own
  async popup, `CMatchUI.getAbilityToPlay`; with `triggerEvent: null` Forge
  asks through the blocking `getAbilityToPlay` ask, which `prompts/` answers.)
- **Not modelled in forge-wire:** `setWeaklySelectable` /
  `clearWeaklySelectable` (`ProtocolMethod.java:71-72`) — Forge's own
  "actionable cards" set during priority (`PlayerControllerHuman.pushActionableCards`,
  gated on FPref `UI_SHOW_ACTIONABLE_HIGHLIGHTS`). Forwarding it would let the
  priority board offer only Forge's actionable cards instead of every card.
- **Server side:** `apps/server/src/play/match.ts` does not keep a seat's
  latest `setSelectables` for `resendAfterSnapshot`, as it does prompt and
  buttons. A refresh mid-targeting drops the selection (the client clears it
  on snapshot, which is safe) until Forge's next one.

## Why the board offers every card outside a selection

Verified in Forge: `setSelectables` is sent only by
`InputSelectEntitiesFromList` and `InputSelectTargets`
(`forge-gui/src/main/java/forge/gamemodes/match/input/`).
`InputPassPriority` — playing a land, casting a spell — sends none. The
desktop client sends `selectCard` for a click on any card and lets the
active Input decide; `isSelectable` only drives highlighting. So during
priority every card the seat can see is offered, and Forge decides what the
click means. No legality is computed client-side.

## Art coverage (lane B)

The wire carries no Scryfall id, and the only name → id table in the browser
is the cube's `draft/pool.json`, which `adapter.ts` uses as its default
`ArtIdIndex`. Against the deck library live matches use (`decks/*/*.dck`),
that covers about 43 of 278 distinct names (825 of 2,944 main-deck cards), and
no basic lands; the committed play fixture (GRN/MRD/DST precons) matches none.
Everything else draws `CardTile`'s text tile. Full coverage needs a committed
`Name|SET → scryfallId` table for the deck library plus basics, generated from
Scryfall bulk data (`packages/carddata`), passed as `artIds`.
