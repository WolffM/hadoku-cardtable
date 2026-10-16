/*
 * Wire state → the board's view model.
 *
 * `fold.ts` produces Forge's object graph as the client holds it: id-keyed
 * property bags. This module is the only place that knows which of those
 * properties mean "battlefield" or "life", and it is the seam the fixture
 * discipline buys: the components under `./Board.tsx` render a `BoardView` and
 * cannot tell whether it came from a committed fixture (`./fixtures.ts`) or a
 * live match over a socket (`./live/match.ts`). Both call `toBoardView` the
 * same way, and `./live/parity.test.ts` holds them to identical markup.
 *
 * ## Where each zone comes from
 *
 * | board              | wire                                                    |
 * | ------------------ | ------------------------------------------------------- |
 * | turn, phase        | GameView `Turn`, `Phase` (`PhaseType` enum name)        |
 * | active player      | GameView `PlayerTurn` (player id)                       |
 * | stack              | GameView `Stack` — StackItemView ids, **top first**     |
 * | life               | PlayerView `Life`                                       |
 * | hand / library     | PlayerView `Hand` / `Library` — card ids                |
 * | battlefield, etc.  | PlayerView `Battlefield` / `Graveyard` / `Exile`        |
 * | a card's face      | the CardStateView at `cardId*16 + CurrentState`         |
 *
 * **Zone membership is the PlayerView's list, never the card's own `Zone`.**
 * Forge's client does the same — it re-stamps each card's `Zone` from the list
 * that holds it (`NetworkGuiGame.applyPropertyMap`), because the per-card field
 * can lag the lists.
 *
 * **A spell is on the stack only while no zone list holds its card.** GameView
 * `Stack` and the PlayerView lists are separate objects, and Forge may send
 * them in separate deltas: a resolving creature arrives on the battlefield one
 * frame before the stack lets go of it (st-stack-resolve, the other seat's
 * screen, ~40 ms apart on a busy runner). Every layer reads one view, so the
 * view puts the card in one place — the list that holds it.
 *
 * "Stack is top first" is read from the data, not assumed: in the committed
 * game the stack is `[49, 48]`, where 48 is the spell and 49 the trigger it
 * caused, so the newer item leads.
 *
 * ## Hidden information
 *
 * An opponent's hand is a **count**. The adapter does not map those cards at
 * all, so no component can render one by accident. That matters more than it
 * sounds: in the captured stream the opponent's hand cards arrive WITH their
 * names — the wire does not hide them in this harness — so the renderer is the
 * last line, and it holds.
 *
 * ## What the wire does not carry
 *
 * - **No Scryfall id.** A card's print is Forge's `ImageKey`
 *   (`c:Mountain|MRD|1` — name, set, art index), not a Scryfall id. The
 *   adapter looks the id up by `Name` + `SetCode` in an `ArtIdIndex`
 *   (`@hadoku/carddata/art`) and puts it on the `DraftCard`; `CardTile` then
 *   resolves the art through the same module exactly as the draft screen does.
 *   Nothing here builds an image URL: the adapter moves an id, the resolver
 *   owns the host.
 *
 *   The default index used to be the cube's `pool.json` alone, which is why
 *   every card a match can contain that was NOT in the drafted cube — a basic
 *   land above all, and every card of a constructed list — had no id and drew
 *   the text tile. That is wave 19 §D #9, *"some art missing"*. The default
 *   is now `KNOWN_ART_IDS`: the pool first (so a cube card still resolves to
 *   the printing its cube was built from), then the committed
 *   `../draft/art-ids.json`, which carries every basic land under every Forge
 *   set code, every card of the committed `decks/` lists, and a bare-name
 *   fallback row per name. `scripts/art/build-art-ids.ts` generates it.
 * - **No collector number.** Left empty.
 * - **Which player is "me".** That is `openView(myPlayers)`, not a delta, so
 *   the caller passes `viewerPlayerId`. The fixture records it beside the
 *   capture; a live match takes it from the server's `MatchSnapshot.playerId`
 *   and never infers it from the state.
 *
 * An id that names no player in the game makes NO seat the viewer, so every
 * hand is a count. That is the safe failure: a wrong or missing viewer hides a
 * hand rather than showing one.
 *
 * ## Attachment: `AttachedCards` is the authority, `EntityAttachedTo` is not
 *
 * Both arrive (`TrackableProperty.java:16, 90`; mapped by
 * `packages/forge-wire/src/tier-c.ts` and let through by
 * `apps/server/src/play/visibility.ts`'s `FACE_ONLY_KEEP`), and they say the
 * same thing from opposite ends — which of them the board may BUILD a stack
 * from is not a matter of taste:
 *
 *   - `AttachedCards` is a `CardViewCollectionType`, so it is a list of CARD
 *     ids and nothing else. Unambiguous.
 *   - `EntityAttachedTo` is a `GameEntityViewType`, which the server flattens
 *     to a bare int (`DeltaSyncManager.toNetworkValue`). A `GameEntity` is a
 *     card OR A PLAYER, and the two id spaces overlap — player 1 and card 1
 *     are both `1` on the wire. An aura on a player would therefore stack onto
 *     whichever card happens to share the number.
 *
 * So `attachedCardIds` (from the host) is what `Board.tsx` draws a stack from;
 * `attachedToId` is carried because it is the attachment's own view of the
 * world and a component may want to mark itself as attached, and it never
 * creates a stack by itself.
 *
 * ## P/T: what the wire has, and the one thing it has not
 *
 * `Power` / `Toughness` (`TrackableProperty.java:132-133`) are the CURRENT
 * values, `Damage` (:61) is damage marked, and all three arrive. So "damaged"
 * is fully derivable here.
 *
 * "Buffed" is not: there is **no `BasePower`/`BaseToughness` and no printed or
 * original card state in `TrackableProperty`** — the states are
 * `CurrentState` / `AlternateState` / `LeftSplitState` / `RightSplitState`
 * (:109-112), `OriginalColors` (:121) and `OriginalManaCost` (:125) exist with
 * no P/T counterpart, and `HasPrintedPT` (:139) is a boolean Forge sets only
 * for vehicles and spacecraft (`CardView.java:1102`). Verified by census of the
 * committed capture: every `Power`/`Toughness` on the wire is a `CardStateView`
 * property and no `Base*` key appears at all.
 *
 * The printed base therefore comes from OUR card data — `../draft/pool.json`,
 * which carries `power`/`toughness` per card — keyed by name
 * (`POOL_PRINTED_PT`). Coverage is the cube and nothing else, and a card it has
 * never heard of has NO printed base: `boardPT` then reports `plain`, never
 * "buffed". A `*` or `1+*` printed value is not a number and is treated the
 * same way. Guessing a base would paint a plain creature blue, which is worse
 * than drawing it plain.
 *
 * `LethalDamage` (:63) arrives too and is carried, but the board does not draw
 * its number: it is `getLethal() - getDamage() - getTotalAssignedDamage()` and
 * returns **0** outright when any assigned damage has deathtouch
 * (`Card.java:5978-5986`), so it is not "remaining toughness".
 *
 * ## Haste is not summoning sickness
 *
 * Forge's `Sickness` (:54) is true for anything that arrived this turn, haste
 * or not. `Keywords` (:146, `KeywordCollectionViewType`) is on the wire as each
 * keyword's `original()` text — verified in the committed capture, where Oxidda
 * Golem's face carries `["Affinity:Mountain", "Haste"]` — so `summoningSick` is
 * `Sickness` AND no `Haste`, and `arrivedThisTurn` keeps Forge's raw answer for
 * anyone who wants it.
 *
 * ## The mana pool: `Mana`, and the one byte that is not the colour you expect
 *
 * A seat's FLOATING mana is `PlayerView.Mana` — set to an empty map in the
 * constructor (`PlayerView.java:54`) and refilled by `updateMana`
 * (`PlayerView.java:501-507`) — and until wave 26 nothing here read it, so a
 * player could not see mana they had already tapped for. Forge applies the pool
 * to a cost before it asks for the rest, so the mana works; it was simply
 * invisible, which is the bug.
 *
 * It crosses as `ManaMapType` → `{ t: 'map', v: [[byte, int], …] }`
 * (`packages/forge-wire/src/tier-c.ts`), and the keys are **`ManaAtom`'s**, not
 * `MagicColor`'s. That distinction is the whole of the mapping and it is easy to
 * get wrong in exactly one place: `updateMana` iterates `ManaAtom.MANATYPES`
 * (`ManaAtom.java:15`), whose colourless is `1 << 5` = **32**, while
 * `MagicColor.COLORLESS` is **0** (`MagicColor.java:22`). W/U/B/R/G agree at
 * 1/2/4/8/16 because `ManaAtom` copies them (`ManaAtom.java:7-11`).
 *
 * Read off the committed capture rather than the constant: every `Mana` value in
 * `fixtures/tierc-game1-seq1-27.json` is a six-entry map over the bytes
 * `{16, 32, 1, 2, 4, 8}`, all of them `0` — a real pool at a moment with nothing
 * floating, which is also why the fixture draws no pool at all.
 *
 * Only NON-ZERO colours reach the view: Forge sends all six every time, and six
 * zeroes are not a pool. A player with nothing floating has an empty list.
 */

import {
  artIdIndex,
  artIdIndexFromTable,
  mergeArtIdIndexes,
  scryfallIdFor,
  type ArtIdIndex,
  type ArtIdSource,
  type ArtIdTableFile,
} from '@hadoku/carddata/art';
import type { DraftCard, ManaColor, Rarity } from '@hadoku/shared';

import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import poolData from '../draft/pool.json' with { type: 'json' };
import type { PendingTriggers, WaitingEffects, WireState } from './fold.ts';
import { cardStateKey, deltaKey, WireType, type Tagged, type WireObject } from './wire.ts';

/** One effect a permanent's resolved ability left waiting — {@link BoardCard.waiting}. */
export interface BoardCardWaiting {
  kind: 'trigger' | 'effect';
  text: string;
}

