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
import type { WireState } from './fold.ts';
import { cardStateKey, deltaKey, WireType, type Tagged, type WireObject } from './wire.ts';

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
   * R15 (wave 35, shape 1; wave 53 T adds `printed`). Set when an effect has
   * changed what this permanent IS — Magus of the Moon's `AddType$ Mountain |
   * RemoveLandTypes$ True` reads a nonbasic land's current type line as
   * `Land — Mountain` (the wire gives us the CURRENT line directly, `Type`,
   * read live — no adapter change needed for that half), and Urborg, Tomb of
   * Yawgmoth's `AddType$ Swamp` (no `RemoveLandTypes`) turns a Plains into
   * `Land — Plains Swamp` — but this is set ONLY when our own card data knows
   * the card's PRINTED type line and it disagrees with the current one
   * (`POOL_PRINTED_TYPE_LINE`, same 534-card cube-only ceiling `printed` above
   * already accepts, for the same reason: Forge's wire has no printed-type
   * field at all, only the live `Type` — confirmed against
   * `TrackableProperty.java` — so "printed" can only ever come from our own
   * static data). `name` is the card's own (unchanged) name — neither effect
   * renames the permanent, only retypes it. `printed` is the printed line
   * itself (`Land — Plains`, say), carried so the board can draw it directly
   * (the pill's hover text) without a second lookup. `null` when nothing is
   * known to have changed, which is also the honest answer for a card our
   * data has never heard of.
   *
   * `ChangedTypes` (`tier-c.ts`, Forge's `Card.getChangedTextTypeWords()`) is
   * NOT this fact — read at the source
   * (`forge-game/.../card/Card.java:5477`): it is a word-substitution map for
   * RULES TEXT ("whenever a Human enters" reading "whenever a Wizard enters"
   * after a type-change-text effect), never populated by either card here,
   * and not a comparison with a printed line at all. This field stays exactly
   * what wave 35 built: wire `Type` vs. our own pool data.
   */
  changedFrom?: { name: string; printed: string } | null;
  /**
   * Wave 36 T7, the operator: *"Cavern of Souls shows its chosen type."*
   * Forge's `ChosenType` (`TrackableProperty.java:65`, `StringType`,
   * `tier-c.ts:353`) is the value an `AddType$ ChosenType`-style ability
   * resolved at resolution time — Cavern of Souls' creature type, and
   * anything else that carries the same property. Read off the CardView
   * (`view`, not the face): it is not part of a printed face, it is a fact
   * Forge is currently tracking about this permanent, the same shelf
   * `AttachedCards` and `Tapped` sit on.
   *
   * `null` for "nothing chosen" — absent on the wire, or a blank string
   * (Forge may send either for a card that has not chosen yet, or one with
   * no such ability at all) — never a drawn empty label.
   */
  chosenType?: string | null;
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
 * imprint, a chosen-cards effect, a must-block list, and whatever the wire
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
export type RelationKind = 'hauntedBy' | 'haunting' | 'encoded' | 'imprinted' | 'chosen' | 'mustBlock';

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
  life: number;
  isViewer: boolean;
  isActive: boolean;
  hasPriority: boolean;
  hasLost: boolean;
  /** `null` for anyone but the viewer: an opponent's hand is a count. */
  hand: BoardCard[] | null;
  handCount: number;
  libraryCount: number;
  /**
   * The library's card ids, top first — ids only, never a face: the projection
   * hides every library card. Read so a reorder can be heard as a shuffle
   * (`live/sound-events.ts`); Forge re-sends the list on every shuffle
   * (`Zone.shuffle` → `onChanged` → `updateZoneForView`). Optional, like the
   * other late fields, for hand-typed players in other suites.
   */
  libraryIds?: readonly number[];
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
   * `updateTargetCards`/`updateTargetPlayers`). Both cross as the same
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
}

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
   * Forge's `CombatView`, one entry per attacking band, and empty outside
   * combat. OPTIONAL like `BoardCard`'s late fields: `toBoardView` always sets
   * it, and a view typed out by hand in another suite need not.
   */
  combat?: CombatBand[];
  gameOver: boolean;
  /** Ids a zone named whose object never arrived. A non-empty list is a bug upstream. */
  missingCardIds: number[];
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
  /** Where a card's PRINTED type line is looked up, for `changedFrom` (R15). Defaults to `POOL_PRINTED_TYPE_LINE`. */
  printedType?: PrintedTypeLineIndex;
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

// ── what a card's printed TYPE LINE is (R15) ─────────────────────────────────

/** Printed type line by card name, lower-cased. A name it does not hold has no printed type to compare against. */
export type PrintedTypeLineIndex = ReadonlyMap<string, string>;

/**
 * A printed-type-line index over anything shaped like our card data. Same
 * shape and the same coverage limit as {@link printedPTIndex}: keyed by name
 * alone, first write wins.
 */
export function printedTypeLineIndex(cards: readonly { name?: unknown; typeLine?: unknown }[]): PrintedTypeLineIndex {
  const index = new Map<string, string>();
  for (const card of cards) {
    if (typeof card.name !== 'string' || typeof card.typeLine !== 'string' || card.typeLine.length === 0) continue;
    const key = card.name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, card.typeLine);
  }
  return index;
}

/**
 * The five basic land type lines, in the exact shape `typeLineOf` builds off
 * the wire (`"Basic Land — Plains"`, not `"Land — Plains"` — Forge's own
 * `plains.txt` is `Types:Basic Land Plains`, confirmed against the cardsfolder
 * script). Unlike every other row in this index, these are not a cube-pool
 * fact that might be wrong for a different printing — a basic land's type
 * line is the same on every printing that has ever existed, so this is not
 * the same kind of guess `POOL_PRINTED_TYPE_LINE`'s other rows are.
 *
 * Why this exists at all: basic lands are never a cube's own drafted cards
 * (`pool.json` carries none of them — confirmed, zero rows for any of the
 * five names), so without this table Urborg, Tomb of Yawgmoth's own
 * textbook case — *"turns a Plains into a Swamp too"* (the operator,
 * Playtest 9) — could never be detected: the most common real-game target of
 * that effect would silently read "nothing changed" forever, not because the
 * effect did not fire but because this index had never heard of a Plains.
 */
const BASIC_LAND_TYPE_LINES: readonly { name: string; typeLine: string }[] = (
  ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const
).map((name) => ({ name, typeLine: `Basic Land — ${name}` }));

/**
 * Every printed type line the browser knows: the five basic lands (always
 * correct, any printing — see {@link BASIC_LAND_TYPE_LINES}), then the
 * drafted cube's own pool — the same 534-card ceiling `POOL_PRINTED_PT`
 * already accepts, for the same reason (the wire carries no printed-type
 * field, and nothing here is wired to the committed `decks/` lists the way
 * art is). The pool is given LAST: `printedTypeLineIndex` keeps the first row
 * for a name, and a cube reprinting a basic by its plain name (it never does
 * today, but nothing stops a future cube from trying) must not shadow the one
 * fact about it that is never cube-specific.
 */
export const POOL_PRINTED_TYPE_LINE: PrintedTypeLineIndex = printedTypeLineIndex([
  ...BASIC_LAND_TYPE_LINES,
  ...(poolData as { cards: { name: string; typeLine?: string }[] }).cards,
]);

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

function typeLineOf(t: Tagged | undefined): string {
  if (t === undefined || t.t !== 'cardtype') return '';
  const ct = t as Extract<Tagged, { t: 'cardtype' }>;
  const head = [...ct.sup, ...ct.core].join(' ');
  return ct.sub.length > 0 ? `${head} — ${ct.sub.join(' ')}` : head;
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
 * Whether a keyword list grants haste.
 *
 * A keyword crosses as its own text, with any parameter after a colon
 * (`Affinity:Mountain` in the committed capture), so the token before the colon
 * is the keyword's name. `Haste` takes no parameter
 * (`Keyword.java:100 HASTE("Haste", SimpleKeyword.class, …)`). This is a
 * membership test on structured data, not a match against prose.
 */
function hasHaste(keywords: readonly string[]): boolean {
  return keywords.some((k) => (k.split(':')[0] ?? '').trim().toLowerCase() === 'haste');
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
  { key: 'ChosenCards', kind: 'chosen' },
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

/** `description` without Forge's stack-instance notes: its " (Targeting: …)" and a closing " […]". */
function withoutStackNotes(description: string): string {
  let out = description.trim();
  const targeting = out.indexOf(' (Targeting: ');
  const targetsEnd = targeting < 0 ? -1 : balancedEnd(out, targeting + 1, '(', ')');
  if (targetsEnd > 0) out = `${out.slice(0, targeting)}${out.slice(targetsEnd + 1)}`.trim();
  for (let at = out.indexOf(' ['); at >= 0; at = out.indexOf(' [', at + 1)) {
    if (balancedEnd(out, at + 1, '[', ']') === out.length - 1) return out.slice(0, at).trim();
  }
  return out;
}

/**
 * An ability's own words, for its chip on the stack. Forge's `StackItemView` carries two texts:
 *
 *   - `Description` (`TrackableProperty.Description`, `StackItemView.updateText` ←
 *     `SpellAbilityStackInstance.getStackDescription()`): the stack instance's, which for a trigger
 *     ends in Forge's own notes — `WrappedAbility.getStackDescription` appends
 *     " (Targeting: [[Lightning Bolt (12)]])" and `Trigger.getImportantStackObjects`'s
 *     " [Zone Changer: Eternal Witness (40)]" or " [Phase: Bella]";
 *   - `Key` (`TrackableProperty.Key`, `StackItemView.updateKey` ← `SpellAbility.yieldKey()`, the
 *     auto-yield key): "<card> (<id>): <text>", whose text is the trigger's own `TriggerDescription`
 *     (`WrappedAbility.yieldKey`) or the ability's own description, cost included — the card's words.
 *
 * So: `Key` past its card prefix. `Description` with its notes taken off (and its leading
 * "<card> - ", which the chip's band already names) when there is no `Key`, or when its text was
 * never filled in — a modal trigger's "ABILITY", which also leaves "CARDNAME" in place
 * (`Trigger.toString`).
 */
export function abilityTextOf(key: string | null, description: string, sourceName: string | null): string {
  const own = (key ?? '').replace(/^.*?\(H?\d+\): /, '').trim();
  if (own !== '' && !/\b(?:ABILITY|CARDNAME)\b/.test(own)) return own;
  const named = sourceName !== null && description.startsWith(`${sourceName} - `) ? description.slice(sourceName.length + 3) : description;
  return withoutStackNotes(named);
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
  printedType: PrintedTypeLineIndex = POOL_PRINTED_TYPE_LINE,
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
  // R15, shape 1: a permanent's current type line disagreeing with the one
  // our own data knows for its (unchanged) name. Scoped to the battlefield —
  // a continuous type-changing effect (Magus of the Moon's `AddType$
  // Mountain`) only applies there, and a card elsewhere just reads printed.
  const printedLine = onBattlefield ? printedType.get(name.trim().toLowerCase()) : undefined;
  const changedFrom = printedLine !== undefined && printedLine !== card.typeLine ? { name, printed: printedLine } : null;
  // T7: a blank string is the same "nothing chosen" absence is, never a drawn label.
  const chosenTypeRaw = readStr(view, 'ChosenType');
  const chosenType = chosenTypeRaw !== null && chosenTypeRaw.trim() !== '' ? chosenTypeRaw.trim() : null;
  const relations = readRelations(state, view);
  const abilityText = readAbilityText(face);

  return {
    id,
    card,
    hidden,
    tapped: readBool(view, 'Tapped'),
    // #17: a hasty creature CAN act, so it is not summoning sick — whatever
    // Forge's `Sickness` says about when it arrived.
    summoningSick: arrivedThisTurn && !hasHaste(keywords),
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
    chosenType,
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

export function toBoardView(
  state: WireState,
  seq: number,
  {
    viewerPlayerId,
    artIds = KNOWN_ART_IDS,
    printedPT = POOL_PRINTED_PT,
    printedType = POOL_PRINTED_TYPE_LINE,
    avatarByPlayerId,
    nameByPlayerId,
    stackTargetSpells,
  }: AdaptOptions,
): BoardView {
  const game = [...state.values()].find((o) => o._type === WireType.Game);
  const missing: number[] = [];

  const cardsIn = (ids: number[], onBattlefield = false): BoardCard[] => {
    const out: BoardCard[] = [];
    for (const id of ids) {
      const c = toBoardCard(state, id, artIds, printedPT, onBattlefield, printedType);
      if (c === null) missing.push(id);
      else out.push(c);
    }
    return out;
  };

  const activePlayerId = prop(game, 'PlayerTurn') !== undefined ? readInt(game, 'PlayerTurn') : null;
  const playerIds = readIds(game, 'Players');
  const players: BoardPlayer[] = playerIds.map((pid) => {
    const p = state.get(deltaKey(WireType.Player, pid));
    const isViewer = pid === viewerPlayerId;
    const handIds = readIds(p, 'Hand');
    const avatarId = avatarByPlayerId?.get(pid);
    const seatName = nameByPlayerId?.get(pid);
    return {
      id: pid,
      // Defensive: the seat's name is wire data. Only a non-blank string wins.
      name:
        typeof seatName === 'string' && seatName.trim() !== ''
          ? seatName
          : (readStr(p, 'Name') ?? `player ${pid}`),
      life: readInt(p, 'Life'),
      isViewer,
      isActive: pid === activePlayerId,
      hasPriority: readBool(p, 'HasPriority'),
      hasLost: readBool(p, 'HasLost'),
      hand: isViewer ? cardsIn(handIds) : null,
      handCount: handIds.length,
      libraryCount: readIds(p, 'Library').length,
      libraryIds: readIds(p, 'Library'),
      battlefield: cardsIn(readIds(p, 'Battlefield'), true),
      graveyard: cardsIn(readIds(p, 'Graveyard')),
      exile: cardsIn(readIds(p, 'Exile')),
      manaPool: readManaPool(p, 'Mana'),
      counters: countersOf(p),
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

  const stack: StackEntry[] = readIds(game, 'Stack').map((sid) => {
    const item = state.get(deltaKey(WireType.StackItem, sid));
    const sourceCardId = prop(item, 'SourceCard') !== undefined ? readInt(item, 'SourceCard') : null;
    const source = sourceCardId !== null ? toBoardCard(state, sourceCardId, artIds, printedPT, false, printedType) : null;
    const activator = prop(item, 'ActivatingPlayer') !== undefined ? readInt(item, 'ActivatingPlayer') : null;
    const targetCardIds = readIds(item, 'TargetCards');
    const targetPlayerIds = readIds(item, 'TargetPlayers');
    // T8: resolved NAMES, never ids — a card by the same resolver every other
    // card on the board goes through, a player by the board's own name.
    const targetNames = [
      ...targetCardIds.map((tid) => nameOfCard(state, tid)),
      ...targetPlayerIds.map((pid) => playerNameById.get(pid) ?? `player ${pid}`),
    ];
    const description = readStr(item, 'Description') ?? readStr(item, 'Key') ?? `stack item ${sid}`;
    return {
      id: sid,
      description,
      sourceCardId,
      sourceName: source?.card.name ?? null,
      sourceCard: source?.card ?? null,
      sourceHidden: source?.hidden === true,
      abilityText: abilityTextOf(readStr(item, 'Key'), description, source?.card.name ?? null),
      controllerName: activator === null ? null : nameOfPlayer(activator),
      isAbility: readBool(item, 'Ability'),
      targetCardIds,
      targetPlayerIds,
      targetLabel: targetNames.length > 0 ? targetNames.join(', ') : null,
      targetStackItemId: stackTargetSpells?.get(sid) ?? null,
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
    gameOver: readBool(game, 'GameOver'),
    missingCardIds: missing,
  };
}
