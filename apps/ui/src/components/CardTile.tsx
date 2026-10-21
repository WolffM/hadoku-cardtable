import { memo, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
/**
 * One card, drawn as our own layout.
 *
 * ## What this deliberately is not
 *
 * The chrome we draw is not a Magic card frame. No beveled border, no type icon,
 * and the frame itself is still forbidden outright (D20 did not loosen that, nor
 * the WotC logo or the Magic wordmark): the layout could not be mistaken for the
 * printed object — a flat panel, name and cost on one row, type line, rules
 * text, and a stat badge. Colour identity shows as a stripe down the leading
 * edge, which is ours.
 *
 * **Symbols are the fonts' now.** D20 (2026-09-27) chose third-party symbol
 * fonts over drawing our own, so the cost, the inline `{T}` in rules text and the set
 * symbol in the print line all come from Mana and Keyrune through `ManaPip.tsx`.
 * See `docs/LICENSING.md` §3.2; the two packs are not the same position.
 *
 * Rarity is still a letter, not a gem: `C U R M S`. Keyrune can recolour a set
 * symbol by rarity and we do not use that — colour would be the only signal.
 *
 * ## The text tile is the card; the art covers it
 *
 * Card art is a real `<img>` now, laid over the panel above. It does not replace
 * the tile — the tile stays underneath as the fallback, so a card is readable
 * whether or not an image ever arrives. Everything above still describes the
 * chrome, which is what the trademark rule governs; the art is the card itself.
 *
 * ## Oracle text keeps its newlines
 *
 * Abilities are newline-separated in the payload and each one is its own line
 * here. Collapsing them into a paragraph makes a five-ability planeswalker
 * unreadable, which is the card you most need to read before picking.
 *
 * ## A tile makes a sound, and owns none of it
 *
 * Hovering a tile plays the `ui.hover-card` role; picking one plays `pickRole`
 * (`ui.select` unless the caller names another, as the draft pack does with
 * `ui.draft-pick`). Both go through `../sound/index.ts`. This component holds
 * no audio object, no file name and no volume, and it does not consult the
 * player's mute — for the same reason it holds no image URL: what plays is the
 * operator's assignment, changed in one place.
 *
 * ## A card with other faces draws them, out of sight
 *
 * A card that carries `faces` (a transformed card's back, a modal double-faced card's, a split
 * card's halves, an adventure) draws each as a tile of its own in one hidden layer of the app's
 * scope (`facesHost`), grouped under `data-faces-of` and named by the tile's own `data-faces`. The
 * inspector (`../play/inspect/index.ts`) turns an enlarged card to them on the mouse wheel (the
 * operator, 2026-10-17: *"show transformed cards with mousewheel"*; 2026-10-19, on Etali in a
 * deck: *"why can i not scroll to see it?"*). Because the tile draws them, every surface that
 * draws a card — the board, the stack, a prompt, a pack, a pool, a deck — has them, with nothing
 * of its own to remember. A face tile is not a card on screen: no test id, no card id, no sound.
 */

import type { ReactNode } from 'react';
import { DOOR_TIP, faceCropStyle, type DoorState, type TileCard, type TileFace } from './faceCrop.ts';
import { ManaCost, ManaPip, SetSymbol } from './ManaPip.tsx';
import { wubrgKey } from './ColorSymbol.tsx';
import { cardImageUrl } from '../draft/cardImage.ts';
import { playRole, roleHandler } from '../sound/index.ts';
import { documentScope } from '../dom.ts';

const RARITY_LETTER: Record<string, string> = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  mythic: 'M',
  special: 'S',
};

/**
 * Inline `{T}`/`{G}`-style symbols inside rules text, rendered with the same
 * pips as the cost. Without this an activated ability reads `{R}, {T}, Exile…`
 * with literal braces, which is the one place a text-only card actually gets
 * harder to read than a printed one.
 *
 * `{T}` has no special case any more. It used to be spelled out as the word TAP,
 * because the tap symbol was a mark we would not reproduce; D20 ships it from
 * Mana (`ms-tap`) like every other symbol, so it goes through `ManaPip` too. The
 * board's own text still writes TAP as a word (`play/Board.tsx`) — that is a
 * different renderer and a different lane.
 */
