/*
 * Build a deck out of a finished pool — the one deck editor, for a drafted
 * build (`limited`) and for the sideboard step between games (`sideboard`).
 *
 * ## The layout (the operator's pick, 2026-10-17: "A · Arena-style")
 *
 * The pool is a grid across the top, filterable by colour, type and mana
 * value and sortable. The deck is piles by mana value along the bottom, lands
 * last, with a bar of counts and colours over it and a strip at its right for
 * the curve and the basics. The whole editor fits its box; the pool and the
 * piles scroll inside it, the page never does.
 *
 * A card moves by a click, or by dragging it onto the other area. The move is
 * always `moveToMain`/`moveToSideboard` (or `setBasicLand` for a basic), which
 * only ever shuffle the SAME pool between two piles — so "you may only play
 * what you drafted" and "you may only sideboard what was in your 75" both hold
 * by construction, with no rule of this component's own.
 *
 * ## An unfinished deck is not an error
 *
 * The deck's size is a meter, `n/floor`. At the floor the meter becomes the
 * way onward: Play for a build, Ready for a sideboard step. A build's Play
 * stays disabled until the server calls it legal (`POST /api/tables/check`,
 * asked once the deck reaches its floor and again as it changes, debounced);
 * the verdict itself is never text on screen. The room's gate still refuses
 * an illegal deck at ready and start, and that refusal is the caller's to
 * show. Saving is silent: the root carries `data-save` for anything that needs
 * to know, and only a real failure — a save that failed, a check that could
 * not be asked — shows, as one quiet `deck-fault` line.
 *
 * ## Basics
 *
 * `allowBasics` (a drafted pool, in either mode) gives the per-colour
 * counters and Auto (`build.ts`'s `suggestBasics`, Forge's own suggestion).
 * A constructed 75 has no counters: its basics are ordinary cards of the 75.
 * Either way the lands pile draws one card per land with a ×N badge, so
 * seventeen basics never make a seventeen-card pile.
 *
 * ## The shared inspector
 *
 * Every tile is the board's `CardTile`, and this mounts
 * `play/inspect/index.ts`'s inspector over its own root, with its own
 * `[data-board-zoom]` layer, as `DeckPeek.tsx` does. The inspector finds a
 * tile by `data-card-id` matching `w<digits>` (the board's convention), so the
 * faces handed to `CardTile` carry a synthetic `w<n>` id from ONE counter
 * across both areas — two tiles sharing an id would let a hover open the
 * wrong card. It is display-only; a move always keys on the entry's own
 * `CardRequest`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { CardRequest, DeckEntry } from '@hadoku/carddata/dck';
import {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  isBasicLand,
  mainDeckSize,
  moveToMain,
  moveToSideboard,
  setBasicLand,
  sideboardSize,
  type Deck,
} from '@hadoku/deck';

import { CardTile } from '../components/CardTile.tsx';
import { mainDeckColors } from '../components/DeckView.tsx';
import { ManaPip } from '../components/ManaPip.tsx';
import { ColorSymbol } from '../components/ColorSymbol.tsx';
import { mountInspector } from '../play/inspect/index.ts';
import { cardRequestOf, deckFromPool, dckTextOf, draftBuild, savedBuild } from '../draft/deckFromPool.ts';
import type { DraftCard, ManaColor } from '../draft/types.ts';
import { DropArea, startCardDrag, useCardSplit, type Area } from './dragMove.tsx';
import { cardHeightOf, columnsOf, cssPx, gridAt, largestCard, outerHeight, pilesAt, useBox } from '../components/cardFit.ts';
import { MV_CAP, groupCards, isCreatureFace, isLandFace, sortCards, type SortKey } from './cardOrder.ts';
import { cardIndex, draftedSeat, mainSummary, namedCardPool, suggestBasics } from './build.ts';
import type { TablesClient, Verdict } from '../screens/tables.ts';
import './deckEditor.css';

export type DeckEditorMode = 'limited' | 'sideboard';

export type SaveOutcome = { ok: true } | { ok: false; issues: string[] };

export type ReadyState = 'idle' | 'busy' | 'ready';

export interface DeckEditorProps {
  mode: DeckEditorMode;
  draftId: string;
  /** Every card the deck may play: the drafted pool (`limited`), or the fixed 75 (`sideboard`). */
  pool: readonly DraftCard[];
  /** The caller's last saved build. Undefined or null opens fresh from `pool`. */
  savedDeck?: string | null;
  /** `limited`'s server check, which enables Play. Absent: Play is never enabled. */
  client?: TablesClient;
  checkDelayMs?: number;
  /** Silent autosave, debounced. Absent saves nothing. */
  onSave?: (dck: string) => Promise<SaveOutcome>;
  saveDelayMs?: number;
  /** `limited`'s way onward, offered at the floor: Play with the build as it stands, not the debounced save, which may still be pending. */
  onPlay?: (dck: string) => void;
  /** `sideboard`'s way onward: submit THIS split. Offered once the deck reaches its floor. */
  onReady?: (deck: Deck) => void;
  readyState?: ReadyState;
  /** The basics counters and Auto. Defaults to `mode === 'limited'`; a sideboard step on a drafted pool sets it. */
  allowBasics?: boolean;
  /** The main deck's floor: 40 for a drafted pool, the format's for a constructed 75. */
  minMain?: number;
}

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
/** The largest a card is drawn here. */
const MAX_CARD_W = 150;
const BASIC_OF: Record<ManaColor, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const PIP_OF: Record<string, ManaColor> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

