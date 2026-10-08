# §B evidence — "Waiting for {name} to …" (AD5, AB3)

Wave 60. Playtest 14: *"i play thirst for knowledge and my opponent just sees
the mini version, but i would have expected to display a 'Waiting for Hadoku
to {card effect they are selecting things to resolve for}…'"*

## The shipped verb table

| ask method (or synthetic tag) | verb | example sentence |
| --- | --- | --- |
| `chooseSingleEntityForEffect`, or a `setSelectables` selection with `min === max === 1` | choose | "Waiting for Bob to choose…" |
| `getChoices`, `chooseEntitiesForEffect`, or any other `setSelectables` selection | choose cards | "Waiting for Alice to choose cards for Thirst for Knowledge…" |
| `confirm` (and every other blocking method not named above: `showConfirmDialog`, `showOptionDialog`, `showInputDialog`, `order`, `sideboard`, `tempShowZones`, `getAbilityToPlay`, `assignCombatDamage`, `assignGenericAmount`, `manipulateCardList`, `openZones`) | decide | "Waiting for Bob to decide…" |
| the synthetic `'pay'` tag (an `InputPayMana` prompt in progress — never a real `OpenAsk`, see below) | pay | "Waiting for Bob to pay for Lightning Bolt…" |

Implemented in `apps/ui/src/play/live/LiveBoard.tsx`'s `WAITING_VERB` +
`waitingSentence`; pinned verb-by-verb in `LiveBoard.test.ts`'s
`it.each` block ("AD5 verb table"). With no host card the sentence drops the
`for …` clause ("Waiting for Bob to decide…").

## A selection counts too — the discovery this wave's own probe made

The brief's own illustrative sentence ("to choose for Thirst for
Knowledge…") assumed the discard would arrive as a blocking ask
(`getChoices`/`chooseCardsForEffect`). **Measured against the real jar**
(`CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES`, a throwaway
`zzz-w60-probe.jvm.test.ts` built on `scenario.ts`'s own harness, deleted
once read) that assumption was wrong: Thirst for Knowledge's
"draw three cards, then discard two cards unless you discard an artifact
card" reaches the wire as

```
setSelectables { cards: [5 hand ids], min: 2, max: 2, players: [] }
```

