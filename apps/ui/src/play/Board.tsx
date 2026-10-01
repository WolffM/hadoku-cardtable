/*
 * The board: one game state, drawn.
 *
 * Renders a `BoardView` and nothing else. It has no idea whether the view came
 * from a committed fixture or a live stream — the same split that let the
 * draft's transport be swapped without touching `DraftScreen`. No socket, no
 * protocol, no fold: see `fixtures.ts` → `fold.ts` → `adapter.ts` for how a
 * view is made.
 *
 * ## The canvas is static, and that is absolute
 *
 * The operator, 2026-09-24: *"the location for the stack causes the field to
 * change in size. this can never happen. the entire canvas must be fully
 * static at all times."* So the board is a grid of FIXED tracks (`board.css`)
 * and every zone renders its slot whether or not it holds anything:
 *
 *   - a zone's card list is always in the markup, empty or not, so an empty
 *     zone is the same box as a full one;
 *   - a battlefield always draws all four of its rows (below), so a player's
 *     first artifact does not add a row to the table;
 *   - an opponent's hidden hand is always its backs strip, zero backs or ten;
 *   - the stack's band is a fixed height, holding nothing or five items —
 *     items overflow by scrolling INSIDE the band;
 *   - the missing-card alert and the overlay root are positioned out of flow,
 *     so neither can push a track when it appears.
 *
 * Nothing here is sized by its content. `Board.test.ts` renders the same view
 * with an empty, a one-item and a five-item stack and holds the structure
 * identical; `e2e/table-fit.spec.ts` measures the real boxes in a browser.
 *
 * ## One undivided battlefield by default; four labelled groups as the alternate (item 11)
 *
 * The operator asked, at least three times, for the battlefield NOT to be
 * type-separated by default: *"i said this should be an alternate ui and the
 * real ui should just be a single board, no seperators."* So `single` — cards
 * in one lane, in arrival/placement order — is the `boardLayout` prop's
 * default, and the settings panel is the only way to reach the alternate.
 *
 * The alternate is what wave 26 built and is unchanged: the operator,
 * 2026-09-25, wanted the battlefield's *"ordering random"* fixed by keeping
 * lands, artifacts and creatures apart, so `type-separated` is four groups
 * inside the one fixed slot — lands, artifacts, creatures, and everything else
 * — each with its label and its count, all four always drawn. A card's group
 * is read off its OWN type line (`BoardCard.card.typeLine`, which the adapter
 * already carries); nothing is asked of the engine and no rule is implemented
 * here. `permanentType` resolves an overlap by what the card is used as: an
 * artifact land is a land, an artifact creature is a creature — and it answers
 * the same way whichever layout is on screen, because Forge's own rules (the
 * attack-declare gesture standing down on creatures) still need to know what a
 * card IS even when the board draws no lanes for it. `visualRow` is the one
 * that differs by layout: everything in one bucket by default, `permanentType`
 * in the alternate.
 *
 * Wave 24's placement model is not replaced either way, only un-bucketed by
 * default: a drop on a card's top or bottom third still stacks it, the middle
 * still reorders, a new permanent still joins the end — of the one lane by
 * default, of its type row in the alternate. The two layouts keep independent
 * arrangements (different `Arrangement` store keys), so switching the setting
 * back and forth does not throw either one away.
 *
 * In the alternate, the four groups are drawn as LANES ACROSS the slot rather than bands down it, and that
 * was measured, not chosen: the slot is 840 × 130 at 1280×800, where four
 * bands are a 21px card and four lanes are a 100px one. `board.css` has the
 * arithmetic. The attribute stays `data-board-row` — a row of the table, which
 * is what it is — and which axis the stylesheet draws it on is the
 * stylesheet's business.
 *
 * ## The arrangement is the player's, and it never leaves the browser
 *
 * Grouping is the DEFAULT order, not a cage. The viewer drags a permanent
 * within a row or into another row and it stays where they put it, and drags a
 * card of their own HAND to wherever in the hand they want it; `Regroup` throws
 * the whole seat's arrangement away and the default order comes back. Two
 * things about this are load-bearing:
 *
 *   - **It sends nothing to Forge.** There is no wire message, no reply, no
 *     ask. It reorders what the VIEW draws, which is why a player may tidy a
 *     board in the middle of someone else's turn.
 *   - **It survives a resync.** A resync replaces the whole view (a new `seq`,
 *     every object again) and may remount this component; the arrangement
 *     lives in `ARRANGED`, a module-level store keyed by the match and the
 *     seat, holding card ids — so a new view, a new mount, or both, redraw the
 *     same arrangement. `forgetArrangements()` empties it, for a test that
 *     wants the default grouping back.
 *
 * A card the arrangement names that is no longer on the battlefield is
 * ignored, and a permanent that arrives while an arrangement stands joins the
 * end of its own row. Only the viewer's own side is draggable: the arrangement
 * is theirs, and the opponent arranges their own side on their own screen.
 *
 * ## The hand is arranged the same way, and stands down on a card Forge offered
 *
 * The operator, 2026-09-27: they could not reorder their own hand at all. The
 * hand is now the same gesture, the same store and the same slot machinery as a
 * battlefield row — one slot key, `<playerId>:hand`, holding the order the
 * player put their cards in. A drop on a card puts the dragged card in front of
 * it; a drop on the hand's own list puts it at the end. There is no STACKING in
 * a hand: a hand is a row of cards you hold, so the thirds of a card's box that
 * mean "stack above / below" on a battlefield mean nothing here and the drop is
 * always a reorder.
 *
 * **The condition for a hand card is stricter than the battlefield's, and that
 * is the seam, not taste.** A press on a natively-draggable element starts no
 * gesture of the interaction lane at all (`live/gestures/install.ts`'s
 * `nativelyDraggable`), so making a card arrangeable GIVES UP that lane's press
 * on it. On a battlefield the trade is the documented one: a permanent is played
 * by clicking it, and drag-to-play on it is what arranging costs. In a hand it
 * cannot be paid, because **dragging a card out of your hand onto the
 * battlefield is how a land and a spell are played** — the gesture
 * `e2e/play.spec.ts` drives for both, and the operator's own report
 * (*"cards are not dragable"*) was that regression in production. So a hand card
 * is arrangeable only when no other gesture can want the press: Forge has not
 * offered it, no selection is open, and nothing is being declared.
 *
 * Which is exactly the set of presses that do nothing today — at plain priority
 * with no selection open, `install.ts` starts no gesture over a card Forge did
 * not offer. So the hand gained a gesture and nothing lost one.
 *
 * What the player sees: on anyone else's turn the whole hand rearranges; in
 * their own main phase the cards they can actually play are pinned (they are
 * the ones a drag plays) and every other card still moves; while Forge is asking
 * or combat is being declared the hand holds still. No rule is implemented
 * anywhere in that — every set is Forge's own, read off `interaction`.
 *
 * ## Stacking: deliberate as well as free
 *
 * The operator, 2026-09-27: *"i dont want these snapping zones… put cards
 * wherever they want… snap above/below each other in any order"*. So a row is a
 * list of PILES rather than a list of cards, and which third of a card's box a
 * drop lands in says which of three things the player meant — stack on top of
 * it, stack under it, or reorder in front of it (`dropOnCard`). A drop on the
 * row's own box is still "at the end of this row, on its own", which is the
 * gesture `e2e/table-fit.spec.ts` drives.
 *
 * Forge's own client has this as two preferences — `UI_STACK_CREATURES` and
 * `UI_MAX_STACK_DEPTH` (default `4`, `ForgePreferences.java:93,96`, consumed by
 * `VField.java:33` and `VCardDisplayArea.java:380`). We took the idea and not
 * the implementation: stacking here is per pile rather than per player, it is
 * never automatic, and the depth is not refused — a pile of nine is drawn, with
 * the FAN capped at Forge's four so the offsets stay legible (`card.css`).
 * Refusing a drop the player made is worse than a tight fan.
 *
 * ## Forge's attachments are not the player's arrangement (#11)
 *
 * An equipped creature and its gear are one pile because `AttachedCards` says
 * so, and `withAttachments` applies that AFTER the player's arrangement — so
 * rearranging the board cannot separate them, and `Regroup` cannot either. The
 * player decides where the stack sits; Forge decides what is in it.
 *
 * ## A seat's furniture is a vertical bar at its side
 *
 * The operator, 2026-09-26: *"use a vertical bar for showing the players
 * health, avatar, name, hand, library. horizontal space is precious"*. So a
 * seat is no longer a wide header strip over its zones: the avatar, the life
 * on it, the name, the mana pool, the hand count and the library count stack in
 * ONE narrow column at the seat's left edge (`board.css`, `--who-w`). The width
 * that header used to spend on empty strip goes to the battlefield, and the
 * 2.5rem of HEIGHT it cost every seat pays for the horizontal lane labels below.
 *
 * **It supersedes the layout of wave 20's face anchoring, not its point.** The
 * operator, 2026-09-25: *"avatar and number looks slick, but confusing which
 * is which"* — so ours still reads as ours. Two things carry that, and both
 * are load-bearing:
 *
 *   - the AVATAR BLOCK sits in the outer track of the bar: the first for the
 *     opponent (the top of the board) and the last for the viewer (the bottom).
 *     The two faces are still as far apart as the canvas allows, which is what
 *     `e2e/table-fit.spec.ts` measures;
 *   - the viewer's seat says so in words — `(you)` beside their name — and in
 *     `data-viewer`, on the seat and on the face.
 *
 * The counts are the other track, so a flag arriving mid-game ("their turn",
 * "priority") grows the track that has room rather than moving the face.
 *
 * ## The table is blocked the way the operator drew it (wave 26 §A)
 *
 * `docs/planning/board-layout-2026-09-27.md` is a spec made by dragging the real
 * regions on a 1280×800 canvas, and four of its rows are this file's:
 *
 *   - **one narrow left column per seat, ~5.6% wide, in TWO cells.** The upper
 *     cell is the portrait, its life, its name, its MANA POOL and its counts
 *     (`.seat__who`, still `[data-player-bar]`); the lower cell is the piles
 *     (`.seat__piles`, the graveyard and exile). The column no longer spans the
 *     seat's height and the old full-height piles COLUMN beside the battlefield
 *     is gone — which is what makes "the graveyard is below the portrait"
 *     (wave 25 §E) fall out of the geometry rather than out of a rule.
 *   - **four rows, hands outermost**: the opponent's hand, their battlefield, the
 *     centre line, your battlefield, your hand. The two battlefields face each
 *     other across the middle and each hand is as far from it as the canvas
 *     allows, which is also what keeps the two faces apart.
 *   - **the right end of every row is RESERVED** (`board.css`, `--right-gutter`).
 *     The phase rail, the controls and the log button are permanent overlays
 *     floating over that end (`live/live.css`, lane B's), so a card may never
 *     come to rest under them. Transient overlays — the stack, a question — just
 *     cover what is beneath.
 *
 * ## No zone panels and no zone labels
 *
 * The operator, asked directly on 2026-09-27: *"yes drop the zone labels too"*,
 * and the panel chrome went with the captions. `ZoneShell` draws neither. What a
 * zone keeps is its accessible name, `data-zone`, `data-owner` and `data-count` —
 * see `ZoneShell` for why each one is not optional.
 *
 * A battlefield's four LANE labels are a different thing and they stay: they name
 * a grouping this file invented, not a zone the table's own shape identifies.
 *
 * ## Every label that is left is horizontal
 *
 * The operator, 2026-09-26: *"vertical words are impossible to read, lets try
 * it differently"*. Nothing on this board is set rotated. A battlefield lane's
 * label is a horizontal strip across the top of its own lane, a FIXED track
 * (`board.css`), so it reads straight and still cannot be pushed by what the lane
 * holds. `Board.test.ts` greps the stylesheet for `writing-mode` and `rotate` to
 * keep it that way; the one rotation left on the board is a TAPPED CARD, which is
 * a card turned sideways and not a word (`card.css`).
 *
 * ## No prose
 *
 * The operator, 2026-09-24: *"this text is completely unnecessary: 'Stack 0
 * / empty'"*. There is no empty-state text, no hint and no explanation
 * anywhere on this board — and since wave 26 §A a zone shows no label either.
 * When it holds nothing it shows its slot and nothing else. Do not reintroduce a
 * sentence here.
 *
 * ## Cards are `CardTile`
 *
 * Every card on the board is the draft's own `CardTile`, unchanged — our
 * layout, our pips, and art through the art resolver (`draft/cardImage.ts` →
 * `@hadoku/carddata/art`) from the Scryfall id the adapter looked up. No host
 * is named here. A card with no id is the text tile, which is a whole card on
 * its own. The board adds only the state a printed card doesn't have (damage,
 * counters, tapped, attacking, blocking, summoning sickness, whether it is a
 * token) — and since wave 28 §A.15 it DRAWS that state rather than writing it:
 * see "A card's state is drawn" below. A stack item draws its source card the
 * same way, from `StackEntry.sourceCard`.
 *
 * ## P/T on the board is the board's badge, not the tile's stat
 *
 * A creature on a battlefield wears `3 / 1` — the current power and what is
 * LEFT of the toughness — in a badge this file draws (`PowerToughness`), because
 * the art covers `CardTile`'s printed `.card__stat` and `CardTile` is not this
 * lane's file. `adapter.ts`'s `boardPT` decides what the numbers mean; this
 * decides what they look like. Buffed is blue, hurt is red, and — settled at
 * dispatch — **colour is never the only signal**: each state also carries a
 * marker glyph, a heavier weight, and the whole thing in words in the badge's
 * accessible name. A card whose printed base our data does not know draws
 * plain, which is the honest answer and never a guessed buff.
 *
 * ## Tapped is turned sideways, and so is an attacker
 *
 * A tapped card is rotated a quarter turn inside a landscape box of the same
 * width (`card.css`), so it reads as tapped at a glance and still takes no
 * more room than its column. Since wave 28 that is the WHOLE of "tapped" here —
 * the word is gone — and an ATTACKING creature is drawn the same way, which is
 * item 6: *"creatures should tap when they are attacking"*. `data-tapped` and
 * `data-attacking` stay two attributes, because they are two facts; only the
 * drawing is shared.
 *
 * ## What is clickable is Forge's answer, not ours
 *
 * `interaction` carries the ids Forge last sent in `setSelectables`. A card
 * whose id is in that set is a real `<button>` — focusable, Enter/Space work —
 * and calls `onSelectCard`; any other card is inert markup with no handler at
 * all, so there is nothing to call. Players are the same, from
 * `selectablePlayers`: a selectable seat's name and its face are both buttons,
 * and an unselectable one is neither. This file never decides what may be
 * selected: we implement no rules. With no `interaction` every card is inert.
 *
 * The one control on this board that is ours rather than Forge's is `Regroup`,
 * which answers no question and sends nothing.
 *
 * ## The DOM is the seam with the interaction and inspector lanes
 *
 * Other lanes draw a targeter arrow and enlarge a card under the pointer; they
 * find things without owning this markup. What is guaranteed here, and pinned
 * by a test:
 *
 *   - every card in a zone carries `data-card-id="<id>"`, and `<id>` is unique
 *     across the board (it also keeps `data-board-card`, the older name, with
 *     the same value — other suites query it). A stack item does NOT carry
 *     `data-card-id`: the card an ability came from is still on its
 *     battlefield, so the id would be there twice and uniqueness is the
 *     property the arrow needs. The item names its card in `data-source-card`.
 *
 *     **`CardTile` draws its own `data-card-id` too, and it is a different
 *     namespace**: the draft's card id, `w<forge id>` (`adapter.ts:317`). So
 *     `[data-card-id="107"]` is this board's card 107 and nothing else, but a
 *     bare `[data-card-id]` or a `closest()` also matches the tile inside it.
 *     Match on the value, not the attribute.
 *
 *   - every player's face carries `data-player-face` and `data-player-id`, and
 *     lives in that seat's `[data-player-bar]` — the vertical bar, which is
 *     NOT a zone and carries no `data-zone`, because the set of zones on this
 *     board is itself asserted;
 *   - every zone carries `data-zone` and `data-owner` (`you`, `them`, or
 *     `table` for the stack, which belongs to no seat);
 *   - a battlefield's rows each carry `data-board-row` (`lands`, `artifacts`,
 *     `creatures`, `other`), in that order, and `data-empty` when the row
 *     holds nothing. A draggable card carries `draggable` — on the viewer's own
 *     battlefield and in their own hand — and the viewer's SEAT carries one
 *     `[data-arrange-reset]` control, which resets the whole seat; it used to
 *     hang off the battlefield's label column, and §A.3 took that column with the
 *     label;
 *
 *     **A row's `:scope > ul.zone__cards > li.board-card` children are its
 *     PILES, one per visual column** — the bottom card of each. The cards above
 *     it are `li.board-card` inside that element's own `ul.board-card__pile`,
 *     each with its own `data-card-id` and its `data-pile-depth`. A lone card is
 *     a pile of one and carries neither attribute. So a descendant query for
 *     `[data-card-id="<id>"]` still finds exactly one element anywhere on the
 *     board, and a `:scope >` query still measures one card's box;
 *
 *     **A battlefield writes `--cols` in three places and `board.css` sizes the
 *     zone from it** (wave 27 §A.1): on `ul.zone__rows`, every pile on that
 *     battlefield; on each lane's `<li>`, that lane's piles; and on the viewer's
 *     own hand list, its cards. The stylesheet cannot take these itself — a lane
 *     is `contain: size`, so nothing in it contributes to its width, and no
 *     selector can sum a count across the four lanes. It replaces the inline
 *     `flex-grow` a lane used to carry, which is now `ceil(--cols / --rows)`
 *     there. A DOM-only probe that adds cards to a lane owes it `--cols`, the
 *     way `e2e/table-fit.spec.ts`'s crowd probe owed it the grow;
 *
 *   - this lane's gesture is HTML5 DRAG-AND-DROP and nothing else:
 *     `dragstart` / `dragend` on an arrangeable card's `<li>`, `dragover` /
 *     `drop` on that `<li>` and on the box it sits in — a battlefield row's
 *     `<li>`, or the hand's own `<ul class="zone__cards">`. **No pointer event is
 *     bound anywhere in this file**, so the interaction lane's delegated pointer
 *     handling has the pointer to itself. A card whose press is an ARRANGEMENT
 *     needs no offer from Forge and sends nothing, which is why it is this
 *     gesture and not the pointer layer's. Nothing here reads, writes or styles
 *     `data-attack-intent`; this lane's own attributes are `data-arrange-reset`,
 *     `data-pile-size`, `data-pile-depth`, `data-attached` and `data-pt*`;
 *
 *     **A card Forge is ASKING ABOUT is never `draggable`, and that is the
 *     seam, not a detail.** A `draggable="true"` element starts the browser's
 *     native drag from the same press the interaction lane starts a targeter
 *     drag on, so a card that was both would fire both gestures at once. The
 *     condition on a BATTLEFIELD is `interaction.selectionOpen && selectable` —
 *     an OPEN SELECTION, not merely Forge's actionable set, whose own docs are
 *     on `BoardInteraction.selectionOpen`. In the HAND it is `selectable`
 *     alone, because drag-to-play out of a hand may not be given up (the hand's
 *     own section above). So a natively-draggable element is never a card an
 *     open selection is waiting on, and in a hand never a card Forge offered at
 *     all;
 *   - `data-board-overlay` is a positioned root covering the canvas exactly,
 *     at the board's top level, for those lanes to render into. This file adds
 *     no pointer handler to it and draws nothing in it.
 *
 * The inspector (`inspect/index.ts`) is BOOTED here — one mount effect on the
 * board's root element, disposed on unmount — and that is the whole of this
 * file's involvement with it: it attaches its own listeners, by delegation,
 * and renders into the overlay root. No handler, prop or markup here is for
 * it.
 *
 * ## Hidden information
 *
 * An opponent's hand arrives as `hand: null` and a count (`adapter.ts`), and is
 * drawn as that many card backs — our own pattern, not Magic's back. There is
 * no card object to render, so no face can leak through here.
 *
 * ## Layout
 *
 * The opponent on top with their hand outermost and their bar's face beside
 * their battlefield, the viewer at the bottom with their hand outermost and their
 * bar's face beside theirs — the two battlefields meeting at the centre line.
 * Page layout is `board.css`; how a single card looks is `card.css`, sized from
 * `--card-w` so the layout can shrink cards per zone — down to `--card-min`, the
 * width at which a card's NAME stops being readable, and no further (§A.1).
 */

