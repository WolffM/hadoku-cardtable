/*
 * The fixture source still renders unchanged — byte for byte — and the live
 * source renders the same bytes from the same game.
 *
 * ## The baseline
 *
 * Re-recorded for `CardTile` drawing Forge's LIVE `AbilityText` in place of
 * the printed `OracleText` when the two differ; see `../adapter.ts`'s
 * `BoardCard.abilityText` and `../../components/CardTile.tsx`'s `liveText`.
 * Not owned by the change that moved it, but the pin is a mechanical
 * consequence of a sanctioned behaviour change, not a bug, and every entry
 * below that has moved this pin has re-recorded it rather than touch the
 * assertion — see the next entry down. 42983 -> 42876, -107, measured the
 * strong way: the fixture rendered with `liveText={null}` (the prior
 * behaviour) and with `liveText={entry.abilityText}` (the new one),
 * `diff --word-diff` on the two, every changed region accounted for. Four
 * of the committed fixture's cards carry a live `AbilityText` that reads
 * differently from their printed `OracleText` — not a haunt relation (the
 * fixture has none; see `adapter.test.ts`'s own note), just Forge's ability-
 * text generator phrasing or ordering a multi-clause card differently from
 * its oracle-text generator:
 *
 *    0  Oxidda Golem (76): Affinity-then-Haste becomes Haste-then-Affinity —
 *       the same two facts, reordered; no characters gained or lost.
 *    0  Pyrite Spellbomb (108): its two activated abilities swap order the
 *       same way — 0 net.
 *  -97  Ral's Staticaster (2): printed `Trample (This creature can deal
 *       excess combat damage to the player or planeswalker it's attacking.)`
 *       loses its parenthetical reminder text, reading bare `Trample` —
 *       `AbilityText` does not reproduce a keyword's reminder text the way
 *       `OracleText` does.
 *  -10  Ral's Dispersal (17, the stack's own source card): Forge's ability
 *       text paraphrases the printed sentence slightly differently
 *       ("reveal it, and put it into your hand" / "shuffle." versus "and put
 *       it in your hand" / "shuffle it.") — the same card, the same effect,
 *       a different sentence from the SAME engine's two different text
 *       generators.
 *  ────
 * -107  42983 -> 42876.
 *
 * Before that, re-recorded for the stack redesign (2026-10-06, approved by the operator:
 * https://claude.ai/artifact/BUeXnHbHkeqtxFccyHQSfd — *"i honestly really
 * just want one of these [expanded views]"*). 44350 -> 42983, -1367, measured
 * the strong way: the fixture rendered with the previous `Board.tsx` and with
 * this one, the two `<section class="stack">`s diffed directly, and the rest
 * of the markup byte-identical. The fixture's stack holds two items, so the
 * row still draws both; the whole of the change is the big view and the
 * carousel's own click:
 *
 * -1311  `<div class="stack__big" data-shown="true" data-pinned="true"
 *        aria-hidden="true">…</div>`, the row's own enlarged view with its
 *        `CardTile` of Fire Urchin, gone: a thumbnail is read through the
 *        inspector now, like every other tile.
 *   -20  ` aria-current="true"` on the top item: nothing is "shown" any more.
 *   -36  the two thumbnails' `<button type="button" class="stack__body">`
 *        (the carousel's own pick-a-card click) are `<span class="stack__body">`:
 *        with no big view there is nothing to pick for, and a thumbnail is a
 *        button only while Forge's own stack-choice ask offers it
 *        (`.stack__select`, unchanged).
 *  ─────
 * -1367  44350 -> 42983.
 *
 * Before that, re-recorded in Wave 46 §A for X3, the stack carousel (operator, asked four
 * times: *"show a sort of gallery/carousel small view … whatever is the top
 * card should show in the expanded big view below it"*, demo v5 approved).
 * 42550 -> 43762, +1212, and every one of the characters is accounted for —
 * measured the strong way, rendering the fixture with and without this
 * wave's `Board.tsx` and diffing the two `<section class="stack">`s directly
 * (`REST_EQUAL` true: nothing OUTSIDE the stack's own section moved by a
 * single byte):
 *
 *   -68  `<h3 class="zone__head">Stack <span class="zone__count">2</span></h3>`,
 *        gone outright — the demo and the "no explanatory text" rule both
 *        drop the stack's visible label; `aria-label="Stack"` (unchanged,
 *        already on the section) carries the accessible name it used to.
 *  +109  item 49's (Fire Urchin's trigger) `<li>`: `class="stack__item"` grows
 *        ` stack__item--top stack__item--mine` (it is the top, and the
 *        viewer's own), gains `data-is-ability="true"` and
 *        `aria-current="true"` (it is what the big view shows by default)
 *        and `aria-label="Bob (Capturing) · Fire Urchin · ability"`; loses
 *        `data-source-card="21"` (the stack opted out of the generic
 *        inspector this wave — `inspect/index.ts`'s own header says why).
 *   +60  item 48's (Direct Current) `<li>`: the same shape, one class, no
 *        `data-is-ability` (it is a spell), no `aria-current` (not shown),
 *        `aria-label="Bob (Capturing) · Direct Current → Goblin Replica"`,
 *        `data-source-card="1"` gone the same way.
 *   +69  item 49's body: `<span class="stack__body">` becomes
 *        `<button type="button" class="stack__body" aria-label="…">` — a
 *        real button now (the carousel's own click-to-pin gesture, unrelated
 *        to Forge's `button.stack__select`, which this item still has none
 *        of either way).
 *   +79  item 48's body, the same shape with its own (longer) `aria-label`.
 *    +4  both items' body CLOSE tag, `</span>` (7) -> `</button>` (9), twice.
 *  -211  item 49's `<span class="stack__what">…</span>` — the whole T8
 *        one-line summary (`.stack__controller`, `.stack__sep`,
 *        `.stack__source`, `.stack__kind`) — gone; the same facts are now
 *        the `<li>`'s own `aria-label`, above.
 *  -223  item 48's `.stack__what`, the same way (plus `.stack__target`).
 *  +100  two `<span class="stack__n" aria-hidden="true">`, 50 characters
 *        each: the ordinal badge (1, 2) every thumbnail draws now.
 *   +68  `<div class="stack__big" data-pinned="true" aria-hidden="true">…</div>`'s
 *        own open and close tags — the new big view, a fixed slot after
 *        `</ol>` regardless of state (`Board.test.ts`'s "the canvas is
 *        static" suite pins this).
 * +1225  the big view's OWN content: a second, whole `CardTile` clone of
 *        item 49 (Fire Urchin, the top of the stack — the big view is
 *        PINNED and shows it by default, nothing else on this fixture's
 *        board covers it). Identical markup to the thumbnail's own CardTile,
 *        duplicated rather than cloned at runtime, because this is a
 *        server-rendered string, not a live DOM the component could reuse a
 *        node from.
 *  ─────
 * +1212  42550 -> 43762, and -68+109+60+69+79+4-211-223+100+68+1225 = 1212
 *        exactly.
 *
 * Checked the strong way, as the paragraph below demands: a scratch render of
 * `../fixtures.ts`'s own view through BOTH the previous `Board.tsx` (`git show
 * HEAD:` before this wave) and this wave's, diffed with `renderToStaticMarkup`
 * — the `<section class="stack">` substring is the only place either string
 * differs; `../adapter.ts` and `../fixtures.ts` did not move.
 *
 * Re-recorded again, immediately after, for X3's own follow-up fix (the real
 * infinite-layout-effect bug `.stack__big`'s own comment in `Board.tsx`
 * describes — a `display: none` box measures zero, which can never overlap a
 * permanent, which flips the pin check back on, forever, against a live
 * page): `hidden={…}` (a boolean HTML attribute, omitted entirely when
 * false) became `data-shown={… || undefined}` (`board.css` reads it for
 * `visibility`, not `display`, instead). 43762 -> 43780, +18, exactly
 * `' data-shown="true"'` (18 characters) appearing on `.stack__big` where
 * `hidden` used to contribute nothing — confirmed directly: the fixture's
 * own stack is non-empty and `StackView`'s `pinned` state defaults to
 * `true` (`useState(true)`, and `renderToStaticMarkup` never runs the
 * layout effect that could change it), so `displayed` is non-null and this
 * attribute is always present in this render. Nothing else moved; `grep`
 * for `data-shown` in the rendered string finds exactly one match.
 *
 * Re-recorded in Wave 36 §B for T8 (third ask): *"the stack shows what is
 * happening, not all the text."* `StackItem` no longer draws
 * `item.description` at all — Forge's own resolved prose, which used to sit
 * in a `.stack__text` span beside the name — and draws `controllerName` (who)
 * BEFORE `sourceName` (what, moved up from second) with a `.stack__sep`
 * between them, then `.stack__target` (at what, new this wave) when
 * `targetLabel` is not null. 42801 -> 42550, -251, and every one of the 251
 * characters is accounted for — measured the strong way, rendering the
 * fixture with and without this wave's `Board.tsx` and diffing the two stack
 * `<li>`s directly (both items' art, type, cost and rules-text markup is
 * untouched; only `.stack__what`'s own children moved):
 *
 *  -214  item 49 (Fire Urchin's trigger, an ability, no target): removed
 *        `<span class="stack__text"><span>Whenever you cast an instant or
 *        sorcery spell, Fire Urchin gets +1/+0 until end of turn. [Card:
 *        Direct Current (1), Activator: Bob (Capturing), SpellAbility: Direct
 *        Current deals 2 damage to any target.]</span></span>` (249 chars);
 *        added one `<span class="stack__sep"> · </span>` (35) ahead of the
 *        (unchanged) `.stack__source` span that now follows `.stack__controller`
 *        instead of leading it. 35 - 249 = -214.
 *   -37  item 48 (Direct Current, the spell, target card 67 "Goblin
 *        Replica"): removed `<span class="stack__text"><span>Direct Current
 *        (1) - Direct Current (1) deals 2 damage to Goblin Replica
 *        (67).</span></span>` (124 chars); added the same `.stack__sep` (35)
 *        plus `<span class="stack__target"> → Goblin Replica</span>` (52) —
 *        `targetLabel` resolved from this item's own `TargetCards: [67]`
 *        (wave 33's own field, read this wave for the first time) through the
 *        SAME card resolver every other name on the board goes through. 35 +
 *        52 - 124 = -37.
 *  ─────
 *  -251  42801 -> 42550, and -214 - 37 = -251 exactly. `T6` (the hand's
 *        uncapped `--card-w`), `T7` (`ChosenType`) and `T10` (the
 *        `sessionStorage` hydration) move NOTHING here: this fixture's cards
 *        carry no `ChosenType`, hand card height is a stylesheet number this
 *        test never reads, and `sessionStorage` starts empty for a fixture
 *        render with no prior arrangement.
 *
 * Checked the strong way, as the paragraph below demands: reverting
 * `../Board.tsx` and `../adapter.ts` ALONE (to their pre-wave-36 content, in a
 * scratch copy of this directory with the two swapped back) renders 42801 at
 * the same sha256 this pin carried before; the working tree's two files alone
 * render 42550. `../card.css` and `../fixtures.ts` did not move.
 *
 * Re-recorded in Wave 35 §B a second time, for R10's OWN follow-up fix
 * (`disabled` → `tabIndex={-1}`, found by lane E's real-browser e2e run: a
 * `disabled` element never receives a pointer event in a real browser, which
 * broke the arrange-drag's own press for every inert card — jsdom does not
 * reproduce that suppression, so the first round of unit tests could not
 * catch it): 42753 -> 42801, +48, fully accounted for — the SAME 24 inert
 * cards each trade ` disabled=""` (12 characters) for ` tabindex="-1"` (14
 * characters), +2 × 24 = +48 exactly, and nothing else changed.
 *
 * Re-recorded in Wave 35 §B for R10 (the flicker fix) itself: 41985 -> 42753,
 * +768, fully accounted for — measured the strong way, rendering the fixture
 * with and without `Board.tsx`'s change and diffing the real strings. This
 * fixture's 24 cards Forge has not offered (`interaction` is omitted here, so
 * EVERY card is inert) each move from `<div class="board-card__face">...</div>`
 * (36 characters of tags) to `<button type="button" class="board-card__face"
 * disabled="">...</button>` (68 characters of tags) — +32 characters × 24 =
 * +768 exactly, and nothing else in the tree changed (card.css's selectable
 * styling moved off the `button` tag to `[data-selectable]`, which is a
 * stylesheet this test never reads). R16 (the game-over banner's removal)
 * contributes nothing here: this fixture's `view.gameOver` is false, so the
 * deleted `<p class="board__over">` branch never rendered for it either way.
 *
 * Re-recorded in Wave 33 §B for shape 3 (the active-player ring hook): 41864
 * -> 41985, +121, and every one of the characters is accounted for —
 * measured the strong way, by rendering the fixture with and without the
 * change and diffing the real strings:
 *
 *  +102  two `<span class="seat__ring" aria-hidden="true"></span>` (51 each),
 *        one per seat's `PlayerFace` — the ring is now a real element, always
 *        in the markup, lit by `card.css` only while its seat's `<section
 *        data-testid="player">` carries `data-active`. Before this wave the
 *        ring was a `box-shadow` on `.face__art` with no element of its own.
 *   +19  ` data-active="true"` on the viewer's `<section data-testid="player">`
 *        — shape 3's other half. The viewer (id 0) is this fixture's active
 *        player, so exactly one seat gains the attribute; the opponent's
 *        section gains none (`data-active={player.isActive || undefined}`).
 *    ±0  `.face`'s own `data-active` is unchanged (still set directly from
 *        `player.isActive`, as before this wave) — this delta is additive,
 *        not a move.
 *    ±0  item 1 (Q18) changes a BRANCH CONDITION on `StackItem`'s
 *        selectability, not markup, and this render passes no `interaction`
 *        prop at all — `selectable` is false either way, with or without the
 *        fix.
 *    ±0  item 2 (shape 2, `targetCardIds`/`targetPlayerIds`) is carried on
 *        `StackEntry` but drawn nowhere by this lane — G's arrow is the
 *        reader. The fixture's own spell (id 48) already carries a real
 *        target (`[67]`, checked directly against `toBoardView`'s output),
 *        and it changes nothing here.
 *    ±0  item 4 (player counters) draws nothing for either seat: this
 *        fixture's `PlayerView.Counters` is empty for both (checked directly
 *        against `toBoardView`'s output), so `PlayerCounters` renders `null`
 *        for both, same as before this wave (the component did not exist).
 *    ±0  item 5 (`--accent-ink`) is a token swap inside an existing
 *        declaration's VALUE, in a stylesheet this test never reads.
 *  ─────
 *  +121  41864 -> 41985, and 102 + 19 = 121 exactly.
 *
 * Checked the strong way: reverting `../Board.tsx` and `../card.css` alone
 * (to their pre-wave-33 content) makes this test PASS at the previous pin,
 * which is what proves the whole delta is those two files and that
 * `../adapter.ts` and `../fixtures.ts` did not move any markup.
 *
 * Re-recorded in Wave 30 §A for item 11: `single` — one undivided battlefield,
 * no type sections — is now `boardLayout`'s default, and `fixtureMarkup()`
 * renders `<Board>` with no `boardLayout` prop at all, so this pin is exactly
 * the case that has to move. 42868 -> 41422, and every one of the 1446
 * characters is accounted for — computed by rendering both the old
 * (`boardLayout: 'type-separated'`) and new (no prop) markup for the same
 * fixture and diffing the real strings, not estimated:
 *
 *  -1538  removed from each seat's battlefield, the type-separated alternate's
 *         own wrapping, now drawn only when `boardLayout: 'type-separated'`
 *         is passed explicitly: two `<ul class="zone__rows" style="--cols:N">`
 *         (+`</ul>`, 90B), eight `<li class="zone__row" data-board-row="…"
 *         [data-empty="true"] style="--cols:N">` lane wrappers (+`</li>`,
 *         624B), eight `<h5 class="zone__row-head">Lands <span
 *         class="zone__count">N</span></h5>`-shaped lane labels (592B), and
 *         the eight bare `<ul class="zone__cards">` (+`</ul>`) those lanes
 *         held their cards in (232B) — 90 + 624 + 592 + 232 = 1538.
 *   +92   added, one per seat: the single flat `<ul class="zone__cards"
 *         style="--cols:N">` (+`</ul>`) that replaces all of the above —
 *         `Battlefield`'s `single` branch reusing the hand's own `--cols`
 *         device (`board.css`'s `.seat > .zone--battlefield > .zone__cards`
 *         header has the sizing this enables) rather than inventing a second.
 *  ─────
 *  -1446  42868 -> 41422, and 92 - 1538 = -1446 exactly. Nothing else on the
 *         page changed: no seat furniture, no piles, no hand, no stack — item
 *         11 touches only the battlefield's own markup.
 *
 * Re-recorded in Wave 28 §A for the play surface's state layer (§A.15) and the
 * seat's symbol counts (§A.10). That change does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 42286 -> 42868, and every one of the 582 characters is accounted for:
 *
 * +1226  the four seat COUNTS became a drawn mark and a number (§A.10, the
 *        operator: *"can we get symbols to display hand/deck size instead of
 *        words?"*). `<span data-testid="hand-count">hand 2</span>` (44) became
 *        337, and the library's 51 became 371: a wrapper class, an `aria-label`
 *        carrying the word the symbol replaced, a three-path `<svg>` for the hand
 *        and a four-path one for the library, and the number in its own span.
 *        190 -> 1416 over the four of them.
 *  -644  every status CHIP, gone (§A.15, *"all the shitty text you have written
 *        on the card looks ugly"*). Six cards on this board are tapped — Izzet
 *        Guildgate 8, Island 24, Izzet Guildgate 6, Mountain 87, Mountain 78 and
 *        Vulshok War Boar 99 — and each carried a one-chip list at
 *        `96 + len(name)` characters: 6 x 96 plus 68 characters of card name.
 *    ±0  the rest of the state layer contributes NOTHING here, and that is the
 *        fixture being honest rather than the layer being absent: no card in the
 *        captured game is summoning sick, attacking, blocking, a token, damaged
 *        or carrying a counter (checked, card by card), so no `data-sick`,
 *        `data-attacking`, `data-blocking`, `data-token`, `data-damage`,
 *        `.board-card__marks` or `.board-card__counters` is emitted. The
 *        `Board.test.ts` cases for those build their own view.
 *    ±0  `data-question` on `.board__mid` (§A.7/§13) is absent: this test renders
 *        `<Board>` with no `interaction` prop, so no question can be open.
 *    ±0  `data-avatar` on a face (§A.4) is absent: nothing populates
 *        `BoardPlayer.avatarId` yet, which the field's own doc says is the state
 *        of the feature, and `PlayerFace` draws the generated mark for a seat
 *        without one.
 *  ─────
 *  +582  42286 -> 42868, and 1226 - 644 = 582 exactly.
 *
 * Re-recorded in Wave 27 for `3bb983d` (lane A: a lane's `flex-grow` stopped
 * being its PILE count and became the COLUMNS it draws, and `--rows` became one
 * decision per battlefield instead of one per lane — the budget bug that let a
 * two-row lane ask for two rows of width and spend one, starving its neighbour
 * down to 27px cards). That commit does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 42233 -> 42286, and every one of the 53 characters is accounted for:
 *
 *   +28  the two `<ul class="zone__rows">` gained `style="--cols:N"`. This is
 *        the fix itself: the zone decides `--rows` once, so the zone is where
 *        the total column count has to be written. CSS could not take it —
 *        a lane is `contain: size`, so nothing inside one contributes to its
 *        width, and no selector sums across the four lanes.
 *   -18  six lanes swapped `style="flex-grow:N"` (11 chars) for
 *        `style="--cols:N"` (8). The other two lanes' swaps are folded into
 *        the +28 above, because each is the same tag as its `zone__rows`.
 *   +17  the viewer's hand list gained `style="--cols:5"`. Graveyards and
 *        exiles did NOT: they are piles sized by their own box, so `--cols` there
 *        would be dead markup — and writing it would have made this delta
 *        roughly +150 instead of +53.
 *   +26  four `<span>` wrappers, and these are §A.7: `inOurWords` no longer
 *        rewrites `{T}` to the literal word `TAP`, so rules text is now split
 *        into `ManaPip` symbols and `<span>` text pieces. `ms-tap` appears 10
 *        times both before and after and the word `TAP` zero times both times —
 *        this fixture's text carries no `{T}` at all, so what the pin sees of
 *        §A.7 is the span split, not the symbol.
 *   ─────
 *   +53  42233 -> 42286, and 28 - 18 + 17 + 26 = 53 exactly.
 *
 * Checked the strong way the paragraph below demands, and the answer is
 * narrower than lane A predicted. Of the five files the pin depends on, only
 * two moved this wave: `../Board.tsx` (lane A) and `../../components/CardTile.tsx`
 * (lane F, which wired hover/select sound cues). Reverting `CardTile.tsx` ALONE
 * leaves 42286 — F moved nothing here, because a cue is an event handler and an
 * event handler is not markup. Reverting `../Board.tsx` alone makes this test
 * PASS at 42233. So the whole +53 is lane A's, and `../adapter.ts`,
 * `../fixtures.ts` and `ManaPip.tsx` did not move.
 *
 * Lane D deleted `styles.css`'s 16 pre-D20 `.pip` rules this wave and that is
 * invisible here, as it must be: Wave 26's note below predicted the
 * `display: contents` shim would "collapse once that section is gone", but the
 * shim lives in `ManaPip.tsx`, which no lane owned, so it is still emitted on
 * every pip. The 2537 characters it costs are still in this number. Deleting
 * it is a later wave's, and it will move this pin again.
 *
 * Re-recorded in Wave 26 for `473571d` (lane C: every mana pip, the tap symbol
 * and the set symbols became Keyrune/Mana glyphs under D20) and `f6d15b6`
 * (lane A: the table re-blocked as the operator drew it — four rows with the
 * hands outermost, the piles moved into the left column's lower cell, every
 * zone panel and caption deleted, the turn bar deleted, a right gutter
 * reserved for the permanent overlays, and the seat's mana pool drawn for the
 * first time). NEITHER commit owns this file, so the pin is re-recorded here
 * immediately after them, as the paragraph below prescribes. 7385 characters
 * arrived, 34848 -> 42233, and the two lanes are separable:
 *
 * +7988  lane C, measured by reverting `../../components/ManaPip.tsx` and
 *        `CardTile.tsx` alone: 2537 the `display: contents` compatibility shim
 *        on 59 pips, 3692 the new set symbols, 929 the pip markup itself, and
 *        830 the hover `title` added to the glyph. The shim is there because
 *        `styles.css` still carries the pre-D20 `.pip` disc rules and no lane
 *        this wave owned that file; deleting that section collapses it.
 *  -603  lane A: -219 the `<header class="board__bar">`, -562 eight
 *        `<h4 class="zone__head">` (two battlefields, two hands, two
 *        graveyards, two exiles), -32 the `<div class="zone__gutter">`, +210
 *        two `<ul class="seat__mana">` at 105 each. The graveyard `<section>`
 *        moved again and, as in Wave 25, the diff is an insert and a delete of
 *        the SAME bytes; `zone__regroup` -> `seat__regroup` is the same length.
 *  ─────
 * +7385  34848 -> 42233, and 7988 - 603 = 7385 exactly.
 *
 * Checked the strong way, and this is worth recording because the first
 * diagnosis of it was WRONG: reverting only `../Board.tsx` and `../adapter.ts`
 * leaves 42836, which reads like a pre-existing red and was reported as one.
 * It is not. Reverting all FOUR files the pin actually depends on —
 * `../Board.tsx`, `../adapter.ts`, `../../components/CardTile.tsx` and
 * `ManaPip.tsx` — to `origin/main` makes this test PASS at 34848, which is
 * what proves the whole delta is this wave's and that `../fixtures.ts` did not
 * move. `2939301` shipped the font FILES and moved no markup. A revert that
 * leaves another lane's change in the tree is not a baseline.
 *
 * Lane B moved nothing here, as this file's own rule predicts: it renders
 * `Board` alone, and B owns nothing `Board` imports.
 *
 * Re-recorded in Wave 32 lane B (Q9 the one left column, Q4a the two tiers, Q4b
 * the pointer drag, Q1b the turn ring): 41256 -> 41864, +608, and every character
 * is accounted for. Measured the strong way — the HEAD `Board.tsx` and this one
 * rendered side by side, split on `><`, and the line multisets subtracted:
 *
 *   +48  two `<div class="seat__side">` (24 each): the column that wraps a seat's
 *        bar and its piles, which are one column now
 *   +24  four `</div>`: two close those wrappers, two close the tiers' wrappers
 *   +72  two `<div class="zone__tiers">` (25), the opponent's `data-tiers="mirrored"` (47)
 *   +10  two more `</ul>` (5 each): each battlefield's one list is two
 *  +285  the four tier lists, `<ul class="zone__cards" data-tier=… style="--cols:N">`
 *        (the viewer's two also carry `data-arrange-slot`)
 *   -82  the two battlefield lists they replace (41 each)
 *   +25  ` data-arrange-slot="hand"` on the viewer's hand list
 *  +251  ten ` data-arrange-card="<slot>"` on the draggable cards: back x4 (25), front x1
 *        (26), hand x5 (25). The opponent has none: nothing of theirs is draggable.
 *   +17  ` style="--cols:2"` on the opponent's card-backs list (Q2: same grid as a hand)
 *   -42  `<span class="seat__flag">their turn</span>`: the turn is a ring now (Q1b)
 *  ─────
 *  +608  41256 -> 41864, and 48 + 24 + 72 + 10 + 285 - 82 + 25 + 251 + 17 - 42 = 608 exactly.
 *
 * `draggable="true"` is unchanged at 10, the seam the gestures layer stands down on.
 *
 * Re-recorded in Wave 31 §A (lane A, P3 and P5): 41422 -> 41256, and every one
 * of the 166 characters is accounted for — the operator asked for the visible
 * `(you)` to go and for Regroup to be deleted:
 *
 *  -129  `<button type="button" class="seat__regroup" data-arrange-reset=""
 *        aria-label="Regroup your battlefield and hand">Regroup</button>`
 *   -37  `<span class="seat__you"> (you)</span>`
 *  ─────
 *  -166  41422 -> 41256, and 129 + 37 = 166 exactly. The seat's `aria-label`
 *        still says `… (you)` (that is an attribute of the same length it was),
 *        and nothing else in the markup moved: the new layout is CSS.
 *
 * Re-recorded in Wave 25 for `3710618` (lane E: the hand gained the same free
 * arrangement the battlefield has, the graveyard moved under the portrait and
 * its counts, and a claimed press selects no text). That commit does not own
 * this file, so the pin is re-recorded here immediately after it, as the
 * paragraph below prescribes. 94 characters arrived, and the whole of the
 * change is the hand's new `draggable` plus one relabelled control:
 *
 *   +85  five `draggable="true"` attributes, 17 characters each — one per card
 *        of the VIEWER's own hand, which is the lane's first defect: the hand
 *        `<Zone>` was passed no arrangement, so `draggable` was false for every
 *        card in it. `draggable="true"` therefore goes 5 -> 10 in this markup:
 *        the five battlefield cards the ledger above pinned, plus these five.
 *        The opponent's hand is a count, not cards, so it contributes none.
 *    +9  `aria-label="Regroup your battlefield"` -> `"… battlefield and hand"`,
 *        because the one reset control now clears both slots of the store.
 *    ±0  BOTH graveyard `<section>`s moved — out of `.seat__piles`' column and
 *        into the foot of `.seat__who` — and the diff is an insert and a delete
 *        of the SAME bytes: 3498 for `data-owner="them"`, 3581 for
 *        `data-owner="you"`. A zone that moved without its markup changing is
 *        exactly what a grid-area move should look like here.
 *    ±0  `data-selectable` is still 0: this test renders `<Board>` with no
 *        `interaction` prop, so nothing Forge offers can reach it.
 *  ─────
 *   +94  34754 -> 34848, and 85 + 9 = 94 exactly.
 *
 * That ledger is a measurement, not an estimate, and it was checked the strong
 * way: `Board.tsx` alone was reverted to `c698ae5` in the working tree and this
 * test PASSED at the previous pin, which is what proves the whole delta is
 * `Board.tsx` and that neither `../adapter.ts` nor `../fixtures.ts` moved.
 *
 * Re-recorded in Wave 24 for `c239b6b` (lane A: the battlefield gained free
 * placement and stacking, equipment folded onto what it equips, a P/T badge
 * that distinguishes buffed from damaged, and haste stopped wearing the
 * summoning-sickness chip). That commit does not own this file, so the pin is
 * re-recorded here immediately after it, as the paragraph below prescribes.
 * 702 characters arrived and the whole of the change is the P/T badge:
 *
 *  +702  three `.board-card__pt` badges, 234 characters each — one per creature
 *        on a battlefield in the fixture (Vulshok War Boar 5/5, Goblin Replica
 *        2/2, Fire Urchin 1/3). All three render PLAIN, because no card of the
 *        captured game is in the cube pool and the printed base is what decides
 *        whether a number is buffed — so none carries a state attribute or a
 *        marker glyph, and all three are the same length.
 *    ±0  piles: `data-pile-size` / `data-pile-depth` do not occur. The fixture
 *        carries no arrangement, and a lone card renders exactly the markup it
 *        rendered before — no wrapper, no nested list, no attribute.
 *    ±0  `data-attached` does not occur: the capture has no attachment.
 *    ±0  no damage chip was traded for a badge — no battlefield card in the
 *        fixture has `Damage`.
 *    ±0  `draggable` is unchanged at 5 and `data-selectable` at 0: this test
 *        renders `<Board>` with no `interaction` prop, so lane A's new rule
 *        that an offered card is not draggable cannot bite here.
 *  ─────
 *  +702  34052 -> 34754, and 3 x 234 = 702 exactly.
 *
 * That ledger is a measurement, not an estimate, and it was checked the strong
 * way: extract the three badges by walking their balanced `<span>`s and the
 * remainder is 34052 characters with sha256
 * `78d3849befc5fd43e0e388d78ba49b758f402ee6d93cc119664899af79239695` — byte for
 * byte the PREVIOUS baseline. So the three badges are the whole of the change
 * and nothing else in the board's markup moved, which is exactly what this
 * test exists to be able to say.
 *
 * Before that, re-recorded in Wave 22 for `f9dc909` (§C.3: a seat's furniture moved out of
 * its wide `seat__head` strip into the vertical `seat__who` bar — the avatar,
 * the name and the counts in one narrow column). 97 characters left, and the
 * whole of the change is that move; §C.1 (no rotated labels) and §C.2 (the
 * preview anchors top-left) are a stylesheet and a pure function and render no
 * markup. The ledger, both seats together:
 *
 *   -54  `<header class="seat__head">` gone
 *   +84  `<div class="seat__who" data-player-bar="">`
 *   +50  `<div class="seat__ident">`
 *    +6  each seat's `</header>` → `</div></div>`
 *    +2  `<span class="seat__meta">` → `<div class="seat__counts">`
 *    -2  and its `</span>` → `</div>`
 *   -10  `data-testid="face-life"` → `data-testid="life"`
 *  -173  the duplicate `.seat__life` pill, deleted: a seat drew its life twice,
 *        once on the avatar and once beside the name, and the narrow bar has
 *        room for one. `data-testid="life"` is the badge on the avatar now,
 *        which is what `e2e/play.spec.ts` reads.
 *
 * Before that, in Wave 20 at `dcb2e60` (§A: the battlefield grouped into
 * `data-board-row` rows with a gutter and a reset control, and the faces moved
 * to the ends), and in Wave 19 (Board gained faces, fixed zones and
 * stack art: 5c42535, 48d8266). `BASELINE_SHA256` / `BASELINE_LENGTH` are the static markup of
 * `<Board view={boardFromFixture(PLAY_FIXTURES[0])} />`, recorded at commit
 * 2709447 — Wave 9's base, BEFORE this lane touched `../adapter.ts` or added
 * anything under `live/`. If this test fails, the fixture path renders
 * differently than it did before the live source existed, which is precisely
 * the regression the fixture exists to catch. If the change is intended (a
 * deliberate Board or adapter change in a later wave), re-record both numbers
 * from the failure message and say so in that commit.
 *
 * `Board.test.ts` and `fold.test.ts` are the finer-grained net and are not
 * modified by this lane; this is the coarse one that sees every byte.
 *
 * **It renders `Board` and nothing else** — but `Board` is not a leaf, and in
 * Wave 26 that distinction cost a wrong diagnosis. A failure here is a change
 * to `../Board.tsx`, `../adapter.ts` or `../fixtures.ts`, OR to anything they
 * render: `../../components/CardTile.tsx` and, through it,
 * `../../components/ManaPip.tsx`. Never to anything under `live/`. Before
 * blaming a commit, revert ALL of those to the last green ref and confirm this
 * test passes — a revert that leaves a sibling lane's change in the tree
 * measures both and reads like a pre-existing red. Re-recording the two numbers belongs with the commit that makes the
 * markup change — or, when that commit does not own this file, immediately
 * after it, naming it (as the paragraph above does for `dcb2e60`).
 */

