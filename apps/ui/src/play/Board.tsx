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
 * still reorders, a permanent nobody placed takes the first free column of
 * its row, else the row's end (`group`). The two layouts keep independent
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
 *   - **It survives a RELOAD too** (T10, wave 36, D1). `ARRANGED` alone does
 *     not — it is JavaScript memory, and a reload starts the page's
 *     JavaScript over — so every write also goes to `sessionStorage`, keyed
 *     by match AND seat, and the first read of a match-and-seat this TAB has
 *     not seen since loading hydrates `ARRANGED` from it. Per TAB, not per
 *     browser or device: `sessionStorage`, not `localStorage`, on purpose
 *     (the tracker's own default, open to being overruled). See `setArranged`
 *     / `arrangementFor`, below.
 *
 * A card the arrangement names that is no longer on the battlefield is
 * ignored, and a permanent that arrives while an arrangement stands joins the
 * end of its own row. Only the viewer's own side is arrangeable: the arrangement
 * is theirs, and the opponent arranges their own side on their own screen.
 *
 * ## The hand is arranged too, but not by this component's own gesture
 *
 * The operator: they could not reorder their own hand at all, and then
 * (once a first drag-based fix made it reachable only on a card Forge was
 * not offering) that it needed a smoother animation and to be visible to the
 * opponent. The hand uses the SAME store and the SAME slot machinery as a
 * battlefield row — one slot key, `<playerId>:hand`, holding the order the
 * player put their cards in, `handOrder`/`withHandMove` below — but the
 * GESTURE that writes it is `live/gestures/install.ts`'s, not this
 * component's own `useArrangeDrag`: a press on a hand card, Forge-offered or
 * not, belongs to the interaction lane, because that lane is the one that
 * already decides whether the press stays in the hand (a reorder) or leaves
 * it (how a land or a spell is played). `commitHandMove`, below, is that
 * lane's own write into this store, the same cross-lane shape
 * `notePlayedTo` already uses. There is no STACKING in a hand: a hand is a
 * row of cards you hold, so the thirds of a card's box that mean "stack
 * above / below" on a battlefield mean nothing here and a drop is always a
 * reorder.
 *
 * `CardOnBoard` never marks a hand card `data-arrange-card`, whatever Forge
 * is doing, so `useArrangeDrag` (below) never starts from one — the press
 * always reaches the interaction lane first.
 *
 * ## Stacking: deliberate as well as free
 *
 * The operator, 2026-09-27: *"i dont want these snapping zones… put cards
 * wherever they want… snap above/below each other in any order"*. So a row is a
 * list of PILES rather than a list of cards, and where in a card's box a drop
 * lands says which of three things the player meant — stack on top of it,
 * stack under it, or reorder in front of it (`snapTo`): stacking is the easy
 * case, most of the card's box by WIDTH; reordering is a thin strip at each
 * edge. A drop on the row's own box is still "at the end of this row, on its
 * own", which is the gesture `e2e/table-fit.spec.ts` drives.
 *
 * Forge's own client has this as two preferences — `UI_STACK_CREATURES` and
 * `UI_MAX_STACK_DEPTH` (default `4`, `ForgePreferences.java:93,96`, consumed by
 * `VField.java:33` and `VCardDisplayArea.java:380`). We took the idea and not
 * the implementation: stacking here is per pile rather than per player, it is
 * never automatic, and the depth is not refused — a pile of nine is drawn, with
 * the FAN capped at Forge's four so the offsets stay legible (`card.css`), and
 * EVERY card in the pile — base and fanned alike — is narrowed by that same
 * capped fan: an inline `--pile-fan` set by `CardOnBoard`, not left to
 * `card.css`'s own `:has()` cascade, which only ever reaches the base card —
 * a fanned member left to that cascade draws un-narrowed, its right edge
 * running past the pile's own box and into whatever ancestor's `overflow:
 * auto` (the last resort, `board.css`) is there to catch it. Refusing a drop
 * the player made is worse than a tight fan.
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
 * counters, tapped, attacking, blocking, summoning sickness) — and since wave
 * 28 §A.15 it DRAWS that state rather than writing it:
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
 * drawing is shared — and not for a creature with vigilance (`data-vigilant`),
 * which attacks without tapping.
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
 *     property the arrow needs. `data-stack-id` is the item's own id
 *     (`gestures/stack.ts`'s `stackItemBox`, lane B's arrows); wave 46 X3
 *     deleted `data-source-card` — the stack opted out of the generic
 *     inspector (`inspect/index.ts`'s own header explains why) rather than
 *     keeping an attribute nothing reads any more.
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
 *     holds nothing. A card the viewer may arrange carries `data-arrange-card` —
 *     on their own battlefield only — and the viewer's SEAT carries one
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
 *   - this lane's gesture is `useArrangeDrag`'s press-drag on a
 *     `[data-arrange-card]` `<li>`. A card whose press is an ARRANGEMENT needs
 *     no offer from Forge and sends nothing, which is why it is this gesture
 *     and not the pointer layer's. Nothing here reads, writes or styles
 *     `data-attack-intent`; this lane's own attributes are `data-arrange-card`,
 *     `data-arrange-reset`, `data-pile-size`, `data-pile-depth`,
 *     `data-attached` and `data-pt*`;
 *
 *     **A card Forge is ASKING ABOUT is never `data-arrange-card`, and that is
 *     the seam, not a detail.** The interaction lane stands down on a press
 *     that starts on one (`live/gestures/install.ts`'s `arrangeable`), so a
 *     card that was both would lose the targeter drag. The condition is
 *     `interaction.selectionOpen && selectable` — an OPEN SELECTION, not merely
 *     Forge's actionable set, whose own docs are on
 *     `BoardInteraction.selectionOpen`;
 *   - `data-board-overlay` is a positioned root covering the canvas exactly,
 *     at the board's top level, for those lanes to render into. This file adds
 *     no pointer handler to it and draws nothing in it;
 *   - `data-board-zoom` is the same box one layer up (`--z-zoom`): the
 *     inspector and the tooltip draw there, above everything on the table —
 *     the phase rail, the controls and a decision window included.
 *
 * The inspector (`inspect/index.ts`) is BOOTED here — one mount effect on the
 * board's root element, disposed on unmount — and that is the whole of this
 * file's involvement with it: it attaches its own listeners, by delegation,
 * and renders into the zoom layer. No handler, prop or markup here is for
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

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { CardTile } from '../components/CardTile.tsx';
import type { TileCard } from '../components/faceCrop.ts';
import { colorWordToken, ManaPip } from '../components/ManaPip.tsx';
import { cardImageUrl } from '../draft/cardImage.ts';
import { Avatar } from '../components/Avatar.tsx';
import {
  boardPT,
  hasKeyword,
  keywordTags,
  type BoardCard,
  type BoardCardChoice,
  type BoardCardState,
  type BoardCardWaiting,
  type BoardDoor,
  type BoardEmblem,
  type BoardPlayer,
  type BoardView,
  type PoolColor,
  type PTState,
  viewerOf,
} from './adapter.ts';
import { LONG_PRESS_MS, mountInspector } from './inspect/index.ts';
import { mountTips } from './tip/index.ts';
import { choiceTip, keywordTip, MARK_TIP, SEEN_TIP, stateTip, waitingTip } from './tip/words.ts';
import { documentScope, eventTarget } from '../dom.ts';
import { TopLayer } from '../topLayer.tsx';
import { clickLatch, pastSlop } from './live/gestures/types.ts';
import { installNumbers, type Revealed } from './live/numbers.ts';
import { installPlaced } from './live/placed.ts';
import { DEPARTURE_MAX_MS, departuresOf, installDepartures, LEAVING_GAP_ATTR, type Departure } from './live/departures.ts';
import { AbilityChip } from './live/AbilityChip.tsx';
import { HiddenCard } from './HiddenCard.tsx';
import { PileView } from './PileView.tsx';
import { useCardMenu } from './card-menu/CardMenu.tsx';
import { CheckMark } from './marks.tsx';
import { Relations } from './Relations.tsx';
import { cardWidthIn } from './card-size.ts';
import { liftGhost, type Ghost } from './lift.ts';
import { observeZoneBoxes, type ZoneBoxes } from './zone-box.ts';
import { PLACEMENT_WAIT_MS, UNLOCK_BEAT_MS } from './motion.ts';
import './board.css';
import './card.css';

/** What Forge currently lets the viewer click, and where a click goes. */
/** One held card's tags (`BoardInteraction.held`): its changed cost as cost tokens, and a granted flash, each with its tooltip. */
export interface HeldTags {
  readonly cost?: { readonly tokens: readonly string[]; readonly change: 'less' | 'more' | 'same'; readonly tip: string };
  readonly flash?: string;
}

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
   * this field they would be `data-arrange-card`, and the interaction lane's
   * pointer layer stands down on every one of those — so arranging would
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
   * The card Forge just turned away (`LiveMatch.refused`): drawn with a brief
   * refusal mark, `seq` restarting it for a second refusal of the same card.
   * **Absent means nothing refused.**
   */
  refused?: { card: number; seq: number };
  /**
   * The held cards an effect forbids this seat to cast (Reflector Mage's,
   * Silence's — the bridge's `castForbidden`), each with the words its tooltip
   * says. Not mana, not timing: only a `CantBeCast` static puts a card here.
   * **Absent means none.**
   */
  castForbidden?: ReadonlyMap<number, string>;
  /**
   * What continuous effects change about this seat's held cards (the bridge's
   * `heldChanges`): a cost Forge would charge differently now, and a flash an
   * effect grants, each with the words its tooltip says. Drawn as tags on the
   * hand card, beside any keyword an effect gave it. **Absent means none.**
   */
  held?: ReadonlyMap<number, HeldTags>;
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
  /**
   * The operator, on the mulligan bottom-pick: *"hard to tell when i have a
   * card selected because the background for all cards is green."* Forge's
   * own `setHighlighted` — the ids THIS seat has already chosen inside an
   * open, multi-pick selection (a mulligan's bottom seven, a discard, a
   * sacrifice) — kept apart from `selectable` so a card already picked can be
   * drawn as PICKED rather than merely offered. `selectable` still includes
   * every id in here too (`live/match.ts`'s own fold), because Forge's input
   * answers a second click on a picked card the same way it answers the
   * first one; this field only adds the drawing `selectable` alone cannot
   * carry.
   *
   * **Absent means nothing is picked** — the safe default, and the state
   * every fixture and `live/parity.test.ts` render in.
   */
  highlighted?: ReadonlySet<number>;
  /**
   * While this seat blocks: the attacker the next blocker click goes to (`live/match.ts`'s
   * `blockFocusOf`) — drawn as the block focus, never as picked. Absent outside the block step.
   */
  blockFocus?: number;
  /**
   * The combat damage the viewer's open damage window assigns, by card id
   * (`live/match.ts`'s `damagePreviewOf`): each card shows the number it is
   * about to take, in the floating combat numbers' own look (`numbers.css`),
   * held still for as long as the window is open. Absent with no window open.
   */
  damagePreview?: ReadonlyMap<number, number>;
  /**
   * While this seat declares attackers or blockers: its creatures Forge says
   * can attack or block right now (`pushAttackerCandidates` /
   * `pushBlockerCandidates`), drawn larger and lifted so the step's own cards
   * stand apart from the everyday can-act glow. Absent outside those windows.
   */
  combatReady?: ReadonlySet<number>;
  /**
   * The colours of the viewer's floating pool that pay the open payment: pressable
   * (`live/match.ts`'s `poolPays`). Absent otherwise.
   */
  poolPays?: readonly PoolColor[];
  /** The pool pays the open payment more than one way, so it is highlighted (`live/match.ts`'s `poolChoice`). */
  poolChoice?: boolean;
  /** A colour of the viewer's pool was pressed. Only ever called for one in `poolPays`. */
  onPayFromPool?(color: PoolColor): void;
  /** A card was clicked. Only ever called for an id in `selectable`. */
  onSelectCard(cardId: number): void;
  onSelectPlayer(playerId: number): void;
}

/** Which side of the table a zone is on. The stack belongs to neither. */
type ZoneOwner = 'you' | 'them' | 'table';
/** The two zones drawn as piles, each of which opens as a `PileView`. */
type PileZone = 'graveyard' | 'exile';

/* ── the battlefield's rows ───────────────────────────────────────────── */

/**
 * Item 11. *"i said this should be an alternate ui and the real ui should
 * just be a single board, no seperators."* `single` — one undivided
 * battlefield, cards in arrival/placement order — is the DEFAULT; the four
 * type-separated lanes below survive as the `type-separated` alternate,
 * behind the settings panel's own choice. Nothing about wave 24's placement
 * model changes either way: a drop on a card's top or bottom third still
 * stacks it, the middle still reorders, a permanent nobody placed takes the
 * first free column of its row, else the row's end (`group`).
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
export type BoardRow = (typeof BOARD_ROWS)[number] | (typeof SINGLE_ROWS)[number];

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
 *
 * An EMPTY pile is a gap: a column the player left open on purpose (ledger Z8,
 * the operator, 2026-10-07: *"if i want to place a card in a particular slot
 * further to the right with gaps in between i should be able to"*). It is
 * drawn as an empty column (`.zone__gap`), counts toward `--cols`, and is a
 * place a card can be dropped. Only the player makes one — by dropping a card
 * at a column past the row's end, or by moving the only card out of a column
 * onto a pile or a column of the same row (`withMove`); a pile that empties
 * because its card left the battlefield closes up, as it always did. Trailing
 * gaps are trimmed at every write.
 */
type Pile = readonly BoardCard[];

/**
 * The same card, as a player names one: the same name, and both tokens or both cards (a Goblin token
 * is not a Goblin card). A card this seat cannot see is never the same as anything — its name says
 * nothing about which card it is. Whether two are also INTERCHANGEABLE (counters, tapped, text) is
 * the card menu's stricter question (`card-menu/actions.ts`'s `sameToken`), built on this one.
 */
export function sameCard(a: BoardCard, b: BoardCard): boolean {
  return a.hidden !== true && b.hidden !== true && a.card.name === b.card.name && a.token === b.token;
}

/**
 * How many copies of one card a pile is, for its `×N` badge — the operator, 2026-10-12: *"when
 * multiple copies of the same creature or token are stacked let's show an xN on top so it's clear
 * how many there are."* `null` unless the pile holds two or more cards that are all the same card
 * (`sameCard`): a pile that mixes cards — gear on a creature, a land under a creature — is not copies.
 */
export function copiesIn(pile: Pile): number | null {
  return pile.length >= 2 && pile.every((card) => sameCard(card, pile[0]!)) ? pile.length : null;
}

/**
 * One battlefield, in rows of piles. Always every `BoardRow` key, whether or
 * not the layout on screen draws it — `rowsForLayout` says which ones a given
 * render actually uses, and the rest sit empty.
 */
export type Grouped = Readonly<Record<BoardRow, readonly Pile[]>>;

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
export type Arrangement = Readonly<Record<string, readonly (readonly number[])[]>>;

const NO_ARRANGEMENT: Arrangement = {};
export const slotKey = (playerId: number, slot: ArrangeSlot): string => `${playerId}:${slot}`;

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
 *
 * T10 (wave 36, found during w35), D1: a RELOAD must not lose it — this map
 * alone does, because it is JavaScript memory and a reload starts the page's
 * JavaScript over. `sessionStorage` (below) is the part of this that
 * survives a reload; this map stays the part every render reads, so nothing
 * downstream of `arranged = ARRANGED.get(key) ?? NO_ARRANGEMENT` has to know
 * persistence exists at all.
 */
const ARRANGED = new Map<string, Arrangement>();

/**
 * Which match a view is: its title and its seats. The ids are SORTED, not in
 * the view's order — that order puts the viewer first, and a watcher's viewer
 * changes with the perspective (`flipPerspective`); a key that changed with it
 * lost every arrangement on the flip (2026-10-12).
 */
function matchKey(view: BoardView): string {
  return `${view.title}|${[...view.players.map((p) => p.id)].sort((a, b) => a - b).join(',')}`;
}

/** Forget every match's arrangement. For a test that wants the default grouping. */
export function forgetArrangements(): void {
  ARRANGED.clear();
}

/*
 * ── T10: the arrangement survives a reload (D1) ─────────────────────────
 *
 * The operator's own ledger item: *"the board arrangement is lost on
 * reload."* D1 (the tracker's default, not overruled): kept PER TAB
 * (`sessionStorage`, not `localStorage`) and keyed by match AND seat — a
 * reload of the same tab sees its own tidying back; a different browser or a
 * different seat does not, which is also why only THIS viewer's own slots are
 * ever written (every `ARRANGED.set` call in this file passes `viewer.id`,
 * never an opponent's).
 *
 * `sessionStorage` can throw on read or write — a private window, cleared
 * site data, a blocked third-party context (the same list `sound/mute.ts`
 * documents for `localStorage`) — so every access is inside a `try`/`catch`
 * that falls back to "nothing persisted": a blocked store costs a player
 * their tidying across a reload, never a blank board.
 */

const ARRANGED_SESSION_PREFIX = 'cardtable.play.arranged.v1:';

function arrangedSessionKey(key: string, viewerId: number): string {
  return `${ARRANGED_SESSION_PREFIX}${key}:${viewerId}`;
}

/** This seat's own slots of an arrangement — the only slice `sessionStorage` ever holds. */
function seatSlice(arrangement: Arrangement, viewerId: number): Arrangement {
  const prefix = `${viewerId}:`;
  const out: Record<string, readonly (readonly number[])[]> = {};
  for (const [k, v] of Object.entries(arrangement)) if (k.startsWith(prefix)) out[k] = v;
  return out;
}

/**
 * What `sessionStorage` says this match-and-seat's arrangement was, trusting
 * nothing about its shape — it is this tab's own past write, but a schema can
 * still move under it (`.v1`) and a hand-edited value is not impossible.
 * `null` for "nothing to restore", which is also the answer for anything that
 * fails to parse as the shape this file writes.
 */
function readArrangedSession(key: string, viewerId: number): Arrangement | null {
  let raw: string | null;
  try {
    raw = globalThis.sessionStorage?.getItem(arrangedSessionKey(key, viewerId)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const prefix = `${viewerId}:`;
    const out: Record<string, readonly (readonly number[])[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Never trust a foreign seat's key, even inside this tab's own storage.
      if (!k.startsWith(prefix) || !Array.isArray(v)) continue;
      const piles: number[][] = [];
      for (const pile of v) {
        if (!Array.isArray(pile) || !pile.every((n) => typeof n === 'number')) continue;
        piles.push(pile);
      }
      out[k] = piles;
    }
    return out;
  } catch {
    return null;
  }
}

/** Best-effort write of this seat's own slice. Never throws, never blocks a drop. */
function writeArrangedSession(key: string, viewerId: number, arrangement: Arrangement): void {
  try {
    globalThis.sessionStorage?.setItem(arrangedSessionKey(key, viewerId), JSON.stringify(seatSlice(arrangement, viewerId)));
  } catch {
    // Nothing to do: the tidying holds for this page and is simply not
    // remembered across the next reload.
  }
}

/** The seat's battlefield rows alone — never its hand, whose order names hidden cards. */
function battlefieldRows(arrangement: Arrangement, playerId: number): Record<string, readonly (readonly number[])[]> {
  const out: Record<string, readonly (readonly number[])[]> = {};
  for (const [k, v] of Object.entries(seatSlice(arrangement, playerId))) {
    const slot = k.slice(`${playerId}:`.length);
    if (slot !== 'hand') out[slot] = v;
  }
  return out;
}

export type OwnArrangementListener = (change: { readonly matchKey: string; readonly playerId: number; readonly rows: Record<string, readonly (readonly number[])[]> }) => void;
const OWN_ARRANGEMENT_LISTENERS = new Set<OwnArrangementListener>();
/** Mounted boards, woken when the other seat's arrangement arrives (`applyTheirArrangement`). */
const MOUNTED_BOARDS = new Set<() => void>();

/**
 * The viewer's hand card picked up right now, and its height before it was: the hand holds its slot
 * open with an empty `<li data-hand-gap>` in front of it (`Zone`), so the cards after it do not
 * close up under the pointer while it is out of the grid. Written by the gestures lane
 * (`live/gestures/hand.ts`); a card the hand no longer has holds nothing.
 */
let HELD_HAND_SLOT: { readonly cardId: number; readonly height: number } | null = null;

export function holdHandSlot(slot: { cardId: number; height: number } | null): void {
  if (HELD_HAND_SLOT?.cardId === slot?.cardId && HELD_HAND_SLOT?.height === slot?.height) return;
  HELD_HAND_SLOT = slot;
  for (const wake of MOUNTED_BOARDS) wake();
}

/**
 * Told of every arrangement this seat makes of its own battlefield (its
 * rows, never its hand) — what `live/arrangement-sync.ts` sends to the other
 * seat, so their screen draws this side as it was placed.
 */
export function onOwnArrangement(listener: OwnArrangementListener): () => void {
  OWN_ARRANGEMENT_LISTENERS.add(listener);
  return () => {
    OWN_ARRANGEMENT_LISTENERS.delete(listener);
  };
}

/**
 * The OTHER seat's arrangement of their battlefield, into this tab's store
 * under their player id — `group()` reads it for any player, so their side
 * draws in their piles from the next frame. Replaces their rows wholesale (a
 * row they no longer name goes back to the view's order); never touches a
 * hand or any other player's rows. Every mounted board is woken.
 */
export function applyTheirArrangement(view: BoardView, playerId: number, rows: Record<string, readonly (readonly number[])[]>): void {
  const key = matchKey(view);
  const prefix = `${playerId}:`;
  const next: Record<string, readonly (readonly number[])[]> = {};
  // On the viewer's HYDRATED arrangement: a replay of theirs can arrive before this tab's board has
  // read its own rows back from `sessionStorage` (a reload), and a store written first would be
  // taken for the hydrated one — the viewer's own tidying lost (T10 on main, Forge run 37719372048).
  const viewer = viewerOf(view);
  const base = viewer === undefined ? (ARRANGED.get(key) ?? NO_ARRANGEMENT) : arrangementFor(key, viewer.id);
  for (const [k, v] of Object.entries(base)) if (!k.startsWith(prefix) || k === `${prefix}hand`) next[k] = v;
  for (const [slot, piles] of Object.entries(rows)) if (slot !== 'hand') next[`${prefix}${slot}`] = piles;
  ARRANGED.set(key, next);
  for (const wake of MOUNTED_BOARDS) wake();
}

/** Every write to `ARRANGED` goes through here, so persistence cannot be forgotten at one call site. */
function setArranged(key: string, viewerId: number, next: Arrangement): void {
  ARRANGED.set(key, next);
  writeArrangedSession(key, viewerId, next);
  const rows = battlefieldRows(next, viewerId);
  for (const listener of OWN_ARRANGEMENT_LISTENERS) listener({ matchKey: key, playerId: viewerId, rows });
}

/**
 * This match-and-seat's arrangement, hydrating `ARRANGED` from
 * `sessionStorage` the first time this TAB sees it (a real reload starts
 * `ARRANGED` empty; a resync-remount within the same tab does not, and the
 * `ARRANGED.get` below is what keeps that case free of a redundant parse).
 */
function arrangementFor(key: string, viewerId: number): Arrangement {
  const cached = ARRANGED.get(key);
  if (cached !== undefined) return cached;
  const restored = readArrangedSession(key, viewerId);
  if (restored === null) return NO_ARRANGEMENT;
  ARRANGED.set(key, restored);
  return restored;
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
export function group(cards: readonly BoardCard[], playerId: number, arranged: Arrangement, layout: BoardLayout): Grouped {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: Record<BoardRow, BoardCard[][]> = emptyRows();
  const placed = new Set<number>();
  /** The pile each placed card was drawn in. */
  const pileOf = new Map<number, BoardCard[]>();
  for (const row of rowsForLayout(layout)) {
    for (const pile of arranged[slotKey(playerId, row)] ?? []) {
      // A gap the player left: an empty column, kept as one.
      if (pile.length === 0) {
        rows[row].push([]);
        continue;
      }
      const members: BoardCard[] = [];
      for (const id of pile) {
        const card = byId.get(id);
        if (card === undefined || placed.has(id)) continue;
        placed.add(id);
        members.push(card);
        pileOf.set(id, members);
      }
      if (members.length > 0) rows[row].push(members);
    }
  }
  // A card nobody placed that carries one somebody did — a Germ born holding the Batterskull the
  // player let go, a token an aura was moved onto — is drawn in that card's column: the pile stays
  // where its placed card was put. Repeated while one joins, for a chain of attachments.
  for (let joined = true; joined; ) {
    joined = false;
    for (const card of cards) {
      if (placed.has(card.id)) continue;
      const pile = (card.attachedCardIds ?? []).map((id) => pileOf.get(id)).find((p) => p !== undefined);
      if (pile === undefined) continue;
      pile.push(card);
      placed.add(card.id);
      pileOf.set(card.id, pile);
      joined = true;
    }
  }
  // An attachment nobody placed takes no column: `withAttachments` draws it in its host's pile, and a
  // column it filled here would close up there, moving every column right of it.
  const attached = new Set(cards.flatMap((c) => (c.attachedCardIds ?? []).filter((id) => id !== c.id && byId.has(id))));
  for (const card of cards) {
    if (placed.has(card.id) || attached.has(card.id)) continue;
    // A card nobody placed — a token, a card an effect put onto the battlefield, any arrival with no
    // placement of its own — takes the first free column of its row from the left, else the row's end.
    const row = rows[visualRow(card, layout)];
    const gap = row.findIndex((pile) => pile.length === 0);
    if (gap === -1) row.push([card]);
    else row[gap] = [card];
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
      if (pile.length === 0) {
        out[row].push([]);
        continue;
      }
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
 *   - most of its box (everything but a thin strip at each edge): stack
 *     ON TOP of that card if the drop is in the upper half, UNDERNEATH it if
 *     in the lower half;
 *   - a thin strip at its left or right edge: the old behaviour, in front of
 *     that card's pile.
 *
 * In a HAND a card is one target, `before` — nothing stacks in a hand, so the
 * edge strips are not read there at all.
 */
/**
 * Exported for `live/gestures/hand.ts`: the hand's own reorder gesture builds
 * one of these (always `before`/`end` — a hand never stacks, see below) to
 * hand to `withHandMove` across the lane boundary, the same seam
 * `notePlayedTo`/`commitHandMove` already cross it by.
 */
export type DropTarget =
  | { kind: 'end' }
  | { kind: 'before'; id: number }
  | { kind: 'stack'; id: number; onTop: boolean }
  /** A column of the row by index, counting gaps: an existing gap, or one past the end with gaps opened up to it (Z8). */
  | { kind: 'at'; column: number };

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
  /**
   * Every column of the slot in drawing order: a pile's base card, or a gap (`id: null`).
   * `size` is how many cards the pile holds (absent: one) — `snapTo` needs it to know whether
   * the card being dragged IS the whole pile under the pointer, or only part of one.
   */
  readonly piles: readonly { readonly id: number | null; readonly box: Box; readonly size?: number }[];
  /**
   * One column's pitch (a card's width plus the gap between cards), for
   * placing a card in a column past the row's end. Read off any card on the
   * same battlefield, so an empty row knows it too; null when none is drawn.
   */
  readonly step?: number | null;
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
  readonly kind: 'before' | 'end' | 'stack-top' | 'stack-bottom' | 'at';
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
 * reads WIDTH first: a thin strip at the left or right edge is "in front of
 * this pile" / "after it"; the rest — most of the card — stacks on it (upper half)
 * or under it (lower half). A hand does not stack (its slot is `hand`): it is only
 * ever before or after. "After" the last pile is the slot's `end`; after any other
 * it is in front of the next one.
 *
 * Pure, and in pixels: `Board.test.ts` drives it with boxes, since jsdom lays
 * nothing out.
 */
/**
 * `dragging`: the card being moved. Its own column is not a place to put it — not a stack onto
 * itself, not "before" itself — and the column right after it is where it already is. Before
 * this (2026-10-08, the operator: "moving it directly to the right just doesn't work"), the
 * dimmed card under the pointer was a pile like any other: its middle stacked the card onto
 * itself (which `withMove` turned into "the end of the row"), its edges offered the gap it was
 * already in, and the one-column-right move was a thin strip at the neighbour's far edge.
 */
/**
 * Every column that fits the row's width is a place to put a card — the operator, 2026-10-09, after
 * four reports of a card that could be dragged left but not right: *"just let people put cards wherever
 * they want and always draw all the placement locations."* Beyond the row's last real column (a card or
 * a gap), one gap pile per pitch up to the row's right edge; `snapTo` then treats them like any other gap,
 * which deletes every special case there used to be for "past the end" and "its own column".
 */
export function withColumnsToWidth(slot: SlotGeometry): SlotGeometry {
  const step = slot.step ?? null;
  if (slot.slot === 'hand' || step === null || step <= 0) return slot;
  const piles = [...slot.piles];
  const last = piles[piles.length - 1]?.box ?? null;
  const width = last === null ? step - 6 : last.right - last.left;
  const top = last?.top ?? slot.box.top + 4;
  const bottom = last?.bottom ?? slot.box.bottom - 4;
  let left = last === null ? slot.box.left + 4 : last.left + step;
  // A column counts while it STARTS inside the row: a pointer one pitch past the last card is in a
  // column that may only partly fit, and it still lands there (ledger Z8's proof, `stacking.spec.ts`).
  while (left < slot.box.right - 4 && piles.length < 64) {
    piles.push({ id: null, box: { left, top, right: left + width, bottom } });
    left += step;
  }
  return { ...slot, piles };
}

/**
 * How many of the columns `withColumnsToWidth` adds fit the row WHOLE — the empty columns the placement
 * scaffold draws (a partly fitting one would reflow the grid mid-drag). `row` is the list's content box,
 * `width` a card's (`card-size.ts`), `gap` the list's own `column-gap`.
 */
export function virtualColumns(row: { readonly left: number; readonly right: number }, lastRight: number | null, count: number, width: number | null, gap: number): number {
  if (width === null || width <= 0) return 0;
  const step = width + gap;
  let left = lastRight === null ? row.left : lastRight + gap;
  let n = 0;
  while (left + width <= row.right + 1 && count + n < 64) {
    n += 1;
    left += step;
  }
  return n;
}

export function snapTo(slots: readonly SlotGeometry[], x: number, y: number, dragging: number | null = null, whole = false): Snap | null {
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
    // A row with no column at all (its pitch unknown): the start.
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
  // The dragged card's own column (a pile of just itself, or the pile it heads when `whole` carries all of it) is never the target.
  const own = (p: { readonly id: number | null; readonly size?: number }): boolean => dragging !== null && p.id === dragging && (whole || (p.size ?? 1) <= 1);
  let at = -1;
  let nearest = Infinity;
  piles.forEach((pile, i) => {
    if (own(pile)) return;
    const d = distanceTo(pile.box, x, y);
    if (d < nearest) {
      at = i;
      nearest = d;
    }
  });
  if (at === -1) {
    // Every column is the dragged card's own: the row is its alone, and it stays.
    const height = Math.min(box.bottom - box.top, 96);
    return { slot, target: { kind: 'end' }, kind: 'end', card: null, bar: { left: box.left + 4, top: (box.top + box.bottom - height) / 2, width: BAR, height } };
  }
  const ownBox = dragging === null ? null : (piles.find((p) => own(p))?.box ?? null);
  if (stacking && ownBox !== null && distanceTo(ownBox, x, y) === 0) {
    // On its own box: it stays — a self target `withMove` leaves in place.
    return { slot, target: { kind: 'before', id: dragging! }, kind: 'before', card: dragging!, bar: { left: ownBox.left - BAR - 1, top: ownBox.top, width: BAR, height: ownBox.bottom - ownBox.top } };
  }
  const pile = piles[at]!;
  const { left, top, right, bottom } = pile.box;
  /*
   * Z8. Over a gap: the card goes into that column. Past the last column, by
   * a whole column's pitch or more: a new column there, with gaps opened up to
   * it — "a particular slot further to the right". Within one pitch past the
   * last card it is still the row's `end`, as it always was.
   */
  if (stacking && pile.id === null) {
    return { slot, target: { kind: 'at', column: at }, kind: 'at', card: null, bar: { left: left - BAR - 1, top, width: BAR, height: bottom - top } };
  }
  // The next column that is not the dragged card's own (its own is where it came from, not a place).
  const nextAt = piles.findIndex((p, i) => i > at && !own(p));
  // A hand has no gaps (`withHandMove` writes piles of one), so a null id can only be a battlefield gap, handled above.
  const pileId = pile.id ?? -1;
  const height = bottom - top;
  const width = right - left;
  const inside = nearest === 0;
  /*
   * Width is read first, not height: a thin strip at each edge (`EDGE`, a
   * fraction of the card's width) is before/after, and the whole rest of the
   * card — most of it — stacks, on top or underneath by which half of the
   * height the pointer is in. The previous rule read HEIGHT thirds instead —
   * top stacks on, bottom stacks under, and the whole MIDDLE third (any x)
   * reordered — so a drop anywhere near a card's vertical centre missed the
   * stack and reordered instead, which is most drops aimed at a card.
   */
  const EDGE = 0.12;
  if (stacking && inside && height > 0 && width > 0) {
    const fx = (x - left) / width;
    if (fx > EDGE && fx < 1 - EDGE) {
      const onTop = y - top < height / 2;
      return onTop
        ? {
            slot,
            target: { kind: 'stack', id: pileId, onTop: true },
            kind: 'stack-top',
            card: pileId,
            bar: { left, top: top - BAR / 2, width, height: BAR + 1 },
          }
        : {
            slot,
            target: { kind: 'stack', id: pileId, onTop: false },
            kind: 'stack-bottom',
            card: pileId,
            bar: { left, top: bottom - BAR / 2 - 1, width, height: BAR + 1 },
          };
    }
  }
  if (x < (left + right) / 2) {
    return {
      slot,
      target: { kind: 'before', id: pileId },
      kind: 'before',
      card: pileId,
      bar: { left: left - BAR - 1, top, width: BAR, height },
    };
  }
  const nextId = nextAt === -1 ? undefined : piles[nextAt]!.id;
  // After this pile, where the next column is a gap: into that gap (Z8).
  if (nextId === null) {
    return { slot, target: { kind: 'at', column: nextAt }, kind: 'at', card: null, bar: { left: right + 1, top, width: BAR, height } };
  }
  return {
    slot,
    target: nextId === undefined ? { kind: 'end' } : { kind: 'before', id: nextId },
    kind: nextId === undefined ? 'end' : 'before',
    card: nextId === undefined ? pileId : nextId,
    bar: { left: right + 1, top, width: BAR, height },
  };
}

// ── A cast the gestures lane is carrying: its spell stands off the stack ────

/**
 * The card whose own spell the stack does not draw for now, or null.
 *
 * The operator, on dragging a creature out of the hand: *"i dont think we need
 * the stack to appear at all if the opponent doesn't take priority. we can skip
 * the confidant being on the stack."* While the gestures lane holds a played
 * permanent at its release point, that card IS the spell as far as the caster
 * is concerned, and drawing it a second time as a stack thumbnail is the flash
 * they were describing. The gestures lane decides when that stops being true
 * (the opponent is taking their time, something else joined the stack, Forge
 * asks a question) and calls this with null; `Board` only draws what it says.
 *
 * Module-level and written from outside React for the same reason
 * `notePlayedTo` is, but unlike a pending placement this one has to WAKE a
 * mounted `Board` — the stand-in ends on the gestures lane's own clock, with
 * no Forge frame to ride — so it is a store `Board` subscribes to.
 */
let carriedCastId: number | null = null;
const carriedCastListeners = new Set<() => void>();

export function carryCastOffStack(cardId: number | null): void {
  if (carriedCastId === cardId) return;
  carriedCastId = cardId;
  for (const listener of carriedCastListeners) listener();
}

const readCarriedCast = (): number | null => carriedCastId;

function subscribeCarriedCast(listener: () => void): () => void {
  carriedCastListeners.add(listener);
  return () => carriedCastListeners.delete(listener);
}

// ── R9: a cast's drop point, remembered until the permanent arrives ─────────

/**
 * A cast's intended battlefield slot, remembered by the card's own (stable)
 * id until Forge actually plays it — the seam with the gestures lane's cast
 * gesture, which otherwise has nowhere to record "where you dropped it" (no
 * hand card is ever `CardOnBoard`'s `data-arrange-card`, because
 * dragging it out of hand is how it is PLAYED). Module-level like
 * `ARRANGED`: a resync may remount `Board` and a cast in
 * flight must outlive that exactly the same way a rearrange does.
 *
 * Written from OUTSIDE React (the gestures lane calls `notePlayedTo` once, at
 * the release that sends the cast — before Forge has replied, so the card is
 * not on the battlefield yet). A plain `Map` write is invisible to React, but
 * nothing needs to wake a mounted `Board` early for it: the effect below
 * reads this map as one of its own dependencies change, and the next thing
 * that changes `viewer` IS Forge's reply adding the card to the battlefield —
 * the ordinary re-render that follows already re-examines it.
 */
/**
 * Where a card about to arrive on a player's battlefield goes — reserved from
 * the moment it was let go, for EITHER side, and always for the card let go:
 * the viewer's own from `notePlayedTo`, the other seat's from the act's own
 * `forge:placement` (`expectPlacement`). While one waits, the row
 * draws a real gap at that column (`data-expected`), the stand-in — the face
 * for its owner, the back for the opponent — glides into it, and the arrival
 * is drawn in that gap: the same on both screens, by construction.
 */
interface PendingPlacement {
  readonly cardId: number;
  /** Never `'hand'` — a cast lands on the battlefield by definition; see `notePlayedTo`. */
  readonly slot: BoardRow;
  readonly target: DropTarget;
  readonly expiresAt: number;
}
/** By player id: one card in flight per player at a time, which is what a hand can do. */
const PENDING_PLACEMENTS = new Map<number, PendingPlacement>();
/** The viewer of the live board, so `notePlayedTo` can key its placement by player. */
let LIVE_VIEWER_ID: number | null = null;
/** This render's own `matchKey(view)`, beside `LIVE_VIEWER_ID` for the same reason: `commitHandMove`'s seam into `ARRANGED` has no render of its own to read it from. */
let LIVE_MATCH_KEY: string | null = null;

/** Forget every pending placement. For a test that wants a clean slate, the same reason `forgetArrangements` exists. */
export function forgetPendingPlacements(): void {
  PENDING_PLACEMENTS.clear();
}

/**
 * Every slot of the viewer's own battlefield, read straight from the live DOM
 * — the same shape `useArrangeDrag`'s own `geometry()` reads (and the same
 * selector), but callable from OUTSIDE an active drag, which is what
 * `notePlayedTo`/`previewPlayedTo` need: a cast's release is not an arrange
 * gesture and has no `Press` of its own to read it from.
 */
/**
 * A battlefield row's column pitch — a card's width plus the gap after it —
 * read off any two neighbouring columns on the same battlefield, or one card
 * and the row's own gap. Null with no card drawn on that battlefield at all.
 */
function columnPitch(slotEl: HTMLElement): number | null {
  const field = slotEl.closest<HTMLElement>('[data-zone="battlefield"]');
  if (field === null) return null;
  // Two neighbouring columns measure the pitch exactly; one card and the list's own gap only estimate it.
  // No card at all (the first permanent of the game): a probe column, laid out by the grid's own
  // `grid-auto-columns`, is the width — otherwise the pitch is unknown, the column is 0, and the
  // first played card lands at the row's left whatever the release (ledger AE25, a regression).
  let estimate: number | null = null;
  let lists = 0;
  for (const list of field.querySelectorAll<HTMLElement>('.zone__cards')) {
    lists += 1;
    const items = list.querySelectorAll<HTMLElement>(':scope > li.board-card, :scope > li.zone__gap:not([data-virtual])');
    if (items.length >= 2) {
      const a = items[0]!.getBoundingClientRect();
      const b = items[1]!.getBoundingClientRect();
      if (b.left > a.left) return b.left - a.left;
    }
    if (items.length === 1 && estimate === null) {
      const a = items[0]!.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      if (a.width > 0) estimate = a.width + gap;
    }
  }
  if (estimate === null && lists > 0) {
    const list = field.querySelector<HTMLElement>('.zone__cards')!;
    const width = cardWidthIn(list);
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    if (width !== null) estimate = width + gap;
  }
  return estimate;
}

function liveViewerGeometry(): SlotGeometry[] {
  const out: SlotGeometry[] = [];
  for (const el of documentScope().querySelectorAll<HTMLElement>('.board .seat[data-viewer] [data-arrange-slot]')) {
    const named = el.getAttribute('data-arrange-slot') as ArrangeSlot;
    const list = el.matches('.zone__cards') ? el : el.querySelector<HTMLElement>(':scope > .zone__cards');
    const piles = [...(list?.querySelectorAll<HTMLElement>(':scope > li.board-card, :scope > li.zone__gap:not([data-virtual])') ?? [])].map((li) => ({
      id: li.classList.contains('zone__gap') ? null : Number(li.dataset.cardId),
      box: li.getBoundingClientRect(),
    }));
    out.push(withColumnsToWidth({ slot: named, box: el.getBoundingClientRect(), piles, step: columnPitch(el) }));
  }
  return out;
}

/**
 * The seam with the gestures lane's cast gesture (`live/gestures/cast.ts`):
 * where a cast's release said the resulting permanent should land, so it does
 * not simply join the end of its type row. Called exactly once per cast, at
 * the release — before Forge has replied, so the card is not on the
 * battlefield yet. Hit-tests `point` through the exact same `snapTo` an
 * arrange-drag's own indicator uses, against the live DOM. A point that hits
 * no slot, or hits `'hand'`, records nothing, same as a drag indicator going
 * `hidden`.
 *
 * `cardId` is the HAND card's own id, which IS the battlefield id it
 * arrives/sits under: Forge's `TrackableObject.id` is `final` and no code
 * path on a zone change reconstructs a `Card` (only token CREATION does, and
 * a token is never cast from a hand) — checked against
 * `forge/forge-game/src/main/java/forge/trackable/TrackableObject.java` and
 * the zone-change paths, not assumed.
 */
export function notePlayedTo(cardId: number, point: { x: number; y: number }): void {
  const at = placementAt(point);
  if (at === null || LIVE_VIEWER_ID === null) return;
  PENDING_PLACEMENTS.set(LIVE_VIEWER_ID, { cardId, slot: at.slot, target: at.target, expiresAt: Date.now() + PLACEMENT_WAIT_MS });
  for (const wake of MOUNTED_BOARDS) wake();
}

/** The column a release at `point` (client coordinates) means on the viewer's own battlefield, or null off it. */
export function placementAt(point: { x: number; y: number }): { slot: BoardRow; target: DropTarget } | null {
  const snap = snapTo(liveViewerGeometry(), point.x, point.y);
  // A cast lands ON THE BATTLEFIELD by definition — 'hand' is in the same
  // geometry list (the hand is arrangeable too) but is never a meaningful
  // target for "where a newly played permanent goes".
  if (snap === null || snap.slot === 'hand') return null;
  return { slot: snap.slot, target: snap.target };
}

/**
 * The OTHER seat let `cardId` go at this column of their battlefield (the act's
 * `forge:placement`): that card is placed there when it arrives, and the row
 * shows the gap until it does.
 */
export function expectPlacement(playerId: number, slot: string, target: DropTarget, cardId: number): void {
  if (!([...BOARD_ROWS, ...SINGLE_ROWS] as readonly string[]).includes(slot)) return;
  PENDING_PLACEMENTS.set(playerId, { cardId, slot: slot as BoardRow, target, expiresAt: Date.now() + PLACEMENT_WAIT_MS });
  for (const wake of MOUNTED_BOARDS) wake();
}

/** Their card `cardId` is still parked on their screen (a target, a payment): its column keeps waiting — see `PLACEMENT_WAIT_MS`. */
export function renewPlacement(playerId: number, cardId: number): void {
  const p = PENDING_PLACEMENTS.get(playerId);
  if (p !== undefined && p.cardId === cardId && p.expiresAt >= Date.now()) PENDING_PLACEMENTS.set(playerId, { ...p, expiresAt: Date.now() + PLACEMENT_WAIT_MS });
}

/** The ends of a play that leave nothing to arrive in the column its release reserved. */
const ENDS_WITHOUT_CARD = [
  // Home to the hand: a cancel, a park Forge never answered, a question about the card itself, Forge giving it back.
  'cancel',
  'floated-unanswered',
  'offered',
  'settled',
  'home',
  // Countered into a graveyard.
  'elsewhere',
  // The other seat's clocks giving up on it.
  'grace',
  'timeout',
] as const;
/** The ends that leave the column waiting: the card took it, or the play only moved on — onto the stack, behind the seat's next cast, off a screen that went away. */
type EndWithCardStillComing = 'landed' | 'drawn' | 'spell' | 'placement' | 'next-play' | 'disposed' | 'dispose';
/** How a play of a permanent stops being followed — the viewer's own park (`gestures/install.ts`) or the other seat's wait (`live/presence.ts`). */
export type PlayEnd = (typeof ENDS_WITHOUT_CARD)[number] | EndWithCardStillComing;
const WITHOUT_CARD: ReadonlySet<PlayEnd> = new Set(ENDS_WITHOUT_CARD);

/**
 * Either seat's play of `cardId` ended `how`. One that ended without its card gives up its column and the row
 * closes the gap; any other keeps it waiting until the card arrives or the clock runs out.
 */
export function endPlacement(playerId: number, cardId: number, how: PlayEnd): void {
  if (WITHOUT_CARD.has(how) && PENDING_PLACEMENTS.get(playerId)?.cardId === cardId) dropPlacement(playerId);
}

/** `playerId`'s placement stops waiting, and every mounted row redraws without its gap. */
function dropPlacement(playerId: number): void {
  PENDING_PLACEMENTS.delete(playerId);
  for (const wake of MOUNTED_BOARDS) wake();
}

/** The placement waiting for a player, if one is (tests, and the stand-ins' clean-up). */
export function pendingPlacementFor(playerId: number): { cardId: number; slot: BoardRow; target: DropTarget } | null {
  const p = PENDING_PLACEMENTS.get(playerId);
  return p === undefined || p.expiresAt < Date.now() ? null : { cardId: p.cardId, slot: p.slot, target: p.target };
}

/**
 * The reserved gap for a waiting placement: an empty pile in the row at the
 * target's column, by `withMove`'s own arithmetic, so the card lands exactly
 * where the gap was. A `stack` target reserves nothing (the card joins a pile).
 */
function withExpectedGap(rows: Grouped, row: BoardRow, target: DropTarget): { rows: Grouped; index: number } | null {
  if (target.kind === 'stack') return null;
  const into = [...rows[row]];
  let index: number;
  if (target.kind === 'at') {
    while (into.length < target.column) into.push([]);
    index = target.column;
    if (into.length === target.column) into.push([]);
    else if (into[target.column]!.length > 0) into.splice(target.column, 0, []);
  } else if (target.kind === 'end') {
    into.push([]);
    index = into.length - 1;
  } else {
    const at = into.findIndex((p) => p.some((c) => c.id === target.id));
    if (at === -1) {
      into.push([]);
      index = into.length - 1;
    } else {
      into.splice(at, 0, []);
      index = at;
    }
  }
  return { rows: { ...rows, [row]: into }, index };
}

/** The board a root holds (or is): the gestures layer's canvas sits around it, an arrange-drag's root is it. */
function boardIn(root: ParentNode): HTMLElement | null {
  return root instanceof HTMLElement && root.matches('.board') ? root : root.querySelector<HTMLElement>('.board');
}

/** The `<ul>` of cards a slot element holds (a tier is its own list, a lane holds one). */
function cardsOf(slotEl: HTMLElement): HTMLElement | null {
  return slotEl.matches('.zone__cards') ? slotEl : slotEl.querySelector<HTMLElement>(':scope > .zone__cards');
}

/**
 * The placement scaffold — the one thing drawn while a card the viewer moves could land on their
 * battlefield, a rearrange and a permanent carried out of the hand alike: every column of every one of
 * the VIEWER's rows (`board.css`, `[data-placing]`) — the gaps a row holds, and one empty column for each
 * more that fits the row whole. The other seat's rows are never part of it: no card of theirs is ours to
 * place. Idempotent, so a gesture may call it on every move.
 */
export function showPlacementColumns(root: ParentNode): void {
  const board = boardIn(root);
  if (board === null || board.hasAttribute('data-placing')) return;
  board.setAttribute('data-placing', '');
  for (const el of board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot]')) {
    const list = cardsOf(el);
    if (list === null) continue;
    const items = list.querySelectorAll<HTMLElement>(':scope > li.board-card, :scope > li.zone__gap');
    const last = items.length === 0 ? null : items[items.length - 1]!.getBoundingClientRect().right;
    const box = list.getBoundingClientRect();
    const style = getComputedStyle(list);
    const row = { left: box.left + (Number.parseFloat(style.paddingLeft) || 0), right: box.right - (Number.parseFloat(style.paddingRight) || 0) };
    const n = virtualColumns(row, last, items.length, cardWidthIn(list), Number.parseFloat(style.columnGap) || 0);
    for (let i = 0; i < n; i += 1) {
      const li = document.createElement('li');
      li.className = 'zone__gap';
      li.setAttribute('data-gap', '');
      li.setAttribute('data-virtual', '');
      li.setAttribute('aria-hidden', 'true');
      list.append(li);
    }
  }
}

/** The scaffold off again: a release, a cancel, or the carried card back over the hand. */
export function clearPlacementColumns(root: ParentNode): void {
  const board = boardIn(root);
  if (board === null) return;
  board.removeAttribute('data-placing');
  for (const li of board.querySelectorAll('li.zone__gap[data-virtual]')) li.remove();
}

/**
 * The column a snap lands in, as drawn: the gap or scaffold column it fills (`at`, and `end` where the
 * row has room past its last card), else the card it goes before or onto.
 */
function snapColumn(board: HTMLElement, snap: Snap): Element | null {
  const slotEl = [...board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-arrange-slot]')].find((el) => el.getAttribute('data-arrange-slot') === snap.slot);
  const list = slotEl === undefined ? null : cardsOf(slotEl);
  if (list !== null && snap.target.kind === 'at') return list.querySelectorAll(':scope > li.board-card, :scope > li.zone__gap')[snap.target.column] ?? null;
  const past = list !== null && snap.target.kind === 'end' ? list.querySelector(':scope > li.zone__gap[data-virtual]') : null;
  if (past !== null) return past;
  return snap.card === null ? null : board.querySelector(`.seat[data-viewer] li.board-card[data-card-id="${snap.card}"]`);
}

/**
 * Where a release would land, drawn: the indicator bar at the snap and its column marked
 * (`data-arrange-target`); `null` hides both. Returns what it marked, for the next call to clear.
 */
function drawSnap(board: HTMLElement, bar: HTMLElement, snap: Snap | null, marked: readonly Element[]): Element[] {
  for (const el of marked) el.removeAttribute('data-arrange-target');
  if (snap === null || snap.slot === 'hand') {
    bar.setAttribute('hidden', '');
    return [];
  }
  const box = board.getBoundingClientRect();
  bar.removeAttribute('hidden');
  bar.setAttribute('data-arrange-kind', snap.kind);
  bar.setAttribute('data-arrange-slot', snap.slot);
  bar.style.width = `${snap.bar.width}px`;
  bar.style.height = `${snap.bar.height}px`;
  bar.style.left = `${snap.bar.left - box.left}px`;
  bar.style.top = `${snap.bar.top - box.top}px`;
  const column = snapColumn(board, snap);
  if (column === null) return [];
  column.setAttribute('data-arrange-target', snap.kind);
  return [column];
}

/**
 * The cast gesture's half of the placement preview (`live/gestures/install.ts`): call on every pointer
 * move while a castable card is lifted over the battlefield; `null` clears it (release, Escape, leaving
 * the battlefield). The same indicator bar and column mark an arrange-drag draws (`drawSnap`), on the
 * scaffold the gesture put up (`showPlacementColumns`, via `cast.ts`'s drop cues). The bar is created
 * once and reused, and re-parented if `Board` itself remounted since the last call.
 */
let previewEl: HTMLElement | null = null;
let previewMarked: Element[] = [];
export function previewPlayedTo(point: { x: number; y: number } | null): void {
  const board = documentScope().querySelector<HTMLElement>('.board');
  if (board === null) return;
  if (previewEl === null) {
    previewEl = document.createElement('div');
    previewEl.setAttribute('data-arrange-indicator', '');
    previewEl.setAttribute('aria-hidden', 'true');
    previewEl.setAttribute('hidden', '');
  }
  if (!board.contains(previewEl)) board.append(previewEl);
  previewMarked = drawSnap(board, previewEl, point === null ? null : snapTo(liveViewerGeometry(), point.x, point.y), previewMarked);
}

/**
 * The arrangement after a drag: `cardId` lands in `row`, at `target`. Several ids are a whole pile
 * carried at once (a long press, `useArrangeDrag`), bottom first: they land together, as one pile in
 * that order, wherever one card would.
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
export function withMove(
  rows: Grouped,
  playerId: number,
  arranged: Arrangement,
  cardId: number | readonly number[],
  row: BoardRow,
  target: DropTarget,
  layout: BoardLayout,
): Arrangement {
  const moving = typeof cardId === 'number' ? [cardId] : [...cardId];
  const carried = new Set(moving);
  const active = rowsForLayout(layout);
  const piles: Record<BoardRow, number[][]> = emptyRows();
  // A gap the player left stays a gap. So does the column a card leaves within its own row, so that no
  // column of that row moves because another one emptied — a card placed at a column (Z8), or stacked onto
  // a pile (the operator, 2026-10-13: a lone card stacked onto the pile to its right moved the pile one
  // column left). Only a reorder closes it up: the card takes a column of its own in the row (`before`,
  // `end`), so the row is the same columns re-ordered. A card that leaves the row closes its column too.
  const keepsColumn = target.kind !== 'before' && target.kind !== 'end';
  for (const r of active) {
    piles[r] = rows[r]
      .map((p) => ({ was: p.length, ids: p.map((c) => c.id).filter((id) => !carried.has(id)) }))
      .filter((p) => p.was === 0 || p.ids.length > 0 || (keepsColumn && r === row))
      .map((p) => p.ids);
  }
  const into = piles[row];
  if ((target.kind === 'before' || target.kind === 'stack') && carried.has(target.id)) {
    // Dropped back on its own column: it stays exactly where it was.
    for (const r of active) piles[r] = rows[r].map((p) => p.map((c) => c.id));
  } else if (target.kind === 'at') {
    while (into.length < target.column) into.push([]);
    if (into.length === target.column) into.push(moving);
    else if (into[target.column]!.length === 0) into[target.column] = moving;
    else into.splice(target.column, 0, moving);
  } else if (target.kind === 'end') {
    into.push(moving);
  } else {
    const index = into.findIndex((p) => p.includes(target.id));
    if (index === -1) into.push(moving);
    else if (target.kind === 'before') into.splice(index, 0, moving);
    else {
      const pile = into[index]!;
      const at = pile.indexOf(target.id);
      pile.splice(target.onTop ? at + 1 : at, 0, ...moving);
    }
  }
  // Trailing gaps hold no column anyone can see; only the ones between cards stay.
  for (const r of active) while (piles[r].length > 0 && piles[r][piles[r].length - 1]!.length === 0) piles[r].pop();
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
export function handOrder(cards: readonly BoardCard[], playerId: number, arranged: Arrangement): readonly BoardCard[] {
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
 *
 * Takes the current order as bare ids, not `BoardCard[]` — `live/gestures/hand.ts`
 * reads its own order straight off the DOM (`data-card-id`) and has no card
 * objects to hand back; `handOrder`'s own callers still pass `.map((c) => c.id)`.
 */
export function withHandMove(
  orderedIds: readonly number[],
  playerId: number,
  arranged: Arrangement,
  cardId: number,
  target: DropTarget,
): Arrangement {
  const ids = orderedIds.filter((id) => id !== cardId);
  const at = target.kind === 'before' ? ids.indexOf(target.id) : -1;
  if (at === -1) ids.push(cardId);
  else ids.splice(at, 0, cardId);
  return { ...arranged, [slotKey(playerId, 'hand')]: ids.map((id) => [id]) };
}

/**
 * A hand reorder committed from OUTSIDE React — `live/gestures/hand.ts`'s own
 * seam into the arrangement store, the same shape `notePlayedTo` already uses
 * for a cast's landing spot: a dumb write into the module-level store, keyed
 * by the match and seat this render last saw (`LIVE_MATCH_KEY`/`LIVE_VIEWER_ID`,
 * refreshed every render beside each other), then every mounted board is woken.
 * A spectator, or a render that has not happened yet, has nothing to key by and
 * the call is a no-op.
 */
export function commitHandMove(orderedIds: readonly number[], cardId: number, target: DropTarget): void {
  if (LIVE_VIEWER_ID === null || LIVE_MATCH_KEY === null) return;
  const key = LIVE_MATCH_KEY;
  const viewerId = LIVE_VIEWER_ID;
  setArranged(key, viewerId, withHandMove(orderedIds, viewerId, arrangementFor(key, viewerId), cardId, target));
  for (const wake of MOUNTED_BOARDS) wake();
}

/**
 * The drag, as the markup sees it: a marker, present only on the viewer's own
 * side. Every other zone gets `undefined` and renders no drag affordance and
 * no slot box.
 *
 * It carries nothing because nothing in the markup runs the drag any more: the
 * pointer events are `Board`'s own, on `window` (`useArrangeDrag`), and the markup
 * only says WHICH cards are pick-up-able (`data-arrange-card`, never a hand
 * card — see `CardOnBoard`'s `arrangeable`) and which boxes are slots
 * (`data-arrange-slot`, the hand's own included: a cast's placement preview,
 * `liveViewerGeometry`, still needs it to know a point is OVER the hand, not a
 * legal drop).
 */
interface Arranging {
  readonly enabled: true;
}

const ARRANGING: Arranging = { enabled: true };

/**
 * A planeswalker's loyalty, drawn the way a creature's power and toughness
 * are: the same badge `PowerToughness` draws below, reusing its classes
 * wholesale (`.board-card__pt`, `.board-card__pt-n`) rather than a new one.
 *
 * `adapter.ts`'s `toBoardCard` already keeps `card.loyalty` CURRENT — a
 * loyalty counter when the battlefield has one, the printed value before it
 * ever does — so there is nothing to compute here. One number, not two, and
 * no `data-pt-state` (plain): our own data never carries a planeswalker's
 * PRINTED loyalty through to here (only `card.power`/`toughness` get a
 * `printed` baseline, `adapter.ts`'s `POOL_PRINTED_PT`), so there is nothing
 * to compare the current number against — unlike a creature's buffed/hurt
 * ink, "changing" here means only that the number on the board updates when
 * Forge's own counter does, not that it is coloured by how.
 */
function Loyalty({ entry }: { entry: BoardCard }) {
  const loyalty = Number(entry.card.loyalty);
  if (!Number.isFinite(loyalty)) return null;
  return (
    <span className="board-card__pt" data-pt="loyalty" aria-label={`loyalty ${loyalty}`} data-tip={`Loyalty ${loyalty}`}>
      <span className="board-card__pt-n" data-pt-of="loyalty">
        {loyalty}
      </span>
    </span>
  );
}

/**
 * A creature's power and toughness, as the operator asked for them (#12, #18):
 * *"3 (blue) / 1 (red)"* — the current power, and what is LEFT of the toughness.
 * Damage is drawn here and nowhere else: a 4/5 Tarmogoyf dealt 3 reads `4/2`,
 * the 2 in the danger ink with no marker (the operator, 2026-10-11, *"just show
 * 4/2(red)"*), and its accessible name says the toughness and the damage.
 *
 * `adapter.ts`'s `boardPT` decides what the numbers mean; this draws them. It
 * is the board's own badge rather than the tile's `.card__stat`, because the art
 * covers the tile and the printed stat with it, and because `CardTile` is not
 * this lane's file.
 *
 * A card whose printed base our data does not know draws PLAIN — no ink, no
 * marker — and never claims a buff it cannot know about.
 *
 * A planeswalker draws its {@link Loyalty} instead — and both, when it is a
 * creature too (Gideon on his own turn): `adapter.ts` sets `card.power` off
 * Forge's current type line, so the badges follow the effect that made it one.
 */
function PowerToughness({ entry }: { entry: BoardCard }) {
  if (entry.card.loyalty === undefined) return <CreaturePT entry={entry} />;
  return (
    <>
      <Loyalty entry={entry} />
      {entry.card.power !== undefined && <CreaturePT entry={entry} />}
    </>
  );
}

function CreaturePT({ entry }: { entry: BoardCard }) {
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
        data-tip={`${entry.damage} damage marked`}
      >
        <span className="board-card__pt-n" data-pt-state="hurt" data-pt-of="damage">
          {entry.damage}
        </span>
      </span>
    );
  }
  const say = (what: string, value: number, state: PTState): string =>
    state === 'buffed'
      ? `${what} ${value}, up from ${what === 'power' ? pt.printed?.power : pt.printed?.toughness}`
      : state === 'hurt'
        ? `${what} ${value}, down`
        : state === 'damaged'
          ? `${what} ${value + pt.damage}, ${pt.damage} damage marked`
          : `${what} ${value}`;
  const number = (value: number, state: PTState, which: string) => (
    <span className="board-card__pt-n" data-pt-state={state === 'plain' ? undefined : state} data-pt-of={which}>
      {value}
    </span>
  );
  const said = `${say('power', pt.power, pt.powerState)}, ${say('toughness', pt.toughness, pt.toughnessState)}`;
  return (
    <span
      className="board-card__pt"
      data-pt=""
      /* Damage, on the badge that carries it — the badge itself reads hurt, so a
         damaged creature is visible before anyone reads the two numbers. */
      data-damage={pt.damage > 0 ? pt.damage : undefined}
      aria-label={said}
      data-tip={said.charAt(0).toUpperCase() + said.slice(1)}
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
 * show that. actually all the text you have written on the card looks
 * ugly, we need to find a way to handle all of that with effects."*
 *
 * What was here was one function that turned seven states into STRINGS and
 * dropped them on a ~70px tile over real art: `tapped`, `summoning sick`,
 * `attacking`, `blocking`, `3 damage`, `token`, `1 +1/+1`. Every one of them is
 * now a treatment — or, for `token`, nothing at all (the operator, 2026-10-14:
 * "let's just get rid of the token indicator, its noise") — and each treatment
 * is in a DIFFERENT CHANNEL, which is the constraint that made this a design
 * problem rather than a CSS one:
 *
 * | state | channel | why not something else |
 * | --- | --- | --- |
 * | tapped, attacking | a quarter turn (`card.css`) | the convention, and Forge's own. An attacker reads as tapped because that is what the operator asked for in item 6 and because Forge taps it a moment later anyway |
 * | damage | the P/T badge's own ink (`PowerToughness`) | the number that matters is what is LEFT, and the badge already holds it |
 * | counters | a numbered badge, bottom-left | `+1/+1` is the common case and gets the compact `+3`; anything else falls back to its name |
 * | summoning sick | a corner mark, a drawn crescent, and nothing over the art (the operator, 2026-10-15: "let's drop the dashed summoning sickness on the art, not needed") | a mark is a shape, so it cannot be confused with any outline |
 * | attacking | a corner mark, drawn crossed swords, beside the quarter turn and the danger outline (the operator, 2026-10-15: "let's show a 'crossed swords' pill icon on top of cards that have been selected as attackers") | Forge's own `Attacking`: on the attacker's screen from the click that picks it, on every other screen once the attack is locked in (`adapter.ts`'s `toBoardView`), until combat ends or it is called back |
 * | blocking | a corner mark, a drawn shield, and an outline in the theme's success (`card.css`), as the attacker's is in its danger | the operator asked for its own colour (2026-10-10) |
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
 * background.
 */

/** A state that draws as a corner mark. The rest of them draw as themselves. */
type StateMark = 'sick' | 'cantBlock' | 'attacking' | 'blocking';

/**
 * The marks, as geometry we drew rather than a typeface that might not have the
 * character. 16×16,
 * currentColor, no image and nothing that could be mistaken for a WotC mark.
 */
const MARK_ART: Readonly<Record<StateMark, string>> = {
  /* A crescent: this one is asleep. */
  sick: 'M10.6 2.2a6 6 0 1 0 3.2 9.9A7 7 0 0 1 10.6 2.2Z',
  /* The shield, hollow and struck through: this one can't be in the way. */
  cantBlock:
    'M8 1.6l5.4 2v4.3c0 3.2-2.3 5.6-5.4 6.5-3.1-.9-5.4-3.3-5.4-6.5V3.6Z M8 3.3L4.2 4.7V7.9c0 2.3 1.6 4.1 3.8 4.8 2.2-.7 3.8-2.5 3.8-4.8V4.7Z M1.4 13.5L13.5 1.4l1.1 1.1L2.5 14.6Z',
  /* Two swords crossed, points up: this one is on the attack. */
  attacking:
    'M13.2 2.8 13.1 4.5 7.2 10.4 5.6 8.8 11.5 2.9Z M4.3 7.5 8.5 11.7 7.6 12.7 3.3 8.4Z M5 10.1 5.9 11 4.4 12.5 3.5 11.6Z M3.1 11.2 4.8 12.9 3.8 13.9 2.1 12.2Z M2.8 2.8 4.5 2.9 10.4 8.8 8.8 10.4 2.9 4.5Z M7.5 11.7 11.7 7.5 12.7 8.4 8.4 12.7Z M10.1 11 11 10.1 12.5 11.6 11.6 12.5Z M11.2 12.9 12.9 11.2 13.9 12.2 12.2 13.9Z',
  /* A shield: this one is in the way. */
  blocking: 'M8 1.6l5.4 2v4.3c0 3.2-2.3 5.6-5.4 6.5-3.1-.9-5.4-3.3-5.4-6.5V3.6Z',
};

const MARK_WORD: Readonly<Record<StateMark, string>> = {
  sick: 'summoning sick',
  cantBlock: "can't block",
  attacking: 'attacking',
  blocking: 'blocking',
};

/**
 * The marks a card wears, in a fixed order so two cards in a row read the same
 * way. The word rides along visually hidden (`card.css`): the picture is for
 * the player and the word is for anything that cannot see it, which is the same
 * split the P/T badge makes between its marker glyph and its accessible name.
 *
 * R15 USED to add a fourth mark here (`changed`, wave 35) — a corner icon
 * reading "changed from X" in its title and accessible word. Wave 53 T drops
 * it: the operator asked again in Playtest 9 for the SAME fact, explicitly as
 * "a pill over the type bar" rather than a corner glyph, so `TypePill` below
 * replaces it rather than running alongside it — one signal for one fact, not
 * two for the same one.
 */
function StateMarks({ entry }: { entry: BoardCard }) {
  const marks: StateMark[] = [];
  if (entry.summoningSick) marks.push('sick');
  if (entry.cantBlock === true) marks.push('cantBlock');
  if (entry.attacking) marks.push('attacking');
  if (entry.blocking) marks.push('blocking');
  if (marks.length === 0) return null;
  return (
    <ul className="board-card__marks" aria-label={`${entry.card.name} status`}>
      {marks.map((mark) => (
        <li key={mark} className="board-card__mark" data-mark={mark} data-tip={MARK_TIP[mark]}>
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

function Counters({
  entry,
  timeFirst = false,
}: {
  entry: BoardCard;
  /**
   * In exile, a suspended card's `Time` counter is the one fact that answers
   * "how long is left" — the operator's own case (Ancestral Vision) — so it
   * leads whatever else is on the card there. `Array.prototype.sort` is
   * stable, so this only moves `Time` counters forward and leaves every other
   * pair in the order Forge sent them.
   */
  timeFirst?: boolean;
}) {
  const counters = entry.counters.filter((c) => c.count !== 0);
  if (counters.length === 0) return null;
  const ordered = timeFirst
    ? [...counters].sort((a, b) => Number(b.name === 'Time') - Number(a.name === 'Time'))
    : counters;
  return (
    <ul
      className="board-card__counters"
      aria-label={`${entry.card.name} counters: ${ordered.map((c) => `${c.count} ${c.name}`).join(', ')}`}
    >
      {ordered.map((c) => (
        <li
          key={c.name}
          className="board-card__counter"
          data-counter={counterKind(c.name)}
          data-count={c.count}
          data-tip={`${c.count} ${c.name} counter${Math.abs(c.count) === 1 ? '' : 's'}`}
        >
          <span aria-hidden="true">{counterFace(c)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The card's top-right tag column, in this order: what a resolved ability left
 * waiting, the state Forge tracks a permanent is in, a held card's changed cost,
 * what was chosen for a permanent, a flash an effect grants a held card, an eye
 * on a held card the opponent was shown, then each evergreen keyword the card
 * has NOW and was not printed with.
 *
 *   - Held changes (`BoardInteraction.held`), the operator: *"can we display
 *     modified costs on cards in hand using our applied overlay tags? should
 *     apply to anything that modifies anything in hand"*. The cost tag is its
 *     pips and sits over the printed cost it replaces.
 *
 *   - Choices, the operator, 2026-10-12: *"any card that selects a color or
 *     makes a decision that becomes a permanent thing about it on the
 *     battlefield should recieve a visual indicator."* `adapter.ts`'s
 *     `choices` — every choice property Forge tracks on the card
 *     (`CHOICE_PROPS`) — one tag each; a colour is its mana symbol, anything
 *     else its words.
 *   - States, the operator, 2026-10-21: *"class cards should show their
 *     current level as a pip"*. `adapter.ts`'s `states` (`STATE_PROPS`), one
 *     tag each: a pip per step when Forge's card names the top, the reached
 *     ones filled, else the number in the same count a collapsed mark wears.
 *   - Keywords, the operator: *"a tag on the creature when they gain
 *     flying."* (`keywordTags`).
 *   - Seen, the operator, 2026-10-15: *"much like how we created a pill for
 *     cost reduction in hand, let's also create an 'eye' pill for cards that
 *     have been revealed to your opponent"* (`BoardCard.seenByOpponent`), on a
 *     card in your hand or your library's revealed top.
 *
 * Every tag says on hover (`data-tip`, the board's one tooltip) what it is.
 */
function CardTags({
  entry,
  choices,
  states,
  waiting,
  held,
  seen = false,
}: {
  entry: BoardCard;
  choices: readonly BoardCardChoice[];
  /** What Forge tracks the permanent is in (`BoardCard.states`). */
  states: readonly BoardCardState[];
  waiting: readonly BoardCardWaiting[];
  held?: HeldTags;
  /** Draw the eye: a card of the viewer's the opponent was shown (`BoardCard.seenByOpponent`). */
  seen?: boolean;
}) {
  const keywords = keywordTags(entry.keywords, entry.card.oracleText);
  const cost = held?.cost;
  const flash = held?.flash;
  if (choices.length === 0 && states.length === 0 && waiting.length === 0 && keywords.length === 0 && cost === undefined && flash === undefined && !seen) return null;
  const waits = sameMarks(waiting, (w) => w.kind).map((group) => ({ kind: group[0]!.kind, count: group.length, tip: listed(group.map(waitingTip)) }));
  const said = [
    ...waits.map((w) => w.tip),
    ...states.map(stateTip),
    ...(cost === undefined ? [] : [`costs ${cost.tokens.join(' ')}`]),
    ...choices.map(choiceTip),
    ...(flash === undefined ? [] : ['Flash']),
    ...(seen ? [SEEN_TIP] : []),
    ...keywords,
  ];
  return (
    <ul className="board-card__tags" aria-label={`${entry.card.name}: ${said.join('; ')}`}>
      {waits.map((w) => (
        <li key={w.kind} className="board-card__tag" data-effect={w.kind} data-count={w.count > 1 ? w.count : undefined} data-tip={w.tip}>
          <svg className="board-card__effect-glyph" viewBox="0 0 16 16" focusable="false" aria-hidden="true">
            <path d="M4 1h8v1.5c0 2-1.4 3.6-3 4.5v2c1.6.9 3 2.5 3 4.5V15H4v-1.5c0-2 1.4-3.6 3-4.5V7C5.4 6.1 4 4.5 4 2.5Z" />
          </svg>
          {w.count > 1 && (
            <span className="board-card__tag-count" aria-hidden="true">
              {w.count}
            </span>
          )}
        </li>
      ))}
      {states.map((state) => (
        <li key={state.kind} className="board-card__tag" data-state={state.kind} data-value={state.value} data-max={state.max} data-tip={stateTip(state)}>
          {state.max === undefined || state.value > state.max ? (
            <span className="board-card__tag-count">{state.value}</span>
          ) : (
            Array.from({ length: state.max }, (_, i) => <span key={i} className="board-card__state-pip" data-filled={i < state.value ? '' : undefined} aria-hidden="true" />)
          )}
        </li>
      ))}
      {cost !== undefined && (
        <li className="board-card__tag" data-cost={cost.tokens.join(' ')} data-cost-change={cost.change} data-tip={cost.tip}>
          {cost.tokens.map((token, i) => (
            <ManaPip key={`${token}-${i}`} token={token} />
          ))}
        </li>
      )}
      {choices.map((choice, i) => (
        <li key={`${choice.kind}:${i}`} className="board-card__tag" data-choice={choice.kind} data-tip={choiceTip(choice)}>
          {choice.kind === 'color' ? choice.values.map((word) => <ChoiceWord key={word} word={word} />) : choice.values.join(', ')}
        </li>
      ))}
      {flash !== undefined && (
        <li className="board-card__tag" data-keyword="flash" data-tip={flash}>
          Flash
        </li>
      )}
      {seen && (
        <li className="board-card__tag" data-seen data-tip={SEEN_TIP}>
          <svg className="board-card__seen-glyph" viewBox="0 0 16 16" focusable="false" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8 3C4.4 3 1.6 5.4.5 8c1.1 2.6 3.9 5 7.5 5s6.4-2.4 7.5-5C14.4 5.4 11.6 3 8 3Zm0 1.9a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Zm0 1.7a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z"
            />
          </svg>
        </li>
      )}
      {keywords.map((tag) => (
        <li key={tag} className="board-card__tag" data-keyword={tag.toLowerCase()} data-tip={keywordTip(tag)}>
          {tag}
        </li>
      ))}
    </ul>
  );
}

/**
 * The operator, 2026-10-20: *"once the white hourglass happens more than once, let's just display it
 * once and show a number next to it that we increment rather than continuing to stack the icon
 * lower."* Marks that draw the same (`key`) are one group, in the order each first appears, so the
 * card wears one mark per kind and a count beside it; Kappa Cannoneer's third "can't be blocked this
 * turn" is a 3, not a third hourglass down the card.
 */
function sameMarks<T>(marks: readonly T[], key: (mark: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const mark of marks) groups.set(key(mark), [...(groups.get(key(mark)) ?? []), mark]);
  return [...groups.values()];
}

/** One line per distinct line, with how many times it was said: what a collapsed mark's tip lists. */
function listed(lines: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, n]) => (n > 1 ? `${line} (×${n})` : line)).join('\n');
}

/** A chosen colour: the Mana font's own symbol (D20), or the word when it names none. */
function ChoiceWord({ word }: { word: string }) {
  const token = colorWordToken(word);
  return token === null ? <>{word}</> : <ManaPip token={token} />;
}

/**
 * R15 (wave 53 T), the operator, Playtest 9: *"cards like 'Magus of the moon'
 * and 'Urborg tomb of yawgmoth' change the types of cards. i need this to be
 * visually indicated by a tag of some kind … put one of our overlay pills
 * over the type bar."*
 *
 * `entry.changedFrom` is `adapter.ts`'s own comparison — the wire's CURRENT
 * `Type` against the PRINTED type line Forge names for it (`PlayBridge.java`'s
 * `printedTypes`) — set only when they disagree, a token's line led by `Token` on either side. The
 * pill's own visible text is the CURRENT type line — Forge's words, read live — so a glance says
 * what the permanent IS now, a token copy drawn with its card's art included;
 * hovering it (its `data-tip`, the board's one tooltip, `tip/index.ts`) says
 * what it was PRINTED as.
 *
 * Positioned over the type bar — roughly where `CardTile`'s own `.card__type`
 * sits, just under the name row — rather than in a free corner: the marks
 * (top-left), the tag column (top-right), the counters (bottom-left)
 * and the P/T badge (bottom-right) all stay exactly where they were.
 */
function TypePill({ entry }: { entry: BoardCard }) {
  const changed = entry.changedFrom;
  if (changed == null) return null;
  return (
    <span className="board-card__type-pill" data-tip={`Printed as ${changed.printed}`}>
      {changed.current}
    </span>
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
 * different, and only inside its own box (`card.css` fans and offsets within
 * one card's width — nothing about a pile changes the slot it is in).
 *
 * **Every card in the pile gets the SAME `--pile-fan`, set inline, from the
 * pile's own size.** `card.css`'s own comment next to
 * `.board-card[data-pile-size]` says every card in a pile is narrowed by the
 * whole fan, but its `:has()` selectors only ever reach the BASE card: the
 * default rule `.board-card { --pile-fan: 0px }` matches every nested pile
 * member too and wins there — custom properties are per-element, and a
 * selector matching the element itself always beats an ancestor's inherited
 * value. Left to that cascade, a fanned member draws at its full,
 * un-narrowed width and runs past the pile's own box. Computing the fan once
 * here and setting it as an inline style on every `<li>` of the pile sidesteps
 * the cascade entirely — inline always wins over a class rule for the same
 * element — so `card.css` needs no change for this.
 */
/** `card.css`'s `--stack-step` on `.board-card[data-pile-size]`. Keep the two in sync. */
const STACK_STEP = 8;
/** Forge's `UI_MAX_STACK_DEPTH` (4 cards total), less the base card itself. */
const MAX_FAN_DEPTH = 3;


function CardOnBoard({
  entry,
  interaction,
  arranging,
  slot,
  pile,
  /** How many cards the WHOLE pile holds, base included. Absent for a lone card. */
  pileSize,
  depth = 0,
  inExile = false,
  libraryTop = false,
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
  /** How many cards the whole pile holds, base included. Absent for a lone card. */
  pileSize?: number;
  /** 0 for the bottom of a pile, 1 for the card on it, and so on. */
  depth?: number;
  /**
   * This card sits in an exile pile. The operator: *"ancestral visions is a
   * card placed into exile with suspend counters. we need a way to visualize
   * cards in exile with counters on them."* Exile is not a battlefield, so
   * none of the other state marks (summoning sick, attacking, blocking) mean
   * anything there — only the counters do, because a suspended card's time
   * counters are the one fact about it a player needs to see without opening
   * the inspector.
   */
  inExile?: boolean;
  /** The library's top card, drawn under its owner's avatar while the seat may see it — not a permanent. */
  libraryTop?: boolean;
}) {
  const selectable = interaction !== undefined && interaction.selectable.has(entry.id);
  /** This card is one Forge already marked picked, not merely offered — see `BoardInteraction.highlighted`. */
  const picked = interaction !== undefined && (interaction.highlighted?.has(entry.id) ?? false);
  const previewed = interaction?.damagePreview?.get(entry.id) ?? 0;
  /*
   * A card Forge is ASKING ABOUT belongs to Forge, and that — not "actionable" —
   * is what the arrangement stands down on.
   *
   * Why it has to stand down at all: the two gestures on this board are not
   * exclusive on their own. The interaction lane starts its targeter drag on
   * `pointerdown` over a card in `interaction.selectable`
   * (`live/gestures/install.ts`), and `useArrangeDrag` ALSO starts from the
   * same press on a `data-arrange-card` — so one press would both rearrange
   * the board and send a `selectCard` on release.
   *
   * Why the condition is `selectionOpen && selectable` and not `selectable`:
   * `selectable` also carries Forge's ACTIONABLE set (`setWeaklySelectable`),
   * which on your own turn is most of your own lands and creatures. Gating on
   * that made the board unarrangeable for most of a game — the opposite of
   * *"i dont want these snapping zones… put cards wherever they want"*, and
   * `e2e/table-fit.spec.ts` red on it: a permanent it dragged between rows was
   * not arrangeable, so the drag never started and the card did not move. An
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
  /** The one piece of the state layer that also reads off the battlefield — see `inExile`. */
  const showCounters = onBattlefield || inExile;
  const itsAttackToDeclare =
    interaction?.declaringAttackers === true && onBattlefield && permanentType(entry) === 'creatures';
  /**
   * Whether this card may be PICKED UP. Whether a card may be DROPPED ON is a
   * different question and needs no markup: the snap reads every pile's box in the
   * slot, pinned cards included, so a card the player cannot pick up is still a
   * place they can put one.
   *
   * Never a hand card: dragging one out of hand onto the battlefield is how a
   * land or a spell is played, and a press on it — Forge-offered or not — is
   * `live/gestures/install.ts`'s own gesture now, never this component's. A
   * hand card still arranges (the header's "The hand is arranged too" has the
   * argument), just not through this attribute.
   */
  const arrangeable = arranging !== undefined && slot !== undefined && slot !== 'hand' && !inOpenSelection && !itsAttackToDeclare;
  const above = pile === undefined ? [] : pile.slice(1);
  /*
   * The fan every card in the pile is narrowed by, computed ONCE from the
   * pile's own size and set inline on every card of it — base and fanned
   * alike — so `card.css`'s `--pile-fan` cascade (which only ever reached the
   * base card; see this function's own header) cannot leave a member at its
   * full, un-narrowed width. `STACK_STEP`/`MAX_FAN_DEPTH` mirror `card.css`'s
   * `--stack-step: 8px` and Forge's `UI_MAX_STACK_DEPTH` (4 cards: the base
   * plus 3 fanned) exactly — if either changes there, it must change here too.
   */
  const pileFan = pileSize === undefined || pileSize <= 1 ? 0 : Math.min(pileSize - 1, MAX_FAN_DEPTH) * STACK_STEP;
  const copies = pile === undefined ? null : copiesIn(pile);
  const flying = onBattlefield && hasKeyword(entry.keywords, 'flying');
  /** Where in its loop a flyer is (`card.css`'s `--fly-phase`, 0–1): from its id, so two never move in step, and the same on both screens. */
  const flyPhase = flying ? (((entry.id * 0.618034) % 1) + 1) % 1 : undefined;
  /** An effect forbids casting this held card (`BoardInteraction.castForbidden`): drawn greyed, and its tip says why. */
  const forbidden = onBattlefield ? undefined : interaction?.castForbidden?.get(entry.id);
  /** A Room on the battlefield is drawn as its doors — see `RoomDoors`. */
  const doors = onBattlefield && entry.hidden !== true ? roomDoors(entry) : null;

  return (
    <li
      className="board-card"
      style={
        pileFan > 0 || flyPhase !== undefined
          ? ({
              ...(pileFan > 0 && { '--pile-fan': `${pileFan}px` }),
              ...(flyPhase !== undefined && { '--fly-phase': flyPhase.toFixed(4) }),
            } as CSSProperties)
          : undefined
      }
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
      /* Attacking does not tap it, so `card.css` does not turn it for attacking. */
      data-vigilant={hasKeyword(entry.keywords, 'vigilance') || undefined}
      /* Loops on the wing (`card.css`): a flyer, by Forge's current keywords. */
      data-flying={flying || undefined}
      data-blocking={entry.blocking || undefined}
      data-board-card={entry.id}
      data-card-id={entry.id}
      data-selectable={selectable || undefined}
      /* A picked card keeps `data-selectable` too — see `BoardInteraction.highlighted`'s own note. */
      data-picked={picked || undefined}
      data-block-focus={(interaction?.blockFocus === entry.id) || undefined}
      data-combat-ready={(onBattlefield && (interaction?.combatReady?.has(entry.id) ?? false)) || undefined}
      /* Item 16 — see `BoardInteraction.actionable`'s own note. */
      data-can-act={(interaction?.actionable?.has(entry.id) ?? false) || undefined}
      data-library-top={libraryTop || undefined}
      data-only-viewer={(libraryTop && entry.onlyViewer === true) || undefined}
      data-cast-forbidden={forbidden === undefined ? undefined : ''}
      data-tip={forbidden}
      data-refused={interaction?.refused?.card === entry.id ? (interaction.refused.seq % 2 === 0 ? 'even' : 'odd') : undefined}
      /* Forge says this card is attached to something: not the player's doing. */
      data-attached={(entry.attachedToId ?? null) !== null || undefined}
      data-pile-size={above.length > 0 ? pile!.length : undefined}
      data-pile-depth={depth > 0 ? depth : undefined}
      /*
       * The slot the card is in, on exactly the presses `useArrangeDrag` owns;
       * the gestures layer stands down on it (`live/gestures/install.ts`'s
       * `arrangeable`).
       */
      data-arrange-card={arrangeable ? slot : undefined}
      data-room={doors !== null || undefined}
    >
      {/*
       * R10 (wave 35), diagnosed: this used to be a `<button>` when `selectable`
       * and a plain `<div>` otherwise. `selectable` folds in `declaredAttackers`
       * (`live/match.ts`), which only counts a just-declared attacker once
       * Forge's `buttons` update shows "Call Back" — a SEPARATE signal from the
       * view's own `Attacking` flag, so there is a real window, between the two
       * arriving, where a creature is `attacking` but not yet (again) selectable.
       * Switching DOM element type (`button` → `div` → `button`) across that
       * window unmounts this whole subtree each time — a fresh `<img>` with
       * nothing painted over the text underneath it for a frame, which is
       * exactly "a flicker of 'Creature' and rules text when a creature taps to
       * attack." The face is now always the same element — a `<button>` — so
       * the window in the data can no longer cause a window in the DOM. The
       * selectable-only styling moved from a `button.board-card__face` tag
       * selector to `.board-card[data-selectable] > .board-card__face` in
       * `card.css`, which was the only thing still keyed off the tag.
       *
       * NOT `disabled` (found live, by lane E's e2e run): a real browser never
       * dispatches pointer events to, or bubbles them past, a `disabled` form
       * control — the HTML spec's own behaviour, which jsdom does not
       * reproduce (every unit test here fired `pointerdown` directly on the
       * element and jsdom delivered it regardless), so this shipped a second
       * regression the first one's own tests could not see: a disabled card's
       * arrange-drag could never START on a real mouse, because
       * `useArrangeDrag`'s board-level listener never saw the press at all.
       * `tabIndex={-1}` keeps the same accessibility outcome (out of the tab
       * order) without touching whether the browser delivers pointer events —
       * `onClick` being `undefined` already keeps a click from doing anything.
       */}
      <button
        type="button"
        className="board-card__face"
        tabIndex={selectable ? undefined : -1}
        aria-label={
          selectable
            ? `${picked ? 'Picked, ' : 'Select '}${entry.card.name}${entry.tapped ? ', tapped' : ''}`
            : undefined
        }
        /* The same fact the drawing says, for anything that cannot see the mark. */
        aria-pressed={selectable ? picked : undefined}
        onClick={selectable ? () => interaction.onSelectCard(entry.id) : undefined}
      >
        {/*
         * `liveText`: Forge's live `AbilityText` (`adapter.ts`), shown in
         * place of the printed oracle text when it says something the
         * printed text does not (a Haunt-granted keyword). The inspector
         * clones this exact tile, so this is also the inspector's own text
         * source — nothing else to change there.
         */}
        {entry.hidden === true ? (
          <HiddenCard card={entry.card} />
        ) : doors !== null ? (
          <RoomDoors doors={doors} state={entry.doors!} />
        ) : (
          <CardTile card={entry.card} liveText={entry.abilityText} conditionMet={entry.conditionMet === true} />
        )}
      </button>
      {picked && (
        <span className="board-card__picked" aria-hidden="true" data-tip="Picked">
          <CheckMark className="board-card__picked-art" />
        </span>
      )}
      {onBattlefield && <PowerToughness entry={entry} />}
      {onBattlefield && previewed > 0 && (
        <span className="board-card__damage-preview" data-damage-preview={previewed} aria-label={`${previewed} damage to be dealt`}>
          {previewed}
        </span>
      )}
      {onBattlefield && <StateMarks entry={entry} />}
      {showCounters && <Counters entry={entry} timeFirst={inExile} />}
      {(onBattlefield || slot === 'hand' || (libraryTop && entry.seenByOpponent === true)) && (
        <CardTags
          entry={entry}
          choices={onBattlefield ? (entry.choices ?? []) : []}
          states={onBattlefield ? (entry.states ?? []) : []}
          waiting={onBattlefield ? (entry.waiting ?? []) : []}
          held={slot === 'hand' ? interaction?.held?.get(entry.id) : undefined}
          seen={(slot === 'hand' || libraryTop) && entry.seenByOpponent === true}
        />
      )}
      {onBattlefield && <TypePill entry={entry} />}
      {/*
       * NOT gated on `onBattlefield`: the haunting card's own pill reads on
       * the card itself while it sits in EXILE (Haunt's own zone after it
       * resolves), not on the creature it haunts. `Relations` draws nothing
       * for the common case (no relation at all).
       */}
      <Relations entry={entry} />
      {copies !== null && (
        <span className="board-card__copies" data-copies={copies} data-tip={`${copies} copies of ${entry.card.name}`}>
          ×{copies}
        </span>
      )}
      {above.length > 0 && (
        <ul className="board-card__pile" aria-label={`Stacked on ${entry.card.name}`}>
          {above.map((c, i) => (
            <CardOnBoard
              key={c.id}
              entry={c}
              interaction={interaction}
              arranging={arranging}
              slot={slot}
              pileSize={pileSize}
              depth={i + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A Room's two doors as the tiles to draw, left then right — its faces, each cropped to its half of
 * the card and marked with its state (`adapter.ts`'s `BoardCard.doors`). Null for any other card.
 */
function roomDoors(entry: BoardCard): readonly [TileCard, TileCard] | null {
  if (entry.doors === undefined) return null;
  const faces = entry.card.faces ?? [];
  // Each door is a tile of its own, and the other door is the face its wheel turns to.
  const tile = (door: BoardDoor): TileCard | undefined => {
    const face = faces.find((f) => f.name === door.name && f.door !== undefined);
    return face === undefined ? undefined : { ...face, cardId: entry.card.cardId, faces: faces.filter((f) => f !== face) };
  };
  const left = tile(entry.doors[0]);
  const right = tile(entry.doors[1]);
  return left === undefined || right === undefined ? null : [left, right];
}

/**
 * The operator, 2026-10-19: *"cards like 'Walk-In Closet' it's hard to tell whats actually going on.
 * which room was played, which room is active? has the door been unlocked?"* A Room on the battlefield
 * is drawn turned, as its printed card reads: its two doors upright side by side, each its own half of
 * the card's image. A locked door is dimmed under a padlock, an unlocked one full strength under an
 * open door (`CardTile`'s `DoorMark`, so the inspector's enlargement shows the same). A press on the
 * Room is Forge's offer of the card, its unlocks among it, and a choice between two is drawn as these
 * same doors (`prompts/ChoicePrompts.tsx`'s `facedAbilities`).
 *
 * A door that unlocks while drawn plays a beat (`data-unlocking`, `card.css`) for
 * {@link UNLOCK_BEAT_MS}. A door already open when the Room arrives does not: the cast is its own beat.
 */
function RoomDoors({ doors, state }: { doors: readonly [TileCard, TileCard]; state: readonly [BoardDoor, BoardDoor] }) {
  const opening = useUnlockBeat(state);
  return (
    <span className="board-card__doors">
      {doors.map((door, i) => (
        <span key={door.name} className="board-card__door" data-door-side={i === 0 ? 'left' : 'right'} data-unlocking={opening.has(door.name) || undefined}>
          <CardTile card={door} />
        </span>
      ))}
    </span>
  );
}

/** The doors of `doors` that unlocked since the last draw, for {@link UNLOCK_BEAT_MS}. */
function useUnlockBeat(doors: readonly BoardDoor[]): ReadonlySet<string> {
  const shown = useRef<string | null>(null);
  const [opening, setOpening] = useState<ReadonlySet<string>>(NO_DOORS);
  const key = doors.map((d) => `${d.name}:${d.unlocked ? 1 : 0}`).join('|');
  useEffect(() => {
    const before = shown.current;
    shown.current = key;
    if (before === null) return undefined;
    const was = new Set(before.split('|'));
    const opened = key
      .split('|')
      .filter((door) => door.endsWith(':1') && was.has(`${door.slice(0, -2)}:0`))
      .map((door) => door.slice(0, -2));
    if (opened.length === 0) return undefined;
    setOpening(new Set(opened));
    const timer = window.setTimeout(() => setOpening(NO_DOORS), UNLOCK_BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
  return opening;
}

const NO_DOORS: ReadonlySet<string> = new Set();

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
  onOpen,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  label: string;
  cards: readonly BoardCard[];
  interaction: BoardInteraction | undefined;
  /**
   * A graveyard or an exile only: opens its `PileView`. A click anywhere on the pile does, except
   * on a card Forge offers — that click is the card's own, exactly as everywhere on the board.
   */
  onOpen?: () => void;
  /**
   * Present only on the viewer's own HAND — the one `Zone` whose order is the
   * player's. A graveyard and an exile pile are Forge's own order and get
   * `undefined`, so no card in them is arrangeable and the list takes no drop.
   * `cards` arrives already in the player's order (`handOrder`).
   */
  arranging?: Arranging;
}) {
  return (
    <ZoneShell
      owner={owner}
      ownerSide={ownerSide}
      zone={zone}
      label={label}
      count={cards.length}
      canAct={zone !== 'hand' && cards.some((c) => interaction?.actionable?.has(c.id) === true)}
      onClick={
        onOpen === undefined || cards.length === 0
          ? undefined
          : (event) => {
              if (event.target instanceof Element && event.target.closest('[data-selectable]') !== null) return;
              onOpen();
            }
      }
    >
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
          <Fragment key={c.id}>
            {zone === 'hand' && HELD_HAND_SLOT?.cardId === c.id ? <li data-hand-gap="" aria-hidden="true" style={{ height: HELD_HAND_SLOT.height }} /> : null}
            <CardOnBoard entry={c} interaction={interaction} arranging={arranging} slot={arranging === undefined ? undefined : 'hand'} inExile={zone === 'exile'} />
          </Fragment>
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
  canAct = false,
  onClick,
  children,
}: {
  owner: string;
  ownerSide: ZoneOwner;
  zone: string;
  /** Not drawn — the zone's accessible name. See above. */
  label: string;
  count: number;
  /**
   * A pile holding a card Forge offers to be played from it (flashback, a library top under
   * Courser): the pile carries the card's own glow, so a card buried in it is never missed.
   */
  canAct?: boolean;
  /** A pile's opener — see `Zone`'s `onOpen`. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`zone zone--${zone}`}
      onClick={onClick}
      aria-label={`${owner} ${label}`}
      data-zone={zone}
      data-owner={ownerSide}
      data-count={count}
      data-can-act={canAct || undefined}
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
const NOTHING_LEAVING: readonly Departure[] = [];

const NOTHING_HELD: ReadonlySet<number> = new Set();

/** A pile less the cards still on their way to it. */
function unheld(cards: readonly BoardCard[], held: ReadonlySet<number>): readonly BoardCard[] {
  return held.size === 0 || !cards.some((c) => held.has(c.id)) ? cards : cards.filter((c) => !held.has(c.id));
}

/**
 * A battlefield's cards with the ones still drawn leaving put back where they were — each at its
 * old index, and holding nothing: whatever was attached to it is a permanent of its own now.
 */
function withLeaving(cards: readonly BoardCard[], leaving: readonly Departure[]): readonly BoardCard[] {
  if (leaving.length === 0) return cards;
  const out = [...cards];
  for (const d of [...leaving].sort((a, b) => a.index - b.index)) {
    if (out.some((c) => c.id === d.cardId)) continue;
    out.splice(Math.min(d.index, out.length), 0, { ...d.card, attachedCardIds: [] });
  }
  return out;
}

function Battlefield({
  player,
  ownerSide,
  interaction,
  arranging,
  arranged,
  layout,
  leaving = NOTHING_LEAVING,
}: {
  player: BoardPlayer;
  ownerSide: ZoneOwner;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
  layout: BoardLayout;
  /** This battlefield's permanents still drawn leaving (`live/departures.ts`): their places are kept as gaps. */
  leaving?: readonly Departure[];
}) {
  const leavingIds = new Set(leaving.map((d) => d.cardId));
  const grouped = group(withLeaving(player.battlefield, leaving), player.id, arranged, layout);
  const expected = PENDING_PLACEMENTS.get(player.id);
  const reserved =
    expected === undefined || expected.expiresAt < Date.now() || !rowsForLayout(layout).includes(expected.slot)
      ? null
      : withExpectedGap(grouped, expected.slot, expected.target);
  const rows = reserved?.rows ?? grouped;
  const isExpectedGap = (row: BoardRow, i: number): boolean => reserved !== null && expected !== undefined && expected.slot === row && reserved.index === i;
  /** One column: a gap the player left, the place a leaving card keeps, or a pile — less any card of it that is leaving. */
  const pileItem = (whole: Pile, row: BoardRow, i: number) => {
    if (whole.length === 0) {
      return <li key={`gap-${i}`} className="zone__gap" data-gap="" data-expected={isExpectedGap(row, i) ? '' : undefined} aria-hidden="true" />;
    }
    const pile = whole.filter((c) => !leavingIds.has(c.id));
    if (pile.length === 0) {
      const id = whole[0]!.id;
      return <li key={`leaving-${id}`} className="zone__gap" data-gap="" {...{ [LEAVING_GAP_ATTR]: id }} aria-hidden="true" />;
    }
    return (
      <CardOnBoard key={pile[0]!.id} entry={pile[0]!} interaction={interaction} arranging={arranging} slot={row} pile={pile} pileSize={pile.length} />
    );
  };

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
              {rows[tier].map((pile, i) => pileItem(pile, tier, i))}
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
              {rows[row].map((pile, i) => pileItem(pile, row, i))}
            </ul>
          </li>
        ))}
      </ul>
    </ZoneShell>
  );
}

/**
 * Someone else's hand: a count, drawn as that many backs — except a card this
 * screen was shown and still knows (`BoardPlayer.handShown`: a Thoughtseize's
 * look, a revealed top card drawn), which is drawn face up in its place. The
 * strip is always in the markup so the slot is one height at nought backs and
 * at ten.
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
 *
 * Not always the opponent's (2026-10-12): a watcher's wire hides EVERY hand,
 * the perspective seat's at the bottom included, so this is drawn on the
 * viewer's side too. `ownerSide` is the seat's, like every other zone of it —
 * `[data-owner="them"]` is how the presence layer finds the OTHER seat's hand,
 * and a strip at the bottom claiming to be theirs would be found first — and
 * `zone--backs` is what the stylesheet sizes the strip by on either side
 * (`board.css`), never the side it happens to be on.
 */
function HiddenHand({ player, ownerSide, interaction }: { player: BoardPlayer; ownerSide: ZoneOwner; interaction: BoardInteraction | undefined }) {
  return (
    <section
      className="zone zone--hand zone--backs"
      aria-label={`${player.name} Hand`}
      data-zone="hand"
      data-owner={ownerSide}
      data-count={player.handCount}
    >
      <ul className="card-backs" style={{ '--cols': player.handCount } as CSSProperties}>
        {Array.from({ length: player.handCount }, (_, i) => {
          const shown = player.handShown?.[i] ?? null;
          return shown === null ? (
            <li key={`back-${i}`} className="card-back" data-card-back="" aria-hidden="true" />
          ) : (
            <CardOnBoard key={shown.id} entry={shown} interaction={interaction} />
          );
        })}
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
 *
 * Poison is drawn beside it, and nowhere else (the operator, 2026-10-15: *"show
 * poison counters next to the life total when they happen … center justified
 * within two split columns … instead of P can we show a skull and bones
 * icon?"*): while the seat has any, `.face__vitals` splits into two equal
 * columns, life then `PoisonMark`, each centred in its own; with none, life is
 * alone and centred under the mark as before.
 *
 * ## The ring: who Forge is waiting on
 *
 * `.seat__ring` is the ring itself — an element that exists on every face,
 * always, drawn over the avatar's own box, lit by `card.css` exactly while
 * its ANCESTOR `<section data-testid="player">` (`PlayerArea`, below) carries
 * `data-priority`: the seat Forge is waiting on to act (the operator,
 * 2026-10-13: *"the circle around the avatar should indicate priority"*).
 * Whose turn it is is the seat's own edge light and the other side's shade
 * (`data-active`, `board.css`), never a ring. Both hooks are the section's, so an e2e spec
 * selects them without reaching into this component's own markup.
 */
function PlayerFace({
  player,
  interaction,
  onOpenSettings,
}: {
  player: BoardPlayer;
  interaction: BoardInteraction | undefined;
  onOpenSettings: ((from: Element) => void) | undefined;
}) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  const emblems = player.emblems ?? [];
  const poison = poisonOf(player);
  const mark = (
    <>
      {/* The watchparty character, or our mark: a seat with no face is worse than a generic face. */}
      <Avatar id={player.avatarId} fallback="mark" className="face__art face__avatar" data-testid="seat-avatar" />
      {/*
       * The ring itself: always in the markup, over the avatar's own box, drawn
       * only while `card.css` sees a `data-priority` ancestor. Decorative —
       * the fact is said in words on the seat's own `aria-label`/section, not
       * here — so it is `aria-hidden` and `pointer-events: none`.
       */}
      <span className="seat__ring" aria-hidden="true" />
      <span className="face__vitals" data-poisoned={poison > 0 || undefined}>
        <span className="face__life" data-testid="life">
          {player.life}
        </span>
        {poison > 0 && <PoisonMark count={poison} />}
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
      ) : player.isViewer && onOpenSettings !== undefined ? (
        /* Your own face opens cardtable's settings (`../settings/Settings.tsx`) whenever Forge is not asking for a player. */
        <button
          type="button"
          className="face__hit face__hit--settings"
          aria-label="Settings"
          aria-haspopup="dialog"
          data-testid="seat-settings"
          onClick={(event) => onOpenSettings(event.currentTarget)}
        >
          {mark}
        </button>
      ) : (
        <div className="face__hit">{mark}</div>
      )}
      {emblems.length === 0 ? null : <SeatEmblems emblems={emblems} />}
      <span className="face__name">{player.name}</span>
    </div>
  );
}

/** The counter Forge names poison (`CounterEnumType.POISON`), the one player counter drawn on the face rather than the counts line. */
const POISON = 'Poison';

/** Forge's `GameRules.poisonCountersToLose` for a two-player game. */
export const POISON_TO_LOSE = 10;

/** How many poison counters the seat has; 0 for none. */
export function poisonOf(player: BoardPlayer): number {
  return player.counters?.find((c) => c.name === POISON)?.count ?? 0;
}

/**
 * A seat's poison, beside its life: a skull and crossbones we draw, as geometry like the hand and
 * library marks, and the count. The words are in the tip and the accessible name.
 */
function PoisonMark({ count }: { count: number }) {
  const said = `${count} poison`;
  return (
    <span className="face__poison" data-testid="poison" data-poison={count} data-tip={said} role="img" aria-label={said}>
      <svg className="face__poison-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          fillRule="evenodd"
          d="M8 1C5.5 1 3.6 2.8 3.6 5.2c0 1.4.6 2.5 1.6 3.2v1.5h5.6V8.4c1-.7 1.6-1.8 1.6-3.2C12.4 2.8 10.5 1 8 1ZM6.2 4.4a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Zm3.6 0a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4ZM8 6.9l.7 1.2H7.3Z"
        />
        <path d="m2.4 10.9.5-1.2 10.7 4.2-.5 1.2Z" />
        <path d="m13.6 10.9-.5-1.2-10.7 4.2.5 1.2Z" />
        <circle cx="2.2" cy="10.4" r="1" />
        <circle cx="13.8" cy="10.4" r="1" />
        <circle cx="2.2" cy="15" r="1" />
        <circle cx="13.8" cy="15" r="1" />
      </svg>
      <span aria-hidden="true">{count}</span>
    </span>
  );
}

/** One medallion: its source's art, or the drawn mark when there is none or it fails to load. */
function EmblemMedallion({ emblem, slot }: { emblem: BoardEmblem; slot: number }) {
  const [broken, setBroken] = useState(false);
  const art = cardImageUrl(emblem.scryfallId);
  return (
    <span className="face__emblem" data-emblem={emblem.id} data-slot={slot}>
      {art === null || broken ? (
        <svg className="face__emblem-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" />
        </svg>
      ) : (
        <img className="face__emblem-art" src={art} alt="" aria-hidden="true" onError={() => setBroken(true)} />
      )}
    </span>
  );
}

/** The medallions one avatar has room for around it (`card.css`'s `.face__emblem` slots). */
const EMBLEM_SLOTS = 4;

/** The emblems that get a medallion of their own: all of them while they fit, else all but the slot that counts the rest. */
function medallionsOf(emblems: readonly BoardEmblem[]): readonly BoardEmblem[] {
  return emblems.length > EMBLEM_SLOTS ? emblems.slice(0, EMBLEM_SLOTS - 1) : emblems;
}

/**
 * A player's emblems, as medallions around their avatar — the operator, 2026-10-14: *"i need a
 * visual for emblems. let's make it so they go around the player's avatar and hovering the players
 * avatar shows all their emblems."* One medallion per emblem in fixed slots outside the priority
 * ring (`card.css`), so an emblem arriving moves nothing; past the slots, the last one counts the
 * rest. A medallion shows its source's art cropped to the illustration, else a drawn emblem mark.
 *
 * Hovering the avatar (a medallion is part of it) enlarges every emblem as its trigger's own chip
 * (`AbilityChip`) — the operator, 2026-10-21: *"we already have the emblem card chip for the
 * trigger, we can just use that. and when hovering over the player, then we display the card
 * chips."* The chips are drawn here, hidden, for the inspector to enlarge (`inspect/`'s
 * `EMBLEM_CHIPS`): the one expanded view, as a stack item's chip is.
 */
function SeatEmblems({ emblems }: { emblems: readonly BoardEmblem[] }) {
  const shown = medallionsOf(emblems);
  const rest = emblems.length - shown.length;
  return (
    <>
      <span className="face__emblems" data-emblems={emblems.length} role="img" aria-label={emblems.map((e) => `${e.card.name}: ${e.text}`).join('\n')}>
        {shown.map((e, slot) => (
          <EmblemMedallion key={e.id} emblem={e} slot={slot} />
        ))}
        {rest === 0 ? null : (
          <span className="face__emblem face__emblem--more" data-emblem-more="" data-slot={EMBLEM_SLOTS - 1}>
            +{rest}
          </span>
        )}
      </span>
      <div hidden data-emblem-chips="">
        {emblems.map((e) => (
          <AbilityChip key={e.id} source={e.card} name={e.card.name} text={e.text} />
        ))}
      </div>
    </>
  );
}

/**
 * The seat's STATUS zone, between its name and its library mark — the operator, 2026-10-19: *"when a
 * player has extra turns, this kind of thing should be visible somewhere around their portrait.
 * let's make a special zone between their name and the deck symbol for this type of information. by
 * default that zone is empty, but when things like storm counters are being tracked or extra turns,
 * then it'd be good to show it there."* What the game is tracking about this player right now, one
 * chip each: a drawn mark and a number, the words in the tip and the accessible name.
 *
 * Its track is a fixed one (`--status-h`, `board.css`) and is there while it is empty, so a chip
 * arriving moves neither the face nor the counts. The tracks it holds:
 *
 *   - the storm count (`BoardPlayer.storm`): your own seat only, only while your hand holds a Storm
 *     card (the operator, 2026-10-14) — it was the last medallion round the avatar until this zone;
 *   - the extra turns to come (`extraTurns`), on any seat: a Time Walk resolving is public;
 *   - the mark that this turn IS an extra one (`extraTurn`), on the seat whose turn it is.
 */
function SeatStatus({ player }: { player: BoardPlayer }) {
  const { storm, extraTurns, extraTurn } = player;
  const turns = (n: number): string => `${n} extra ${n === 1 ? 'turn' : 'turns'}`;
  const items = [storm !== undefined, extraTurn === true, extraTurns !== undefined].filter(Boolean).length;
  return (
    <div className="seat__status" data-seat-status="" data-items={items}>
      {extraTurn === true && (
        <span className="seat__chip seat__chip--now" data-testid="extra-turn-now" data-tip="Extra turn" role="img" aria-label="Extra turn">
          <ExtraTurnArt />
        </span>
      )}
      {extraTurns !== undefined && (
        <span className="seat__chip" data-testid="extra-turns" data-extra-turns={extraTurns} data-tip={turns(extraTurns)} role="img" aria-label={turns(extraTurns)}>
          <ExtraTurnArt />
          <span aria-hidden="true">{extraTurns}</span>
        </span>
      )}
      {storm !== undefined && (
        <span className="seat__chip" data-testid="storm-count" data-storm={storm} data-tip={`Storm ${storm}`} role="img" aria-label={`Storm ${storm}`}>
          <svg className="seat__chip-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4.5 9.5a3 3 0 0 1 .4-6 4 4 0 0 1 7.4 1.2 2.4 2.4 0 0 1-.3 4.8H10l-1.6 2.4h1.8L6.6 15.5l1-3.4H5.8l1.2-2.6Z" />
          </svg>
          <span aria-hidden="true">{storm}</span>
        </span>
      )}
    </div>
  );
}

/** An extra turn, drawn: a turn arrow come round on itself. Ours, as geometry like the library mark. */
function ExtraTurnArt() {
  return (
    <svg className="seat__chip-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 2a6 6 0 1 0 5.7 7.9l-1.9-.6A4 4 0 1 1 8 4c1 0 1.9.4 2.6 1L9 6.5h5V1.5l-1.9 1.9A6 6 0 0 0 8 2Z" />
    </svg>
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
 * Each entry is the Mana font's symbol and a count, on a chip that carries no
 * colour of its own (`board.css`). Colour is never the only signal: `data-mana`
 * carries the letter, the symbol is the colour's own glyph, and the whole pool
 * is in the list's accessible name in words.
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

function ManaPool({ player, interaction }: { player: BoardPlayer; interaction?: BoardInteraction }) {
  const pool = player.manaPool ?? [];
  const total = pool.reduce((n, m) => n + m.count, 0);
  const said = pool.map((m) => `${m.count} ${MANA_WORD[m.color]}`).join(', ');
  // Mana that pays the open payment is the player's to press (operator, 2026-10-22); when the pool
  // pays it more than one way the pool wears the can-act outline too (operator, 2026-10-21).
  const pays = player.isViewer ? (interaction?.poolPays ?? []) : [];
  const choice = player.isViewer && interaction?.poolChoice === true;
  return (
    <ul
      className="seat__mana"
      data-mana-pool=""
      data-mana-total={total}
      data-pool-pays={choice ? '' : undefined}
      aria-label={total === 0 ? `${player.name} mana pool` : `${player.name} mana pool: ${said}`}
    >
      {pool.map((m) => {
        const pressable = pays.includes(m.color);
        return (
          <li
            key={m.color}
            className="seat__mana-pip"
            data-mana={m.color}
            data-mana-count={m.count}
            data-pool-pay={pressable ? '' : undefined}
            role={pressable ? 'button' : undefined}
            tabIndex={pressable ? 0 : undefined}
            aria-label={pressable ? `Pay with ${MANA_WORD[m.color]}` : undefined}
            onClick={pressable ? () => interaction?.onPayFromPool?.(m.color) : undefined}
          >
            {/* The Mana font's own symbol (D20), never the letter (operator,
                2026-10-06: "instead of showing 'U1' can we show the actual mana
                symbol"). The list's own label already says it in words. */}
            <span className="seat__mana-symbol" aria-hidden="true">
              <ManaPip token={m.color} />
            </span>
            <span aria-hidden="true">
              {m.count}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The known player-counter names abbreviate to a short, DISTINCT glyph — never
 * the same first letter twice — so a seat shows them on the one line
 * `--counts-h` has room for without widening the track (wave 34 §B, below).
 * "XP" for experience is the common-usage shorthand. Poison is not here: it is
 * drawn beside the life total (`PoisonMark`).
 */
const PLAYER_COUNTER_ABBREV: Readonly<Record<string, string>> = {
  Energy: 'E',
  Experience: 'XP',
};

/** Any OTHER name Forge ever puts on a player falls back to its own initial, capitalised. */
function playerCounterAbbrev(name: string): string {
  return PLAYER_COUNTER_ABBREV[name] ?? name.slice(0, 1).toUpperCase();
}

/**
 * Player-level counters — energy, experience, and anything else Forge tracks on
 * the PLAYER rather than a card (wave 33 item 4) — except poison, which is
 * drawn beside the life total (`PoisonMark`).
 *
 * Read off `BoardPlayer.counters`, which `adapter.ts` fills from the SAME wire
 * property a card's own counters use (`GameEntityView.Counters`, shared by
 * `PlayerView` and `CardView`). Drawn beside the seat's hand/library counts —
 * the same track, the same size — and only when non-zero: a seat with none of
 * these shows nothing here, the same contract every other optional mark on
 * this board keeps.
 *
 * Wave 34 §B: the glyph is a short abbreviation (`E7`, `XP2`), not the
 * word (`7 energy`). `e2e/table-fit.spec.ts`'s Q9/Q2 column check measures
 * the gap between the HAND/LIBRARY marks' own rendered box and the graveyard
 * — a gap that tracks `--counts-h` itself, not how much of it the counters
 * fill — so growing the track to fit a longer word moved the graveyard
 * (measured: 46.3px of "nothing but a pile's own margin", GAP_MAX 32). The
 * word, in full, is still here: in `data-tip` for a pointer and `aria-label` for
 * everything else — nothing about the counter's MEANING is abbreviated, only
 * its glyph.
 */
function PlayerCounters({ player }: { player: BoardPlayer }) {
  const counters = (player.counters ?? []).filter((c) => c.count !== 0 && c.name !== POISON);
  if (counters.length === 0) return null;
  return (
    <>
      {counters.map((c) => (
        <span
          key={c.name}
          className="seat__counter"
          data-counter={c.name.toLowerCase()}
          data-tip={`${c.count} ${c.name.toLowerCase()}`}
          aria-label={`${c.count} ${c.name.toLowerCase()}`}
        >
          {playerCounterAbbrev(c.name)}
          {c.count}
        </span>
      ))}
    </>
  );
}

function PlayerArea({
  player,
  interaction,
  arranging,
  arranged,
  layout,
  leaving,
  held,
  onOpenPile,
  onOpenSettings,
  onOpenDeck,
}: {
  player: BoardPlayer;
  interaction: BoardInteraction | undefined;
  arranging: Arranging | undefined;
  arranged: Arrangement;
  layout: BoardLayout;
  leaving: readonly Departure[];
  /** Cards still on their way to a pile (`Board`'s `held`): left out of the graveyard and exile until they arrive. */
  held: ReadonlySet<number>;
  onOpenPile: (zone: PileZone) => void;
  onOpenSettings?: (from: Element) => void;
  onOpenDeck?: (from: Element) => void;
}) {
  const selectable = interaction !== undefined && interaction.selectablePlayers.has(player.id);
  const libraryMark = (
    <>
      <svg className="seat__count-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.6 1.6h6.8l2.4 3.4H2.2Z" />
        <path d="M4.6 6.2h6.8l2.4 3.4H2.2Z" />
        <path d="M4.6 10.8h6.8l2.4 3.4H2.2Z" />
      </svg>
      <span aria-hidden="true">{player.libraryCount}</span>
    </>
  );
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
      // The active side's edge light and the other's shade (`board.css`'s `.seat[data-active]`),
      // and the ring of the seat Forge is waiting on (`card.css`'s `.seat[data-priority]`).
      data-active={player.isActive || undefined}
      data-priority={player.hasPriority || undefined}
      aria-label={player.isViewer ? `${player.name} (you)` : player.name}
    >
      {/*
       * The seat's furniture, in the upper cell of its narrow left column: the
       * avatar with its life, the name, its status, the counts, then the mana pool — and,
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
            <PlayerFace player={player} interaction={interaction} onOpenSettings={onOpenSettings} />
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
          <SeatStatus player={player} />
          <ManaPool player={player} interaction={interaction} />
          {/*
           * The library's count, as a MARK rather than a word (item 10: *"can we get
           * symbols to display hand/deck size instead of words?"*). The hand's count is
           * gone (the operator, 2026-10-17: *"Hand count should be gone, instead let's
           * allow the deck count number to be slightly bigger and the deck icon to be
           * three stacked trapazoids"*) — a hand is drawn card by card, backs included,
           * so it counts itself. Ours, drawn here as geometry like the player mark: no
           * font to miss the glyph, no WotC symbol anywhere near it.
           *
           * `library-count` is the one handle anything has on the number, and it carries
           * the word in its accessible name: the mark is for the eye, the label for
           * everything else.
           */}
          <div className="seat__counts">
            {player.isViewer && onOpenDeck !== undefined ? (
              /* Your own opens your deck list (the operator, 2026-10-17: "Clicking on deck icon should let you open your deck list"). */
              <button
                type="button"
                className="seat__count seat__count--open"
                data-testid="library-count"
                aria-label={`library ${player.libraryCount}`}
                aria-haspopup="dialog"
                onClick={(event) => onOpenDeck(event.currentTarget)}
              >
                {libraryMark}
              </button>
            ) : (
              <span className="seat__count" data-testid="library-count" aria-label={`library ${player.libraryCount}`}>
                {libraryMark}
              </span>
            )}
            <PlayerCounters player={player} />
          </div>
        </div>
        {player.libraryTop !== undefined && (
          /*
           * The library's top cards this screen knows, top first — revealed (Goblin Guide, Dark
           * Confidant), standing revealed (Courser of Kruphix), or looked at and kept there (a fate
           * seal, a scry) — under its owner's avatar (the operator, 2026-10-13: "when top of deck is
           * revealed put it below the avatar"), in the seat's own column: under it on yours, the
           * mirror on theirs. The top card whole, each under it a strip behind it. Not a permanent
           * and not arranged; a land Forge offers from the top is played from here like a hand card
           * (`live/gestures/cast.ts`).
           */
          <ZoneShell
            owner={player.name}
            ownerSide={side}
            zone="library"
            label="Library"
            count={player.libraryCount}
            canAct={interaction?.actionable?.has(player.libraryTop[0]!.id) === true}
          >
            <ul className="zone__cards">
              {/* Keyed: the next top is another card, never this element reused with the last one's gesture styles. */}
              {player.libraryTop.map((entry) => (
                <CardOnBoard key={entry.id} entry={entry} interaction={interaction} libraryTop />
              ))}
            </ul>
          </ZoneShell>
        )}
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
            cards={unheld(player.graveyard, held)}
            interaction={interaction}
            onOpen={() => onOpenPile('graveyard')}
          />
          <Zone
            owner={player.name}
            ownerSide={side}
            zone="exile"
            label="Exile"
            cards={unheld(player.exile, held)}
            interaction={interaction}
            onOpen={() => onOpenPile('exile')}
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
        leaving={leaving}
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
        <HiddenHand player={player} ownerSide={side} interaction={interaction} />
      )}
    </section>
  );
}

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
 *      ours. Otherwise we cancel it ourselves, so the press selects no text. A
 *      press that never moves stays a plain click.
 *   2. `pointermove` past `DRAG_SLOP_PX`: the drag begins. The card's `<li>` is
 *      dimmed in place (`data-arrange-dragging`), a clone of it — the GHOST,
 *      `data-arrange-ghost`, stripped of every id so card ids stay unique — is
 *      drawn lifted under the pointer, and from then on every move re-snaps.
 *   3. Each move finds the nearest slot of the card's own zone and the nearest
 *      place in it (`snapTo`, which counts empty slots), and draws the INDICATOR
 *      bar there (`data-arrange-indicator`, `data-arrange-kind`) and lights the
 *      slot and card it is on (`data-arrange-target`).
 *   4. `pointerup` commits to the snap; `pointercancel` and Escape do not. The
 *      `click` that follows a real drag is swallowed once (`clickLatch`).
 *
 * A press held still for `LONG_PRESS_MS` on a card of a pile picks up the WHOLE pile (the operator,
 * 2026-10-21: *"when i have cards stacked, allow me to 'long press' to pick up the whole stack and
 * move it"*): the drag begins right there, its ghost is the pile as drawn, and the release puts every
 * card of it down together, in its order (`withMove` takes the pile's ids). A press that moves before
 * then is the one card under it, as before. Not on touch: there a long press is the inspector's and
 * the card menu's (`inspect/index.ts`'s `CARD_LONG_PRESS`).
 *
 * Nothing is sent to Forge. Everything it draws is removed again on every exit.
 */

/** Every box `board.css` sizes cards from, measured (`zone-box.ts`) — the boxes a render added, from that render's own commit. */
function useZoneBoxes(root: { readonly current: HTMLElement | null }): void {
  const boxes = useRef<ZoneBoxes | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (boxes.current === undefined) boxes.current = observeZoneBoxes();
    if (root.current !== null) boxes.current?.sync(root.current);
  });
  useEffect(
    () => () => {
      boxes.current?.disconnect();
      boxes.current = undefined;
    },
    [],
  );
}

function useArrangeDrag(
  root: { readonly current: HTMLElement | null },
  enabled: boolean,
  commit: (cardIds: readonly number[], slot: ArrangeSlot, target: DropTarget) => void,
): void {
  /** Always the latest `commit`: the listeners are installed once and must not go stale. */
  const latest = useRef(commit);
  latest.current = commit;

  useEffect(() => {
    const board = root.current;
    if (board === null || !enabled) return undefined;

    interface Press {
      readonly pointerId: number;
      /** The card pressed; once a long press has taken its pile, the pile's bottom card. */
      li: HTMLElement;
      cardId: number;
      /** Every card of the pile a long press picked up, bottom first; null for one card. */
      pile: readonly number[] | null;
      /** The long press's timer, while it may still fire. */
      hold: ReturnType<typeof setTimeout> | null;
      readonly slot: ArrangeSlot;
      readonly x: number;
      readonly y: number;
      ghost: Ghost | null;
      indicator: HTMLElement | null;
      snap: Snap | null;
      marked: Element[];
    }
    let press: Press | null = null;
    const clicks = clickLatch();

    /** Every slot of the viewer's seat — all zones, so the snap can tell which one the pointer is really over. */
    const geometry = (): SlotGeometry[] => {
      const out: SlotGeometry[] = [];
      for (const el of board.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-arrange-slot]')) {
        const named = el.getAttribute('data-arrange-slot') as ArrangeSlot;
        const list = el.matches('.zone__cards') ? el : el.querySelector<HTMLElement>(':scope > .zone__cards');
        const piles = [...(list?.querySelectorAll<HTMLElement>(':scope > li.board-card, :scope > li.zone__gap:not([data-virtual])') ?? [])].map((li) => ({
          id: li.classList.contains('zone__gap') ? null : Number(li.dataset.cardId),
          box: li.getBoundingClientRect(),
          size: li.dataset.pileSize === undefined ? 1 : Number(li.dataset.pileSize),
        }));
        out.push(withColumnsToWidth({ slot: named, box: el.getBoundingClientRect(), piles, step: columnPitch(el) }));
      }
      return out;
    };

    const draw = (p: Press, x: number, y: number): void => {
      p.ghost?.move({ x, y });
      const found = snapTo(geometry(), x, y, p.cardId, p.pile !== null);
      /*
       * `p.slot` is never `'hand'` (no hand card is ever arrangeable, so this
       * drag never starts from one) — a permanent dropped over the hand is
       * nowhere, same as it always was: playing a card out of a hand is
       * Forge's, never ours.
       */
      const snap = found !== null && found.slot !== 'hand' ? found : null;
      p.snap = snap;
      if (p.indicator !== null) p.marked = drawSnap(board, p.indicator, snap, p.marked);
    };

    /** The press has moved far enough to be a drag: draw the ghost and the indicator. */
    const begin = (p: Press, x: number, y: number): void => {
      const ghost = liftGhost(p.li, board, { x: p.x, y: p.y }, String(p.cardId));
      if (p.pile === null) {
        // A card lifted out of a pile is one card: neither the pile nor its count travels with it.
        for (const el of ghost.el.querySelectorAll(':scope > .board-card__pile, :scope > .board-card__copies')) el.remove();
      } else {
        // The whole pile travels, drawn as it was: the copy gets back the pile marks `liftGhost` strips.
        ghost.el.setAttribute('data-pile-size', p.li.dataset.pileSize ?? String(p.pile.length));
        const above = (el: Element) => [...el.querySelectorAll<HTMLElement>(':scope > .board-card__pile > li.board-card')];
        const depths = above(p.li).map((li) => li.dataset.pileDepth ?? '');
        above(ghost.el).forEach((li, i) => li.setAttribute('data-pile-depth', depths[i] ?? ''));
      }
      const indicator = document.createElement('div');
      indicator.setAttribute('data-arrange-indicator', '');
      indicator.setAttribute('aria-hidden', 'true');
      indicator.setAttribute('hidden', '');
      board.append(indicator);
      p.ghost = ghost;
      p.indicator = indicator;
      p.li.setAttribute('data-arrange-dragging', '');
      board.setAttribute('data-arrange-active', '');
      showPlacementColumns(board);
      draw(p, x, y);
    };

    const end = (): void => {
      const p = press;
      press = null;
      window.removeEventListener('keydown', onKey, true);
      if (p === null) return;
      if (p.hold !== null) clearTimeout(p.hold);
      for (const el of p.marked) el.removeAttribute('data-arrange-target');
      p.ghost?.remove();
      p.indicator?.remove();
      p.li.removeAttribute('data-arrange-dragging');
      board.removeAttribute('data-arrange-active');
      clearPlacementColumns(board);
    };

    const onDown = (event: PointerEvent): void => {
      clicks.reset();
      if (press !== null || event.button !== 0 || !event.isPrimary) return;
      // Claimed by the gestures layer: combat declaration, a payment. Not ours.
      if (event.defaultPrevented) return;
      const target = eventTarget(event);
      if (!(target instanceof Element) || !board.contains(target)) return;
      const li = target.closest<HTMLElement>('li.board-card');
      const slot = li?.getAttribute('data-arrange-card');
      if (li === null || li === undefined || slot === null || slot === undefined) return;
      // Ours now: the press selects no text.
      if (event.cancelable) event.preventDefault();
      const p: Press = {
        pointerId: event.pointerId,
        li,
        cardId: Number(li.dataset.cardId),
        pile: null,
        hold: null,
        slot: slot as ArrangeSlot,
        x: event.clientX,
        y: event.clientY,
        ghost: null,
        indicator: null,
        snap: null,
        marked: [],
      };
      press = p;
      // The pile this card is in: its bottom card is the row's own `<li>`, the rest are in that card's `.board-card__pile`.
      const base = li.parentElement?.classList.contains('board-card__pile') === true ? li.parentElement.closest<HTMLElement>('li.board-card') : li;
      if (event.pointerType !== 'touch' && base?.dataset.pileSize !== undefined) {
        p.hold = setTimeout(() => {
          p.hold = null;
          if (press !== p || p.ghost !== null) return;
          p.li = base;
          p.cardId = Number(base.dataset.cardId);
          p.pile = [base, ...base.querySelectorAll<HTMLElement>(':scope > .board-card__pile > li.board-card')].map((el) => Number(el.dataset.cardId));
          begin(p, p.x, p.y);
        }, LONG_PRESS_MS);
      }
      window.addEventListener('keydown', onKey, true);
    };

    const onMove = (event: PointerEvent): void => {
      const p = press;
      if (p === null || event.pointerId !== p.pointerId) return;
      if (p.ghost === null) {
        if (!pastSlop(p, { x: event.clientX, y: event.clientY })) return;
        if (p.hold !== null) clearTimeout(p.hold);
        p.hold = null;
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
      clicks.arm();
      if (snap !== null) latest.current(p.pile ?? [p.cardId], snap.slot, snap.target);
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
    window.addEventListener('click', clicks.swallow, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('click', clicks.swallow, true);
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
 * No `slot` and no `arranging`, so it is never arrangeable here — moving it
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

/**
 * The stack's own zone — a NON-VISUAL anchor now (wave 59 §S: the placed-cards
 * layer, `live/placed.ts`, draws every item as a card at a point, both seats',
 * replacing the thumbnail row and the lone band outright). What used to be
 * read off the row — "is anything on the stack", "how many" — is still read
 * off this element, because nothing else names the fact: `data-count` is
 * every item Forge's own stack holds (`view.stack.length`); `data-carried` is
 * how many of those a played card is ALSO currently standing in for, in the
 * gap between its release and the moment `live/placed.ts` takes over drawing
 * it at that same point (`carryCastOffStack`, `gestures/install.ts`) — kept
 * for the readers that still check it (`e2e/played-card.spec.ts`), though
 * nothing visual depends on it any more: every item is drawn once, by
 * `placed.ts`, whether or not a played card is also standing in for it.
 *
 * `data-zone`/`data-owner="table"` is the whole of what makes this a zone at
 * all — no label, no box, nothing drawn (`board.css` keeps it invisible).
 */
function StackView({ count, carried }: { count: number; carried: number }) {
  return <section className="stack" aria-label="Stack" data-zone="stack" data-owner="table" data-count={count} data-carried={carried > 0 ? carried : undefined} />;
}

export function Board({
  view,
  interaction,
  boardLayout = 'single',
  onOpenSettings,
  onOpenDeck,
  onEffect,
  revealed,
  fastMode = false,
}: {
  view: BoardView;
  /** The last reveal this seat was shown (`live/match.ts`'s `revealed`): its beat comes before what it causes (`live/numbers.ts`). */
  revealed?: Revealed | null;
  /** Fast Mode (`live/prefs.ts`): nothing that left the battlefield is drawn leaving, and a resolution does not blink first. */
  fastMode?: boolean;
  interaction?: BoardInteraction;
  /** What each view's change was drawn as (`live/numbers.ts`'s beats) — the seat's `effect` client event. */
  onEffect?: (data: Record<string, string | number | boolean>) => void;
  /** The viewer's own face opens the game's settings: `LiveBoard` owns them. */
  onOpenSettings?: (from: Element) => void;
  /** The viewer's own library count opens their deck list: `LiveBoard` fetches it. */
  onOpenDeck?: (from: Element) => void;
  /**
   * Item 11. `single` — one undivided battlefield — is the default; the
   * settings panel is the only place that reads a stored preference and
   * passes `type-separated` here. A test that wants the alternate passes it
   * explicitly, which is also how the alternate's own pinned markup keeps
   * being exercised without becoming the default.
   */
  boardLayout?: BoardLayout;
}) {
  const viewer = viewerOf(view);
  const others = view.players.filter((p) => !p.isViewer);
  // `data-carried`'s own bookkeeping only now (`StackView`'s own note): a played card standing in
  // for its own spell, in the gap before `live/placed.ts` takes over drawing it at that point.
  // The third argument is the same reading: a statically rendered board (`live/parity.test.ts`) has no gesture layer, and so carries nothing.
  const carriedCast = useSyncExternalStore(subscribeCarriedCast, readCarriedCast, readCarriedCast);
  const carried = carriedCast !== null && view.stack.some((item) => !item.isAbility && item.sourceCardId === carriedCast) ? 1 : 0;
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
   * The one pile opened in a `PileView`, if any — this screen's alone. Shown only while that pile
   * still has cards, and toggled against what is SHOWN, so a pile that emptied under an open view
   * opens again on the next click.
   */
  const [openPile, setOpenPile] = useState<{ playerId: number; zone: PileZone } | null>(null);
  const closePile = useCallback(() => setOpenPile(null), []);
  /** A selection made in the view closes it, then answers exactly as the board's own click does. */
  const pileInteraction: BoardInteraction | undefined =
    interaction === undefined
      ? undefined
      : {
          ...interaction,
          onSelectCard: (id) => {
            setOpenPile(null);
            interaction.onSelectCard(id);
          },
        };

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
  /* The marks' tooltip (`tip/index.ts`), booted the same way. */
  useEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    return mountTips(el);
  }, []);

  /*
   * Floating life/damage numbers (`live/numbers.ts`), booted the same way:
   * one mount, into the same root, disposed on unmount. What it draws comes
   * from `notify`, called below on every `view` this component receives —
   * the module diffs it against the one before and spawns whatever changed.
   */
  const numbers = useRef<ReturnType<typeof installNumbers> | null>(null);
  const reportEffect = useRef(onEffect);
  reportEffect.current = onEffect;
  const fastNow = useRef(fastMode);
  fastNow.current = fastMode;
  /*
   * What left a battlefield is drawn leaving (`live/departures.ts`): its row keeps its place
   * (`leaving`, below — the same diff `numbers` makes), a copy of it plays its exit motion over that
   * place at the beat `numbers` gives it, and then the place closes. Layout effects, all three of
   * these, and in this order: `numbers` decides the beats (and when a resolving spell may fade, which
   * `placed` reads below), and `departures` is told what each card looked like only after.
   */
  const [shown, setShown] = useState<{ view: BoardView; leaving: ReadonlyMap<number, { departure: Departure; at: number }> }>(() => ({
    view,
    leaving: new Map(),
  }));
  let leaving = shown.leaving;
  if (shown.view !== view) {
    const next = new Map(leaving);
    for (const id of next.keys()) if (view.players.some((p) => p.battlefield.some((c) => c.id === id))) next.delete(id);
    if (!fastMode) for (const departure of departuresOf(shown.view, view)) next.set(departure.cardId, { departure, at: Date.now() });
    leaving = next;
    setShown({ view, leaving: next });
  }
  const departed = useCallback((cardId: number) => {
    setShown((s) => {
      if (!s.leaving.has(cardId)) return s;
      const next = new Map(s.leaving);
      next.delete(cardId);
      return { ...s, leaving: next };
    });
  }, []);
  // A departure whose beat never came — nothing drew it — gives its place back all the same.
  useEffect(() => {
    if (leaving.size === 0) return undefined;
    const oldest = Math.min(...[...leaving.values()].map((l) => l.at));
    const timer = setTimeout(
      () => {
        for (const [id, l] of leaving) if (Date.now() - l.at >= DEPARTURE_MAX_MS) departed(id);
      },
      Math.max(0, oldest + DEPARTURE_MAX_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [leaving, departed]);
  const leavingOn = (playerId: number): readonly Departure[] => {
    const out = [...leaving.values()].filter((l) => l.departure.playerId === playerId).map((l) => l.departure);
    return out.length === 0 ? NOTHING_LEAVING : out;
  };
  /*
   * A card still drawn on its way to a pile — a permanent leaving the battlefield, a resolved spell
   * waiting on the stack while its effects play (`live/placed.ts`'s `onHolding`) — is in no pile yet:
   * it shows up there, and the pile's count goes up, once its motion is over (the operator,
   * 2026-10-16: "make sure all these animations can finish before the card show up in the gy/exile
   * zones").
   */
  const [spellsHeld, setSpellsHeld] = useState<ReadonlySet<number>>(NOTHING_HELD);
  const held = leaving.size === 0 && spellsHeld.size === 0 ? NOTHING_HELD : new Set([...leaving.keys(), ...spellsHeld]);
  const pileOwner = openPile === null ? undefined : view.players.find((p) => p.id === openPile.playerId);
  const pileCards = pileOwner === undefined || openPile === null ? [] : unheld(pileOwner[openPile.zone], held);
  const shownPile = pileCards.length > 0 ? openPile : null;
  const openPileOf = (playerId: number) => (zone: PileZone) =>
    setOpenPile(shownPile?.playerId === playerId && shownPile.zone === zone ? null : { playerId, zone });
  const departures = useRef<ReturnType<typeof installDepartures> | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    const handle = installDepartures(el, { onDone: departed, report: (data) => reportEffect.current?.(data) });
    departures.current = handle;
    return () => {
      departures.current = null;
      handle.dispose();
    };
  }, [departed]);
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    const handle = installNumbers(el, {
      report: (data) => reportEffect.current?.(data),
      fastMode: () => fastNow.current,
      leave: (departure, delayMs) => departures.current?.leave(departure, delayMs),
    });
    numbers.current = handle;
    return () => {
      numbers.current = null;
      handle.dispose();
    };
  }, []);
  useLayoutEffect(() => {
    numbers.current?.notify(view, revealed ?? undefined);
  }, [view, revealed]);

  /*
   * The placed-cards layer (`live/placed.ts`, §S), booted the same way as the
   * inspector and the numbers: one mount into the same root, disposed on
   * unmount. `notify` runs on every `view` this component receives and on
   * every `interaction` change — Q18's own case, a spell on the stack that is
   * ALSO one of Forge's `setSelectables` by its own card id — mirroring
   * `installNumbers` exactly, one layer down. Layout effects, so the layer
   * repaints with the board in one frame: a spell that resolved onto the
   * battlefield was drawn on the stack AND in its row for a painted frame in
   * between (w67-shaman, the other screen's frame sheet).
   */
  const placed = useRef<ReturnType<typeof installPlaced> | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return undefined;
    const handle = installPlaced(el, { onHolding: setSpellsHeld });
    placed.current = handle;
    return () => {
      placed.current = null;
      handle.dispose();
    };
  }, []);
  useLayoutEffect(() => {
    placed.current?.notify(
      view,
      interaction === undefined ? undefined : { isSelectable: (cardId) => interaction.selectable.has(cardId), onSelect: interaction.onSelectCard },
    );
  }, [view, interaction]);
  // Last, every commit: where the stack is drawn now and how each battlefield card is, for the next commit's beats and departures.
  useLayoutEffect(() => {
    numbers.current?.noteStack(view);
    departures.current?.snapshot();
  });

  /*
   * The player's arrangement, out of the module store rather than React state
   * — a resync may remount this component and the arrangement must outlive
   * that. `redraw` is what a drag does: the store is the truth, so all a
   * handler has to do is change it and ask for a frame.
   */
  const key = matchKey(view);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    MOUNTED_BOARDS.add(redraw);
    return () => {
      MOUNTED_BOARDS.delete(redraw);
    };
  }, []);
  // T10: hydrated from `sessionStorage` the first time this tab sees this
  // match-and-seat (a real reload, not merely a resync-remount). There is no
  // viewer to key a seat's own storage by when none is identified, so that
  // case reads the in-memory store alone, exactly as it always did.
  const arranged = viewer === undefined ? (ARRANGED.get(key) ?? NO_ARRANGEMENT) : arrangementFor(key, viewer.id);
  /**
   * One drop, applied — a BATTLEFIELD rearrange only: `useArrangeDrag`,
   * below, never starts from a hand card (`CardOnBoard`'s `arrangeable`
   * excludes every one of them), so `slot` here is never `'hand'`. The
   * hand's own reorder is `commitHandMove`'s seam instead, written from
   * `live/gestures/install.ts`.
   *
   * Everything a drop does is here: it writes the store and asks for a
   * frame. It sends NOTHING — there is no sender in this scope, no ask, no
   * reply; a rearrange is invisible to Forge by construction. The commit
   * also checks that the carried card is actually on the viewer's own
   * battlefield (the snap itself only offers a card's own zone, so this is
   * the second lock, not the first) — moving a card between zones is
   * Forge's, never ours.
   */
  const commit = (cardIds: readonly number[], slot: ArrangeSlot, target: DropTarget): void => {
    if (viewer === undefined) return;
    if ('id' in target && cardIds.includes(target.id)) return;
    // Never reached — `slot` narrows `withMove`'s own `BoardRow` for the type checker, the
    // runtime fact being that `useArrangeDrag` never starts a drag from a hand card at all.
    if (slot === 'hand') return;
    if (!cardIds.every((id) => viewer.battlefield.some((c) => c.id === id))) return;
    setArranged(key, viewer.id, withMove(group(viewer.battlefield, viewer.id, arranged, boardLayout), viewer.id, arranged, cardIds, slot, target, boardLayout));
    redraw();
  };
  useArrangeDrag(root, viewer !== undefined, commit);
  const cardMenu = useCardMenu(
    root,
    viewer === undefined
      ? null
      : {
          cards: viewer.battlefield,
          playerId: viewer.id,
          arranged,
          layout: boardLayout,
          commit: (next) => {
            setArranged(key, viewer.id, next);
            redraw();
          },
        },
  );
  useZoneBoxes(root);

  /*
   * Fold in any PENDING placement (`notePlayedTo`, above) for a card the
   * viewer's battlefield currently shows — synchronously before paint
   * (`useLayoutEffect`, not `useEffect`), so there is no append-then-snap
   * flash: by the time the browser paints this frame, the card is already
   * where the cast's drop point said it should be. `notePlayedTo` is called
   * before Forge's reply adds the card to the battlefield, so the next
   * change to `viewer` (that very reply) is already what re-runs this
   * effect — no separate wake-up needed. A card with no pending placement,
   * or a stale (TTL-expired) one, is left alone — `group()`'s own default
   * for an arrival (the first free column of its row, else the row's end).
   */
  LIVE_VIEWER_ID = viewer?.id ?? null;
  LIVE_MATCH_KEY = key;
  useLayoutEffect(() => {
    const now = Date.now();
    let next = arranged;
    let ownChanged = false;
    for (const player of view.players) {
      const pending = PENDING_PLACEMENTS.get(player.id);
      if (pending === undefined) continue;
      // A placement takes its card whenever it is on the battlefield — already there, or arriving
      // later: the message is the authority, whichever came first.
      const card = pending.expiresAt < now ? undefined : player.battlefield.find((c) => c.id === pending.cardId);
      if (card !== undefined) {
        next = withMove(group(player.battlefield, player.id, next, boardLayout), player.id, next, card.id, pending.slot, pending.target, boardLayout);
        if (player.id === viewer?.id) ownChanged = true;
      }
      if (card !== undefined || pending.expiresAt < now) dropPlacement(player.id);
    }
    if (next !== arranged) {
      if (ownChanged && viewer !== undefined) setArranged(key, viewer.id, next);
      else ARRANGED.set(key, next);
    }
  }, [view, viewer, arranged, key, boardLayout]);

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
            leaving={leavingOn(p.id)}
            held={held}
            onOpenPile={openPileOf(p.id)}
          />
        ))}
      </div>

      {/*
       * The old stack band's column. `data-question` is the whole of items 7
       * and 13 on this side: ROOMY by default, compact while a question
       * stands in front of it (`board.css` reads it) — still true, because
       * `live/placed.ts`'s default spot (decision a) is this column's own
       * centre, so a question narrowing it moves where an unplaced spell
       * lands too. `StackView` itself draws nothing here any more (§S): every
       * item is a card, at a point, in the overlay — see `live/placed.ts`.
       */}
      <div
        className="board__mid"
        data-testid="board-mid"
        data-question={interaction?.questionOpen === true || undefined}
      >
        <StackView count={view.stack.length} carried={carried} />
      </div>

      {staged !== undefined && <StagingArea card={staged} interaction={interaction} />}

      {viewer !== undefined && (
        <PlayerArea
          player={viewer}
          interaction={interaction}
          arranging={arranging}
          arranged={arranged}
          layout={boardLayout}
          leaving={leavingOn(viewer.id)}
          held={held}
          onOpenPile={openPileOf(viewer.id)}
          onOpenSettings={onOpenSettings}
          onOpenDeck={onOpenDeck}
        />
      )}

      {/*
       * Out of flow: the missing-card alert may appear mid-game and a track
       * that appears is exactly what the static rule forbids.
       *
       * The old `game over` banner (`.board__over`) that used to render here
       * is GONE (wave 35, R16, the manager's ruling on seam 4 in
       * `docs/planning/wave35-2026-10-02.md`): `LiveBoard` (lane L) now draws
       * a full result screen over the board when `view.gameOver`, as
       * `<section data-testid="game-result" class="board__over">`, styled
       * entirely in `live.css`. `Board` itself draws no game-over text and
       * owns no `.board__over` rule — see `Board.test.ts`'s
       * "the turn bar is deleted" describe block.
       */}
      {view.missingCardIds.length > 0 && (
        <p className="board__warn" role="alert">
          {view.missingCardIds.length} card(s) named by a zone never arrived: {view.missingCardIds.join(', ')}
        </p>
      )}
      <div className="board__overlay" data-board-overlay="">
        {cardMenu}
        {shownPile !== null && pileOwner !== undefined && (
          <PileView
            ownerSide={pileOwner.isViewer ? 'you' : 'them'}
            zone={shownPile.zone}
            label={shownPile.zone === 'graveyard' ? 'Graveyard' : 'Exile'}
            count={pileCards.length}
            onClose={closePile}
          >
            {/* Newest first — and before them every card Forge offers from the pile, however deep it lies. */}
            {[...pileCards]
              .reverse()
              .sort((a, b) => Number(interaction?.actionable?.has(b.id) === true) - Number(interaction?.actionable?.has(a.id) === true))
              .map((c) => (
              <CardOnBoard key={c.id} entry={c} interaction={pileInteraction} inExile={shownPile.zone === 'exile'} />
            ))}
          </PileView>
        )}
      </div>
      <TopLayer clip />
    </section>
  );
}