import { useEffect, useReducer, useRef, type CSSProperties, type ReactNode } from 'react';

import { CardTile } from '../components/CardTile.tsx';
import { ManaPip } from '../components/ManaPip.tsx';
import { avatarSquareUrl } from '../room/avatar.ts';
import {
  boardPT,
  type BoardCard,
  type BoardPlayer,
  type BoardView,
  type PoolColor,
  type PTState,
  type StackEntry,
} from './adapter.ts';
import { mountInspector } from './inspect/index.ts';
import './board.css';
import './card.css';

/** What Forge currently lets the viewer click, and where a click goes. */
export interface BoardInteraction {
  /** Card ids Forge currently says are selectable (from setSelectables). */
  selectable: ReadonlySet<number>;
  /** Player ids Forge currently says are selectable. */
  selectablePlayers: ReadonlySet<number>;
  /**
   * Forge has an OPEN SELECTION: a question on the table that a click is an
   * ANSWER to.
   *
   * This is not the same claim as `selectable`, and the difference is the whole
   * reason the field exists. `selectable` carries two states Forge keeps apart
   * and the wire used to flatten here:
   *
   *   - **an offer** — `setSelectables(cards, min, max)`, published by exactly
   *     two inputs in all of Forge, both of them selection inputs
   *     (`InputSelectEntitiesFromList.java:57`, `InputSelectTargets.java:68`).
   *     *"I am asking, and a click on one of these is the answer."*
   *   - **actionable** — `setWeaklySelectable`, published at priority, during a
   *     mana payment, and while declaring attackers or blockers
   *     (`PlayerControllerHuman.pushActionableCards`). *"You COULD do something
   *     with this."* On your own turn that is most of your own permanents.
   *
   * The board must not reason about Forge's inputs, so it is told which of the
   * two is live rather than inferring it from set membership. **Absent means no
   * selection is open** — the safe default, and the state every fixture and
   * `live/parity.test.ts` render in.
   *
   * What it is FOR: a card Forge is asking about is Forge's, so the arrangement
   * stands down on it (`CardOnBoard`). Merely actionable is not asking, and
   * gating the arrangement on that killed free placement for most of a game —
   * which is what `e2e/table-fit.spec.ts` red on, correctly.
   */
  selectionOpen?: boolean;
  /**
   * This seat is declaring attackers, so its own CREATURES belong to the
   * interaction lane's attack gesture and the arrangement stands down on them.
   *
   * This exists because `selectionOpen` does NOT cover it and cannot be made to.
   * Forge publishes an open selection from exactly two inputs, both of them
   * selection inputs; `InputAttack` publishes none — it calls `updateButtons`
   * and, on stop, `clearActionableCards` (`InputAttack.java:87-101`), so its
   * creatures arrive as Forge's ACTIONABLE set with no selection open. Without
   * this field they would be `draggable`, and the interaction lane's pointer
   * layer stands down on any natively-draggable element — so arranging would
   * shadow attacking for the whole step.
   *
   * Only the viewer's own creatures stand down (by the card's own type line, not
   * by which lane the player has dragged it into): lands and everything else
   * stay arrangeable, because no gesture of the other lane starts on them here.
   *
   * **Absent means not declaring attackers** — the safe default, and the state
   * every fixture renders in. The fact itself is structured state, not prose:
   * phase `COMBAT_DECLARE_ATTACKERS` and this seat is the active player.
   */
  declaringAttackers?: boolean;
  /**
   * A QUESTION is on screen — one of Forge's fifteen asks, or the mana-payment
   * window. Items 7 and 13: *"the stack should allow to be bigger unless there is
   * a decision waiting"*.
   *
   * It is not `selectionOpen`, and the difference is why this field exists.
   * `selectionOpen` is about the CARDS Forge offered; this is about a PANEL
   * standing in front of the board, in the column the stack takes the top of
   * (`--live-col-x`, `live/live.css`). The stack is roomy when nothing is in
   * front of it and compact when something is, because the alternative is a
   * bigger stack overlapping the question that displaced it.
   *
   * **Absent means no question** — the safe default, the state every fixture and
   * `live/parity.test.ts` render in, and the one that gives the stack its room.
   * `LiveBoard` is the one place both facts are readable off the same handle, so
   * it is where this is filled in, exactly as `declaringAttackers` is.
   */
  questionOpen?: boolean;
  /**
   * Item 16 — *"things like morbid should be visible when they are active…
   * the orange glow from Hearthstone."* The one half of that request the wire
   * actually supports: Forge's ACTIONABLE set (`setWeaklySelectable`), and
   * ONLY while no real selection is open — `LiveBoard.tsx` clears this the
   * moment `selectionOpen` is true, so it never claims the same cards
   * `selectable` already rings when Forge is asking a specific question.
   * *"You could do something with this"* is a different, weaker claim than
   * *"answer with one of these"*, and `card.css` draws the two as different
   * channels (a ring, and a blur) so a card carrying both is read as both.
   *
   * **Absent means no glow anywhere** — the safe default, and the state every
   * fixture and `live/parity.test.ts` render in.
   */
  actionable?: ReadonlySet<number>;
  /**
   * Item 17.2 — *"when playing a card, it should get put in the 'decision
   * area' and the arrow should draw from there."* The id of the hand card
   * this seat clicked to cast, while Forge is asking for its target
   * (`LiveMatch.lastSelectedCard`, scoped to a real open selection and to the
   * viewer's own hand — an activated ability from a permanent already on the
   * battlefield stays put, because it was never "played").
   *
   * `Board` draws that ONE card in `.staging` instead of its hand slot — never
   * both, so `data-card-id` stays unique across the board — and
   * `gestures/install.ts`'s `clickOrigin` finds it there without either file
   * knowing the other exists: it already walks the whole canvas for
   * `[data-board-card="<id>"]`.
   *
   * **Absent means nothing is staged** — the safe default, and the state every
   * fixture renders in.
   */
  stagedCardId?: number;
  /** A card was clicked. Only ever called for an id in `selectable`. */
  onSelectCard(cardId: number): void;
  onSelectPlayer(playerId: number): void;
}