export interface BoardCard {
  id: number;
  /** What `CardTile` draws. */
  card: DraftCard;
  /**
   * This seat's wire carries no name for the card — it may not see it — so the
   * board draws its back, and `card.name` is `HIDDEN_CARD_NAME`.
   */
  hidden?: boolean;
  tapped: boolean;
  /** It arrived this turn AND cannot act: Forge's `Sickness` and no `Haste`. */
  summoningSick: boolean;
  damage: number;
  /*
   * Everything below is OPTIONAL, and that is a deliberate boundary rather than
   * laziness: `toBoardCard` always sets all of it, and a `BoardCard` typed out
   * by hand in a suite that is testing something else entirely (the inspector's,
   * say) does not have to restate the whole wire to name a card. Readers take
   * the absent case as "nothing known", which is the same answer the wire gives
   * for a card with no attachments and no keywords.
   */
  /** Forge's raw `Sickness` — true for anything that arrived this turn, haste or not. */
  arrivedThisTurn?: boolean;
  /**
   * A card the viewer holds — in its hand, or its library's revealed top — that another player was
   * shown and still knows: the server's projection names that player in the card's `PlayerMayLook`
   * for the card's holder only (`apps/server/src/play/visibility.ts`, "What the other seats were
   * shown"), and stops the moment that player forgets it. Absent otherwise.
   */
  seenByOpponent?: boolean;
  /** Each keyword's `original()` text, off the current face (`Keywords`). */
  keywords?: readonly string[];
  /** Forge's `LethalDamage`. Carried, not drawn — see the header. */
  lethalDamage?: number;
  /** `AttachedCards`: what Forge says is attached TO this card. The stack's authority. */
  attachedCardIds?: readonly number[];
  /**
   * `EntityAttachedTo`: what this card is attached to, as the bare int the
   * server flattens a `GameEntityView` to. A CARD or a PLAYER — the id spaces
   * overlap — so nothing may build a stack from it. See the header.
   */
  attachedToId?: number | null;
  /** Printed P/T from our own card data, or `null` when we do not know the card. */
  printed?: { power: number; toughness: number } | null;
  counters: { name: string; count: number }[];
  attacking: boolean;
  blocking: boolean;
  token: boolean;
  /**
   * Set when an effect has changed what this permanent IS: its current type line (the wire's
   * `Type`) is not the one printed on it, which Forge itself reports for every battlefield
   * permanent (`PlayBridge.java`'s `printedTypes`: the face's own type before any effect, plus its
   * characteristic-defining abilities; a copy's is the copied card's, so Phyrexian Metamorph's
   * "an artifact in addition" is a change). Magus of the Moon's nonbasic land reads `Land — Mountain`
   * against a printed `Land`; Urborg's Plains reads `Basic Land — Plains Swamp`. `name` is the
   * card's own; `printed` the printed line, drawn as the pill's hover text. `null` when nothing
   * changed.
   *
   * `ChangedTypes` (`tier-c.ts`, Forge's `Card.getChangedTextTypeWords()`) is NOT this fact: it
   * is a word-substitution map for RULES TEXT (`forge-game/.../card/Card.java:5477`).
   */
  changedFrom?: { name: string; printed: string } | null;
  /**
   * The operator, 2026-10-12: *"any card that selects a color or makes a
   * decision that becomes a permanent thing about it on the battlefield should
   * recieve a visual indicator."* Every choice Forge tracks on this permanent's
   * `CardView` (`CHOICE_PROPS`: a colour, a creature type, a named card, a
   * player, a number, a mode…), one entry per property, in that table's order.
   * Absent/empty for a card that has chosen nothing, which is most cards.
   */
  choices?: BoardCardChoice[];
  /**
   * The operator, 2026-10-13: *"indicator for active affect of narset -2 effect … maybe on a black
   * chip on the planes walker?"* What a resolved ability of this permanent left waiting
   * (`PlayBridge.java`'s `waitingEffects`): a delayed trigger Forge holds until it fires, or an
   * effect naming this card as its source. Forge's own words; absent for a card with none.
   */
  waiting?: BoardCardWaiting[];
  /**
   * The card that made this token (`PlayBridge.java`'s `tokenSources`): the host of the ability that
   * created it — Kalitas for the Zombie its replacement makes. Absent for a card Forge keeps none for.
   */
  createdBy?: number;
  /**
   * The operator, 2026-10-15: *"would be nice if we had an indicator for can't block"*. Set when
   * Forge says this creature can't block (`PlayBridge.java`'s `cantBlock`, `CombatUtil.canBlock`
   * with its own restrictions only — tapped is not one). Absent for every creature that can.
   */
  cantBlock?: true;
  /**
   * The operator, 2026-10-15: *"i would like it if the game told you when things like 'metalcraft'
   * are active … in hearthstone the card turns orange when its conditional effect is 'active'"*. Set
   * when Forge says this card's own condition is met right now (`PlayBridge.java`'s `conditionMet`:
   * metalcraft, threshold, delirium, hellbent, "as long as you control …"), in a hand or on a
   * battlefield. Absent for every card whose condition is off, and for a card with none.
   */
  conditionMet?: true;
  /**
   * The operator: *"i played 'Cry of Contrition' which has haunt. i expect
   * to see the 'haunt' keyword on my creature … is there an easier way to
   * always get that effect name to popup rather than having to hardcode all
   * of them?"* Every relation Forge's wire names generically (`readRelations`'s
   * own table), read off `view` like `AttachedCards` — a live fact about the
   * permanent, not its printed face. Absent/empty for a card with none,
   * which is every card most of the time.
   */
  relations?: BoardCardRelation[];
  /**
   * Forge's live `AbilityText` (`CardStateView.getAbilityText`, the same face
   * `oracleText` reads off) — the ability text AS FORGE HAS IT NOW, haunt's
   * own granted keyword included, where `card.oracleText` is only ever the
   * PRINTED text. `null` when Forge sent nothing (never a drawn blank); see
   * `readAbilityText`'s own note for why this is never raw HTML.
   */
  abilityText?: string | null;
}

/**
 * A relation Forge's own wire says this card has to another — haunt, encode,
 * imprint, a must-block list, and whatever the wire
 * adds next. `ids` is the other side's forge id(s), in Forge's own order;
 * `names` is each one resolved to a name (`nameOfCard`), `HIDDEN_CARD_NAME`
 * for one this seat may not see.
 */
export interface BoardCardRelation {
  kind: RelationKind;
  ids: number[];
  names: string[];
}

/** Every relation kind the board draws a pill for. See `RELATION_PROPS`. */
export type RelationKind = 'hauntedBy' | 'haunting' | 'encoded' | 'imprinted' | 'mustBlock';

/** What a choice a permanent carries is OF — one per row of `CHOICE_PROPS`' kinds. */
export type ChoiceKind =
  | 'color'
  | 'type'
  | 'notedType'
  | 'card'
  | 'chosenCard'
  | 'player'
  | 'protector'
  | 'number'
  | 'mode'
  | 'direction'
  | 'evenOdd'
  | 'sector';

/**
 * One choice Forge says this permanent made or was given: `values` in Forge's
 * own order, already words — a colour capitalised (`Blue`), a card or player
 * resolved to its name. Never empty.
 */
export interface BoardCardChoice {
  kind: ChoiceKind;
  values: string[];
}

/**
 * How one of a card's two numbers stands: against its printed base (`buffed`,
 * `hurt`, `plain`), or — toughness only — `damaged`, which wins over the
 * printed comparison because the number drawn is already what is left.
 */
export type PTState = 'buffed' | 'hurt' | 'damaged' | 'plain';

/** What the board draws for a creature's power and toughness. */
export interface BoardPT {
  /** Forge's current power. */
  power: number;
  /** Current toughness less damage marked — what is left of it. */
  toughness: number;
  powerState: PTState;
  toughnessState: PTState;
  /** `null` when our card data has no printed base for this card. */
  printed: { power: number; toughness: number } | null;
  damage: number;
}

/**
 * The operator's spec (#12, #18): *a 1/2 with +2/+2 that has taken 3 reads
 * 3 (blue) / 1 (red)*.
 *
 * Power is Forge's current power; toughness is what is LEFT of it, current less
 * damage marked. Toughness with damage marked is `damaged` and nothing else —
 * the operator, 2026-10-11, of a 4/5 Tarmogoyf dealt 3: *"just show 4/2(red)"*.
 * Otherwise a number is `buffed` when it is above the printed base, `hurt` when
 * below it, and `plain` when nothing is known — which is what a card our data
 * has never heard of always gets, because an unknown base may not be drawn as a
 * buff.
 *
 * `null` for anything without both numbers: not a creature, or a creature whose
 * face carried no P/T.
 */
export function boardPT(entry: BoardCard): BoardPT | null {
  const power = Number(entry.card.power);
  const current = Number(entry.card.toughness);
  if (entry.card.power === undefined || entry.card.toughness === undefined) return null;
  if (!Number.isFinite(power) || !Number.isFinite(current)) return null;
  const damage = entry.damage;
  const toughness = current - damage;
  const printed = entry.printed ?? null;
  const against = (value: number, base: number | undefined): PTState =>
    base === undefined ? 'plain' : value > base ? 'buffed' : value < base ? 'hurt' : 'plain';
  return {
    power,
    toughness,
    powerState: against(power, printed?.power),
    toughnessState: damage > 0 ? 'damaged' : against(toughness, printed?.toughness),
    printed,
    damage,
  };
}

/**
 * One colour of a seat's mana pool. `C` is Forge's colourless mana — a mana
 * type, which is why it is not in `ManaColor`.
 */
export type PoolColor = ManaColor | 'C';

/** How much of one colour is floating in a seat's pool. Never zero. */
export interface ManaInPool {
  color: PoolColor;
  count: number;
}