/** A basic land's face: the library art, a land's type line, and no colour of its own. */
const BASIC_FACES: ReadonlyMap<string, DraftCard> = new Map(
  namedCardPool(BASIC_LAND_NAMES).map((f) => [f.name, { ...f, typeLine: `Basic Land — ${f.name}`, colors: [], manaValue: 0 }]),
);

/** A card with no copy of its name in `pool` — a stale save. Enough to draw, never to pick from. */
function fallbackFace(card: CardRequest): DraftCard {
  return (
    BASIC_FACES.get(card.name) ?? {
      cardId: 'fallback',
      name: card.name,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: '',
      oracleText: '',
      setCode: card.set ?? '',
      collectorNumber: card.collectorNumber ?? '',
      rarity: 'common',
    }
  );
}

function facesByKey(pool: readonly DraftCard[]): Map<string, DraftCard[]> {
  const index = new Map<string, DraftCard[]>();
  for (const card of pool) {
    const key = cardKey(cardRequestOf(card));
    const bucket = index.get(key);
    if (bucket) bucket.push(card);
    else index.set(key, [card]);
  }
  return index;
}

/** One copy of one entry, as drawn. */
interface Tile {
  /** `cardKey` of the entry — what a move and a drag carry. */
  key: string;
  copy: number;
  face: DraftCard;
  request: CardRequest;
  /** From `deck.basics` (a counter), not from the pool. */
  basic: boolean;
}

const faceOf = (t: Tile): DraftCard => t.face;

type TypeFilter = 'creature' | 'spell' | 'land';
interface PoolFilter {
  colors: ReadonlySet<ManaColor | 'C'>;
  type: TypeFilter | null;
  mv: number | null;
}

function matchesFilter(card: DraftCard, f: PoolFilter): boolean {
  if (f.colors.size > 0) {
    if (card.colors.length === 0 ? !f.colors.has('C') : !card.colors.some((c) => f.colors.has(c))) return false;
  }
  if (f.type === 'creature' && !isCreatureFace(card)) return false;
  if (f.type === 'spell' && (isCreatureFace(card) || isLandFace(card))) return false;
  if (f.type === 'land' && !isLandFace(card)) return false;
  if (f.mv !== null && Math.min(MV_CAP, card.manaValue) !== f.mv) return false;
  return true;
}

/** A limited build is the drafter's one build (`draftBuild`); a sideboard step opens on the 75 it was given. */
function openDeck(savedDeck: string | null | undefined, mode: DeckEditorMode, draftId: string, pool: readonly DraftCard[], allowBasics: boolean): Deck {
  const saved = savedBuild(savedDeck, allowBasics);
  if (mode === 'limited') return draftBuild(draftId, pool, saved);
  return saved ?? deckFromPool(draftId, pool);
}