/** Which side of the table a zone is on. The stack belongs to neither. */
type ZoneOwner = 'you' | 'them' | 'table';

/* ── the battlefield's rows ───────────────────────────────────────────── */

/**
 * Item 11. *"i said this should be an alternate ui and the real ui should
 * just be a single board, no seperators."* `single` — one undivided
 * battlefield, cards in arrival/placement order — is the DEFAULT; the four
 * type-separated lanes below survive as the `type-separated` alternate,
 * behind the settings panel's own choice. Nothing about wave 24's placement
 * model changes either way: a drop on a card's top or bottom third still
 * stacks it, the middle still reorders, a new permanent still joins the end —
 * of its ROW in the alternate, of the one lane in the default.
 */
export type BoardLayout = 'single' | 'type-separated';

/** The type-separated alternate's rows, top to bottom. Every battlefield draws all four. */
const BOARD_ROWS = ['lands', 'artifacts', 'creatures', 'other'] as const;
/**
 * The single-layout default's two tiers (wave 32 Q4a): the BACK row is lands and
 * the FRONT row is everything else, each filled left to right. Where a permanent
 * goes by default — a player may put any card in either row (Q4b).
 */
const SINGLE_ROWS = ['front', 'back'] as const;
type BoardRow = (typeof BOARD_ROWS)[number] | (typeof SINGLE_ROWS)[number];

/** Which rows a layout draws, and in what order `--cols` sums them. */
function rowsForLayout(layout: BoardLayout): readonly BoardRow[] {
  return layout === 'single' ? SINGLE_ROWS : BOARD_ROWS;
}

const ROW_LABEL: Readonly<Record<BoardRow, string>> = {
  lands: 'Lands',
  artifacts: 'Artifacts',
  creatures: 'Creatures',
  other: 'Other',
  front: '',
  back: '',
};

/** A fresh, empty set of piles per row — one place that names every `BoardRow`. */
function emptyRows<T>(): Record<BoardRow, T[]> {
  return {
    lands: [],
    artifacts: [],
    creatures: [],
    other: [],
    front: [],
    back: [],
  };
}

/**
 * A permanent's TYPE, off its own type line. This is a fact about the card —
 * used by the type-separated alternate to bucket it, and by the attack-declare
 * gesture (`CardOnBoard`) to know which cards are creatures — and it is read
 * the same way whatever the board's layout is: the single layout not drawing
 * lanes does not mean Forge's own rules stop caring what a card is.
 *
 * Read off the types, never the subtypes — `Artifact — Equipment` is an
 * artifact and nothing here should care that "Equipment" is a word. An overlap
 * resolves to what the card is USED as, which is why the order below is land,
 * then creature, then artifact: an artifact land is tapped for mana and an
 * artifact creature attacks.
 */
function permanentType(card: BoardCard): (typeof BOARD_ROWS)[number] {
  const types = card.card.typeLine.split('—')[0] ?? '';
  if (/\bLand\b/i.test(types)) return 'lands';
  if (/\bCreature\b/i.test(types)) return 'creatures';
  if (/\bArtifact\b/i.test(types)) return 'artifacts';
  return 'other';
}

/**
 * Which row a permanent draws in, for the layout actually on screen: its type
 * in the alternate, the one lane in the default. Only the default's grouping
 * is new here — the alternate is `permanentType`, unchanged.
 */
function visualRow(card: BoardCard, layout: BoardLayout): BoardRow {
  if (layout === 'single') return permanentType(card) === 'lands' ? 'back' : 'front';
  return permanentType(card);
}

/**
 * A pile: cards drawn as one, BOTTOM FIRST. A lone card is a pile of one, and
 * that is the overwhelming case — a battlefield with nothing stacked and nothing
 * attached draws exactly the markup it drew before piles existed.
 */
type Pile = readonly BoardCard[];

/**
 * One battlefield, in rows of piles. Always every `BoardRow` key, whether or
 * not the layout on screen draws it — `rowsForLayout` says which ones a given
 * render actually uses, and the rest sit empty.
 */
type Grouped = Readonly<Record<BoardRow, readonly Pile[]>>;

/**
 * A slot of one seat the player may arrange: one of the battlefield's four
 * type rows, the single layout's one lane, or their own hand. The hand's slot
 * holds piles of ONE — a hand is a row of cards you hold and nothing in it
 * stacks — which is what lets it share the store, the gesture and the reset
 * with the battlefield instead of inventing a second of each.
 */
type ArrangeSlot = BoardRow | 'hand';
/**
 * The player's own arrangement, as PILES of card ids per `<playerId>:<slot>`. A
 * slot the store does not name is drawn in the view's order, each card on its
 * own; a slot it names is drawn in the player's piles, and then anything the
 * store has never heard of, in the view's order.
 */
type Arrangement = Readonly<Record<string, readonly (readonly number[])[]>>;

const NO_ARRANGEMENT: Arrangement = {};
const slotKey = (playerId: number, slot: ArrangeSlot): string => `${playerId}:${slot}`;

/** How many cards a row holds, across all its piles. */
const cardsIn = (piles: readonly Pile[]): number => piles.reduce((n, p) => n + p.length, 0);

/**
 * How many COLUMNS a whole battlefield draws — every pile in every lane the
 * layout on screen draws (all four in the alternate, the one lane by default).
 *
 * `board.css` sizes the zone from this (`--cols`) because nothing in CSS can
 * count across lanes: `:has(> li:nth-child(n))` counts inside ONE list, and a
 * lane is a size container whose contents contribute nothing to its box.
 */
const cols = (rows: Grouped, layout: BoardLayout): number =>
  layout === 'single'
    ? Math.max(rows.front.length, rows.back.length)
    : rowsForLayout(layout).reduce((n, row) => n + rows[row].length, 0);

/**
 * Every match's arrangement, in the browser and nowhere else — not on the
 * wire, not in the view, not in React state, because a resync may remount the
 * board and React state would go with it. Keyed by the match so two matches in
 * one session do not inherit each other's tidying.
 */
const ARRANGED = new Map<string, Arrangement>();

/** Which match a view is: its title and its seats. */
function matchKey(view: BoardView): string {
  return `${view.title}|${view.players.map((p) => p.id).join(',')}`;
}

/** Forget every match's arrangement. For a test that wants the default grouping. */
export function forgetArrangements(): void {
  ARRANGED.clear();
}

/**
 * A battlefield's rows: what the player arranged first, then everything else
 * in the row `visualRow` puts it in for this layout — and Forge's attachments
 * folded in on top of both.
 *
 * Every card appears exactly once whatever the store says — an id the store
 * lists twice, or lists for a card that has left the battlefield, cannot
 * duplicate a card or lose one. `data-card-id` is unique across the board and
 * three other lanes depend on that.
 */
function group(cards: readonly BoardCard[], playerId: number, arranged: Arrangement, layout: BoardLayout): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: Record<BoardRow, BoardCard[][]> = emptyRows();
  const placed = new Set<number>();
  for (const row of rowsForLayout(layout)) {
    for (const pile of arranged[slotKey(playerId, row)] ?? []) {
      const members: BoardCard[] = [];
      for (const id of pile) {
        const card = byId.get(id);
        if (card === undefined || placed.has(id)) continue;
        placed.add(id);
        members.push(card);
      }
      if (members.length > 0) rows[row].push(members);
    }
  }
  for (const card of cards) {
    if (!placed.has(card.id)) rows[visualRow(card, layout)].push([card]);
  }
  return withAttachments(rows, cards, layout);
}

/**
 * Forge's attachments, drawn as one stack with what they are attached to — and
 * drawn that way whatever the player arranged, because this is the engine's
 * truth about the board rather than the player's opinion about it (#11).
 *
 * The relation is read from the HOST's `AttachedCards`, never from the
 * attachment's `EntityAttachedTo`: that one is a bare int that may name a card
 * or a player and the two id spaces overlap (`adapter.ts`'s header).
 *
 * An attachment joins its host's pile wherever the player has put that host, so
 * rearranging cannot separate an equipped creature from its gear; only cards on
 * THIS battlefield are folded in, so an aura you control on their creature stays
 * a card on your own side, which is where Forge lists it.
 *
 * With nothing attached this returns the rows it was given, unchanged — the
 * common case costs one map and no allocation.
 */
function withAttachments(
  rows: Record<BoardRow, BoardCard[][]>,
  cards: readonly BoardCard[],
  layout: BoardLayout,
): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  /** attachment id → the host that claims it. First claim wins. */
  const hostOf = new Map<number, number>();
  for (const card of cards) {
    for (const attached of card.attachedCardIds ?? []) {
      if (attached === card.id || !byId.has(attached) || hostOf.has(attached)) continue;
      hostOf.set(attached, card.id);
    }
  }
  if (hostOf.size === 0) return rows;

  /** The bottom of a chain (equipment on a creature, an aura on that equipment). */
  const rootHost = (id: number): number => {
    const seen = new Set<number>([id]);
    let at = id;
    for (;;) {
      const next = hostOf.get(at);
      if (next === undefined || seen.has(next)) return at;
      seen.add(next);
      at = next;
    }
  };

  const out: Record<BoardRow, BoardCard[][]> = emptyRows();
  /** Which pile array a host ended up in, so its attachments can be spliced into it. */
  const home = new Map<number, BoardCard[]>();
  for (const row of rowsForLayout(layout)) {
    for (const pile of rows[row]) {
      const kept = pile.filter((c) => rootHost(c.id) === c.id);
      if (kept.length === 0) continue;
      out[row].push(kept);
      for (const c of kept) home.set(c.id, kept);
    }
  }
  for (const card of cards) {
    if (rootHost(card.id) === card.id) continue;
    const pile = home.get(rootHost(card.id));
    // A host that is itself an attachment of an attachment in a cycle has no
    // home; its gear is still drawn, on its own, rather than lost.
    if (pile === undefined) {
      out[visualRow(card, layout)].push([card]);
      continue;
    }
    const at = pile.findIndex((c) => c.id === hostOf.get(card.id));
    pile.splice(at === -1 ? pile.length : at + 1, 0, card);
  }
  return out;
}

/**
 * Where a drop landed, and so what the player meant by it.
 *
 * The SLOT's own box — a battlefield row's, or the hand's list — is `end`: "at
 * the end of this slot, on its own". A CARD is three targets on a battlefield,
 * because the operator asked for two different things at once — *"put cards
 * wherever they want"* and *"snap above/below each other in any order"*:
 *
 *   - its top third: stack ON TOP of that card;
 *   - its bottom third: stack UNDERNEATH it;
 *   - its middle: the old behaviour, in front of that card's pile.
 *
 * In a HAND a card is one target, `before` — nothing stacks in a hand, so the
 * thirds are not read there at all.
 */
type DropTarget = { kind: 'end' } | { kind: 'before'; id: number } | { kind: 'stack'; id: number; onTop: boolean };

/** A box in viewport pixels — what `getBoundingClientRect` gives, minus the methods. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * A slot the dragged card may land in, as the geometry the snap reads: the slot's
 * own box, and the box of the BASE card of each pile in it, in drawing order. An
 * empty slot has no piles and is still a slot — that is the point of it.
 */
export interface SlotGeometry {
  readonly slot: ArrangeSlot;
  readonly box: Box;
  readonly piles: readonly { readonly id: number; readonly box: Box }[];
}

