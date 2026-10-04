# U — `flow.jvm.test.ts` (unowned): one red of seven, stop-and-report

The second of the three unowned jar suites the brief names to check. 6 of 7 pass; one does not, with the
jar env (`w38run`, `--fileParallelism=false`, `CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w38-U/work`):

```
FAIL … > Forge offers the same one ability twice for one click, and the player sees neither
AssertionError: []: expected 0 to be greater than 0
  expect(record.repeatedOffers.length, …).toBeGreaterThan(0)
```

This asserts a Forge ENGINE behaviour — that Forge's bridge sends the `getAbilityToPlay` ask TWICE for
the same card on one click (the double-offer wave 20 item 4/9 made a non-event; `LiveBoard.tsx`'s own
module header explains the shortcut: *"the whole of their 'choose ability often needs the click TWICE',
because Forge asks that offer twice for one selectCard and both copies now answer themselves"*).
`record.repeatedOffers` (`flow.jvm.test.ts:567`) counts consecutive `getAbilityToPlay` asks with the
same key (card + options) — it is a property of how many times FORGE itself re-asked this run, not of
anything the client drew or clicked.

**Not this lane's bug.** This lane's three files (`ConfirmPrompt.tsx`, `DialogPrompts.tsx`, and two
touched comments in `match.ts`) do not touch `getAbilityToPlay`, `autoAnswer`
(`apps/ui/src/play/prompts/rules.ts`, unowned), or `LiveBoard.tsx`'s auto-answer effect
(`pending`/`auto`/`noteAutoAnswered`, around `LiveBoard.tsx:1320-1334`) — none of those lines changed in
this lane's diff. The other six tests in the same file, including the sibling case right above it
(`full control restores the stop the one-ability shortcut removed`) and the one right after
(`a refused click is rare, and never the last word`), both touching the SAME auto-answer machinery,
pass. Whether Forge double-offers a given card is the engine's own call (seed, board state, timing of
the bridge's two `refreshActionable` calls), not something this lane's rendering change can move.

**Not fixed here.** Investigating or fixing this means reading `apps/server/src/play/bridge/PlayBridge.java`
and/or `apps/ui/src/play/prompts/rules.ts`'s `autoAnswer`, neither owned by this lane
(`docs/planning/wave38-2026-10-03.md`'s §U row — no engine changes this wave either way). Per this
lane's own brief: "A red in one of those [the three unowned jar suites] is a stop-and-report, not an
edit." Reported here; `combat-drag.jvm.test.ts` is green (checked separately,
`U-board-play-jvm-red.md` has `board-play.jvm.test.ts`'s own red).