— never an `OpenAsk` at all (`setSelectables` carries no `callId`;
`InputSelectManyBase` is not one of the 15 blocking methods) — with a bridge
`tempShowZones` ask open at the SAME moment (pacing machinery with nothing
for a seat to decide; the UI already auto-answers it,
`e2e/play/prompts.ts`'s `SELF_ANSWERING`) and the LAST `showPromptMessage`
on record still the one-shot "Priority: … Stack: 1 to Resolve." window
Forge gives the caster right before the spell resolves — `card: null`, an
ordinary priority prompt, not an announcement.

So `Match.waitingOnFor` (`apps/server/src/play/match.ts`) checks, in order:

1. `s.payment !== null` → `'pay'`.
2. `s.selection !== null` (a live `setSelectables`) → `min === max === 1` ?
   `chooseSingleEntityForEffect`'s slot : `getChoices`'s slot. Checked
   BEFORE `s.asks`, so a selection wins over a concurrently open
   `tempShowZones` — confirmed against the real jar (both open at once for
   this exact scenario) and pinned server-side
   (`match.test.ts`'s "a selection wins over a concurrently open ask").
3. `s.asks.size > 0` → the oldest open ask's own method.

The host card comes off the freshest `showPromptMessage`'s `card` when
there is one, falling back to the card at the TOP of `Game.Stack`
(`stackTopHostCardId`, new in `match.ts`) when the prompt is stale or
card-less — exactly the `setSelectables` case above: the spell is still ON
the stack while its own discard resolves (nothing passes priority to
remove it mid-resolution), so the stack's top is the one fact that
survives to read. Both sources are resolved through the OTHER seat's own
folded history, never the asking seat's — a card only the asker can see
(their own hand) is absent from that fold and resolves to `null`; the
stack and a battlefield are public either way and resolve to a name. This
is what keeps `e2e/play.spec.ts`'s isolation check meaningful for this
feature: a hand card's name is structurally unreachable from the fold a
non-owning seat is given, not merely filtered on the way out.

## AB3 closed as a side effect, not a separate fix

*"[the operator] sees a flash between the mulligan ending and the first
prompt."* The old small-line banner (`isWaitingForOpponent`) inferred "the
opponent is doing something" from the NEGATIVE SPACE of the viewer's own
three signals (no open ask, no selection, not paying mana, bar disabled) —
`myMoveNow`, wave 36 §L. That inference could go false a beat before the
OTHER seat's real state caught up (the gap between the mulligan ending and
the next real prompt landing), which is exactly the flash.

This wave deletes `myMoveNow` outright and gates the banner on
`theirWaitingOn(match) !== null` — the server's own reported fact for the
OTHER seat, carried over `forge:seats`' new `waitingOn` field (see below).
There is no more local inference to go stale, so there is no more flash.
Pinned: `LiveBoard.test.ts`'s "AB3: appears the instant the server reports
…" and "is independent of the viewer's OWN ask or bar …".

The PREGAME pop-up (`isWaitingForPregameDecision`, the coin toss and either
seat's opening mulligan) is unchanged in its own wording ("Waiting for
{name}…", no verb) — only its trigger (`isWaitingForOpponent`) now needs
the same server fact, since Forge publishes no ask at all for that moment
(see that function's own long-standing note). `LiveBoard.test.ts`'s W1
block was updated to set the fact up explicitly rather than relying on a
test fixture's incidental default.

## The wire mechanism — why `forge:seats`, not a new frame or event

`waitingOn` travels on the EXISTING `forge:seats` event (`Match.seatIdentities()`,
`apps/server/src/play/socket.ts`'s unmodified relay), the same mechanism
wave 29 §B's `avatarId` and wave 31 §S's `name` already use, and for the
same reason their own comments give: `MatchSnapshot`/`ServerEnvelope` are
`.strict()` zod schemas neither lane owns this wave, and `packages/forge-wire`'s
`ServerFrameSchema` models Forge's OWN real wire protocol (32 arms, 38
required methods) — a synthesized `waitingOn` notify has no `ProtocolMethod`
behind it and does not belong there. `forge:seats` already exists precisely
to carry facts like this one without touching either.

This did require two files outside this lane's listed row —
`apps/ui/src/play/live/transport.ts` (`SeatIdentitySchema`, a new optional
`waitingOn` field, `.strict()` like every sibling field) and
`apps/ui/src/play/live/match.ts` (`adoptSeats` carries it onto a new
`LiveMatch.waitingOn` map, keyed by SEAT not player id since an ask can
open before `openView` names a player). Recorded under "ambiguous brief"
in the lane's closing report: the owns row listed `match.ts` as
"(read it)" only, but the blast-radius table's own "who adapts each: B"
column named it, and `apps/server/src/play/match.ts`'s own `seatIdentities()`
docstring (wave 29 §B, written long before this wave) already documents
`.strict()` + `forge:seats` as the established escape hatch for exactly
this class of problem — the same reasoning, reapplied.

`apps/server/src/play/socket.ts` and `apps/server/src/play/transport.ts`
needed NO changes: `socket.ts`'s `forge:seats` emit already forwards
whatever `seatIdentities()` returns, blind to its shape, and no
server-side schema governs that payload (`seatIdentities()`'s own
docstring: "sent instead as its own event… deliberately NOT folded into
`Match.snapshot`").

## Done-when, checked

- **The pins fail when reverted.** `apps/server/src/play/match.ts`:
  `waitingOnFor` mutated to `return null` unconditionally — 4 of 6 new
  `match.test.ts` cases fail (restored, 104/104 green); mutated again to
  disable the `s.selection !== null` branch — the 4 selection-specific
  cases fail (restored, 104/104 green). `apps/ui/src/play/live/LiveBoard.tsx`:
  `theirWaitingOn` mutated to `return null` unconditionally — 14 of 186
  `LiveBoard.test.ts` cases fail (restored, 186/186 green).
- **`e2e/w60-waiting.spec.ts` green on a claw-equivalent run** (this
  worktree, real Forge, `CARDTABLE_FORGE_JAR`/`CARDTABLE_FORGE_RES` from
  the environment block): alice casts Thirst for Knowledge, bob's banner
  reads "Waiting for Alice to choose cards for Thirst for Knowledge…",
  then goes the instant alice answers. 1/1 passed, 7.6s.
- **`e2e/w31.spec.ts` green**, same run, unmodified — the `live-waiting`
  count-0 assertion during alice's OWN London bottom pick still holds
  under the new gate (bob has nothing open at that moment, so
  `theirWaitingOn` is correctly null; no edit needed). 7/7 passed, 1.1m.
- **The isolation check in `play.spec.ts`**: not run this pass (a ~15+
  minute full-game spec; the manager's own claw run is the real proof per
  the wave file's protocol section). Argued safe above (structural, not
  merely filtered) and consistent with every other `cardName`-based line
  already in `match.ts` (payments, triggers) that the isolation check has
  held green against for several waves.