export interface BoardPlayer {
  id: number;
  name: string;
  /** Forge's life total, less what the player has committed to an open payment (`AdaptOptions.lifePaying`). */
  life: number;
  isViewer: boolean;
  isActive: boolean;
  hasPriority: boolean;
  hasLost: boolean;
  /** `null` for anyone but the viewer: an opponent's hand is a count. */
  hand: BoardCard[] | null;
  /**
   * Someone else's hand in Forge's order, a card this seat was shown and still knows (the server's
   * projection keeps it and names the seat in its `PlayerMayLook` — `apps/server/src/play/
   * visibility.ts`, "What a seat was shown") in its place and `null` for every other. Absent when
   * the seat knows none of it, and for the viewer.
   */
  handShown?: readonly (BoardCard | null)[];
  handCount: number;
  libraryCount: number;
  /**
   * The library's card ids, top first — ids only: the projection hides every
   * library card but a top one the seat may look at (`libraryTop`). Read so a reorder can be heard as a shuffle
   * (`live/sound-events.ts`); Forge re-sends the list on every shuffle
   * (`Zone.shuffle` → `onChanged` → `updateZoneForView`). Optional, like the
   * other late fields, for hand-typed players in other suites.
   */
  libraryIds?: readonly number[];
  /**
   * The library's top card, when this seat may see it standing revealed: Forge puts the seat in that
   * card's `PlayerMayLook` (Courser of Kruphix and Future Sight for everyone, Vizier of the Menagerie for
   * its controller only), or revealed it to the seat (Goblin Guide) and the seat still knows it, and the
   * server's projection then sends its face. Absent otherwise — the
   * projection sends a library card it may not see as existence only, never a name — and absent while a
   * prompt shows the seat more of its library than the top (`revealedTop`).
   */
  libraryTop?: BoardCard;
  battlefield: BoardCard[];
  graveyard: BoardCard[];
  exile: BoardCard[];
  /**
   * The floating mana in this seat's pool, WUBRG then colourless, zero counts
   * dropped (`PlayerView.Mana`; see the header). A public fact in Magic, so it
   * is read for every seat and not only the viewer's.
   *
   * OPTIONAL for the same reason `BoardCard`'s late fields are: `toBoardView`
   * always sets it, and a `BoardPlayer` typed out by hand in a suite testing
   * something else (`inspect/index.test.ts`) need not restate the wire. Absent
   * means "nothing known", which draws the same as an empty pool.
   */
  manaPool?: readonly ManaInPool[];
  /**
   * The game's storm count — spells cast this turn (`GameView.StormCount`, which
   * `MagicStack` refreshes on every cast and clears at the turn's start) — set only
   * on the VIEWER's own seat and only while their hand holds a card with Storm:
   * the operator, 2026-10-14, *"show storm counter as an emblem if storm card in
   * hand"*. Never on another seat: whether an opponent holds a Storm card is
   * hidden, and a count that appeared beside them would say so.
   */
  storm?: number;
  /**
   * Player-level counters — poison, energy, experience, and anything else
   * Forge tracks on the PLAYER rather than a card (wave 33 item 4, the first
   * list's item 4: *"poison/infect counters are shown nowhere."*).
   *
   * Read off the SAME wire property a card's own counters use —
   * `GameEntityView.updateCounters` sets `TrackableProperty.Counters` from
   * `CounterMapType` on both `CardView` and `PlayerView` alike, because both
   * extend `GameEntityView` (`GameEntityView.java:94-97`, verified in the
   * cached build). A player's multiset holds `CounterEnumType.POISON` /
   * `ENERGY` / `EXPERIENCE` (`CounterEnumType.java:496-500`) under the SAME
   * `Counters` key a card's `+1/+1` lives under — `countersOf` already reads
   * it, unchanged, for either kind of object.
   *
   * OPTIONAL for the same reason `manaPool` above is: `toBoardView` always
   * sets it, and a `BoardPlayer` typed out by hand in a suite testing
   * something else need not restate the wire. Absent means "nothing known",
   * which draws the same as an empty list — never a drawn zero.
   */
  counters?: readonly { name: string; count: number }[];
  /**
   * The operator, 2026-10-14: *"i need a visual for emblems. let's make it so they go around the
   * player's avatar and hovering the players avatar shows all their emblems."* Every emblem this
   * player has, in Forge's order: an effect card with `IsEmblem` in the player's `Command` zone,
   * which the projection sends both seats in full (a public zone). Absent for a player with none.
   */
  emblems?: readonly BoardEmblem[];
  /**
   * The watchparty character this seat picked, as an id — wave 28 item 4's
   * render half, populated for real as of wave 29 §A.6-8.
   *
   * The remaining hop wave 28 left open (`docs/planning/wave28-evidence/D-avatar-field.md`
   * §2: `routes.ts` → `play/socket.ts` → `play/match.ts` → here) is wired: §B
   * sends every seat's identity on its own event, `forge:seats`
   * (`live/match.ts`'s `adoptSeats`), keyed by the join envelope's own
   * `playerId` — a Forge player id, the same id `BoardPlayer.id` already is —
   * and `toBoardView` below joins the two by it.
   *
   * Still additive and optional: `PlayerFace` draws it when it is there, and a
   * seat without one keeps the generated mark, because a seat with no face is
   * worse than a generic one. `AdaptOptions.avatarByPlayerId` is what a caller
   * (live or fixture) supplies to fill it; the fixture path supplies nothing,
   * so every committed fixture still draws the generated bust, unchanged.
   *
   * Two states, never three: a non-blank string, or absent —
   * `D-avatar-field.md` §3's rule, kept all the way to here. `avatarSquareUrl`
   * (`../room/avatar.ts`) answers `null` for absent, blank and over-long alike,
   * so one null check is the whole fallback.
   */
  avatarId?: string;
}

/** One emblem a player has — {@link BoardPlayer.emblems}. */
export interface BoardEmblem {
  id: number;
  /** The card that made it: Forge names an emblem `Emblem — <source>`. */
  source: string;
  /** What it does, in Forge's own words (its `AbilityText`); its name when Forge sent none. */
  text: string;
  /** The source's art id, when the art index knows the source. */
  scryfallId?: string;
}

/** Forge's emblem name, `Emblem — Sorin, Lord of Innistrad`, to the card that made it. */
const EMBLEM_NAME = /^Emblem\s*[—–-]\s*/;

/** The emblems in a player's `Command` zone — a commander or a non-emblem effect card there is not one. */
function readEmblems(state: WireState, player: WireObject | undefined, artIds: ArtIdIndex, printedPT: PrintedPTIndex): BoardEmblem[] {
  const out: BoardEmblem[] = [];
  for (const id of readIds(player, 'Command')) {
    if (!readBool(state.get(deltaKey(WireType.Card, id)), 'IsEmblem')) continue;
    const c = toBoardCard(state, id, artIds, printedPT);
    if (c === null || c.hidden === true) continue;
    const source = c.card.name.replace(EMBLEM_NAME, '');
    const scryfallId = scryfallIdFor(artIds, source, c.card.setCode);
    out.push({ id, source, text: c.abilityText ?? c.card.name, ...(scryfallId === undefined ? {} : { scryfallId }) });
  }
  return out;
}

export interface StackEntry {
  id: number;
  description: string;
  /**
   * The CardView the item came from. Forge names a spell on the stack by its
   * card, so this is the id `setSelectables` uses when the item is a target.
   */
  sourceCardId: number | null;
  sourceName: string | null;
  /** The source card's full face, so the stack can draw its art. Null when the item names no card. */
  sourceCard: DraftCard | null;
  /** This seat's wire names no source card (`BoardCard.hidden`) — a face-down spell of theirs: drawn as its back. */
  sourceHidden?: boolean;
  /**
   * An ability's own words, for its chip: `abilityTextOf` — never `description`'s stack-instance
   * notes (its targets, the object that triggered it). Absent on an entry typed out by hand: the
   * chip reads `description` then.
   */
  abilityText?: string;
  controllerName: string | null;
  isAbility: boolean;
  /**
   * Wave 33 agreed shape 2: this item's targets, from `StackItemView`'s own
   * `TargetCards` / `TargetPlayers` (`TrackableProperty.java:225-226`, both set
   * from `SpellAbilityStackInstance.getTargetChoices()` — `StackItemView.java`,
   * `updateTargetCards`/`updateTargetPlayers`) and from every `SubInstance`
   * under it (`subInstanceChain`): a modal spell's chosen modes target from
   * there, never from the item itself. Each id once; both cross as the same
   * `list`-of-`int` shape every other entity collection does (`readIds`),
   * empty when the item targets nothing of that kind — never missing.
   *
   * **Not how a Stifle-like ability is targeted.** Forge's own targeting for
   * "counter target activated or triggered ability" does not use these at
   * all: `TargetSelection.chooseCardFromStack` (`forge-gui/.../player/TargetSelection.java:299-342`)
   * asks a GENERIC list-choice (`getGui().one`/`oneOrNone`) over the
   * `StackItemView`s themselves, which is one of Forge's own prompts, not a
   * `setSelectables` card offer. So `interaction.selectable` never contains a
   * stack item id for this purpose, and clicking a stack entry can never BE
   * that answer; these two fields exist for drawing an ARROW from a resolved
   * target (shape 2's stated purpose — G's lane), not for making an entry
   * clickable.
   *
   * OPTIONAL for the same reason `BoardPlayer.manaPool` is: `toBoardView`
   * always sets both, and a `StackEntry` typed out by hand in a suite testing
   * something else (`inspect/index.test.ts`) need not restate the wire.
   * Absent means "nothing known", which draws no arrow — the same answer an
   * empty list gives.
   */
  targetCardIds?: readonly number[];
  targetPlayerIds?: readonly number[];
  /**
   * Wave 36 T8, the operator's own words: *"Alice · Lightning Bolt → Bob"* —
   * the stack's one line names its target. This is `targetCardIds` /
   * `targetPlayerIds` ABOVE, resolved to the names the board already knows
   * (a target card's name off the same wire `toBoardCard` reads any other
   * card by, a target player's off the same seat-identity-aware name
   * `BoardPlayer.name` carries) and joined, so `Board.tsx` draws a name and
   * never an id. Several targets join with a comma; no target is `null`,
   * never a drawn "→" with nothing after it.
   *
   * OPTIONAL for the same reason the two id lists above are: a `StackEntry`
   * typed out by hand (Q18's test, this file) need not restate the wire.
   */
  targetLabel?: string | null;
  /**
   * Wave 49 §A — the OTHER stack item this item targets, when its target is
   * itself a spell or ability on the stack (a counterspell, "counter target
   * activated or triggered ability"). NOT read from `targetCardIds`/
   * `targetPlayerIds` above: both read EMPTY for this exact case — Forge's
   * `TargetChoices` can hold a bare `SpellAbility`, which fails both
   * collections' runtime-type filter (confirmed against the real jar,
   * `scenario-w46-b-counterspell.jvm.test.ts`). This is `AdaptOptions.
   * stackTargetSpells`, keyed by this item's own id — the bridge's wire
   * fact, true for every seat. `live/placed.ts` draws the arc straight off
   * this field now (wave 64/J6); `match.ts`'s `stackTargetArcs` was the
   * CASTER's own client-side pairing, claimed before this wire fact caught
   * up, and `gestures/auto-targets.ts`'s `stackTargetArrows` was the one
   * reader that unioned the two — both deleted (wave 64/J6), dead with no
   * caller left once `placed.ts` took over drawing the arc.
   *
   * `null` when the item targets nothing on the stack, or when no
   * `stackTargetSpells` map was supplied at all. OPTIONAL for the same
   * reason `targetCardIds`/`targetPlayerIds` above are: `toBoardView` always
   * sets it, and a `StackEntry` typed out by hand in a suite testing
   * something else need not restate the wire. Absent and `null` both mean
   * "nothing on the stack" alike.
   */
  targetStackItemId?: number | null;
  /**
   * A trigger Forge has collected and not yet put on the stack (`BoardView.pendingTriggers`):
   * drawn as its chip already, waiting. Its `id` is the trigger's ability id negated, so it never
   * meets a stack id.
   */
  pending?: true;
  /** The waiting trigger whose target question is open. */
  current?: true;
}