/** What the pointer is snapped to: where the card will land, and the bar that says so. */
export interface Snap {
  readonly slot: ArrangeSlot;
  readonly target: DropTarget;
  /**
   * The indicator: `before` a card, `end` of a slot, or a `stack` on the top or
   * bottom of one. Attached to a card (`card`, the pile base it is drawn on) or,
   * for an empty slot, to the slot alone.
   */
  readonly kind: 'before' | 'end' | 'stack-top' | 'stack-bottom';
  readonly card: number | null;
  readonly bar: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** How far a point is from a box: nought inside it, the straight line to the nearest edge outside. */
function distanceTo(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

const BAR = 3;
/** How far from every slot a pointer may be and still snap. Past it the drop is nowhere, and does nothing. */
const SNAP_RADIUS = 80;

/**
 * The slot, and the place in it, that a pointer at `(x, y)` snaps to (wave 32 Q4b:
 * *"i should have complete freedom about what card slot i can drag cards to"*).
 *
 * **Nearest, not containing.** The slot is the one whose box the pointer is in or,
 * failing that, nearest to — so a card let go in the gap between two rows, or
 * beside a lane, still lands somewhere sensible instead of nowhere — but only
 * within `SNAP_RADIUS` of one: a card let go over the opponent's side is nowhere. Empty slots
 * count: with no piles in it a slot snaps to `end`, which is how a card is put in
 * an empty row.
 *
 * Within the slot it is the nearest pile. Over a pile's own box a battlefield card
 * reads the thirds it always did — the top third stacks on it, the bottom third
 * stacks under it — and the middle band splits at the centre into "in front of
 * this pile" and "after it". A hand does not stack (its slot is `hand`): it is only
 * ever before or after. "After" the last pile is the slot's `end`; after any other
 * it is in front of the next one.
 *
 * Pure, and in pixels: `Board.test.ts` drives it with boxes, since jsdom lays
 * nothing out.
 */
export function snapTo(slots: readonly SlotGeometry[], x: number, y: number): Snap | null {
  let best: SlotGeometry | null = null;
  let bestDistance = Infinity;
  for (const slot of slots) {
    const d = distanceTo(slot.box, x, y);
    if (d < bestDistance) {
      best = slot;
      bestDistance = d;
    }
  }
  if (best === null || bestDistance > SNAP_RADIUS) return null;
  const { slot, box, piles } = best;
  const stacking = slot !== 'hand';
  if (piles.length === 0) {
    const height = Math.min(box.bottom - box.top, 96);
    return {
      slot,
      target: { kind: 'end' },
      kind: 'end',
      card: null,
      bar: {
        left: box.left + 4,
        top: (box.top + box.bottom - height) / 2,
        width: BAR,
        height,
      },
    };
  }
  let at = 0;
  let nearest = Infinity;
  piles.forEach((pile, i) => {
    const d = distanceTo(pile.box, x, y);
    if (d < nearest) {
      at = i;
      nearest = d;
    }
  });
  const pile = piles[at]!;
  const { left, top, right, bottom } = pile.box;
  const height = bottom - top;
  const inside = nearest === 0;
  if (stacking && inside && height > 0) {
    const third = (y - top) / height;
    if (third < 1 / 3) {
      return {
        slot,
        target: { kind: 'stack', id: pile.id, onTop: true },
        kind: 'stack-top',
        card: pile.id,
        bar: { left, top: top - BAR / 2, width: right - left, height: BAR + 1 },
      };
    }
    if (third > 2 / 3) {
      return {
        slot,
        target: { kind: 'stack', id: pile.id, onTop: false },
        kind: 'stack-bottom',
        card: pile.id,
        bar: {
          left,
          top: bottom - BAR / 2 - 1,
          width: right - left,
          height: BAR + 1,
        },
      };
    }
  }
  if (x < (left + right) / 2) {
    return {
      slot,
      target: { kind: 'before', id: pile.id },
      kind: 'before',
      card: pile.id,
      bar: { left: left - BAR - 1, top, width: BAR, height },
    };
  }
  const next = piles[at + 1];
  return {
    slot,
    target: next === undefined ? { kind: 'end' } : { kind: 'before', id: next.id },
    kind: next === undefined ? 'end' : 'before',
    card: next === undefined ? pile.id : next.id,
    bar: { left: right + 1, top, width: BAR, height },
  };
}

/**
 * The arrangement after a drag: `cardId` lands in `row`, at `target`.
 *
 * Every row the ACTIVE LAYOUT draws is written out, not just the two the card
 * moved between: what the player is looking at becomes what is stored, so the
 * next permanent to arrive joins the end of its row instead of landing in the
 * middle of an order they arranged. Forge's attachments are written out with
 * it and re-applied on the next render, so an equip stack survives every one
 * of these moves. The OTHER layout's rows are left untouched in the store —
 * rearranging the single lane does not disturb the type-separated rows a
 * player set up earlier, and switching layouts does not throw either away.
 */
function withMove(
  rows: Grouped,
  playerId: number,
  arranged: Arrangement,
  cardId: number,
  row: BoardRow,
  target: DropTarget,
  layout: BoardLayout,
): Arrangement {
  const active = rowsForLayout(layout);
  const piles: Record<BoardRow, number[][]> = emptyRows();
  for (const r of active) {
    piles[r] = rows[r].map((p) => p.map((c) => c.id).filter((id) => id !== cardId)).filter((p) => p.length > 0);
  }
  const into = piles[row];
  if (target.kind === 'end') {
    into.push([cardId]);
  } else {
    const index = into.findIndex((p) => p.includes(target.id));
    if (index === -1) into.push([cardId]);
    else if (target.kind === 'before') into.splice(index, 0, [cardId]);
    else {
      const pile = into[index]!;
      const at = pile.indexOf(target.id);
      pile.splice(target.onTop ? at + 1 : at, 0, cardId);
    }
  }
  const next: Record<string, readonly (readonly number[])[]> = { ...arranged };
  for (const r of active) next[slotKey(playerId, r)] = piles[r];
  return next;
}

/**
 * The viewer's own hand, in the order they arranged it: what the store names
 * first, then every card it has never heard of, in the view's order.
 *
 * A card the store names that is no longer in the hand is ignored and a card
 * drawn while an arrangement stands joins the end of it — the same contract a
 * battlefield row has, and for the same reason: the store holds ids, so a
 * resync that rebuilds every object redraws the same hand.
 */
function handOrder(cards: readonly BoardCard[], playerId: number, arranged: Arrangement): readonly BoardCard[] {
  const named = arranged[slotKey(playerId, 'hand')];
  if (named === undefined) return cards;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out: BoardCard[] = [];
  const placed = new Set<number>();
  for (const pile of named) {
    for (const id of pile) {
      const card = byId.get(id);
      if (card === undefined || placed.has(id)) continue;
      placed.add(id);
      out.push(card);
    }
  }
  for (const card of cards) if (!placed.has(card.id)) out.push(card);
  return out;
}

/**
 * The hand after a drag: `cardId` lands in front of `target`, or at the end.
 *
 * The whole hand is written out, not just the card that moved — what the player
 * is looking at becomes what is stored, so the next card drawn joins the end
 * rather than the middle of an order they chose. Each card is its own pile of
 * one: a hand does not stack.
 */
function withHandMove(
  ordered: readonly BoardCard[],
  playerId: number,
  arranged: Arrangement,
  cardId: number,
  target: DropTarget,
): Arrangement {
  const ids = ordered.map((c) => c.id).filter((id) => id !== cardId);
  const at = target.kind === 'end' ? -1 : ids.indexOf(target.id);
  if (at === -1) ids.push(cardId);
  else ids.splice(at, 0, cardId);
  return { ...arranged, [slotKey(playerId, 'hand')]: ids.map((id) => [id]) };
}

/**
 * The drag, as the markup sees it: a marker, present only on the viewer's own
 * battlefield and their own hand. Every other zone gets `undefined` and renders
 * no drag affordance and no slot box.
 *
 * It carries nothing because nothing in the markup runs the drag any more: the
 * pointer events are `Board`'s own, on `window` (`useArrangeDrag`), and the markup
 * only says WHICH cards are pick-up-able (`data-arrange-card`) and which boxes are
 * slots (`data-arrange-slot`).
 */
interface Arranging {
  readonly enabled: true;
}

const ARRANGING: Arranging = { enabled: true };

/**
 * A stack item's rules text, with its `{…}` symbols drawn as pips.
 *
 * This used to rewrite `{T}` to the literal word `TAP`, because the tap symbol
 * was a mark we had decided not to reproduce. **D20 (2026-09-27) settled that
 * the other way** — the operator: *"naw we're not drawing our own"* — and the
 * symbol now ships from the Mana pack, so `ManaPip` knows `T` and `CardTile`
 * already draws `ms-tap` in a card's own rules text. The word was the last place
 * on the board that still spelled it out.
 *
 * A token the fonts have no glyph for still renders, as itself in a plain
 * capsule; that is `ManaPip`'s contract and not this function's business.
 */
function RulesText({ text }: { text: string }) {
  const pieces = text.split(/(\{[^}]{1,5}\})/g).filter((p) => p !== '');
  return (
    <>
      {pieces.map((piece, i) => {
        const symbol = /^\{([^}]{1,5})\}$/.exec(piece);
        return symbol === null ? <span key={i}>{piece}</span> : <ManaPip key={i} token={symbol[1]!} />;
      })}
    </>
  );
}

/**
 * What a buffed or a hurt number wears BESIDES its colour.
 *
 * Settled at dispatch: *colour may never be the only signal*. So each state
 * carries a marker glyph and a weight of its own as well as an ink, and the
 * badge says the whole thing in words in its accessible name. The glyphs are
 * geometry, not typography that might not render: `▲` and `▼`.
 */
const PT_MARK: Readonly<Record<'buffed' | 'hurt', string>> = {
  buffed: '▲',
  hurt: '▼',
};

/**
 * A creature's power and toughness, as the operator asked for them (#12, #18):
 * *"3 (blue) / 1 (red)"* — the current power, and what is LEFT of the toughness.
 *
 * `adapter.ts`'s `boardPT` decides what the numbers mean; this draws them. It
 * is the board's own badge rather than the tile's `.card__stat`, because the art
 * covers the tile and the printed stat with it, and because `CardTile` is not
 * this lane's file.
 *
 * A card whose printed base our data does not know draws PLAIN — no ink, no
 * marker — and never claims a buff it cannot know about.
 */
function PowerToughness({ entry }: { entry: BoardCard }) {
  const pt = boardPT(entry);
  /*
   * No P/T and damage marked anyway — a planeswalker, a damaged non-creature,
   * or a creature whose printed numbers our data cannot read. Wave 28 §A.15:
   * *"Damage is red on the P/T badge, which `boardPT` already half does. Finish
   * it rather than writing `3 damage` beside it."* This is the other half of
   * finishing it: the number goes in the badge's own box, in the badge's own
   * hurt ink and marker, instead of becoming the one chip that outlived the
   * chips.
   */
  if (pt === null) {
    if (entry.damage <= 0) return null;
    return (
      <span
        className="board-card__pt"
        data-pt=""
        data-damage={entry.damage}
        aria-label={`${entry.damage} damage marked`}
      >
        <span className="board-card__pt-n" data-pt-state="hurt" data-pt-of="damage">
          <span aria-hidden="true">{PT_MARK.hurt}</span>
          {entry.damage}
        </span>
      </span>
    );
  }
  const say = (what: string, value: number, state: PTState): string =>
    state === 'buffed'
      ? `${what} ${value}, up from ${what === 'power' ? pt.printed?.power : pt.printed?.toughness}`
      : state === 'hurt'
        ? `${what} ${value}, ${pt.damage > 0 && what === 'toughness' ? `${pt.damage} damage marked` : 'down'}`
        : `${what} ${value}`;
  const number = (value: number, state: PTState, which: string) => (
    <span className="board-card__pt-n" data-pt-state={state === 'plain' ? undefined : state} data-pt-of={which}>
      {state === 'plain' ? null : <span aria-hidden="true">{PT_MARK[state]}</span>}
      {value}
    </span>
  );
  return (
    <span
      className="board-card__pt"
      data-pt=""
      /* Damage, on the badge that carries it — the badge itself reads hurt, so a
         damaged creature is visible before anyone reads the two numbers. */
      data-damage={pt.damage > 0 ? pt.damage : undefined}
      aria-label={`${say('power', pt.power, pt.powerState)}, ${say('toughness', pt.toughness, pt.toughnessState)}`}
    >
      {number(pt.power, pt.powerState, 'power')}
      <span aria-hidden="true">/</span>
      {number(pt.toughness, pt.toughnessState, 'toughness')}
    </span>
  );
}

