# L — V8: a modal spell's auto-answer logs the card's name

Operator (tracker, from a screenshot, playtest 6): a log line named a spell's mode text,
*"played Choose two — • Prevent all damage…"*, where the card's name belonged
(`docs/planning/playtest-ledger.md` V8, screenshot 2026-10-04, turn 6, casting a modal spell).

## Root cause

`LiveBoard.tsx`'s auto-answer effect called `noteAutoAnswered(match, auto.why)`, where
`auto.why` (`../prompts/rules.ts`'s `autoAnswer`) is the offered ability's own `label` — Forge's
`SpellAbilityView.toString()` (`"cost then description"`, per `tier-b.ts`'s
`OfferedAbilitySchema`). For an ordinary mana ability that is a few words ("Tap: Add R.").
For a MODAL spell with exactly one offered ability (the auto-answer path only fires when there
is exactly one), that "description" is the spell's whole mode menu — exactly the text the
screenshot shows.

## What changed

`apps/ui/src/play/live/LiveBoard.tsx`:

- New `autoAnsweredLine(ask, auto, lookup)`: for a `getAbilityToPlay` auto-answer, looks up the
  ASK's `hostCard.id` through the prompt lookup (`lookupFromState(match.state)`, the same lookup
  `PromptFor` already uses) and returns the card's `name`. If the ability's own label
  (`auto.why`) is short (`<= AUTO_ABILITY_LOG_MAX`, 40 chars), it rides along after an em dash;
  otherwise only the name is logged. `getChoices` (the lone-stack-target auto-answer) is
  untouched — its `why` is already a stack item's own label, a spell's name, with no ability
  text to crowd it out.
- The auto-answer effect now calls `noteAutoAnswered(match, autoAnsweredLine(pending, auto,
  lookupFromState(match.state)))` instead of `noteAutoAnswered(match, auto.why)`.

No change to `match.ts`, `rules.ts`, or `lookup.ts` — `rules.ts` and `lookup.ts` are outside this
lane's files this wave (`apps/ui/src/play/prompts/**` is owned by nobody this wave), and the fix
is entirely in how the client logs the already-sent `why`, not in what Forge is asked or told.

## Unit tests

`apps/ui/src/play/live/LiveBoard.test.ts`, `describe('the says, the toggle, and the ability
label')`:

- `an offer with ONE ability is answered without drawing anything` (existing test, updated): now
  asserts `m.says` contains `played <hostName> — {T}: Add {R}.` (name + short ability), not the
  bare ability text.
- `a modal spell's auto-answer logs the card's name, never its whole mode text` (new): offers one
  ability whose label is a ~100-character modal mode menu ("Choose two — • Prevent all damage
  that would be dealt to you this turn. • Target player discards a card."). Asserts `m.says`
  contains `played <hostName>` and that no line contains the mode text at all.

Run from the worktree root: **266/266 passed, exit 0** (both tests included).

## Mutation test

Reverted the effect to `noteAutoAnswered(match, auto.why)` (the old call), ran the modal-spell
test alone:

- **Mutated (raw `auto.why`): 1 failed** — `expected [ Array(1) ] to include 'played Izzet
  Guildgate'` (the fixture's `mine[0]` battlefield card is Izzet Guildgate; the mutated code
  logged the modal text instead).
- **Restored: 1 passed.**

Full suite re-run after restoring: 266/266 passed, exit 0.