/**
 * One hit of damage on a card, as Forge dealt it (`PlayBridge.java`'s `damage`, beside the frame that
 * shows what it did). `seq` rises across a match and never repeats, so a view's newest hits are the
 * ones above the last `seq` already drawn. `sourceId` is null when Forge named no source or this
 * seat may not see it.
 */
export interface DamageHit {
  readonly seq: number;
  readonly cardId: number;
  readonly sourceId: number | null;
  readonly amount: number;
}

/**
 * One hit of damage on a player, as Forge dealt it (`PlayBridge.java`'s `faceDamage`): numbered with
 * the hits on cards (`DamageHit.seq`), so the two read in the order Forge dealt them. `combat` is
 * Forge's own word that it was combat damage.
 */
export interface FaceHit {
  readonly seq: number;
  readonly playerId: number;
  readonly sourceId: number | null;
  readonly amount: number;
  readonly combat: boolean;
}

/** Why a permanent went to its graveyard, as Forge says it (`PlayBridge.java`'s `deaths`, the fork's `GameEventCardDied.Cause`). */
export type DeathCause = 'DESTROYED' | 'LETHAL_DAMAGE' | 'DEATHTOUCH' | 'ZERO_TOUGHNESS' | 'STATE_RULE' | 'SACRIFICED';

export interface BoardView {
  seq: number;
  title: string;
  turn: number;
  /** `PhaseType` constant name, e.g. `MAIN1`. `null` before the first turn. */
  phase: string | null;
  phaseLabel: string;
  activePlayerId: number | null;
  /** Viewer first, then the others in the game's own order. */
  players: BoardPlayer[];
  /** Top of the stack first. */
  stack: StackEntry[];
  /**
   * The triggers waiting to go on the stack, each as the entry it will be (`pending`). OPTIONAL like
   * `combat`: `toBoardView` always sets it.
   */
  pendingTriggers?: StackEntry[];
  /**
   * Forge's `CombatView`, one entry per attacking band, and empty outside
   * combat. OPTIONAL like `BoardCard`'s late fields: `toBoardView` always sets
   * it, and a view typed out by hand in another suite need not.
   */
  combat?: CombatBand[];
  gameOver: boolean;
  /** Ids a zone named whose object never arrived. A non-empty list is a bug upstream. */
  missingCardIds: number[];
  /** The latest damage hits (`DamageHit`), oldest first: what `live/numbers.ts` draws as hits. Absent on a view typed out by hand. */
  hits?: readonly DamageHit[];
  /** The latest damage hits on players (`FaceHit`), oldest first. Absent on a view typed out by hand. */
  faceHits?: readonly FaceHit[];
  /** Why the permanents that died lately died (`DeathCause`), by card id. Absent on a view typed out by hand, or from a Forge too old to say. */
  deathCauses?: ReadonlyMap<number, DeathCause>;
}

/** Who a band attacks: a player, or a planeswalker or battle (a card). */
export interface CombatDefender {
  kind: 'card' | 'player';
  id: number;
}

/**
 * One attacking band, read off `DeltaPacket.CombatData` (`forge-wire/src/tier-c.ts`).
 *
 * Forge's other blocker list, `blk`, is not read: `GameView.updateCombat`
 * (`GameView.java:216-235`) sends it only once `AttackingBand.isBlocked()` is
 * set, after declare-blockers has resolved (`Combat.java:677-679`), and then it
 * is the same list `pblk` has carried all along.
 */
export interface CombatBand {
  attackers: number[];
  defender: CombatDefender;
  /**
   * Forge's live assignment, `combat.getBlockers(band)` in every frame, while
   * `InputBlock` runs and after —
   * `AttackersWithPlannedBlockers`/`BandsWithPlannedBlockers`
   * (`TrackableProperty.java:237-238`), flattened band-wise into the wire's
   * `pblk` by the fork's own `DeltaSyncManager.combatViewToCombatData`
   * (`DeltaSyncManager.java:401-461`). OPTIONAL like `BoardCard`'s late
   * fields: `toBoardView` always sets it, and a band typed out by hand in
   * another suite need not.
   */
  plannedBlockers?: number[];
}

export interface AdaptOptions {
  viewerPlayerId: number;
  /** Where a card's Scryfall id is looked up. Defaults to `KNOWN_ART_IDS`. */
  artIds?: ArtIdIndex;
  /** Where a card's PRINTED power/toughness is looked up. Defaults to `POOL_PRINTED_PT`. */
  printedPT?: PrintedPTIndex;
  /**
   * Every seat's watchparty character, keyed by Forge PLAYER id — item 4, wave
   * 29 §A.6-8. Absent (the fixture path's default) draws every seat with the
   * generated bust, exactly as before this wave. A live match supplies it from
   * `LiveMatch.avatarByPlayerId` (`live/match.ts`'s `adoptSeats`), and a
   * player id this map does not hold is the safe, common case — a seat with no
   * avatar — not an error.
   */
  avatarByPlayerId?: ReadonlyMap<number, string>;
  /**
   * Every seat's display name, keyed by Forge PLAYER id — wave 31 §A.1, agreed
   * shape 2 (`SeatIdentity.name`, absent when unknown, on `forge:seats`). A live
   * match fills it the way it fills `avatarByPlayerId`; a player id this map does
   * not hold (or holds a blank for) keeps what Forge calls the player, which is
   * what the board showed before the names went in.
   */
  nameByPlayerId?: ReadonlyMap<number, string>;
  /**
   * Wave 49 §A — `PlayBridge.java`'s own `stackTargetSpells` wire fact
   * (`../fold.ts`'s `FoldResult.stackTargetSpells`), a `fromId → toId` map
   * read onto each `StackEntry.targetStackItemId` below. A live match
   * supplies it from `LiveMatch.stackTargetSpells`; absent (the fixture
   * path's default) leaves every entry's `targetStackItemId` `null`, exactly
   * as before this wave.
   */
  stackTargetSpells?: ReadonlyMap<number, number>;
  /** `PlayBridge.java`'s `pendingTriggers` (`../fold.ts`), read onto `BoardView.pendingTriggers`. */
  pendingTriggers?: PendingTriggers;
  /** `PlayBridge.java`'s `waitingEffects` (`../fold.ts`), read onto each battlefield source's `BoardCard.waiting`. */
  waitingEffects?: WaitingEffects;
  /** `PlayBridge.java`'s `tokenSources` (`../fold.ts`), read onto each battlefield token's `BoardCard.createdBy`. */
  tokenSources?: ReadonlyMap<number, number>;
  /** `PlayBridge.java`'s `cantBlock` (`../fold.ts`), read onto each battlefield creature's `BoardCard.cantBlock`. */
  cantBlock?: ReadonlySet<number>;
  /** `PlayBridge.java`'s `printedTypes` (`../fold.ts`): each changed permanent's printed type, read onto its `BoardCard.changedFrom`. */
  printedTypes?: ReadonlyMap<number, Tagged>;
  /**
   * `PlayBridge.java`'s `lifePaying` (`../fold.ts`): life a player has committed to an open payment
   * that Forge takes only when the whole cost is paid. Taken off that player's `BoardPlayer.life`
   * now, so each press shows, and a cancelled payment gives it back.
   */
  lifePaying?: ReadonlyMap<number, number>;
  /** `PlayBridge.java`'s `conditionMet` (`../fold.ts`), read onto each card's `BoardCard.conditionMet`: the bridge names only hand and battlefield cards. */
  conditionMet?: ReadonlySet<number>;
  /** The latest damage hits (`live/match.ts`'s `hits`), carried onto `BoardView.hits` as they are. */
  hits?: readonly DamageHit[];
  /** The latest damage hits on players (`live/match.ts`'s `faceHits`), carried onto `BoardView.faceHits` as they are. */
  faceHits?: readonly FaceHit[];
  /** Why recent deaths happened (`live/match.ts`'s `deathCauses`), carried onto `BoardView.deathCauses` as they are. */
  deathCauses?: ReadonlyMap<number, DeathCause>;
  /**
   * The card Forge's current prompt names (`showPromptMessage`'s third argument, `LiveMatch.promptCard`):
   * a scry 1 asks Top or Bottom of ONE card it lets the seat look at (`PlayerControllerHuman.willPutCardOnTop`,
   * :1089-1099), so that card is the decision's, never a revealed top on the board.
   */
  promptCard?: number | null;
}

// ── what a card's printed power and toughness are ───────────────────────────

/** Printed P/T by card name, lower-cased. A name it does not hold has no base. */
export type PrintedPTIndex = ReadonlyMap<string, { power: number; toughness: number }>;

/**
 * A printed-P/T index over anything shaped like our card data.
 *
 * Keyed by NAME alone, not name + set: a printing does not change a creature's
 * printed P/T, and Forge names a printing our tables often do not have. Only
 * rows whose power AND toughness are integers are kept — `*` and `1+*` are real
 * values in `pool.json` and they are not numbers, so those cards have no base
 * and `boardPT` draws them plain.
 */
export function printedPTIndex(
  cards: readonly { name?: unknown; power?: unknown; toughness?: unknown }[],
): PrintedPTIndex {
  const index = new Map<string, { power: number; toughness: number }>();
  for (const card of cards) {
    if (typeof card.name !== 'string') continue;
    const power = Number.parseInt(String(card.power), 10);
    const toughness = Number.parseInt(String(card.toughness), 10);
    if (String(card.power) !== String(power) || String(card.toughness) !== String(toughness)) continue;
    const key = card.name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, { power, toughness });
  }
  return index;
}

/**
 * Every printed P/T the browser knows: the drafted cube's own pool.
 *
 * This is the whole of the coverage and the limit is deliberate — the wire
 * carries no printed base at all (see the header), `../draft/art-ids.json`
 * carries ids and nothing else, and inventing a base for a card nobody wrote
 * down would paint an ordinary creature blue.
 */
export const POOL_PRINTED_PT: PrintedPTIndex = printedPTIndex(
  (poolData as { cards: { name: string; power?: string; toughness?: string }[] }).cards,
);