function RulesLine({ line, conditionMet = false }: { line: string; conditionMet?: boolean }) {
  const word = conditionMet ? ABILITY_WORD.exec(line) : null;
  const rest = word === null ? line : line.slice(word[0].length);
  const pieces = rest.split(/(\{[^}]{1,5}\})/g).filter((p) => p !== '');
  return (
    <span className="card__rules-line">
      {word !== null && (
        <span className="card__ability-word">
          {word[1]}
        </span>
      )}
      {word !== null && word[0].slice(word[1].length)}
      {pieces.map((piece, i) => {
        const symbol = /^\{([^}]{1,5})\}$/.exec(piece);
        if (!symbol) return <span key={i}>{piece}</span>;
        return <ManaPip key={i} token={symbol[1]} />;
      })}
    </span>
  );
}

/**
 * A rules line that opens with an ability word — "Metalcraft — ", "Spell mastery — ": the
 * printed convention for the clause a condition governs, one to three words then a spaced dash.
 * "Choose one —" opens a mode list, not a condition, and is not one.
 */
const ABILITY_WORD = /^((?!Choose\b)[A-Z][A-Za-z']*(?: [A-Za-z']+){0,2}) — /;

export interface CardTileProps {
  /** A face that shares its card's image (`faceCrop.ts`) draws only its own part of it. */
  card: TileCard;
  /** Present on a pack card, absent in the pool. */
  onPick?: (cardId: string) => void;
  disabled?: boolean;
  /** The role a pick plays: `ui.select` unless the caller names another, or `null` when the caller plays its own. */
  pickRole?: string | null;
  /**
   * The board's live `AbilityText` (`play/adapter.ts`'s
   * `BoardCard.abilityText`), drawn in place of `card.oracleText` when it
   * says something the printed text does not: a Haunt-granted keyword, a
   * live keyword list, whatever Forge's own ability text currently reads.
   * This is the inspector's own text source too — `play/inspect/index.ts`
   * clones this tile's DOM wholesale, so there is no second place that
   * draws rules text for a board card to keep in sync.
   *
   * Absent for every DRAFT use of this component (a pack or pool tile has no
   * "live" to differ from — `card.oracleText` alone is right there), and for
   * a board card whose live text reads the same as its printed one: the
   * printed text is what a player expects to read, and this only overrides
   * it when Forge is actually saying something more.
   */
  liveText?: string | null;
  /**
   * The board's `BoardCard.conditionMet` (`play/adapter.ts`): Forge says this card's own condition
   * is on. The tile glows (`play/card.css`, `.card[data-condition-met]`) and the ability word that
   * names the condition is tinted. The inspector clones this tile, so it shows both too.
   */
  conditionMet?: boolean;
}

/** The hidden layer every tile's other faces are drawn into, made once per scope: the embed's shadow root, or the document's body. */
function facesHost(): HTMLElement {
  const scope = documentScope();
  const found = scope.querySelector<HTMLElement>('[data-card-faces]');
  if (found !== null) return found;
  const host = document.createElement('div');
  host.setAttribute('data-card-faces', '');
  host.hidden = true;
  (scope instanceof Document ? scope.body : scope).append(host);
  return host;
}

let facesSeq = 0;

/** A card's other faces, drawn into {@link facesHost} under the name its tile carries. */
function useFaces(card: TileCard): { key: string | undefined; drawn: ReactNode } {
  const faces = card.faces ?? [];
  const [key] = useState(() => `cf${++facesSeq}`);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const has = faces.length > 0;
  useLayoutEffect(() => {
    if (has) setHost(facesHost());
  }, [has]);
  if (!has) return { key: undefined, drawn: null };
  const drawn =
    host === null
      ? null
      : createPortal(
          <div data-faces-of={key}>
            {faces.map((face) => (
              <FaceTile key={face.name} card={face} />
            ))}
          </div>,
          host,
        );
  return { key, drawn };
}