export function DeckEditor({
  mode,
  draftId,
  pool,
  savedDeck,
  client,
  checkDelayMs = 300,
  onSave,
  saveDelayMs = 600,
  onPlay,
  onReady,
  readyState = 'idle',
  allowBasics = mode === 'limited',
  minMain = LIMITED_MIN_MAIN_DECK_SIZE,
}: DeckEditorProps) {
  const [deck, setDeck] = useState<Deck>(() => openDeck(savedDeck, mode, draftId, pool, allowBasics));
  /** The card that last moved, and where to — its tiles there flash once. */
  const [landed, setLanded] = useState<{ key: string; to: Area; n: number } | null>(null);

  const faces = useMemo(() => facesByKey(pool), [pool]);
  // A deck line naming a printing the pool does not (a library 75's faces are
  // by name alone) still draws that card's face, by its name.
  const facesByName = useMemo(() => {
    const byName = new Map<string, DraftCard>();
    for (const card of pool) if (!byName.has(card.name)) byName.set(card.name, card);
    return byName;
  }, [pool]);
  const poolIndex = useMemo(() => cardIndex(pool), [pool]);

  // ONE counter across both areas — see the header.
  const { mainTiles, sideTiles } = useMemo(() => {
    let n = 0;
    const build = (entries: readonly DeckEntry[], basic: boolean): Tile[] => {
      const out: Tile[] = [];
      for (const entry of entries) {
        const key = cardKey(entry.card);
        const known = faces.get(key) ?? [];
        for (let i = 0; i < entry.count; i += 1) {
          const base = known.length > 0 ? known[i % known.length]! : (facesByName.get(entry.card.name) ?? fallbackFace(entry.card));
          out.push({ key, copy: i, face: { ...base, cardId: `w${n++}` }, request: entry.card, basic });
        }
      }
      return out;
    };
    const main = build(deck.main, false);
    const basics = build(deck.basics, true);
    return { mainTiles: [...main, ...basics], sideTiles: build(deck.sideboard, false) };
  }, [deck, faces, facesByName]);

  /* ── moves ── */
  const toMain = (tile: Tile): void => {
    setDeck((d) => moveToMain(d, tile.request));
    setLanded((l) => ({ key: tile.key, to: 'deck', n: (l?.n ?? 0) + 1 }));
  };
  const toSide = (tile: Tile): void => {
    if (tile.basic) {
      const left = (deck.basics.find((e) => cardKey(e.card) === tile.key)?.count ?? 1) - 1;
      setDeck((d) => setBasicLand(d, tile.request, Math.max(0, left)));
      return;
    }
    setDeck((d) => moveToSideboard(d, tile.request));
    setLanded((l) => ({ key: tile.key, to: 'pool', n: (l?.n ?? 0) + 1 }));
  };
  const dropOnto = (to: Area, key: string): void => {
    const tile = (to === 'deck' ? sideTiles : mainTiles).find((t) => t.key === key);
    if (tile === undefined) return;
    if (to === 'deck') toMain(tile);
    else toSide(tile);
  };
  const split = useCardSplit((key, to) => dropOnto(to, key));
  const setBasic = (c: ManaColor, count: number): void => setDeck((d) => setBasicLand(d, basicLand(BASIC_OF[c]), Math.max(0, count)));
  const autoBasics = (): void =>
    setDeck((d) => {
      const want = suggestBasics(d, poolIndex, minMain);
      let next = d;
      for (const c of COLORS) next = setBasicLand(next, basicLand(BASIC_OF[c]), want[c]);
      return next;
    });

  /* ── the pool's filter and sort ── */
  const [filter, setFilter] = useState<PoolFilter>({ colors: new Set(), type: null, mv: null });
  const [sort, setSort] = useState<SortKey>('mv');
  const toggleColor = (c: ManaColor | 'C'): void =>
    setFilter((f) => {
      const colors = new Set(f.colors);
      if (colors.has(c)) colors.delete(c);
      else colors.add(c);
      return { ...f, colors };
    });
  const shownPool = useMemo(() => sortCards(sideTiles.filter((t) => matchesFilter(t.face, filter)), sort, faceOf), [sideTiles, filter, sort]);

  /* ── the deck's piles ── */
  const { piles, lands } = useMemo(() => {
    // A basic drawn from a counter may have no face of its own to say it is a land.
    const groups = groupCards(mainTiles, 'mv', (t) => (t.basic || isBasicLand(t.request) ? { ...t.face, typeLine: 'Basic Land' } : t.face), true);
    return { piles: groups.filter(([id]) => id !== 'L').map(([, tiles]) => tiles), lands: groups.find(([id]) => id === 'L')![1] };
  }, [mainTiles]);

  /* ── the inspector, over this editor's own root (`DeckPeek.tsx`'s pattern) ── */
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    return el === null ? undefined : mountInspector(el);
  }, []);

  /*
   * ── the sizes: the pool's grid and the deck's piles share the editor's height ──
   *
   * One card width for both areas, the largest at which the pool (at least a
   * row, so it is somewhere to drop) and the piles (beside the strip, never
   * shorter than it) fit together (`components/cardFit.ts`). The pool takes
   * the height its cards need and the deck the rest, so nothing scrolls, and
   * the split follows where the cards are, not a fixed share. Counted on the
   * whole pool, not the filtered one, so a filter never resizes the page.
   */
  const landGroups = useMemo(() => groupLands(lands), [lands]);
  const [measureGrid, gridBox] = useBox();
  const [measurePilesBox, pilesBox] = useBox();
  const pilesEl = useRef<HTMLElement | null>(null);
  const measurePiles = useCallback(
    (el: HTMLElement | null) => {
      pilesEl.current = el;
      measurePilesBox(el);
    },
    [measurePilesBox],
  );
  const strip = useRef<HTMLElement | null>(null);
  const fit = useMemo(() => {
    if (gridBox.width <= 0 || pilesBox.width <= 0) return null;
    const total = gridBox.height + pilesBox.height;
    // Beside the piles (not under them, as on a phone), the strip's own height is the deck's floor.
    const beside = strip.current?.parentElement != null && getComputedStyle(strip.current.parentElement).flexDirection === 'row';
    // Its content, not its box: the box is stretched to the piles' height.
    const last = strip.current?.lastElementChild;
    const stripH = beside && last != null ? last.getBoundingClientRect().bottom - strip.current!.getBoundingClientRect().top : 0;
    const counts = [...piles.map((p) => p.length), landGroups.length];
    // The gaps, a pile's head and the room under its last card, as the stylesheet draws them (at the UI scale).
    const gridEl = pilesEl.current?.closest('.deck-editor')?.querySelector('[data-testid="side-grid"]');
    const gridGap = cssPx(gridEl, 'column-gap', 6);
    const pileGap = cssPx(pilesEl.current, 'column-gap', 8);
    const head = outerHeight(pilesEl.current?.querySelector('.deck-editor__pilehead'), 22) + cssPx(pilesEl.current?.querySelector('.deck-editor__stack'), 'padding-bottom', 4);
    const gridH = (w: number): number => Math.ceil(Math.max(gridAt(sideTiles.length, w, gridBox.width, gridGap).height, cardHeightOf(w)));
    const deckH = (w: number): number => Math.max(pilesAt(counts, w, pilesBox.width, pileGap).height + head, stripH);
    const cardW = largestCard((w) => gridH(w) + deckH(w) <= total, MAX_CARD_W);
    return { cardW, gridH: gridH(cardW), cols: pilesAt(counts, cardW, pilesBox.width, pileGap).cols };
  }, [gridBox, pilesBox, piles, landGroups, sideTiles.length]);

  const count = mainDeckSize(deck);
  const complete = count >= minMain;

  /* ── limited: the server's verdict, asked once the deck is at its floor and has stopped moving ── */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    setVerdict(null);
    setCheckError(null);
    if (mode !== 'limited' || client === undefined || !complete) return;
    let live = true;
    const timer = setTimeout(() => {
      client.check(draftedSeat(draftId, deck)).then(
        (v) => {
          if (live) setVerdict(v);
        },
        (err: unknown) => {
          if (live) setCheckError(err instanceof Error ? err.message : String(err));
        },
      );
    }, checkDelayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, client, deck, draftId, checkDelayMs, complete]);

  /* ── silent autosave: only a build that differs from the last one saved ── */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const lastSaved = useRef<string>(dckTextOf(deck));
  useEffect(() => {
    if (onSave === undefined) return;
    const text = dckTextOf(deck);
    if (text === lastSaved.current) {
      setSaveState((s) => (s === 'saving' ? 'saved' : s));
      return;
    }
    let live = true;
    setSaveState('saving');
    const timer = setTimeout(() => {
      onSave(text).then((outcome) => {
        if (!live) return;
        if (outcome.ok) {
          lastSaved.current = text;
          setSaveState('saved');
          setSaveIssues([]);
        } else {
          setSaveState('error');
          setSaveIssues(outcome.issues);
        }
      });
    }, saveDelayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deck, onSave, saveDelayMs]);

  const summary = mainSummary(deck, poolIndex);
  const colors = mainDeckColors(deck, poolIndex);
  const curve = Array.from({ length: MV_CAP + 1 }, (_, mv) => piles[mv]!.length);
  const basics: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const e of deck.basics) {
    const c = PIP_OF[e.card.name];
    if (c !== undefined) basics[c] += e.count;
  }
  // A save that failed, or a check that could not be asked. Never a verdict.
  const fault = saveState === 'error' ? saveIssues.join(', ') : checkError;
  const flash = (t: Tile, area: Area): boolean => landed !== null && landed.to === area && landed.key === t.key;

  return (
    <div
      className="deck-editor"
      data-testid="deck-editor"
      data-mode={mode}
      data-save={saveState}
      ref={host}
      data-fit={fit === null ? undefined : ''}
      style={fit === null ? undefined : ({ '--cw': `${fit.cardW}px` } as CSSProperties)}
      {...split.handlers}
    >
      <DropArea area="pool" over={split.over} className="deck-editor__pool" testid="pool-area">
        <div className="deck-editor__bar">
          <span className="deck-editor__n" data-testid="side-count" title="pool">
            {sideboardSize(deck)}
          </span>
          <div className="deck-editor__chips" role="group" aria-label="colour">
            {[...COLORS, 'C' as const].map((c) => (
              <button key={c} type="button" className="deck-editor__chip" data-testid={`filter-${c}`} aria-pressed={filter.colors.has(c)} onClick={() => toggleColor(c)}>
                <ManaPip token={c} />
              </button>
            ))}
          </div>
          <div className="deck-editor__chips" role="group" aria-label="type">
            {(
              [
                ['creature', 'ms-creature', 'creatures'],
                ['spell', 'ms-instant', 'other spells'],
                ['land', 'ms-land', 'lands'],
              ] as const
            ).map(([t, icon, label]) => (
              <button
                key={t}
                type="button"
                className="deck-editor__chip"
                data-testid={`type-${t}`}
                aria-pressed={filter.type === t}
                title={label}
                aria-label={label}
                onClick={() => setFilter((f) => ({ ...f, type: f.type === t ? null : t }))}
              >
                <i className={`ms ${icon}`} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="deck-editor__chips" role="group" aria-label="mana value">
            {curve.map((_, mv) => (
              <button
                key={mv}
                type="button"
                className="deck-editor__chip deck-editor__chip--num"
                data-testid={`mv-${mv}`}
                aria-pressed={filter.mv === mv}
                onClick={() => setFilter((f) => ({ ...f, mv: f.mv === mv ? null : mv }))}
              >
                {mv === MV_CAP ? `${mv}+` : mv}
              </button>
            ))}
          </div>
          <span className="deck-editor__spacer" />
          <div className="deck-editor__chips deck-editor__chips--seg" role="group" aria-label="sort">
            {(
              [
                ['mv', <span key="mv" className="deck-editor__sortglyph">0–{MV_CAP}</span>, 'by mana value'],
                ['color', <ColorSymbol key="c" symbol="M" />, 'by colour'],
                ['type', <i key="t" className="ms ms-creature" aria-hidden="true" />, 'by type'],
              ] as Array<[SortKey, ReactNode, string]>
            ).map(([k, glyph, label]) => (
              <button key={k} type="button" className="deck-editor__chip" data-testid={`sort-${k}`} aria-pressed={sort === k} title={label} aria-label={label} onClick={() => setSort(k)}>
                {glyph}
              </button>
            ))}
          </div>
        </div>
        <div className="deck-editor__grid" data-testid="side-grid" ref={measureGrid} style={fit === null ? undefined : { flexBasis: `${fit.gridH}px` }}>
          {shownPool.map((t) => (
            <EditorCard key={`${t.key}#${t.copy}`} tile={t} from="pool" onMove={toMain} flash={flash(t, 'pool') ? landed!.n : 0} />
          ))}
        </div>
      </DropArea>

      <DropArea area="deck" over={split.over} className="deck-editor__deck" testid="deck-area">
        <div className="deck-editor__bar">
          <span className="deck-editor__types">
            <span title="creatures" data-testid="count-creatures">
              <i className="ms ms-creature" aria-hidden="true" /> {summary.creatures}
            </span>
            <span title="other spells" data-testid="count-spells">
              <i className="ms ms-instant" aria-hidden="true" /> {summary.spells}
            </span>
            <span title="lands" data-testid="count-lands">
              <i className="ms ms-land" aria-hidden="true" /> {summary.lands}
            </span>
          </span>
          <ColourBar colors={colors} pips={summary.pips} />
          <span className="deck-editor__spacer" />
          {fault !== null && (
            <p className="deck-editor__fault" data-testid="deck-fault">
              {fault}
            </p>
          )}
          <Onward
            count={count}
            min={minMain}
            mode={mode}
            readyState={readyState}
            verdict={verdict === null ? 'pending' : verdict.legal ? 'legal' : 'illegal'}
            onAct={
              mode === 'limited'
                ? onPlay && (() => onPlay(dckTextOf(deck)))
                : () => onReady?.(deck)
            }
          />
        </div>
        <div className="deck-editor__body">
          <div className="deck-editor__piles" data-testid="main-grid" ref={measurePiles}>
            {piles.map((pile, mv) => (
              <div key={mv} className="deck-editor__pile" data-testid="curve-bucket" data-mv={mv} data-empty={pile.length === 0 ? '' : undefined}>
                <PileHead label={mv === MV_CAP ? `${mv}+` : String(mv)} n={pile.length} />
                <div className="deck-editor__cols">
                  {columnsOf(pile, fit?.cols[mv] ?? 1).map((column, i) => (
                    <div key={i} className="deck-editor__stack">
                      {column.map((t) => (
                        <EditorCard key={`${t.key}#${t.copy}`} tile={t} from="deck" onMove={toSide} flash={flash(t, 'deck') ? landed!.n : 0} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="deck-editor__pile" data-testid="land-pile" data-empty={lands.length === 0 ? '' : undefined}>
              <PileHead label={<i className="ms ms-land" aria-label="lands" />} n={lands.length} />
              <div className="deck-editor__cols">
                {columnsOf(landGroups, fit?.cols[piles.length] ?? 1).map((column, i) => (
                  <div key={i} className="deck-editor__stack">
                    {column.map(({ tile, n }) => (
                      <div key={`${tile.key}#${tile.basic ? 'b' : 'm'}`} className="deck-editor__landcard">
                        <EditorCard tile={tile} from="deck" onMove={toSide} flash={flash(tile, 'deck') ? landed!.n : 0} />
                        {n > 1 && (
                          <span className="deck-editor__badge" data-testid="land-count">
                            ×{n}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <aside className="deck-editor__strip" ref={strip}>
            <Curve curve={curve} />
            {allowBasics && (
              <div className="deck-editor__basics" data-testid="basics">
                {COLORS.map((c) => {
                  const name = BASIC_OF[c];
                  return (
                    <div key={c} className="deck-editor__basic" data-testid={`basic-${name}`}>
                      <button type="button" className="deck-editor__step" aria-label={`one fewer ${name}`} data-testid={`basic-${name}-less`} disabled={basics[c] === 0} onClick={() => setBasic(c, basics[c] - 1)}>
                        −
                      </button>
                      <span className="deck-editor__basic-n" data-zero={basics[c] === 0 ? '' : undefined}>
                        <ManaPip token={c} />
                        <span data-testid={`basic-${name}-count`}>{basics[c]}</span>
                      </span>
                      <button type="button" className="deck-editor__step" aria-label={`one more ${name}`} data-testid={`basic-${name}-more`} onClick={() => setBasic(c, basics[c] + 1)}>
                        +
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="deck-editor__auto" data-testid="basics-auto" title="suggest basic lands" onClick={autoBasics}>
                  <i className="ms ms-land" aria-hidden="true" /> Auto
                </button>
              </div>
            )}
          </aside>
        </div>
      </DropArea>

      <div className="deck-editor__zoom" data-board-zoom="" />
    </div>
  );
}

/** One tile per land in the lands pile, with how many copies it stands for. */
function groupLands(lands: readonly Tile[]): Array<{ tile: Tile; n: number }> {
  const groups = new Map<string, { tile: Tile; n: number }>();
  for (const t of lands) {
    const id = `${t.key}#${t.basic ? 'b' : 'm'}`;
    const g = groups.get(id);
    if (g === undefined) groups.set(id, { tile: t, n: 1 });
    else g.n += 1;
  }
  return [...groups.values()];
}

/** A tile in either area: click moves it, and it drags to the other area. */
function EditorCard({ tile, from, onMove, flash }: { tile: Tile; from: Area; onMove: (t: Tile) => void; flash: number }) {
  return (
    <div
      className="deck-editor__card"
      // Re-keyed by the move counter so the landing flash replays on every move of the same card.
      data-flash={flash > 0 ? flash % 2 : undefined}
      draggable
      data-name={tile.face.name}
      onDragStart={(e) => {
        startCardDrag(e, from, tile.key);
        e.currentTarget.setAttribute('data-lifted', '');
      }}
      onDragEnd={(e) => e.currentTarget.removeAttribute('data-lifted')}
    >
      <CardTile card={tile.face} onPick={() => onMove(tile)} />
    </div>
  );
}

function PileHead({ label, n }: { label: ReactNode; n: number }) {
  return (
    <div className="deck-editor__pilehead">
      <span className="deck-editor__pilemv">{label}</span>
      <span className="deck-editor__pilen">{n}</span>
    </div>
  );
}

/** The deck's colours: a bar in proportion to its coloured symbols, and each colour's pip with its count. */
function ColourBar({ colors, pips }: { colors: readonly string[]; pips: Record<ManaColor, number> }) {
  const total = COLORS.reduce((n, c) => n + pips[c], 0);
  return (
    <span className="deck-editor__colours" data-testid="deck-colors" data-colors={colors.join('')}>
      <span className="deck-editor__colourbar" aria-hidden="true">
        {total > 0 &&
          COLORS.filter((c) => pips[c] > 0).map((c) => <span key={c} className="deck-editor__colourseg" data-c={c} style={{ flexGrow: pips[c] }} />)}
      </span>
      <span className="deck-editor__colourpips">
        {colors.map((c) => (
          <span key={c} className="deck-editor__colourpip" data-color={c}>
            <ManaPip token={c} />
            {pips[c as ManaColor] > 0 && <span>{pips[c as ManaColor]}</span>}
          </span>
        ))}
      </span>
    </span>
  );
}

function Curve({ curve }: { curve: readonly number[] }) {
  const max = Math.max(4, ...curve);
  return (
    <div className="deck-editor__curve" data-testid="curve" aria-label={`curve ${curve.join(' ')}`}>
      {curve.map((n, mv) => (
        <span key={mv} className="deck-editor__curvecol" title={`${n} at ${mv === MV_CAP ? `${mv}+` : mv}`}>
          <span className="deck-editor__curven">{n > 0 ? n : ''}</span>
          <span className="deck-editor__curvebar" style={{ height: `${(n / max) * 100}%` }} />
          <span className="deck-editor__curvemv">{mv === MV_CAP ? `${mv}+` : mv}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * `n/min` while the deck is short; the way onward once it is not. The count is
 * `main-count` in both shapes, so a reader never has to know which is showing.
 */
function Onward({
  count,
  min,
  mode,
  readyState,
  verdict,
  onAct,
}: {
  count: number;
  min: number;
  mode: DeckEditorMode;
  readyState: ReadyState;
  /** `limited`: what the server has said of the build. Play is enabled by `legal` alone. */
  verdict: 'pending' | 'legal' | 'illegal';
  /** Absent: nothing to go on to — the Decks page's editor, outside any game. The count stays. */
  onAct?: () => void;
}) {
  if (count < min || onAct === undefined) {
    const complete = count >= min;
    return (
      <span className="deck-editor__meter" role="meter" aria-valuenow={count} aria-valuemin={0} aria-valuemax={min} data-testid="deck-meter">
        <span className="deck-editor__meter-fill" style={{ width: `${Math.min(1, count / min) * 100}%` }} />
        <span className="deck-editor__meter-text" data-complete={complete ? 'true' : 'false'}>
          <strong data-testid="main-count">{count}</strong>
          {!complete && `/${min}`}
        </span>
      </span>
    );
  }
  const limited = mode === 'limited';
  return (
    <button
      type="button"
      className="deck-editor__go"
      data-testid={limited ? 'play-deck' : 'sideboard-ready'}
      data-complete="true"
      data-verdict={limited ? verdict : undefined}
      aria-pressed={limited ? undefined : readyState === 'ready'}
      disabled={limited ? verdict !== 'legal' : readyState !== 'idle'}
      onClick={onAct}
    >
      <span className="deck-editor__go-n" data-testid="main-count">
        {count}
      </span>
      <span>{limited ? 'Play' : readyState === 'ready' ? 'Ready ✓' : 'Ready'}</span>
    </button>
  );
}