// ── which Scryfall id a card is ──────────────────────────────────────────

/*
 * The index itself lives in `@hadoku/carddata/art`, beside the resolver that
 * consumes its answer. It is re-exported here because this module is where the
 * play board's callers already look for it, and because `./Board.test.ts`
 * imports it from here.
 */
export { artIdIndex, scryfallIdFor, type ArtIdIndex, type ArtIdSource };

/** The cube's cards, keyed by the SCRYFALL set code `build-pool` wrote. */
export const CUBE_ART_IDS: ArtIdIndex = artIdIndex((poolData as { cards: ArtIdSource[] }).cards);

/**
 * Every id the browser knows: the drafted pool first, then the committed table.
 *
 * Order matters and is the whole design. `mergeArtIdIndexes` keeps the FIRST
 * value for a key, so a cube card still resolves to the printing its cube was
 * built from and nothing that worked before this wave resolves differently.
 * `art-ids.json` only ever ADDS keys the pool never had — basic lands under
 * Forge's set codes, the committed constructed lists, and the bare-name
 * fallback that means a card is never blank just because Forge named a
 * printing nobody wrote down.
 */
export const KNOWN_ART_IDS: ArtIdIndex = mergeArtIdIndexes(
  CUBE_ART_IDS,
  artIdIndexFromTable(artIdsData as ArtIdTableFile),
);

// ── reading tagged values ───────────────────────────────────────────────────

function prop(obj: WireObject | undefined, name: string): Tagged | undefined {
  const v = obj?.[name];
  return typeof v === 'object' && v !== null ? v : undefined;
}

function readInt(obj: WireObject | undefined, name: string, fallback = 0): number {
  const v = prop(obj, name);
  return v !== undefined && (v.t === 'int' || v.t === 'long' || v.t === 'byte') && typeof v.v === 'number'
    ? v.v
    : fallback;
}

/**
 * `CombatView`: parallel lists, `def` as `[marker, id]` with 0 = card,
 * 1 = player, `pblk` the live blockers — see {@link CombatBand} for why `blk`
 * is not read.
 */
function readCombat(game: WireObject | undefined): CombatBand[] {
  const raw = prop(game, 'CombatView');
  if (raw === undefined || raw.t !== 'combat') return [];
  const v = raw as Extract<Tagged, { t: 'combat' }>;
  return v.atk.map((attackers, i) => {
    const [marker, id] = v.def[i]!;
    return {
      attackers,
      defender: { kind: marker === 0 ? 'card' : 'player', id },
      plannedBlockers: v.pblk[i] ?? [],
    };
  });
}

function readBool(obj: WireObject | undefined, name: string): boolean {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'bool' && v.v === true;
}

function readStr(obj: WireObject | undefined, name: string): string | null {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'str' && typeof v.v === 'string' ? v.v : null;
}

function readEnum(obj: WireObject | undefined, name: string): string | null {
  const v = prop(obj, name);
  return v !== undefined && v.t === 'enum' && typeof v.v === 'string' ? v.v : null;
}

/**
 * A single entity reference: one int id, or `null`. Forge's `-1` is "nothing"
 * (`resolveFromNetwork` skips it), and so is a value of any other shape.
 */
function readEntityId(obj: WireObject | undefined, name: string): number | null {
  const v = prop(obj, name);
  if (v === undefined || (v.t !== 'int' && v.t !== 'long') || typeof v.v !== 'number') return null;
  return v.v === -1 ? null : v.v;
}

/**
 * `ManaAtom`'s byte → our letter (`ManaAtom.java:7-12`). **32, not 0, is
 * colourless**: `PlayerView.updateMana` walks `ManaAtom.MANATYPES`, and
 * `MagicColor.COLORLESS` — which is 0 — is a different constant that never
 * reaches this map. The committed capture's keys are exactly these six.
 */
const MANA_ATOM: ReadonlyMap<number, PoolColor> = new Map<number, PoolColor>([
  [1, 'W'],
  [2, 'U'],
  [4, 'B'],
  [8, 'R'],
  [16, 'G'],
  [32, 'C'],
]);

/** The order a pool is drawn in: WUBRG, then colourless. */
const POOL_ORDER: readonly PoolColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/**
 * A `ManaMapType` — `{ t: 'map', v: [[byte, int], …] }` — as the pool the board
 * draws. Zero counts are dropped (Forge sends all six colours on every update),
 * an unknown key is ignored rather than guessed at, and the order is ours rather
 * than the `HashMap`'s: the capture's own iteration order is `16, 32, 1, 2, 4, 8`.
 */
function readManaPool(obj: WireObject | undefined, name: string): ManaInPool[] {
  const v = prop(obj, name);
  if (v === undefined || v.t !== 'map' || !Array.isArray(v.v)) return [];
  const counts = new Map<PoolColor, number>();
  for (const entry of v.v as unknown[]) {
    if (!Array.isArray(entry)) continue;
    const [key, value] = entry as (Tagged | null | undefined)[];
    if (key === null || key === undefined || value === null || value === undefined) continue;
    if (key.t !== 'byte' && key.t !== 'int' && key.t !== 'short') continue;
    if (value.t !== 'int' && value.t !== 'long') continue;
    if (typeof key.v !== 'number' || typeof value.v !== 'number') continue;
    const color = MANA_ATOM.get(key.v);
    if (color === undefined || value.v <= 0) continue;
    counts.set(color, (counts.get(color) ?? 0) + value.v);
  }
  return POOL_ORDER.filter((c) => counts.has(c)).map((c) => ({ color: c, count: counts.get(c)! }));
}

/** A `list` of `int` — how every collection of entities crosses the wire. */
function readIds(obj: WireObject | undefined, name: string): number[] {
  const v = prop(obj, name);
  if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
  const ids: number[] = [];
  for (const item of v.v as Tagged[]) {
    // Forge skips -1 when it resolves a collection (`resolveFromNetwork`).
    if (item.t === 'int' && typeof item.v === 'number' && item.v !== -1) ids.push(item.v);
  }
  return ids;
}

/**
 * A stack item and every `SubInstance` under it, in chain order. A charm's or a Command's chosen
 * modes, and any "…, then" clause, are sub-abilities: the item Forge publishes keeps only the
 * root's targets, and each further one is a `StackItemView` one link down
 * (`StackItemView.updateSubInstance`) — the chain Forge's own desktop arrows walk
 * (`TargetingOverlay.java`).
 */
function subInstanceChain(state: WireState, item: WireObject | undefined): WireObject[] {
  const chain: WireObject[] = [];
  for (let at = item; at !== undefined && !chain.includes(at); ) {
    chain.push(at);
    at = prop(at, 'SubInstance') === undefined ? undefined : state.get(deltaKey(WireType.StackItem, readInt(at, 'SubInstance')));
  }
  return chain;
}

// ── card faces ──────────────────────────────────────────────────────────────

/**
 * `ManaCostShard` constant → the cost token our pips draw
 * (`forge-core/.../card/mana/ManaCostShard.java`, the second constructor arg).
 * `COLORED_X` is Forge's "X paid in coloured mana"; its own label is `1`, which
 * would draw as a generic one, so it is drawn as the X it is.
 */
const SHARD_TOKEN: Record<string, string> = {
  WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C',
  WU: 'W/U', WB: 'W/B', UB: 'U/B', UR: 'U/R', BR: 'B/R', BG: 'B/G', RW: 'R/W', RG: 'R/G', GW: 'G/W', GU: 'G/U',
  W2: '2/W', U2: '2/U', B2: '2/B', R2: '2/R', G2: '2/G',
  CW: 'C/W', CU: 'C/U', CB: 'C/B', CR: 'C/R', CG: 'C/G',
  S: 'S', GENERIC: '1', X: 'X', COLORED_X: 'X',
  WP: 'W/P', UP: 'U/P', BP: 'B/P', RP: 'R/P', GP: 'G/P',
  BGP: 'B/G/P', BRP: 'B/R/P', GUP: 'G/U/P', GWP: 'G/W/P', RGP: 'R/G/P',
  RWP: 'R/W/P', UBP: 'U/B/P', URP: 'U/R/P', WBP: 'W/B/P', WUP: 'W/U/P',
};

/**
 * `ManaCost.serialize` → tokens. The format is the generic amount (`-1` for
 * "no cost", e.g. a land), then shard names, joined by U+0006
 * (`ManaCost.java:261`). An unknown shard name is kept verbatim — our pip
 * renders an unknown token rather than dropping it.
 */
export function manaCostTokens(serialized: string): { tokens: string[]; manaValue: number } {
  const [genericText = '-1', ...shards] = serialized.split('\u0006').filter((p) => p !== '');
  const generic = Number.parseInt(genericText, 10);
  const tokens: string[] = [];
  let manaValue = 0;
  if (generic > 0) {
    tokens.push(String(generic));
    manaValue += generic;
  }
  for (const shard of shards) {
    const token = SHARD_TOKEN[shard] ?? shard;
    tokens.push(token);
    manaValue += token === 'X' ? 0 : token.startsWith('2/') ? 2 : 1;
  }
  if (generic === 0 && shards.length === 0) tokens.push('0');
  return { tokens, manaValue };
}

const RARITY: Record<string, Rarity> = {
  BasicLand: 'common',
  Common: 'common',
  Uncommon: 'uncommon',
  Rare: 'rare',
  MythicRare: 'mythic',
  Special: 'special',
  Token: 'special',
};

const WUBRG: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** `ColorSet` crosses as an enum name built from its letters (`BGU`, `R`, `C`). */
function colorsOf(enumName: string | null): ManaColor[] {
  if (enumName === null) return [];
  return WUBRG.filter((c) => enumName.includes(c));
}

/**
 * A face's type line, in the shape Forge's own `CardType.toString` gives it:
 * a card with every creature type (Maskwood Nexus, Changeling) carries
 * `all`, not a list, and reads `(All)` after its subtypes — `(All except …)`
 * when some are excluded. Without it such a card read as printed, and its
 * type pill never showed.
 */
function typeLineOf(t: Tagged | undefined): string {
  if (t === undefined || t.t !== 'cardtype') return '';
  const ct = t as Extract<Tagged, { t: 'cardtype' }>;
  const head = [...ct.sup, ...ct.core].join(' ');
  const all = ct.all ? [ct.exc.length > 0 ? `(All except ${ct.exc.join(' ')})` : '(All)'] : [];
  const tail = [...ct.sub, ...all];
  return tail.length > 0 ? `${head} — ${tail.join(' ')}` : head;
}