/** One face of a card, as the tile draws it — for the inspector to enlarge, never a card on screen. */
function FaceTile({ card }: { card: TileFace }) {
  return (
    <article className="card" data-face-crop={card.faceCrop} data-door={card.door}>
      <CardBody card={card} />
    </article>
  );
}

function CardTileImpl({ card, onPick, disabled = false, liveText, pickRole = 'ui.select', conditionMet = false }: CardTileProps) {
  const faces = useFaces(card);
  const body = <CardBody card={card} liveText={liveText} conditionMet={conditionMet} />;

  // `roleHandler` returns the SAME function object every render, which matters
  // here specifically: this component is `memo`-ised because a late-draft
  // screen holds 60 tiles, and an inline `() => playRole(...)` would allocate a
  // fresh closure per render.
  const onHover = roleHandler('ui.hover-card');

  if (!onPick) {
    return (
      // Hover cues a pool tile too. A pool card is not clickable but it IS the
      // thing you are reading, and a cue that only fires on half the cards on
      // screen reads as a bug rather than as a rule.
      <>
        <article className="card" data-card-id={card.cardId} data-testid="card" data-face-crop={card.faceCrop} data-door={card.door} data-faces={faces.key} data-condition-met={conditionMet ? '' : undefined} onMouseEnter={onHover}>
          {body}
        </article>
        {faces.drawn}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="card card--pickable"
        data-card-id={card.cardId}
        data-face-crop={card.faceCrop}
        data-door={card.door}
        data-testid="card"
        data-faces={faces.key}
        disabled={disabled}
        onMouseEnter={onHover}
        onClick={() => {
          // The cue first, then the pick. `onPick` navigates and re-renders the
          // whole screen, and a cue requested after that has to survive the
          // unmount to be heard.
          if (pickRole !== null) playRole(pickRole);
          onPick(card.cardId);
        }}
        aria-label={`Pick ${card.name}`}
      >
        {body}
      </button>
      {faces.drawn}
    </>
  );
}

/** A face's printed content: art over the text tile. */
function CardBody({ card, liveText, conditionMet = false }: { card: TileFace; liveText?: string | null | undefined; conditionMet?: boolean }) {
  const identity = wubrgKey(card.colors).toLowerCase() || 'colorless';
  const shownText = liveText != null && liveText.trim() !== card.oracleText.trim() ? liveText : card.oracleText;
  // Splitting rules text runs a regex per line. It is small per card and
  // ruinous in aggregate: a late-draft screen holds 15 pack tiles plus a pool
  // of up to 45, and without this every one of them re-parsed its rules on
  // every pick. Keyed on the text actually shown, so it is computed once per
  // card for the lifetime of the tile.
  const rulesLines = useMemo(
    () => shownText.split('\n').filter((l) => l !== ''),
    [shownText],
  );
  const stat =
    card.loyalty !== undefined
      ? card.loyalty
      : card.power !== undefined && card.toughness !== undefined
        ? `${card.power}/${card.toughness}`
        : null;

  // The image URL is built HERE, in the browser, from an id the payload carries
  // plus the committed art manifest. It is never stored and never serialised —
  // the payload moves ids, not URLs. It may point at our own CDN, and it never
  // points at the app's origin: we serve the app, not the bytes. Which source a
  // card uses is a manifest entry, not a decision made in this component. See
  // ../draft/cardImage.ts.
  const imageUrl = cardImageUrl(card.scryfallId);

  return (
    <>
      {imageUrl !== null && (
        // The whole unmodified card face, which carries its own copyright and
        // artist credit — so a source with presentation rules is satisfied by
        // construction rather than by remembering to add a caption. The art is
        // a placeholder and may be re-sourced, so that property is kept even
        // where it is not currently required.
        //
        // `loading="lazy"` because a pack is 15 cards and a pool reaches 45;
        // `decoding="async"` so decode never blocks a pick. On error the img
        // removes itself and the text tile underneath is what you see, which is
        // a complete card on its own. Every card in this cube resolves to a URL
        // now — all 534 carry a scryfallId — so the path that matters here is a
        // fetch that fails: a CDN key that was never uploaded 404s, and only
        // this handler turns that into a readable card instead of a broken one.
        <CardArt url={imageUrl} crop={card.faceCrop} />
      )}
      {card.door !== undefined && <DoorMark door={card.door} />}
      <span className="card__stripe" data-identity={identity} aria-hidden="true" />
      <span className="card__head">
        <span className="card__name">{card.name}</span>
        <ManaCost cost={card.manaCost} label={`${card.name} costs ${card.manaCost.join(' ')}`} />
      </span>
      <span className="card__type">{card.typeLine}</span>
      <span className="card__rules">
        {rulesLines.map((line, i) => (
          <RulesLine key={i} line={line} conditionMet={conditionMet} />
        ))}
      </span>
      <span className="card__foot">
        <span className="card__print">
          {/* Keyrune's glyph for the set, with the code itself beside it — a set
              with no glyph still reads as its code. See SetSymbol. */}
          <SetSymbol code={card.setCode} label={`set ${card.setCode}`} />{' '}
          {card.collectorNumber}
          <span className="card__rarity" title={card.rarity}>
            {RARITY_LETTER[card.rarity] ?? '?'}
          </span>
        </span>
        {stat !== null && (
          <span className="card__stat" title={card.loyalty !== undefined ? 'loyalty' : 'power / toughness'}>
            {stat}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * The art over the tile. A face that shares its card's image is its own part of it, upright, in a
 * frame the tile's shape (`faceCrop.ts`); the frame goes with the image when the image fails.
 */
function CardArt({ url, crop }: { url: string; crop: TileCard['faceCrop'] }) {
  const img = (
    <img
      className="card__art"
      src={url}
      // No srcSet: one correctly-chosen size beats a responsive set that
      // resolves to the largest candidate. See cardImage.ts.
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable={false}
      style={crop === undefined ? undefined : faceCropStyle(crop)}
      onError={(e) => {
        const gone = crop === undefined ? e.currentTarget : e.currentTarget.parentElement;
        if (gone !== null) gone.style.display = 'none';
      }}
    />
  );
  if (crop === undefined) return img;
  return (
    <span className="card__crop" aria-hidden="true">
      {img}
    </span>
  );
}

/** A padlock, and a door standing open: drawn on the tile, so the board, the inspector and a prompt all show it. */
const DOOR_ART: Readonly<Record<DoorState, string>> = {
  locked: 'M5 7V5.2a3 3 0 0 1 6 0V7h1.2c.4 0 .8.4.8.8v6.4c0 .4-.4.8-.8.8H3.8c-.4 0-.8-.4-.8-.8V7.8c0-.4.4-.8.8-.8Zm1.5 0h3V5.2a1.5 1.5 0 0 0-3 0Z',
  unlocked: 'M3 1.5h10v13H3Zm1.3 1.3v10.4h7.4V2.8ZM4.3 2.8 8.5 4v8l-4.2 1.2Z',
};

/** A Room door's state, as a mark at the top of its tile; its word is the tooltip and the accessible name. */
function DoorMark({ door }: { door: DoorState }) {
  return (
    <span className="card__door" data-door-mark={door} data-tip={DOOR_TIP[door]} role="img" aria-label={DOOR_TIP[door]}>
      <svg className="card__door-art" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path fillRule="evenodd" d={DOOR_ART[door]} />
      </svg>
    </span>
  );
}

/**
 * Memoised on purpose.
 *
 * A card is immutable for the life of a draft — `cardId` is stable and nothing
 * about a printed card changes — so a tile only ever needs to re-render when it
 * is handed a different card. Without this, one pick re-rendered every tile on
 * screen: 15 in the pack plus the whole pool, which grows to 45. That is the
 * lag, and it got worse the further into a draft you were.
 *
 * `onPick` must be referentially stable for this to bite — see the `useCallback`
 * in DraftScreen. A fresh closure per render would defeat the comparison and
 * quietly restore the old behaviour.
 */
export const CardTile = memo(CardTileImpl);