/*
 * ── a card's state is DRAWN (wave 28 §A.15) ──────────────────────────────
 *
 * The operator, 2026-09-28: *"+1/+1 looks really ugly, we need a better way to
 * show that. actually all the shitty text you have written on the card looks
 * ugly, we need to find a way to handle all of that with effects."*
 *
 * What was here was one function that turned seven states into STRINGS and
 * dropped them on a ~70px tile over real art: `tapped`, `summoning sick`,
 * `attacking`, `blocking`, `3 damage`, `token`, `1 +1/+1`. Every one of them is
 * now a treatment, and each treatment is in a DIFFERENT CHANNEL, which is the
 * constraint that made this a design problem rather than a CSS one:
 *
 * | state | channel | why not something else |
 * | --- | --- | --- |
 * | tapped, attacking | a quarter turn (`card.css`) | the convention, and Forge's own. An attacker reads as tapped because that is what the operator asked for in item 6 and because Forge taps it a moment later anyway |
 * | damage | the P/T badge's own ink (`PowerToughness`) | the number that matters is what is LEFT, and the badge already holds it |
 * | counters | a numbered badge, bottom-left | `+1/+1` is the common case and gets the compact `+3`; anything else falls back to its name |
 * | summoning sick | the card DESATURATES | a saturation channel, so it cannot be confused with any outline and says the same thing to a colour-blind viewer |
 * | blocking | a corner mark, a drawn shield | a mark, not an outline |
 * | token | a corner mark and a hatched edge (`card.css`) | ditto, and see item 14 below |
 *
 * **The three outlines already on a card are not ours to add a fourth to.** The
 * gestures lane draws a solid accent ring for "Forge is offering this"
 * (`card.css`'s `button.board-card__face`) and a dashed accent outline for "you
 * pointed at this as an attacker" (`live/gestures/gestures.css`). So nothing
 * here is an outline and nothing here is drawn in the accent: a player can tell
 * "Forge is offering this" from "this is sick" because the two are not the same
 * KIND of mark, never mind the same hue.
 *
 * **Every treatment has to read over ART, not against a flat tile.** Card art
 * renders in the deployed app; the artless screenshots are an artefact of
 * `e2e/play/browser.ts` aborting off-loopback requests. So the marks sit in
 * opaque capsules on the card's own chrome rather than relying on the tile's
 * background, and the sick treatment is a filter on the whole face, which is the
 * one treatment that cannot be lost under a picture.
 *
 * **Item 14, the token with no art, is answered here rather than in
 * `CardTile`.** `wolf-token` has no row in `art-ids.json`, so `scryfallIdFor`
 * misses and the tile falls back to its TEXT tile — a whole card, name, type and
 * rules, but no picture. Giving tokens art ids means editing
 * `apps/ui/src/draft/art-ids.json` or `packages/carddata/src/art/`, and neither
 * is this lane's file. What IS this lane's is making the artless tile read as
 * deliberate: a token wears the token mark and a hatched edge, so "this is a
 * thing the game made" is the message instead of "the art failed to load". The
 * two halves are compatible — the day a token gets an id, the art arrives under
 * the same mark.
 */

/** A state that draws as a corner mark. The rest of them draw as themselves. */
type StateMark = 'sick' | 'blocking' | 'token';

/**
 * The marks, as geometry we drew rather than a typeface that might not have the
 * character — the same reason `PT_MARK` is `▲`/`▼` and not a glyph name. 16×16,
 * currentColor, no image and nothing that could be mistaken for a WotC mark.
 */
const MARK_ART: Readonly<Record<StateMark, string>> = {
  /* A crescent: this one is asleep. */
  sick: 'M10.6 2.2a6 6 0 1 0 3.2 9.9A7 7 0 0 1 10.6 2.2Z',
  /* A shield: this one is in the way. */
  blocking: 'M8 1.6l5.4 2v4.3c0 3.2-2.3 5.6-5.4 6.5-3.1-.9-5.4-3.3-5.4-6.5V3.6Z',
  /* A four-point spark: the game made this one. */
  token: 'M8 1.2l1.7 5.1 5.1 1.7-5.1 1.7L8 14.8l-1.7-5.1L1.2 8l5.1-1.7Z',
};

const MARK_WORD: Readonly<Record<StateMark, string>> = {
  sick: 'summoning sick',
  blocking: 'blocking',
  token: 'token',
};

/**
 * The marks a card wears, in a fixed order so two cards in a row read the same
 * way. The word rides along visually hidden (`card.css`): the picture is for
 * the player and the word is for anything that cannot see it, which is the same
 * split the P/T badge makes between its marker glyph and its accessible name.
 */