function coreTypes(t: Tagged | undefined): string[] {
  return t !== undefined && t.t === 'cardtype' ? (t as Extract<Tagged, { t: 'cardtype' }>).core : [];
}

/** A `keywords` value — each keyword's `original()` text. */
function readKeywords(obj: WireObject | undefined): readonly string[] {
  const v = prop(obj, 'Keywords');
  if (v === undefined || v.t !== 'keywords' || !Array.isArray(v.v)) return [];
  return (v.v as unknown[]).filter((k): k is string => typeof k === 'string');
}

/**
 * A keyword's name: the text before any parameter.
 *
 * A keyword crosses as its own text, with any parameter after a colon
 * (`Affinity:Mountain` in the committed capture), so the token before the colon
 * is the keyword's name. This is a membership test on structured data, not a
 * match against prose.
 */
function keywordName(keyword: string): string {
  return (keyword.split(':')[0] ?? '').trim().toLowerCase();
}

/** Whether a keyword list carries this keyword (by name, lower case). */
export function hasKeyword(keywords: readonly string[] | undefined, name: string): boolean {
  return keywords?.some((k) => keywordName(k) === name) ?? false;
}

/**
 * The evergreen keywords the board draws as a tag, in this order, when the
 * card was not printed with them (`keywordTags`). Haste is not here: what it
 * changes is summoning sickness, which the board already draws.
 */
const TAGGED_KEYWORDS: readonly string[] = [
  'flying',
  'reach',
  'first strike',
  'double strike',
  'deathtouch',
  'lifelink',
  'trample',
  'menace',
  'vigilance',
  'defender',
  'hexproof',
  'indestructible',
];

/**
 * The keyword names a card's PRINTED text gives it, among the tagged ones.
 *
 * `OracleText` is the face's printed rules text: Forge sets it once, from the
 * card script's `Oracle:` line (`CardFactory.java:374`, `face.getOracleText()`),
 * and no continuous effect touches it — an aura's flying is in `Keywords` and
 * never here. A printed keyword sits on a keyword line, which is a list of
 * keywords and not a sentence: `Flying, vigilance` against `Enchanted creature
 * gets +1/+1 and has flying.` So a line counts once its reminder text is gone
 * and it does not end in a full stop, and each of its comma-separated items
 * that IS a tagged keyword's name is printed.
 */
function printedKeywordNames(oracleText: string): Set<string> {
  const printed = new Set<string>();
  for (const raw of oracleText.split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)/g, '').trim();
    if (line === '' || line.endsWith('.')) continue;
    for (const item of line.split(/[,;]/)) {
      const name = item.trim().toLowerCase();
      if (TAGGED_KEYWORDS.includes(name)) printed.add(name);
    }
  }
  return printed;
}

/**
 * The keyword tags a card wears: each evergreen keyword it has NOW and was not
 * printed with — an aura's, an equipment's, an anthem's. The operator: *"those
 * types of written tabs should only go there if they received the effect from
 * something else."*
 *
 * NOW is Forge's CURRENT `Keywords` — the cached keywords of the face after
 * every continuous effect (`CardView.updateKeywords` runs on each change), so
 * a granted keyword is here the moment it attaches and gone when it leaves.
 * Printed is `printedKeywordNames` over the face's `OracleText`; a keyword the
 * card has printed AND granted is still printed, and wears no tag. Each tag is
 * Forge's own word for the keyword. A parameterised hexproof
 * (`Hexproof:Card.Black:black`, hexproof from) is not hexproof and gets no tag.
 */
export function keywordTags(keywords: readonly string[] | undefined, oracleText: string): string[] {
  const printed = printedKeywordNames(oracleText);
  const byName = new Map<string, string>();
  for (const k of keywords ?? []) {
    const name = keywordName(k);
    if (name === 'hexproof' && k.includes(':')) continue;
    if (!byName.has(name)) byName.set(name, (k.split(':')[0] ?? '').trim());
  }
  return TAGGED_KEYWORDS.flatMap((name) => {
    const word = byName.get(name);
    return word === undefined || printed.has(name) ? [] : [word];
  });
}

function countersOf(obj: WireObject | undefined): { name: string; count: number }[] {
  const v = prop(obj, 'Counters');
  if (v === undefined || v.t !== 'multiset' || !Array.isArray(v.v)) return [];
  return (v.v as [string, number][]).map(([name, count]) => ({ name, count }));
}

// ── relations ────────────────────────────────────────────────────────────

/**
 * The relation properties `tier-c.ts` already types (`CardViewCollectionType`
 * except `Haunting`, which is `CardViewType` — a single id, Forge's own `-1`
 * meaning "none"). One row per kind: a card new to this table is one more
 * row, never a new per-card rule in `Relations.tsx`.
 */
const RELATION_PROPS: readonly { key: string; kind: RelationKind; single?: true }[] = [
  { key: 'HauntedBy', kind: 'hauntedBy' },
  { key: 'Haunting', kind: 'haunting', single: true },
  { key: 'EncodedCards', kind: 'encoded' },
  { key: 'ImprintedCards', kind: 'imprinted' },
  { key: 'MustBlockCards', kind: 'mustBlock' },
];

/** The index of the `close` that balances the `open` at `from`, or -1. */
function balancedEnd(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * `description` without its " (Targeting: …)" note. The bracket of objects Forge closes a trigger's
 * description with never reaches the wire: the bridge sends every stack item's description without
 * it (`PlayBridge.stackText`).
 */
function withoutTargetsNote(description: string): string {
  const out = description.trim();
  const targeting = out.indexOf(' (Targeting: ');
  const targetsEnd = targeting < 0 ? -1 : balancedEnd(out, targeting + 1, '(', ')');
  return targetsEnd > 0 ? `${out.slice(0, targeting)}${out.slice(targetsEnd + 1)}`.trim() : out;
}

/**
 * An ability's own words, for its chip on the stack. Forge's `StackItemView` carries two texts:
 *
 *   - `Description` (`TrackableProperty.Description`, `StackItemView.updateText` ←
 *     `SpellAbilityStackInstance.getStackDescription()`): the stack instance's, which for a trigger
 *     carries Forge's note of its targets — `WrappedAbility.getStackDescription` appends
 *     " (Targeting: [[Lightning Bolt (12)]])" (its closing " [Zone Changer: …]" the bridge has
 *     already taken off, `PlayBridge.stackText`);
 *   - `Key` (`TrackableProperty.Key`, `StackItemView.updateKey` ← `SpellAbility.yieldKey()`, the
 *     auto-yield key): "<card> (<id>): <text>", whose text is the trigger's own `TriggerDescription`
 *     (`WrappedAbility.yieldKey`) or the ability's own description, cost included — the card's words.
 *
 * So: `Key` past its card prefix. `Description` with its targets note taken off (and its leading
 * "<card> - ", which the chip's band already names) when there is no `Key`, or when its text was
 * never filled in — a modal trigger's "ABILITY", which also leaves "CARDNAME" in place
 * (`Trigger.toString`).
 */
export function abilityTextOf(key: string | null, description: string, sourceName: string | null): string {
  const own = (key ?? '').replace(/^.*?\(H?\d+\): /, '').trim();
  if (own !== '' && !/\b(?:ABILITY|CARDNAME)\b/.test(own)) return own;
  const named = sourceName !== null && description.startsWith(`${sourceName} - `) ? description.slice(sourceName.length + 3) : description;
  return withoutTargetsNote(named);
}

/** What every text that names a card this seat may not see says: never its id, never a blank. */
export const HIDDEN_CARD_NAME = 'Hidden card';

/**
 * A card's own current name, off its face first and its view second — or
 * `null` when this seat's wire carries none (or a blank one): the server's
 * visibility layer (`apps/server/src/play/visibility.ts`) withholds every
 * name of a card this seat may not see — a face-down exile, an opponent's
 * hand — and an id it was never sent anything for is the same case.
 */
function wireName(view: WireObject | undefined, face: WireObject | undefined): string | null {
  const name = readStr(face, 'Name') ?? readStr(view, 'Name');
  return name === null || name.trim() === '' ? null : name;
}

/**
 * A card's name for a text that refers to it — a relation pill, a stack
 * target — read off the same two wire objects `toBoardCard` reads, but never
 * through `toBoardCard` itself: haunt is symmetric (a creature's `HauntedBy`
 * names the sorcery that haunts it, and that sorcery's own `Haunting` names
 * the creature right back), so building the OTHER card's full `BoardCard` —
 * which computes its own relations in turn — would recurse forever.
 */
/** A player's name as Forge's own `PlayerView` has it, for a reader with no seat names to hand. */
function wirePlayerName(state: WireState, pid: number): string {
  return readStr(state.get(deltaKey(WireType.Player, pid)), 'Name') ?? `player ${pid}`;
}

function nameOfCard(state: WireState, id: number): string {
  const view = state.get(deltaKey(WireType.Card, id));
  return wireName(view, view === undefined ? undefined : shownFace(state, id, view, false)) ?? HIDDEN_CARD_NAME;
}

/**
 * The face a card is read off: its current one — except a face-down card off
 * the battlefield that this seat may look at (Hideaway's exile, to the player
 * who exiled it). Forge's face-down face carries no name; the card itself is
 * its Original face (`CardStateName.Original`, ordinal 0), which the server
 * sends only to a seat Forge lets look (`PlayerMayLook`). On the battlefield
 * the face-down face is what is in play (a morph's 2/2), so it stays.
 */
function shownFace(state: WireState, id: number, view: WireObject, onBattlefield: boolean): WireObject | undefined {
  const current = state.get(cardStateKey(id, readInt(view, 'CurrentState', 0)));
  if (onBattlefield || !readBool(view, 'Facedown') || wireName(view, current) !== null) return current;
  return state.get(cardStateKey(id, 0)) ?? current;
}

/**
 * Every relation this card's `view` carries, generically — `RELATION_PROPS`
 * is the whole rule. Empty for a kind with nothing (never a drawn
 * placeholder), and the whole array is empty for a card with no relation at
 * all, which is every card most of the time.
 */
function readRelations(state: WireState, view: WireObject | undefined): BoardCardRelation[] {
  const out: BoardCardRelation[] = [];
  for (const { key, kind, single } of RELATION_PROPS) {
    const relIds = single === true ? ((): number[] => {
      const one = readEntityId(view, key);
      return one === null ? [] : [one];
    })() : readIds(view, key);
    if (relIds.length === 0) continue;
    out.push({ kind, ids: relIds, names: relIds.map((relId) => nameOfCard(state, relId)) });
  }
  return out;
}

// ── choices ─────────────────────────────────────────────────────────────

/**
 * Every choice property Forge's `CardView` tracks (`TrackableProperty.java`,
 * set by `CardView.updateChosen*`/`updateNamedCard`/`updateSector`…), with how
 * its value crosses the wire (`tier-c.ts`). A choice Forge adds is one more row
 * here, never a per-card rule in the board.
 */
const CHOICE_PROPS: readonly { key: string; kind: ChoiceKind; read: 'str' | 'strs' | 'enum' | 'player' | 'cards' }[] = [
  { key: 'ChosenColors', kind: 'color', read: 'strs' },
  { key: 'ChosenType', kind: 'type', read: 'str' },
  { key: 'ChosenType2', kind: 'type', read: 'str' },
  { key: 'NotedTypes', kind: 'notedType', read: 'strs' },
  { key: 'NamedCard', kind: 'card', read: 'strs' },
  { key: 'ChosenCards', kind: 'chosenCard', read: 'cards' },
  { key: 'ChosenPlayer', kind: 'player', read: 'player' },
  { key: 'ProtectingPlayer', kind: 'protector', read: 'player' },
  { key: 'ChosenNumber', kind: 'number', read: 'str' },
  { key: 'ChosenMode', kind: 'mode', read: 'str' },
  { key: 'ChosenDirection', kind: 'direction', read: 'enum' },
  { key: 'ChosenEvenOdd', kind: 'evenOdd', read: 'enum' },
  { key: 'Sector', kind: 'sector', read: 'str' },
];

/** A `StringListType` value's strings (`{ t: 'list', v: [{ t: 'str', v }] }`). */
function readStrs(obj: WireObject | undefined, name: string): string[] {
  const v = prop(obj, name);
  if (v === undefined || v.t !== 'list' || !Array.isArray(v.v)) return [];
  return (v.v as (Tagged | null)[]).flatMap((item) => (item !== null && item.t === 'str' && typeof item.v === 'string' ? [item.v] : []));
}

/** Forge's colour names are lower-case (`MagicColor.Constant`); the board says them as words. */
const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Every choice this card's `view` carries, generically — `CHOICE_PROPS` is the
 * whole rule. A blank value is Forge's "nothing chosen" (a cleared
 * `ChosenNumber` is `""`), never a drawn empty tag.
 */