import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Board } from '../Board.tsx';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { closeMatch, socketIoMatchTransport, startMatch, type LiveMatch } from './match.ts';
import { fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';

// Re-recorded when the placed-cards layer deleted the stack's thumbnail row
// and lone band (two real `CardTile`s' worth of markup — name, type line,
// rules text, mana pips, set symbol): `StackView` is a bare, empty `<section>`
// (`data-zone="stack"`, `data-count`/`data-carried` only) and `live/placed.ts`
// draws every item imperatively into the overlay, which this STATIC render
// (no effects run) never sees. Before it, `CardTile`'s `liveText` re-record:
// 42876, 059e0aaf…; the pin before that: 42983, 0b71d9ff….
const BASELINE_SHA256 = 'b3f0173a920587be6fc803e0c22c0f1c8d3144854aabea5e1c9bcc10b6c498e5';
const BASELINE_LENGTH = 39577;

const fixtureMarkup = (): string =>
  renderToStaticMarkup(createElement(Board, { view: boardFromFixture(PLAY_FIXTURES[0]!) }));

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterAll(async () => {
  if (match !== null) closeMatch(match);
  if (server !== null) await server.close();
});

describe('the fixture source', () => {
  it('renders exactly the markup it rendered before the live source existed', () => {
    const html = fixtureMarkup();
    const digest = createHash('sha256').update(html).digest('hex');
    expect({ length: html.length, sha256: digest }).toEqual({ length: BASELINE_LENGTH, sha256: BASELINE_SHA256 });
  });
});

describe('the live source', () => {
  it('renders the same bytes as the fixture, from the same game over a real socket', async () => {
    const s = (server = await startReplayServer());
    const m = (match = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    }));
    await until('the join snapshot', () => m.stats.snapshots === 1);
    const frames = fixtureFrames();
    for (const f of frames) s.send(f);
    await until('every frame applied', () => m.stats.applied === frames.length);

    expect(renderToStaticMarkup(createElement(Board, { view: m.view! }))).toBe(fixtureMarkup());
  });
});