function StateMarks({ entry }: { entry: BoardCard }) {
  const marks: StateMark[] = [];
  if (entry.summoningSick) marks.push('sick');
  if (entry.blocking) marks.push('blocking');
  if (entry.token) marks.push('token');
  if (marks.length === 0) return null;
  return (
    <ul className="board-card__marks" aria-label={`${entry.card.name} status`}>
      {marks.map((mark) => (
        <li key={mark} className="board-card__mark" data-mark={mark}>
          <svg className="board-card__mark-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d={MARK_ART[mark]} />
          </svg>
          <span className="board-card__mark-word">{MARK_WORD[mark]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What one counter says on a 70px card.
 *
 * The operator: *"Counters are a badge with a number, not `1 +1/+1`. `+1/+1` is
 * the common case and deserves the compact form; a named counter falls back to
 * its name."* So the two P/T counters are a signed number and everything else is
 * its count and its name, clipped by the stylesheet with the whole thing in the
 * list's accessible name.
 */
function counterFace(counter: { name: string; count: number }): string {
  if (counter.name === '+1/+1') return `+${counter.count}`;
  if (counter.name === '-1/-1') return `−${counter.count}`;
  return `${counter.count} ${counter.name}`;
}

const counterKind = (name: string): string => (name === '+1/+1' ? 'plus' : name === '-1/-1' ? 'minus' : 'named');

function Counters({ entry }: { entry: BoardCard }) {
  const counters = entry.counters.filter((c) => c.count !== 0);
  if (counters.length === 0) return null;
  return (
    <ul
      className="board-card__counters"
      aria-label={`${entry.card.name} counters: ${counters.map((c) => `${c.count} ${c.name}`).join(', ')}`}
    >
      {counters.map((c) => (
        <li key={c.name} className="board-card__counter" data-counter={counterKind(c.name)} data-count={c.count}>
          <span aria-hidden="true">{counterFace(c)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One card, and — when it is the bottom of a pile — everything stacked on it.
 *
 * The pile's own `<li>` IS the bottom card, and the cards above it are a nested
 * list inside it. That shape is load-bearing in two directions:
 *
 *   - a battlefield row still answers `:scope > ul.zone__cards > li.board-card`
 *     with one element per VISUAL column, which is what `e2e/table-fit.spec.ts`
 *     measures a card's width from and what `e2e/play.spec.ts` walks;
 *   - every card keeps its own `data-card-id` at its own depth, unique across
 *     the board, which is what the other three lanes read.
 *
 * A lone card renders exactly the markup it rendered before piles existed: no
 * wrapper, no nested list, no extra attribute. Only a pile of two or more is
 * different, and only inside its own box (`card.css` fans it within one card's
 * width — nothing about a pile changes the slot it is in).
 */
function CardOnBoard({
  entry,
  interaction,
  arranging,
  slot,
  pile,
  depth = 0,
}: {
  entry: BoardCard;
  interaction: BoardInteraction | undefined;
  arranging?: Arranging;
  /**
   * Which arrangeable slot this card is in: a battlefield row, or `hand`. Absent
   * in a graveyard, in an exile pile and on the opponent's hidden hand — the
   * zones no gesture of this lane starts in.
   */
  slot?: ArrangeSlot;
  /** The whole pile, on its bottom card. Absent for a lone card and for members. */
  pile?: Pile;
  /** 0 for the bottom of a pile, 1 for the card on it, and so on. */
  depth?: number;
}) {
  const selectable = interaction !== undefined && interaction.selectable.has(entry.id);
  /*
   * A card Forge is ASKING ABOUT belongs to Forge, and that — not "actionable" —
   * is what the arrangement stands down on.
   *
   * Why it has to stand down at all: the two gestures on this board are not
   * exclusive on their own. The interaction lane starts its targeter drag on
   * `pointerdown` over a card in `interaction.selectable`
   * (`live/gestures/install.ts`), and a `draggable="true"` element ALSO starts
   * the browser's own HTML5 drag from the same press — so one press would both
   * rearrange the board and send a `selectCard` on release.
   *
   * Why the condition is `selectionOpen && selectable` and not `selectable`:
   * `selectable` also carries Forge's ACTIONABLE set (`setWeaklySelectable`),
   * which on your own turn is most of your own lands and creatures. Gating on
   * that made the board unarrangeable for most of a game — the opposite of
   * *"i dont want these snapping zones… put cards wherever they want"*, and
   * `e2e/table-fit.spec.ts` red on it: a permanent it dragged between rows was
   * not `draggable`, so `dragstart` never fired and the card did not move. An
   * actionable highlight is Forge saying "you could", not "I am asking".
   *
   * So: arranging is what you do with a card Forge is not asking about. Both
   * gestures keep working, and neither has to guess what the other is doing —
   * the attribute the browser reads is the same fact the pointer lane tests.
   */
  const inOpenSelection = selectable && interaction?.selectionOpen === true;
  /*
   * The other lane's gesture that starts on a card of your own: the attack
   * declaration. Forge publishes no open selection for it, so `selectionOpen`
   * cannot cover this and the fact is carried separately — see the field.
   */
  const onBattlefield = slot !== undefined && slot !== 'hand';
  const itsAttackToDeclare =
    interaction?.declaringAttackers === true && onBattlefield && permanentType(entry) === 'creatures';
  /*
   * In a HAND the arrangement stands down on more than the battlefield's rule
   * covers, and each of the three is a press another gesture already owns — the
   * header's "The hand is arranged the same way" has the argument in full:
   *
   *   - **a card Forge OFFERED**, its actionable set included, because DRAGGING A
   *     CARD OUT OF YOUR HAND IS HOW IT IS PLAYED (`e2e/play.spec.ts` drives a
   *     land and a spell that way, and the operator's *"cards are not dragable"*
   *     was that gesture broken in production). On a battlefield drag-to-play is
   *     what arranging costs; here it may not be;
   *   - **an OPEN SELECTION anywhere**, because the source-less targeter drag
   *     begins anywhere on the table;
   *   - **a declaration**, because the box-draw sweeps from anywhere.
   *
   * With those out, the only press this attribute newly claims is one on an
   * un-offered hand card at plain priority — which starts no gesture of the
   * interaction lane today either (`install.ts` returns when `match.selectables`
   * is null). So nothing that worked stops working: the hand is tidied in the
   * gaps, which is every moment the game is not asking this seat something.
   */
  const handStandsDown =
    slot === 'hand' && (selectable || interaction?.selectionOpen === true || interaction?.declaringAttackers === true);
  /**
   * Whether this card may be PICKED UP. Whether a card may be DROPPED ON is a
   * different question and needs no markup: the snap reads every pile's box in the
   * slot, pinned cards included, so a card the player cannot pick up is still a
   * place they can put one.
   */
  const draggable =
    arranging !== undefined && slot !== undefined && !inOpenSelection && !itsAttackToDeclare && !handStandsDown;
  const above = pile === undefined ? [] : pile.slice(1);

  return (
    <li
      className="board-card"
      /*
       * Forge's own `Tapped`, unchanged and still its alone. `data-attacking` is
       * beside it rather than folded into it (item 6: *"creatures should tap when
       * they are attacking"*) because the two are different facts and only the
       * DRAWING is shared — `card.css` turns a card on either, and the gestures
       * lane's `data-attack-intent` still means the third thing, "you pointed at
       * this", which is neither.
       */
      data-tapped={entry.tapped || undefined}
      data-attacking={entry.attacking || undefined}
      data-sick={entry.summoningSick || undefined}
      data-blocking={entry.blocking || undefined}
      data-token={entry.token || undefined}
      data-board-card={entry.id}
      data-card-id={entry.id}
      data-selectable={selectable || undefined}
      /* Item 16 — see `BoardInteraction.actionable`'s own note. */
      data-can-act={(interaction?.actionable?.has(entry.id) ?? false) || undefined}
      /* Forge says this card is attached to something: not the player's doing. */
      data-attached={(entry.attachedToId ?? null) !== null || undefined}
      data-pile-size={above.length > 0 ? pile!.length : undefined}
      data-pile-depth={depth > 0 ? depth : undefined}
      /*
       * `draggable="true"` is kept as the SEAM, not as the mechanism: the gestures
       * layer stands down on a natively-draggable element
       * (`live/gestures/install.ts: nativelyDraggable`), and that is exactly the
       * set of presses this card owns. The BROWSER's own drag never runs — the
       * press is cancelled by `useArrangeDrag` and `dragstart` is cancelled here as
       * a backstop — because the drag is ours (wave 32 Q4b), with our own ghost.
       * `data-arrange-card` names the slot the card is in and is what the pointer
       * handler looks for.
       */
      draggable={draggable || undefined}
      data-arrange-card={draggable ? slot : undefined}
      onDragStart={draggable ? (e) => e.preventDefault() : undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="board-card__face"
          aria-label={`Select ${entry.card.name}${entry.tapped ? ', tapped' : ''}`}
          onClick={() => interaction.onSelectCard(entry.id)}
        >
          <CardTile card={entry.card} />
        </button>
      ) : (
        <div className="board-card__face">
          <CardTile card={entry.card} />
        </div>
      )}
      {onBattlefield && <PowerToughness entry={entry} />}
      {onBattlefield && <StateMarks entry={entry} />}
      {onBattlefield && <Counters entry={entry} />}
      {above.length > 0 && (
        <ul className="board-card__pile" aria-label={`Stacked on ${entry.card.name}`}>
          {above.map((c, i) => (
            <CardOnBoard
              key={c.id}
              entry={c}
              interaction={interaction}
              arranging={arranging}
              slot={slot}
              depth={i + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * One zone's slot. The list is always rendered, empty or not: its box is the
 * zone's box, and an empty zone that drew something else instead (a word, a
 * shorter element, nothing at all) would be a different size from a full one.
 */
function Zone({
  owner,
  ownerSide,
  zone,
  label,
  cards,
  interaction,
  arranging,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  label: string;
  cards: readonly BoardCard[];
  interaction: BoardInteraction | undefined;
  /**
   * Present only on the viewer's own HAND — the one `Zone` whose order is the
   * player's. A graveyard and an exile pile are Forge's own order and get
   * `undefined`, so no card in them is draggable and the list takes no drop.
   * `cards` arrives already in the player's order (`handOrder`).
   */
  arranging?: Arranging;
}) {
  return (
    <ZoneShell owner={owner} ownerSide={ownerSide} zone={zone} label={label} count={cards.length}>
      <ul
        className="zone__cards"
        /*
         * The count `board.css` sizes this list from — see `Battlefield` below.
         * A HAND only: a graveyard and an exile are piles, sized by their own box
         * and not by a row count, so writing it there would be dead markup.
         */
        style={zone === 'hand' ? ({ '--cols': cards.length } as CSSProperties) : undefined}
        data-arrange-slot={arranging === undefined ? undefined : 'hand'}
      >
        {cards.map((c) => (
          <CardOnBoard
            key={c.id}
            entry={c}
            interaction={interaction}
            arranging={arranging}
            slot={arranging === undefined ? undefined : 'hand'}
          />
        ))}
      </ul>
    </ZoneShell>
  );
}

/**
 * A zone's slot. **No panel and no caption** — wave 26 §A.3.
 *
 * The operator, 2026-09-27, asked directly: *"yes drop the zone labels too"*, and
 * the panel chrome went with them (`docs/planning/board-layout-2026-09-27.md`).
 * A zone is identified by WHERE IT IS and what is in it — the hand is the row
 * nearest you, the graveyard is the pile under your portrait — which is how a
 * table works and why it needs no captions. So this draws no `<h4>`, no border
 * and no fill; the fill each row still has is its SURFACE (a battlefield is
 * sunken, a hand is raised), which is a different instruction of the operator's
 * and is `board.css`'s.
 *
 * Two things survive the deletion and neither is cosmetic:
 *
 *   - **the accessible name.** Dropping a visible caption is not dropping the
 *     zone from the accessibility tree, so the `<section>` keeps
 *     `aria-label="<owner> <label>"` and `label` is still a required prop for
 *     exactly that reason;
 *   - **`data-zone`, `data-owner` and `data-count`.** `e2e/play.spec.ts`,
 *     `e2e/table-fit.spec.ts` and `e2e/arrow.spec.ts` locate every card through
 *     `data-zone`, and `data-count` is how a spec reads a zone's size now that
 *     no element writes it out.
 */
function ZoneShell({
  owner,
  ownerSide,
  zone,
  label,
  count,
  children,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  /** Not drawn — the zone's accessible name. See above. */
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className={`zone zone--${zone}`}
      aria-label={`${owner} ${label}`}
      data-zone={zone}
      data-owner={ownerSide}
      data-count={count}
    >
      {children}
    </section>
  );
}

/**
 * A battlefield. By DEFAULT (`layout === 'single'`, item 11) it is one
 * undivided lane: every permanent in placement order, no type sections, no
 * lane labels. As the ALTERNATE (`type-separated`) it is four labelled rows
 * in the same fixed slot, all four always drawn — wave 26's markup, unchanged,
 * for the tests and the operator's own choice that still want it.
 *
 * Both are the default ordering plus the player's own arrangement on top of
 * it; `arranging` is present only on the viewer's own side.
 */
function Battlefield({
  player,
  ownerSide,
  interaction,
  arranging,
  arranged,
  layout,
}: {
  player: BoardPlayer;
  ownerSide: ZoneOwner;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
  layout: BoardLayout;
}) {
  const rows = group(player.battlefield, player.id, arranged, layout);

  if (layout === 'single') {
    /*
     * Two tiers, back (lands) and front (everything else), each its own list and
     * each a slot a card may be put in even while it is empty. The viewer's front
     * tier is the upper one — towards the centre line — and the opponent's is the
     * mirror: their back row is on top and their front row nearest the middle.
     * `--cols` is the busier tier's, so a land under a creature is the same width.
     */
    const tiers: readonly ('front' | 'back')[] = ownerSide === 'them' ? ['back', 'front'] : ['front', 'back'];
    return (
      <ZoneShell
        owner={player.name}
        ownerSide={ownerSide}
        zone="battlefield"
        label="Battlefield"
        count={player.battlefield.length}
      >
        {/*
         * No row wrapper and no `data-board-row` anywhere — that absence is what
         * `Board.test.ts` reads as "the default has no type sections". A tier is
         * not a type section: it is `data-arrange-slot`, and where a card goes by
         * default rather than a bucket it is confined to.
         */}
        <div className="zone__tiers" data-tiers={ownerSide === 'them' ? 'mirrored' : undefined}>
          {tiers.map((tier) => (
            <ul
              key={tier}
              className="zone__cards"
              data-tier={tier}
              style={{ '--cols': cols(rows, layout) } as CSSProperties}
              data-arrange-slot={arranging === undefined ? undefined : tier}
            >
              {rows[tier].map((pile) => (
                <CardOnBoard
                  key={pile[0]!.id}
                  entry={pile[0]!}
                  interaction={interaction}
                  arranging={arranging}
                  slot={tier}
                  pile={pile}
                />
              ))}
            </ul>
          ))}
        </div>
      </ZoneShell>
    );
  }

  return (
    <ZoneShell
      owner={player.name}
      ownerSide={ownerSide}
      zone="battlefield"
      label="Battlefield"
      count={player.battlefield.length}
    >
      {/*
       * `--cols` is the count `board.css` cannot take for itself: a lane is
       * `contain: size`, so nothing inside it contributes to its width, and the
       * zone-wide row count has to be summed across the four lanes, which no
       * selector can do. The stylesheet turns these two numbers into the row
       * count and each lane's share — see `.zone__rows` there.
       */}
      <ul className="zone__rows" style={{ '--cols': cols(rows, layout) } as CSSProperties}>
        {BOARD_ROWS.map((row) => (
          <li
            key={row}
            className="zone__row"
            data-board-row={row}
            data-empty={rows[row].length === 0 || undefined}
            /*
             * A lane's share of the battlefield's width is how many COLUMNS it
             * draws, and that is `ceil(piles / rows)` — the stylesheet divides,
             * because only it knows how many rows the zone settled on. A stack
             * takes one card's width, which is the whole point of stacking, so
             * this is the PILE count and not the card count. A lane holding
             * nothing takes its label's width and the stylesheet decides that,
             * not this number.
             */
            style={{ '--cols': rows[row].length } as CSSProperties}
            data-arrange-slot={arranging === undefined ? undefined : row}
          >
            <h5 className="zone__row-head">
              {ROW_LABEL[row]} <span className="zone__count">{cardsIn(rows[row])}</span>
            </h5>
            <ul className="zone__cards">
              {rows[row].map((pile) => (
                <CardOnBoard
                  key={pile[0]!.id}
                  entry={pile[0]!}
                  interaction={interaction}
                  arranging={arranging}
                  slot={row}
                  pile={pile}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </ZoneShell>
  );
}

/**
 * Someone else's hand: a count, drawn as that many backs. There is no card
 * here to draw a face from — the adapter never maps these cards. The strip is
 * always in the markup so the slot is one height at nought backs and at ten.
 *
 * Item 12: *"opponents hand should show like real card backs."* A back is a
 * CARD, so it is drawn as one — a card's proportion, a card's radius, a bordered
 * field with an inset panel inside it and a mark in the middle of that panel
 * (`card.css`). What it is NOT is Magic's own back: that is WotC art and this
 * repo draws none of it (CLAUDE.md). Ours is a pattern we made, which is the
 * same trade `PlayerFace` makes against an avatar and `CardTile` makes against a
 * card frame.
 *
 * **The second half of item 12 is not in this wave.** Seeing the opponent
 * REARRANGE their hand needs the arrangement to leave the browser, and the
 * arrangement store (`ARRANGED`, above) is per-viewer by construction with no
 * wire path — it is a design question about what a rearrangement tells the table,
 * not a CSS one. It is w29's.
 */
function HiddenHand({ player }: { player: BoardPlayer }) {
  return (
    <section
      className="zone zone--hand"
      aria-label={`${player.name} Hand`}
      data-zone="hand"
      data-owner="them"
      data-count={player.handCount}
    >
      <ul className="card-backs" aria-hidden="true" style={{ '--cols': player.handCount } as CSSProperties}>
        {Array.from({ length: player.handCount }, (_, i) => (
          <li key={i} className="card-back" data-card-back="" />
        ))}
      </ul>
    </section>
  );
}

/**
 * A player, as a thing you can point at: our own drawn mark with their life on
 * it. Arena's affordance, none of its art — shapes in an inline `<svg>`, no
 * image, no asset, and no WotC mark anywhere near it.
 *
 * It is a `<button>` exactly when Forge says the player may be selected, the
 * same rule the cards follow, and it carries `data-player-face` so the
 * interaction lane can anchor an arrow on it without reading this file.
 *
 * It sits at the OUTER end of its seat's vertical bar — the top of the board
 * for the opponent, the bottom for the viewer (`board.css`) — because the
 * operator could not tell the two apart when both were in the centre band.
 *
 * The badge on the mark is the seat's one life total: `data-testid="life"` is
 * here and nowhere else, so the number a seat shows is the number the avatar
 * shows. `e2e/play.spec.ts` reads it inside `[data-testid="player"]` and
 * compares it to the view, so its text is the number and nothing else.
 */
function PlayerFace({ player, interaction }: { player: BoardPlayer; interaction: BoardInteraction | undefined }) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  /*
   * The watchparty character, when the seat has one — wave 28 item 4, the render
   * half. `avatarSquareUrl` is lane D's one accessor and it answers `null` for
   * absent, blank and over-long alike, so THIS is the whole fallback: a seat with
   * no avatar keeps the mark we draw, because a seat with no face is worse than a
   * generic face.
   *
   * Nothing populates `player.avatarId` in production yet and the field says why
   * (`adapter.ts`). This draws it; the hop that delivers it is a wave of its own.
   *
   * No host is written here. The URL comes out of `watchpartyOrigin()`, derived
   * from the page, so a local e2e stays local — the same rule the art resolver
   * follows for cards. It is only ASKED for when there is an id to resolve:
   * `watchpartyOrigin()` reads `globalThis.location`, and this component renders
   * in `live/parity.test.ts` under `react-dom/server`, where there is none.
   */
  const avatar = player.avatarId === undefined ? null : avatarSquareUrl(player.avatarId);
  const mark = (
    <>
      {avatar === null ? (
        <svg className="face__art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
          <circle className="face__plate" cx="24" cy="24" r="22.5" />
          <circle className="face__brow" cx="24" cy="18" r="7.5" />
          <path className="face__bust" d="M10.5 40.5a13.5 13.5 0 0 1 27 0Z" />
        </svg>
      ) : (
        /* `alt=""`: the seat's name is right beside it and says who this is. */
        <img className="face__art face__avatar" src={avatar} alt="" data-testid="seat-avatar" />
      )}
      <span className="face__life" data-testid="life">
        {player.life}
      </span>
    </>
  );
  return (
    <div
      className="face"
      data-player-face=""
      data-avatar={player.avatarId === undefined ? undefined : player.avatarId}
      data-player-id={player.id}
      data-viewer={player.isViewer || undefined}
      data-active={player.isActive || undefined}
      data-lost={player.hasLost || undefined}
      data-selectable={selectable || undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="face__hit"
          aria-label={`Select ${player.name}`}
          onClick={() => interaction.onSelectPlayer(player.id)}
        >
          {mark}
        </button>
      ) : (
        <div className="face__hit">{mark}</div>
      )}
      <span className="face__name">{player.name}</span>
    </div>
  );
}

/**
 * A seat's FLOATING MANA, beside its own portrait — wave 26 §A.6.
 *
 * Nothing in this UI drew the pool at all before this wave, and that was the
 * actual defect behind the operator's report: *"if i tap the lands first then add
 * mana to my pool, that should also work to pay for the spell"*. It does work —
 * Forge owns the pool and applies it before asking for the rest — so what was
 * broken was that a player could not SEE what they were holding.
 *
 * It is read off `PlayerView.Mana` by `adapter.ts` (which owns the byte→colour
 * mapping and the reason it is not the obvious one) and drawn for EVERY seat,
 * because a mana pool is public information in Magic — unlike a hand, there is
 * nothing to hide here.
 *
 * Drawn with our OWN marks: a letter and a count. Not `ManaPip` — the symbol
 * component is another lane's file this wave (§C) — and the letter is also the
 * honest fallback shape, since a pool entry is a count rather than a cost.
 * Colour is never the only signal: `data-mana` carries the letter, the letter is
 * drawn, and the whole pool is in the list's accessible name in words.
 *
 * Its track is a FIXED one (`--mana-h`, `board.css`), so mana arriving mid-turn
 * cannot move the portrait above it — the same rule every other track here
 * obeys. An empty pool draws an empty list in that same box.
 */
const MANA_WORD: Readonly<Record<PoolColor, string>> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
  C: 'colourless',
};

function ManaPool({ player }: { player: BoardPlayer }) {
  const pool = player.manaPool ?? [];
  const total = pool.reduce((n, m) => n + m.count, 0);
  const said = pool.map((m) => `${m.count} ${MANA_WORD[m.color]}`).join(', ');
  return (
    <ul
      className="seat__mana"
      data-mana-pool=""
      data-mana-total={total}
      aria-label={total === 0 ? `${player.name} mana pool` : `${player.name} mana pool: ${said}`}
    >
      {pool.map((m) => (
        <li key={m.color} className="seat__mana-pip" data-mana={m.color} data-mana-count={m.count}>
          <span className="seat__mana-letter" aria-hidden="true">
            {m.color}
          </span>
          <span className="seat__mana-n" aria-hidden="true">
            {m.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlayerArea({
  player,
  interaction,
  arranging,
  arranged,
  layout,
}: {
  player: BoardPlayer;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
  layout: BoardLayout;
}) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  const side: ZoneOwner = player.isViewer ? 'you' : 'them';
  /*
   * No visible `(you)` (wave 31 §A.1, the operator's P3): the seat's own name is
   * what the table shows. Ours from theirs still rests on the seat's end of the
   * canvas, `data-viewer` and the brighter ink — and the SECTION's accessible
   * name below still says `(you)`, because a screen reader has none of those.
   */
  const name = player.name;
  return (
    <section
      className="seat"
      data-testid="player"
      data-player-id={player.id}
      data-viewer={player.isViewer || undefined}
      data-selectable={selectable || undefined}
      aria-label={player.isViewer ? `${player.name} (you)` : player.name}
    >
      {/*
       * The seat's furniture, in the upper cell of its narrow left column: the
       * avatar with its life, the name, the mana pool, then the counts — and,
       * on the viewer's side, the one control on this board that is ours.
       *
       * Fixed grid tracks (`board.css`), with the avatar block in the seat's
       * OUTER track so the two faces stay at opposite ends of the canvas, the
       * counts in the one that has the slack, so a flag arriving mid-game cannot
       * move a face, and the pool in a named track of its own for the same
       * reason.
       *
       * The column's LOWER cell is `.seat__piles`, beside the hand — so for the
       * viewer the portrait is above and the graveyard below it, which is the
       * operator's own geometry (`board-layout-2026-09-27.md`).
       */}
      <div className="seat__side">
        <div className="seat__who" data-player-bar="">
          <div className="seat__ident">
            <PlayerFace player={player} interaction={interaction} />
            <h3 className="seat__name">
              {selectable ? (
                <button
                  type="button"
                  className="seat__select"
                  aria-label={`Select ${player.name}`}
                  onClick={() => interaction.onSelectPlayer(player.id)}
                >
                  {name}
                </button>
              ) : (
                name
              )}
            </h3>
          </div>
          <ManaPool player={player} />
          {/*
           * The counts, as MARKS rather than words (item 10): *"can we get symbols
           * to display hand/deck size instead of words?"* Two drawn symbols —
           * a fanned hand and a stacked library — each with its number beside it,
           * in a column 72px wide where `hand 7` and `library 46` were most of the
           * ink. They are ours, drawn here as geometry like the player mark and the
           * state marks: no font to miss the glyph, no WotC symbol anywhere near it.
           *
           * The test ids do not move — `hand-count` and `library-count` are read by
           * `Board.test.ts` and are the only handle anything has on these two
           * numbers — and each carries the words in its accessible name, so the
           * symbol is for the eye and the label is for everything else.
           */}
          <div className="seat__counts">
            <span className="seat__count" data-testid="hand-count" aria-label={`hand ${player.handCount}`}>
              <svg className="seat__count-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M3.4 5.6 6 13.4l3.1-1-2.6-7.8Z" />
                <path d="M7.2 4.4h3.1v9H7.2Z" />
                <path d="m11.1 4.6 2.9.9-2.2 7.6-2.4-.8Z" />
              </svg>
              <span aria-hidden="true">{player.handCount}</span>
            </span>
            <span className="seat__count" data-testid="library-count" aria-label={`library ${player.libraryCount}`}>
              <svg className="seat__count-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M2.8 11.4h10.4v1.9H2.8Z" />
                <path d="M2.8 8.1h10.4V10H2.8Z" />
                <path d="M2.8 4.8h10.4v1.9H2.8Z" />
                <path d="M2.8 2.4h10.4v1.5H2.8Z" />
              </svg>
              <span aria-hidden="true">{player.libraryCount}</span>
            </span>
            {player.hasPriority && <span className="seat__flag">priority</span>}
            {player.hasLost && <span className="seat__flag seat__flag--lost">lost</span>}
          </div>
        </div>
        {/*
         * The piles, in the REST of the seat's one left column — under the avatar and
         * the counts, with everything they leave (wave 32 Q9). The opponent's column
         * is the vertical mirror (`board.css`, `column-reverse`): exile strip,
         * graveyard, counts, avatar nearest the centre. Graveyard first: it is the
         * one that fills up, and the one that gets the space.
         */}
        <div className="seat__piles">
          <Zone
            owner={player.name}
            ownerSide={side}
            zone="graveyard"
            label="Graveyard"
            cards={player.graveyard}
            interaction={interaction}
          />
          <Zone
            owner={player.name}
            ownerSide={side}
            zone="exile"
            label="Exile"
            cards={player.exile}
            interaction={interaction}
          />
        </div>
      </div>

      <Battlefield
        player={player}
        ownerSide={side}
        interaction={interaction}
        arranging={arranging}
        arranged={arranged}
        layout={layout}
      />
      {player.hand !== null ? (
        <Zone
          owner={player.name}
          ownerSide={side}
          zone="hand"
          label="Hand"
          /*
           * The player's own order, and the view's for anyone who has not
           * moved a card — MINUS the one card staged in `.staging` right now
           * (item 17.2). It is drawn there instead, not also here: two copies
           * of one `data-card-id` would break every lane that queries it by
           * value, this file's own invariant included.
           */
          cards={handOrder(player.hand, player.id, arranged).filter((c) => c.id !== interaction?.stagedCardId)}
          interaction={interaction}
          arranging={arranging}
        />
      ) : (
        <HiddenHand player={player} />
      )}
    </section>
  );
}

/**
 * One item on the stack: its source card, drawn, beside what it is doing.
 * `sourceCard` is the adapter's own resolved face, so the art here goes
 * through the same resolver as every other card — nothing builds a URL.
 */
function StackItem({ item, interaction }: { item: StackEntry; interaction: BoardInteraction | undefined }) {
  const sourceId = item.sourceCardId;
  const selectable = interaction !== undefined && sourceId !== null && interaction.selectable.has(sourceId);
  const body = (
    <>
      {item.sourceCard !== null && (
        <span className="stack__art">
          <CardTile card={item.sourceCard} />
        </span>
      )}
      <span className="stack__what">
        <span className="stack__source">
          {item.sourceName ?? 'unknown source'}
          {item.isAbility && <span className="stack__kind"> · ability</span>}
        </span>
        {item.controllerName !== null && <span className="stack__controller">{item.controllerName}</span>}
        <span className="stack__text">
          <RulesText text={item.description} />
        </span>
      </span>
    </>
  );
  return (
    <li
      className="stack__item"
      data-stack-id={item.id}
      data-source-card={sourceId ?? undefined}
      data-selectable={selectable || undefined}
    >
      {selectable ? (
        <button
          type="button"
          className="stack__body stack__select"
          aria-label={`Select ${item.sourceName ?? 'stack item'}`}
          onClick={() => interaction.onSelectCard(sourceId)}
        >
          {body}
        </button>
      ) : (
        <span className="stack__body">{body}</span>
      )}
    </li>
  );
}

/**
 * The stack's band. Fixed height, always: the list is in the markup at zero
 * items, and items past the band's width scroll inside it. Nothing about this
 * zone's box depends on what is on the stack — that is item #2 of the
 * operator's list and it is the whole point of this component's shape.
 */
/**
 * The drag that is ours (wave 32 Q4b). The operator: *"it still has the basic
 * 'html picture drag' ghost. we should have our own proper ghost and target
 * indicator when something wants to snap to a nearby card slot,"* and *"i should
 * have complete freedom about what card slot i can drag cards to."*
 *
 * Pointer events on `window`, no HTML5 drag: so there is no browser ghost to
 * suppress, and touch works because a finger is a pointer. The sequence:
 *
 *   1. `pointerdown` on a card carrying `data-arrange-card`, **after** the gestures
 *      layer has had it. That layer claims a press by cancelling it
 *      (`install.ts: claim`) — in combat declaration and a mana payment, where a
 *      permanent's press is Forge's answer — and a press already claimed is not
 *      ours. Otherwise we cancel it ourselves, which is what keeps the browser's
 *      own drag from starting from the same press. A press that never moves stays
 *      a plain click.
 *   2. `pointermove` past `SLOP` pixels: the drag begins. The card's `<li>` is
 *      dimmed in place (`data-arrange-dragging`), a clone of it — the GHOST,
 *      `data-arrange-ghost`, stripped of every id so card ids stay unique — is
 *      drawn lifted under the pointer, and from then on every move re-snaps.
 *   3. Each move finds the nearest slot of the card's own zone and the nearest
 *      place in it (`snapTo`, which counts empty slots), and draws the INDICATOR
 *      bar there (`data-arrange-indicator`, `data-arrange-kind`) and lights the
 *      slot and card it is on (`data-arrange-target`).
 *   4. `pointerup` commits to the snap; `pointercancel` and Escape do not. The
 *      `click` that follows a real drag is swallowed once.
 *
 * Nothing is sent to Forge. Everything it draws is removed again on every exit.
 */
const SLOP = 4;

function useArrangeDrag(
  root: { readonly current: HTMLElement | null },
  enabled: boolean,
  commit: (cardId: number, slot: ArrangeSlot, target: DropTarget) => void,
): void {
  /** Always the latest `commit`: the listeners are installed once and must not go stale. */
  const latest = useRef(commit);
  latest.current = commit;

  useEffect(() => {
    const board = root.current;
    if (board === null || !enabled) return undefined;

    interface Press {
      readonly pointerId: number;
      readonly li: HTMLElement;
      readonly cardId: number;
      readonly slot: ArrangeSlot;
      readonly x: number;
      readonly y: number;
      ghost: HTMLElement | null;
      indicator: HTMLElement | null;
      snap: Snap | null;
      marked: Element[];
      grab: { x: number; y: number };
    }
    let press: Press | null = null;
    /** The one-shot that eats the click after a real drag; removed unused rather than left to eat the next one. */
    let eatClick: (() => void) | null = null;

    const boardBox = (): DOMRect => board.getBoundingClientRect();

    /** Every slot of the viewer's seat — all zones, so the snap can tell which one the pointer is really over. */
    const geometry = (): SlotGeometry[] => {
      const out: SlotGeometry[] = [];
      for (const el of board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-arrange-slot]')) {
        const named = el.getAttribute('data-arrange-slot') as ArrangeSlot;
        const list = el.matches('.zone__cards') ? el : el.querySelector<HTMLElement>(':scope > .zone__cards');
        const piles = [...(list?.querySelectorAll<HTMLElement>(':scope > li.board-card') ?? [])].map((li) => ({
          id: Number(li.dataset.cardId),
          box: li.getBoundingClientRect(),
        }));
        out.push({ slot: named, box: el.getBoundingClientRect(), piles });
      }
      return out;
    };

    const clearMarks = (p: Press): void => {
      for (const el of p.marked) el.removeAttribute('data-arrange-target');
      p.marked = [];
    };

    const draw = (p: Press, x: number, y: number): void => {
      const box = boardBox();
      if (p.ghost !== null) {
        p.ghost.style.left = `${x - box.left - p.grab.x}px`;
        p.ghost.style.top = `${y - box.top - p.grab.y}px`;
      }
      const found = snapTo(geometry(), x, y);
      /*
       * A card only ever lands in the zone it came from: over the battlefield a
       * hand card is nowhere, and so is a permanent over the hand. (Playing a card
       * out of a hand is Forge's — a card it offered is not arrangeable at all.)
       */
      const snap = found !== null && (found.slot === 'hand') === (p.slot === 'hand') ? found : null;
      p.snap = snap;
      clearMarks(p);
      if (snap === null) {
        p.indicator?.setAttribute('hidden', '');
        return;
      }
      const slotEl = [...board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-arrange-slot]')].find(
        (el) => el.getAttribute('data-arrange-slot') === snap.slot,
      );
      if (slotEl !== undefined) {
        slotEl.setAttribute('data-arrange-target', snap.kind);
        p.marked.push(slotEl);
      }
      if (snap.card !== null) {
        const cardEl = board.querySelector(`.seat[data-viewer] li.board-card[data-card-id="${snap.card}"]`);
        if (cardEl !== null) {
          cardEl.setAttribute('data-arrange-target', snap.kind);
          p.marked.push(cardEl);
        }
      }
      const bar = p.indicator;
      if (bar === null) return;
      bar.removeAttribute('hidden');
      bar.setAttribute('data-arrange-kind', snap.kind);
      bar.setAttribute('data-arrange-slot', snap.slot);
      bar.style.width = `${snap.bar.width}px`;
      bar.style.height = `${snap.bar.height}px`;
      bar.style.left = `${snap.bar.left - box.left}px`;
      bar.style.top = `${snap.bar.top - box.top}px`;
    };

    /** The press has moved far enough to be a drag: draw the ghost and the indicator. */
    const begin = (p: Press, x: number, y: number): void => {
      const at = p.li.getBoundingClientRect();
      const ghost = p.li.cloneNode(true) as HTMLElement;
      ghost.querySelector(':scope > .board-card__pile')?.remove();
      for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
        for (const attr of [
          'data-card-id',
          'data-board-card',
          'data-arrange-card',
          'data-arrange-dragging',
          'data-arrange-target',
          'draggable',
          'data-selectable',
          'data-can-act',
        ]) {
          el.removeAttribute(attr);
        }
      }
      ghost.setAttribute('data-arrange-ghost', String(p.cardId));
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.style.width = `${at.width}px`;
      ghost.style.setProperty('--card-w', `${at.width}px`);
      p.grab = { x: x - at.left, y: y - at.top };
      const indicator = document.createElement('div');
      indicator.setAttribute('data-arrange-indicator', '');
      indicator.setAttribute('aria-hidden', 'true');
      indicator.setAttribute('hidden', '');
      board.append(ghost, indicator);
      p.ghost = ghost;
      p.indicator = indicator;
      p.li.setAttribute('data-arrange-dragging', '');
      board.setAttribute('data-arrange-active', '');
      draw(p, x, y);
    };

    const end = (): void => {
      const p = press;
      press = null;
      window.removeEventListener('keydown', onKey, true);
      if (p === null) return;
      clearMarks(p);
      p.ghost?.remove();
      p.indicator?.remove();
      p.li.removeAttribute('data-arrange-dragging');
      board.removeAttribute('data-arrange-active');
    };

    const forgetClick = (): void => {
      eatClick?.();
      eatClick = null;
    };

    const onDown = (event: PointerEvent): void => {
      forgetClick();
      if (press !== null || event.button !== 0 || !event.isPrimary) return;
      // Claimed by the gestures layer: combat declaration, a payment. Not ours.
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || !board.contains(target)) return;
      const li = target.closest<HTMLElement>('li.board-card');
      const slot = li?.getAttribute('data-arrange-card');
      if (li === null || li === undefined || slot === null || slot === undefined) return;
      // Ours now: the browser's own drag must not start from this press.
      if (event.cancelable) event.preventDefault();
      press = {
        pointerId: event.pointerId,
        li,
        cardId: Number(li.dataset.cardId),
        slot: slot as ArrangeSlot,
        x: event.clientX,
        y: event.clientY,
        ghost: null,
        indicator: null,
        snap: null,
        marked: [],
        grab: { x: 0, y: 0 },
      };
      window.addEventListener('keydown', onKey, true);
    };

    const onMove = (event: PointerEvent): void => {
      const p = press;
      if (p === null || event.pointerId !== p.pointerId) return;
      if (p.ghost === null) {
        if (Math.hypot(event.clientX - p.x, event.clientY - p.y) < SLOP) return;
        begin(p, event.clientX, event.clientY);
        return;
      }
      draw(p, event.clientX, event.clientY);
    };

    const onUp = (event: PointerEvent): void => {
      const p = press;
      if (p === null || event.pointerId !== p.pointerId) return;
      const dragged = p.ghost !== null;
      if (dragged) draw(p, event.clientX, event.clientY);
      const snap = p.snap;
      end();
      if (!dragged) return;
      // The release of a real drag is not a click on what it ended over.
      const swallow = (click: Event): void => {
        click.stopPropagation();
        click.preventDefault();
        forgetClick();
      };
      window.addEventListener('click', swallow, true);
      const timer = setTimeout(forgetClick, 0);
      eatClick = () => {
        clearTimeout(timer);
        window.removeEventListener('click', swallow, true);
      };
      if (snap !== null) latest.current(p.cardId, snap.slot, snap.target);
    };

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') end();
    }

    const onCancel = (event: PointerEvent): void => {
      if (press !== null && event.pointerId === press.pointerId) end();
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      forgetClick();
      end();
    };
  }, [root, enabled]);
}

/**
 * Item 17.2 — the operator: *"when playing a card, it should get put in the
 * 'decision area' and the arrow should draw from there."*
 *
 * The SAME footprint `live/live.css`'s `.live__prompt` takes (`board.css`
 * places this one, in the same column, `--live-col-x` / `--live-col-w`) —
 * never both at once, because `LiveBoard.tsx` only sets `stagedCardId` while
 * NEITHER an ask nor a payment is showing, so one box serves both rather than
 * a third floating thing.
 *
 * Drawn through `CardOnBoard` itself, not a bespoke tile: the card Forge is
 * asking about here is exactly as selectable (or not) as it would have been
 * in the hand, and reusing it is what keeps `data-can-act`, the tapped state
 * and the selectable button all correct with no second copy of that logic.
 * No `slot` and no `arranging`, so it is never draggable here — moving it
 * back into the hand is Forge's answer to the question, not a rearrangement.
 */
function StagingArea({ card, interaction }: { card: BoardCard; interaction: BoardInteraction | undefined }) {
  return (
    <div className="staging" data-testid="staging">
      <ul className="staging__list" aria-label="Playing">
        <CardOnBoard entry={card} interaction={interaction} />
      </ul>
    </div>
  );
}

function StackView({
  stack,
  interaction,
}: {
  stack: readonly StackEntry[];
  interaction: BoardInteraction | undefined;
}) {
  return (
    <section className="stack" aria-label="Stack" data-zone="stack" data-owner="table" data-count={stack.length}>
      <h3 className="zone__head">
        Stack <span className="zone__count">{stack.length}</span>
      </h3>
      <ol className="stack__items">
        {stack.map((item) => (
          <StackItem key={item.id} item={item} interaction={interaction} />
        ))}
      </ol>
    </section>
  );
}

export function Board({
  view,
  interaction,
  boardLayout = 'single',
}: {
  view: BoardView;
  interaction?: BoardInteraction;
  /**
   * Item 11. `single` — one undivided battlefield — is the default; the
   * settings panel is the only place that reads a stored preference and
   * passes `type-separated` here. A test that wants the alternate passes it
   * explicitly, which is also how the alternate's own pinned markup keeps
   * being exercised without becoming the default.
   */
  boardLayout?: BoardLayout;
}) {
  const viewer = view.players.find((p) => p.isViewer);
  const others = view.players.filter((p) => !p.isViewer);
  /*
   * Item 17.2's staged card, found once here rather than in `PlayerArea`: it
   * can only ever be the viewer's own (`BoardInteraction.stagedCardId`'s own
   * note), and `PlayerArea` only needs to know WHICH id to leave out of the
   * hand it draws, not the card itself.
   */
  const staged =
    interaction?.stagedCardId === undefined
      ? undefined
      : (viewer?.hand?.find((c) => c.id === interaction.stagedCardId) ?? undefined);

  /*
   * The inspector, booted and nothing more: it attaches its own listeners by
   * delegation and draws into the overlay root. One mount, one dispose.
   */
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    return mountInspector(el);
  }, []);

  /*
   * The player's arrangement, out of the module store rather than React state
   * — a resync may remount this component and the arrangement must outlive
   * that. `redraw` is what a drag does: the store is the truth, so all a
   * handler has to do is change it and ask for a frame.
   */
  const key = matchKey(view);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const arranged = ARRANGED.get(key) ?? NO_ARRANGEMENT;
  /**
   * One drop, applied. Everything a drop does is here: it writes the store and asks
   * for a frame. It sends NOTHING — there is no sender in this scope, no ask, no
   * reply; a rearrange is invisible to Forge by construction.
   *
   * A card only ever lands in the zone it was picked up from: the commit checks
   * that the carried card is in that zone of the viewer's own view, so a hand
   * card snapped to a battlefield row and a permanent snapped into the hand both
   * do nothing at all (the snap itself only offers the card's own zone, so this
   * is the second lock, not the first). Moving a card between zones is Forge's,
   * never ours.
   */
  const commit = (cardId: number, slot: ArrangeSlot, target: DropTarget): void => {
    if (viewer === undefined) return;
    if (target.kind !== 'end' && target.id === cardId) return;
    if (slot === 'hand') {
      const hand = viewer.hand;
      if (hand === null || !hand.some((c) => c.id === cardId)) return;
      ARRANGED.set(key, withHandMove(handOrder(hand, viewer.id, arranged), viewer.id, arranged, cardId, target));
    } else {
      if (!viewer.battlefield.some((c) => c.id === cardId)) return;
      ARRANGED.set(
        key,
        withMove(
          group(viewer.battlefield, viewer.id, arranged, boardLayout),
          viewer.id,
          arranged,
          cardId,
          slot,
          target,
          boardLayout,
        ),
      );
    }
    redraw();
  };
  useArrangeDrag(root, viewer !== undefined, commit);

  const arranging: Arranging | undefined = viewer === undefined ? undefined : ARRANGING;

  return (
    <section className="board" aria-label="Game board" ref={root}>
      <div className="board__opponents">
        {others.map((p) => (
          <PlayerArea
            key={p.id}
            player={p}
            interaction={interaction}
            arranging={undefined}
            arranged={arranged}
            /* Mine only (Q15c): the opponent's board is always the default one. */
            layout="single"
          />
        ))}
      </div>

      {/*
       * The stack's column. `data-question` is the whole of items 7 and 13 on
       * this side: the band is ROOMY by default and compact while a question
       * stands in front of it (`board.css` reads it, and `--stack-card-w` follows
       * the height so a roomy band draws a bigger card). Whether it is DRAWN at
       * all is the stylesheet's, off the list being empty — so the DOM probe in
       * `e2e/table-fit.spec.ts`, which appends `<li>`s without going through
       * React, still sees the stack appear when it fills it.
       */}
      <div
        className="board__mid"
        data-testid="board-mid"
        data-question={interaction?.questionOpen === true || undefined}
      >
        <StackView stack={view.stack} interaction={interaction} />
      </div>

      {staged !== undefined && <StagingArea card={staged} interaction={interaction} />}

      {viewer !== undefined && (
        <PlayerArea
          player={viewer}
          interaction={interaction}
          arranging={arranging}
          arranged={arranged}
          layout={boardLayout}
        />
      )}

      {/*
       * Out of flow, all three of them: none may move a track when it appears.
       *
       * `board__over` is the one thing the turn bar carried that is not the
       * rail's and was not on the operator's delete list — the game ENDING is
       * not the turn number — so it moved out here instead of going with the
       * bar. `e2e/play.spec.ts` and `e2e/table-fit.spec.ts` read it in four
       * places as "the game finished early", and it still answers to `.board__over`.
       */}
      {view.gameOver && (
        <p className="board__over" role="status">
          game over
        </p>
      )}
      {view.missingCardIds.length > 0 && (
        <p className="board__warn" role="alert">
          {view.missingCardIds.length} card(s) named by a zone never arrived: {view.missingCardIds.join(', ')}
        </p>
      )}
      <div className="board__overlay" data-board-overlay="" />
    </section>
  );
}