function readChoices(state: WireState, view: WireObject | undefined, playerName: (pid: number) => string): BoardCardChoice[] {
  const out: BoardCardChoice[] = [];
  for (const { key, kind, read } of CHOICE_PROPS) {
    const raw = ((): string[] => {
      switch (read) {
        case 'str':
          return [readStr(view, key) ?? ''];
        case 'strs':
          return readStrs(view, key);
        case 'enum':
          return [readEnum(view, key) ?? ''];
        case 'player': {
          const pid = readEntityId(view, key);
          return pid === null ? [] : [playerName(pid)];
        }
        case 'cards':
          return readIds(view, key).map((cid) => nameOfCard(state, cid));
      }
    })();
    const values = raw.map((v) => v.trim()).filter((v) => v !== '');
    if (values.length > 0) out.push({ kind, values: kind === 'color' ? values.map(capitalised) : values });
  }
  return out;
}

/**
 * Forge's live `AbilityText` (`CardStateView.getAbilityText`, the same face
 * `OracleText` reads off), with the gray reminder-text markup
 * `Card.getAbilityText` writes stripped back to plain text. That markup is
 * real on this bridge: `HostedMatch.startGame` sets
 * `GameRules.useGrayText()` from `ForgePreferences.UI_GRAY_INACTIVE_TEXT`,
 * whose own default is `"true"` (`forge-gui/src/main/java/forge/gamemodes/
 * match/HostedMatch.java:83`, `.../localinstance/properties/
 * ForgePreferences.java:111`), so the wire value really can read
 * `<span style="color:gray;">…</span>` — this is the one place that reads it
 * as text, never as markup `CardTile`/`RulesText` would have to parse.
 * `null` for a blank value, same as `oracleText`'s own CRLF normalisation.
 */
function readAbilityText(face: WireObject | undefined): string | null {
  const raw = readStr(face, 'AbilityText');
  if (raw === null) return null;
  const text = raw.replace(/<[^>]*>/g, '').replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
}

function toBoardCard(
  state: WireState,
  id: number,
  artIds: ArtIdIndex,
  printedPT: PrintedPTIndex,
  onBattlefield = false,
  printedType?: Tagged,
  playerName: (pid: number) => string = (pid) => wirePlayerName(state, pid),
): BoardCard | null {
  const view = state.get(deltaKey(WireType.Card, id));
  if (view === undefined) return null;
  const face = shownFace(state, id, view, onBattlefield);

  const known = wireName(view, face);
  const hidden = known === null;
  const name = known ?? HIDDEN_CARD_NAME;
  const cost = prop(face, 'ManaCost');
  const { tokens, manaValue } =
    cost !== undefined && cost.t === 'manacost' && typeof cost.v === 'string'
      ? manaCostTokens(cost.v)
      : { tokens: [], manaValue: 0 };
  const type = prop(face, 'Type');
  const core = coreTypes(type);
  const counters = countersOf(view);
  const loyaltyCounter = counters.find((c) => c.name === 'Loyalty');

  const card: DraftCard = {
    cardId: `w${id}`,
    name,
    manaCost: tokens,
    manaValue,
    colors: colorsOf(readEnum(face, 'Colors')),
    typeLine: typeLineOf(type),
    // Forge writes CRLF; CardTile splits on LF and drops empty lines.
    oracleText: (readStr(face, 'OracleText') ?? '').replace(/\r\n?/g, '\n'),
    setCode: readStr(face, 'SetCode') ?? '',
    collectorNumber: '',
    rarity: RARITY[readEnum(face, 'Rarity') ?? ''] ?? 'special',
  };
  const scryfallId = hidden ? undefined : scryfallIdFor(artIds, name, card.setCode);
  if (scryfallId !== undefined) card.scryfallId = scryfallId;
  if (core.includes('Creature')) {
    card.power = String(readInt(face, 'Power'));
    card.toughness = String(readInt(face, 'Toughness'));
  }
  if (core.includes('Planeswalker')) {
    card.loyalty = loyaltyCounter !== undefined ? String(loyaltyCounter.count) : (readStr(face, 'Loyalty') ?? '0');
  }

  const keywords = readKeywords(face);
  // Forge sets `Sickness` on cards in every zone; it only means something on
  // a creature on the battlefield, so it is only reported there.
  const arrivedThisTurn = onBattlefield && core.includes('Creature') && readBool(view, 'Sickness');
  const printedBase = core.includes('Creature') ? printedPT.get(name.trim().toLowerCase()) : undefined;
  // Forge names a battlefield permanent's printed type only when it differs from the current one.
  const printedLine = printedType !== undefined ? typeLineOf(printedType) : undefined;
  const changedFrom = printedLine !== undefined && printedLine !== card.typeLine ? { name, printed: printedLine } : null;
  const choices = readChoices(state, view, playerName);
  const relations = readRelations(state, view);
  const abilityText = readAbilityText(face);

  return {
    id,
    card,
    hidden,
    tapped: readBool(view, 'Tapped'),
    // #17: a hasty creature CAN act, so it is not summoning sick — whatever
    // Forge's `Sickness` says about when it arrived.
    summoningSick: arrivedThisTurn && !hasKeyword(keywords, 'haste'),
    arrivedThisTurn,
    keywords,
    damage: readInt(view, 'Damage'),
    lethalDamage: readInt(view, 'LethalDamage'),
    attachedCardIds: readIds(view, 'AttachedCards'),
    attachedToId: readEntityId(view, 'EntityAttachedTo'),
    printed: printedBase ?? null,
    counters: counters.filter((c) => c.name !== 'Loyalty' || !core.includes('Planeswalker')),
    attacking: readBool(view, 'Attacking'),
    blocking: readBool(view, 'Blocking'),
    token: readBool(view, 'Token'),
    changedFrom,
    choices,
    relations,
    abilityText,
  };
}

// ── the board ───────────────────────────────────────────────────────────────

/** Our words for Forge's `PhaseType` constants (`PhaseType.java:16-28`). */
export const PHASE_LABEL: Readonly<Record<string, string>> = {
  UNTAP: 'Untap',
  UPKEEP: 'Upkeep',
  DRAW: 'Draw',
  MAIN1: 'Main 1',
  COMBAT_BEGIN: 'Beginning of combat',
  COMBAT_DECLARE_ATTACKERS: 'Declare attackers',
  COMBAT_DECLARE_BLOCKERS: 'Declare blockers',
  COMBAT_FIRST_STRIKE_DAMAGE: 'First-strike damage',
  COMBAT_DAMAGE: 'Combat damage',
  COMBAT_END: 'End of combat',
  MAIN2: 'Main 2',
  END_OF_TURN: 'End step',
  CLEANUP: 'Cleanup',
};

/**
 * Whether `viewer` may look at a card in someone else's hand: it is in the card's `PlayerMayLook`,
 * where Forge puts a seat it shows the card to and the server's projection puts a seat that still
 * knows it. A name alone is not enough — Forge's raw stream names every hand card to everybody.
 */
function shownTo(state: WireState, id: number, viewer: number): boolean {
  return readIds(state.get(deltaKey(WireType.Card, id)), 'PlayerMayLook').includes(viewer);
}

/** `card`, marked {@link BoardCard.seenByOpponent} when its `PlayerMayLook` names anyone but `viewer`. */
function seenByOthers(state: WireState, card: BoardCard, viewer: number): BoardCard {
  const seen = readIds(state.get(deltaKey(WireType.Card, card.id)), 'PlayerMayLook').some((p) => p !== viewer);
  return seen ? { ...card, seenByOpponent: true } : card;
}

/** A card the seat may see, or null — the projection sends a card it may not as existence only. */
function known(card: BoardCard | null): BoardCard | null {
  return card === null || card.hidden === true ? null : card;
}

/**
 * The library's top card as a standing reveal, or null.
 *
 * Forge's `PlayerMayLook` (`Card.updateMayLook`, Card.java:3780-3787) is ONE list
 * merging two grants the wire cannot tell apart: a static's `MayLookAt` — every
 * one of the 79 that reach a library in `res/cardsfolder` (Courser of Kruphix,
 * Future Sight, Vizier of the Menagerie) is `Affected$ Card.TopLibrary`, the top
 * card alone — and the temporary look a prompt grants while it shows the seat
 * cards (`PlayerControllerHuman.tempShowCard`, :182-187, undone by
 * `endTempShowCards`, :198-205). A library search grants that look to the whole
 * library (`chooseSingleEntityForEffect`, :596-599, over `ChangeZoneEffect`'s
 * `toReveal`, :1047-1050), and a scry or a look at the top N to N of them; drawn
 * as a revealed top, it put a library card on the board mid-search (the
 * operator, 2026-10-11: *"a hangerback walker appeared on my board suddenly …
 * i'm just searching my library"*). So the top is a standing reveal only when
 * the seat may see it and NOT the card under it — and is not the one card a
 * prompt is showing (a scry 1's Top or Bottom, `AdaptOptions.promptCard`).
 * "May see" includes a top card the seat was shown and still knows (Goblin
 * Guide's reveal): the server's projection keeps sending it while it stays put.
 */
function revealedTop(
  state: WireState,
  libraryIds: readonly number[],
  artIds: ArtIdIndex,
  printedPT: PrintedPTIndex,
  promptCard: number | null,
): BoardCard | null {
  if (libraryIds[0] === promptCard) return null;
  const seen = (id: number | undefined): BoardCard | null => (id === undefined ? null : known(toBoardCard(state, id, artIds, printedPT)));
  const top = seen(libraryIds[0]);
  return top !== null && seen(libraryIds[1]) === null ? top : null;
}

/** The PlayerView lists a card can be drawn in; a spell whose card one of them holds has left the stack (header). */
const ZONE_LISTS = ['Hand', 'Library', 'Battlefield', 'Graveyard', 'Exile'] as const;

export function toBoardView(
  state: WireState,
  seq: number,
  {
    viewerPlayerId,
    artIds = KNOWN_ART_IDS,
    printedPT = POOL_PRINTED_PT,
    avatarByPlayerId,
    nameByPlayerId,
    stackTargetSpells,
    pendingTriggers,
    waitingEffects,
    tokenSources,
    cantBlock,
    printedTypes,
    lifePaying,
    conditionMet,
    hits,
    faceHits,
    deathCauses,
    promptCard = null,
  }: AdaptOptions,
): BoardView {
  const game = [...state.values()].find((o) => o._type === WireType.Game);
  const missing: number[] = [];
  /** The seat's own name when the room gave one (defensive: only a non-blank string wins), else Forge's. */
  const playerName = (pid: number): string => {
    const seatName = nameByPlayerId?.get(pid);
    return typeof seatName === 'string' && seatName.trim() !== '' ? seatName : wirePlayerName(state, pid);
  };

  const waitingOn = new Map<number, BoardCardWaiting[]>();
  for (const { source, kind, text } of waitingEffects ?? []) waitingOn.set(source, [...(waitingOn.get(source) ?? []), { kind, text }]);
  const cardsIn = (ids: number[], onBattlefield = false): BoardCard[] => {
    const out: BoardCard[] = [];
    for (const id of ids) {
      const c = toBoardCard(state, id, artIds, printedPT, onBattlefield, onBattlefield ? printedTypes?.get(id) : undefined, playerName);
      const waiting = onBattlefield ? waitingOn.get(id) : undefined;
      const createdBy = onBattlefield ? tokenSources?.get(id) : undefined;
      const blockless = onBattlefield && cantBlock?.has(id) === true;
      const met = conditionMet?.has(id) === true;
      if (c === null) missing.push(id);
      else if (waiting === undefined && createdBy === undefined && !blockless && !met) out.push(c);
      else
        out.push({
          ...c,
          ...(waiting === undefined ? {} : { waiting }),
          ...(createdBy === undefined ? {} : { createdBy }),
          ...(blockless ? { cantBlock: true as const } : {}),
          ...(met ? { conditionMet: true as const } : {}),
        });
    }
    return out;
  };

  const activePlayerId = prop(game, 'PlayerTurn') !== undefined ? readInt(game, 'PlayerTurn') : null;
  const playerIds = readIds(game, 'Players');
  const players: BoardPlayer[] = playerIds.map((pid) => {
    const p = state.get(deltaKey(WireType.Player, pid));
    const isViewer = pid === viewerPlayerId;
    const handIds = readIds(p, 'Hand');
    const libraryIds = readIds(p, 'Library');
    const top = revealedTop(state, libraryIds, artIds, printedPT, promptCard);
    const shown = isViewer ? [] : handIds.map((id) => shownTo(state, id, viewerPlayerId) ? known(toBoardCard(state, id, artIds, printedPT, false, undefined, playerName)) : null);
    const avatarId = avatarByPlayerId?.get(pid);
    const emblems = readEmblems(state, p, artIds, printedPT);
    const hand = isViewer ? cardsIn(handIds).map((c) => seenByOthers(state, c, viewerPlayerId)) : null;
    const holdsStorm = hand?.some((c) => hasKeyword(c.keywords, 'storm')) === true;
    return {
      id: pid,
      name: playerName(pid),
      life: readInt(p, 'Life') - (lifePaying?.get(pid) ?? 0),
      isViewer,
      isActive: pid === activePlayerId,
      hasPriority: readBool(p, 'HasPriority'),
      hasLost: readBool(p, 'HasLost'),
      hand,
      ...(shown.some((c) => c !== null) ? { handShown: shown } : {}),
      handCount: handIds.length,
      libraryCount: libraryIds.length,
      libraryIds,
      ...(top === null ? {} : { libraryTop: isViewer ? seenByOthers(state, top, viewerPlayerId) : top }),
      battlefield: cardsIn(readIds(p, 'Battlefield'), true),
      graveyard: cardsIn(readIds(p, 'Graveyard')),
      exile: cardsIn(readIds(p, 'Exile')),
      manaPool: readManaPool(p, 'Mana'),
      counters: countersOf(p),
      ...(emblems.length === 0 ? {} : { emblems }),
      ...(holdsStorm ? { storm: prop(game, 'StormCount') === undefined ? 0 : readInt(game, 'StormCount') } : {}),
      // The key must be ABSENT for a seat with none — never `avatarId:
      // undefined` — so an in-process `'avatarId' in player` reader and a JSON
      // reader agree (`D-avatar-field.md` §3).
      ...(avatarId === undefined ? {} : { avatarId }),
    };
  });
  players.sort((a, b) => Number(b.isViewer) - Number(a.isViewer));

  const nameOfPlayer = (pid: number): string | null =>
    readStr(state.get(deltaKey(WireType.Player, pid)), 'Name');

  // T8: the stack's one line names a target by the same seat-identity-aware
  // name the board draws everywhere else, not Forge's raw `PlayerView.Name`.
  const playerNameById = new Map(players.map((p) => [p.id, p.name]));

  const inAZone = new Set(
    playerIds.flatMap((pid) => {
      const p = state.get(deltaKey(WireType.Player, pid));
      return ZONE_LISTS.flatMap((zone) => readIds(p, zone));
    }),
  );
  const stack: StackEntry[] = readIds(game, 'Stack').flatMap((sid) => {
    const item = state.get(deltaKey(WireType.StackItem, sid));
    const sourceCardId = prop(item, 'SourceCard') !== undefined ? readInt(item, 'SourceCard') : null;
    const isAbility = readBool(item, 'Ability');
    if (!isAbility && sourceCardId !== null && inAZone.has(sourceCardId)) return [];
    const source = sourceCardId !== null ? toBoardCard(state, sourceCardId, artIds, printedPT) : null;
    const activator = prop(item, 'ActivatingPlayer') !== undefined ? readInt(item, 'ActivatingPlayer') : null;
    const chain = subInstanceChain(state, item);
    const targetCardIds = [...new Set(chain.flatMap((o) => readIds(o, 'TargetCards')))];
    const targetPlayerIds = [...new Set(chain.flatMap((o) => readIds(o, 'TargetPlayers')))];
    // T8: resolved NAMES, never ids — a card by the same resolver every other
    // card on the board goes through, a player by the board's own name.
    const targetNames = [
      ...targetCardIds.map((tid) => nameOfCard(state, tid)),
      ...targetPlayerIds.map((pid) => playerNameById.get(pid) ?? `player ${pid}`),
    ];
    const description = readStr(item, 'Description') ?? readStr(item, 'Key') ?? `stack item ${sid}`;
    return [{
      id: sid,
      description,
      sourceCardId,
      sourceName: source?.card.name ?? null,
      sourceCard: source?.card ?? null,
      sourceHidden: source?.hidden === true,
      abilityText: abilityTextOf(readStr(item, 'Key'), description, source?.card.name ?? null),
      controllerName: activator === null ? null : nameOfPlayer(activator),
      isAbility,
      targetCardIds,
      targetPlayerIds,
      targetLabel: targetNames.length > 0 ? targetNames.join(', ') : null,
      targetStackItemId: stackTargetSpells?.get(sid) ?? null,
    }];
  });

  const waiting: StackEntry[] = (pendingTriggers ?? []).map((t) => {
    const source = toBoardCard(state, t.hostCard, artIds, printedPT);
    const sourceName = source?.card.name ?? null;
    return {
      id: -t.id,
      description: t.key,
      sourceCardId: t.hostCard,
      sourceName,
      sourceCard: source?.card ?? null,
      sourceHidden: source?.hidden === true,
      abilityText: abilityTextOf(t.key, t.key, sourceName),
      controllerName: nameOfPlayer(t.controller),
      isAbility: true,
      targetCardIds: [],
      targetPlayerIds: [],
      targetLabel: null,
      targetStackItemId: null,
      pending: true,
      ...(t.current === true ? { current: true as const } : {}),
    };
  });

  const phase = readEnum(game, 'Phase');
  return {
    combat: readCombat(game),
    seq,
    title: readStr(game, 'Title') ?? '',
    turn: readInt(game, 'Turn'),
    phase,
    phaseLabel: phase === null ? 'Not started' : (PHASE_LABEL[phase] ?? phase),
    activePlayerId,
    players,
    stack,
    pendingTriggers: waiting,
    gameOver: readBool(game, 'GameOver'),
    missingCardIds: missing,
    ...(hits === undefined || hits.length === 0 ? {} : { hits }),
    ...(faceHits === undefined || faceHits.length === 0 ? {} : { faceHits }),
    ...(deathCauses === undefined || deathCauses.size === 0 ? {} : { deathCauses }),
  };
}
