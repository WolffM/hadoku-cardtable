/*
 * Build a deck out of a finished pool. Two shapes on one component.
 *
 * ## `limited` — what this screen's old limited-only builder used to be, wired
 * to C's store instead of a library opponent
 *
 * `deckFromPool` opens the builder the way Forge's limited editor does — the
 * whole pool in the sideboard, nothing played — and `moveToMain` /
 * `moveToSideboard` only ever move a card between the two piles, so a card you
 * did not draft has no way in. Basic lands are `setBasicLand`: they come from
 * the table, and they are part of the maindeck count `mainDeckSize` reports
 * against `LIMITED_MIN_MAIN_DECK_SIZE` (40, Forge's `DeckFormat.Limited` floor).
 * This component holds a `Deck` and calls those functions; it has no rules of
 * its own.
 *
 * The old builder's Start button played Forge's AI with a library deck in the
 * other seat. That is gone: `onPlay` is the only way out now, and it is wired
 * by `DeckScreen` to the room list's create flow, preset to this pod
 * (`rooms/api.ts`'s `presetCreate`) — a friend room on the pod is where this
 * deck is actually played (wave 13 §C said so for the drafted case specifically:
 * two decks against a person is the gate's own 400).
 *
 * The server still says whether the build is legal, over the same
 * `POST /api/tables/check` the old builder used, debounced as you move cards —
 * **and it is still not what gates `onPlay`**, for the same reason as before: a
 * button a client-side opinion can grey out is a control that can disagree with
 * the server, and the room's own gate is what actually refuses a short deck at
 * a start.
 *
 * What is new this wave: every move also schedules a debounced
 * `PUT /api/drafts/:podId/deck` (`onSave`, C's contract) — `DeckScreen` supplies
 * it over `deck/deckStore.ts`. The built deck opens from `savedDeck` when there
 * is one, so a reload (or the room screen's own picker, over the same `.dck`
 * text) finds the same build you left.
 *
 * ## `sideboard` — wave 72's shape, built and unit-tested here, mounted there
 *
 * A bo3 sideboard step swaps between an already-legal 75 (main plus side) and
 * nothing else: there is no 40-card floor to reach and no fresh pool to open
 * from, so `onPlay` and the server check are both absent. The structural
 * invariant that makes "you may only play what you drafted" true for `limited`
 * — `moveToMain`/`moveToSideboard` only ever shuffle the SAME pool between two
 * piles — is exactly what also makes "you may only sideboard what was in your
 * 75" true here, with no extra code: the legality panel is
 * `deckProblems(deck, pool)`, run against the fixed 75 rather than against a
 * server, and it names a card the SAME way the draft arm does when a saved
 * `.dck` was hand-edited to add one.
 *
 * `allowBasics` is separate from the mode: a sideboard step on a drafted pool
 * still has basics to move around (the pool itself does not carry them), a
 * sideboard step on a constructed 75 does not.
 *
 * ## One grid, `CardTile` faces, the shared inspector
 *
 * Both piles are drawn with the board's own `CardTile` — no text rows, no
 * second card renderer — and this mounts `play/inspect/index.ts`'s inspector
 * over its own root exactly as `DeckPeek.tsx` does, with its own
 * `[data-board-zoom]` layer. The inspector matches a tile by its OWN
 * `data-card-id` against `w<digits>` (`play/inspect/index.ts`'s `TILE_ID`) —
 * the convention the BOARD uses for a live Forge card id, never this screen's.
 * A drafted card's real id (`c0`, `c1`, …) does not match it, and nothing here
 * may edit `play/inspect/*` to teach it a second vocabulary (this wave's
 * ground rule), so the faces handed to `CardTile` below carry a synthetic
 * `w<n>` id of this grid's own numbering — display-only, never the id a pick or
 * a save keys on; `moveToMain`/`moveToSideboard` always take the entry's own
 * `CardRequest`, not this id.
 *
 * The maindeck is grouped by mana value with a curve count, the way
 * `components/PoolView.tsx` already groups a seat's pool; the sideboard/pool is
 * a flat grid filterable by colour. Clicking a tile moves it to the other pile,
 * one copy at a time — the gesture the old builder's text rows used, carried
 * over to a tile's click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { parseDck, type CardRequest, type DeckEntry } from '@hadoku/carddata/dck';
import {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  deckFromDeckFile,
  deckProblems,
  mainDeckSize,
  moveToMain,
  moveToSideboard,
  setBasicLand,
  sideboardSize,
  type Deck,
} from '@hadoku/deck';

import { CardTile } from '../components/CardTile.tsx';
import { DeckColors, mainDeckColors } from '../components/DeckView.tsx';
import { ManaPip } from '../components/ManaPip.tsx';
import { mountInspector } from '../play/inspect/index.ts';
import { cardRequestOf, deckFromPool, dckTextOf, poolEntries } from '../draft/deckFromPool.ts';
import type { DraftCard, ManaColor } from '../draft/types.ts';
import { draftedSeat, mainSummary, cardIndex, splitBasics } from './build.ts';
import type { TablesClient, Verdict } from '../screens/tables.ts';
import './deckEditor.css';

export type DeckEditorMode = 'limited' | 'sideboard';

export type SaveOutcome = { ok: true } | { ok: false; issues: string[] };

export interface DeckEditorProps {
  mode: DeckEditorMode;
  draftId: string;
  /** Every card the deck may play: the drafted pool (`limited`), or the fixed 75 (`sideboard`). */
  pool: readonly DraftCard[];
  /** The caller's last saved build. Undefined or null opens fresh from `pool`. */
  savedDeck?: string | null;
  /** `limited`'s live legality check against `pool`. Unused in `sideboard`. */
  client?: TablesClient;
  checkDelayMs?: number;
  /** Debounced save through C's contract. Absent saves nothing (every `sideboard` use this wave). */
  onSave?: (dck: string) => Promise<SaveOutcome>;
  saveDelayMs?: number;
  /** "Play": the room create flow, preset to this pod. `limited` only. */
  onPlay?: () => void;
  /** The basics widget. Defaults to `mode === 'limited'`; a sideboard step on a drafted pool sets it true. */
  allowBasics?: boolean;
}

/** Which pip a basic land shows. Never WotC's mana symbol. */
const BASIC_PIP: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

const COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** A card whose printing has no copy in `pool` — a stale save, or a basic. Enough to draw, never to pick from. */
function fallbackFace(card: CardRequest): DraftCard {
  return {
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
  };
}

/** Every pool card, by the printing a deck entry names — one bucket per printing, in pick order. */
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

/** One entry, expanded to one tile per copy. */
interface Tile {
  key: string;
  face: DraftCard;
  request: CardRequest;
}

function byManaValue(tiles: readonly Tile[]): Array<[number, Tile[]]> {
  const buckets = new Map<number, Tile[]>();
  for (const tile of tiles) {
    const mv = tile.face.manaValue;
    const bucket = buckets.get(mv);
    if (bucket) bucket.push(tile);
    else buckets.set(mv, [tile]);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
}

function matchesFilter(tile: Tile, active: ReadonlySet<ManaColor | 'C'>): boolean {
  if (active.size === 0) return true;
  if (tile.face.colors.length === 0) return active.has('C');
  return tile.face.colors.some((c) => active.has(c));
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
  allowBasics = mode === 'limited',
}: DeckEditorProps) {
  const [deck, setDeck] = useState<Deck>(() => {
    if (typeof savedDeck === 'string') {
      try {
        return splitBasics(deckFromDeckFile(parseDck(savedDeck)));
      } catch {
        // A corrupt save opens a fresh build rather than crashing the editor.
      }
    }
    return deckFromPool(draftId, pool);
  });

  const index = useMemo(() => facesByKey(pool), [pool]);
  const poolRef = useMemo(() => poolEntries(pool), [pool]);
  const poolIndex = useMemo(() => cardIndex(pool), [pool]);

  // ONE counter for both piles — not one per pile — because both are on
  // screen together and `play/inspect/index.ts` finds a tile by
  // `document.querySelector('[data-card-id="w<n>"]')` (`inspectedCardFrom`):
  // the first element in DOM order with that id wins. Two tiles sharing an id
  // — main's first card and side's first card both minted as `w0` — would
  // have hovering the SIDE tile open the MAIN tile's enlargement instead,
  // silently, since the query has no way to tell the caller it matched the
  // wrong one. `n` is declared once, outside `build`, and `build(deck.main)`
  // runs to completion (consuming its whole range of `n`) before
  // `build(deck.sideboard)` starts — JS evaluates object-literal properties
  // left to right — so the two piles' ids never overlap.
  const { main: mainTiles, side: sideTiles } = useMemo(() => {
    let n = 0;
    const build = (entries: readonly DeckEntry[]): Tile[] => {
      const out: Tile[] = [];
      for (const entry of entries) {
        const key = cardKey(entry.card);
        const faces = index.get(key) ?? [];
        for (let i = 0; i < entry.count; i += 1) {
          const base = faces.length > 0 ? faces[i % faces.length]! : fallbackFace(entry.card);
          out.push({ key: `${key}#${i}`, face: { ...base, cardId: `w${n++}` }, request: entry.card });
        }
      }
      return out;
    };
    return { main: build(deck.main), side: build(deck.sideboard) };
  }, [deck.main, deck.sideboard, index]);

  const [activeColors, setActiveColors] = useState<ReadonlySet<ManaColor | 'C'>>(new Set());
  const toggleColor = (c: ManaColor | 'C'): void => {
    const next = new Set(activeColors);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setActiveColors(next);
  };

  /* ── the inspector, mounted over this editor's own root (`DeckPeek.tsx`'s pattern) ── */
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    return el === null ? undefined : mountInspector(el);
  }, []);

  /* ── limited: the server's verdict, asked once the deck stops moving ── */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'limited' || client === undefined) return;
    let live = true;
    setVerdict(null);
    setCheckError(null);
    const timer = setTimeout(() => {
      client
        .check(draftedSeat(draftId, deck))
        .then((v) => {
          if (live) setVerdict(v);
        })
        .catch((err: unknown) => {
          if (live) setCheckError(err instanceof Error ? err.message : String(err));
        });
    }, checkDelayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, client, deck, draftId, checkDelayMs]);

  /* ── sideboard: the same question, answered locally against the fixed pool ── */
  const sideboardProblems = useMemo(() => (mode === 'sideboard' ? deckProblems(deck, poolRef) : []), [mode, deck, poolRef]);

  /* ── the debounced save, through C's contract ── */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const skipNextSave = useRef(true);
  useEffect(() => {
    if (onSave === undefined) return;
    if (skipNextSave.current) {
      // Not on mount: that would PUT back exactly what was just loaded (the
      // saved build, or a fresh one nobody has touched yet).
      skipNextSave.current = false;
      return;
    }
    let live = true;
    setSaveState('saving');
    const timer = setTimeout(() => {
      onSave(dckTextOf(deck)).then((outcome) => {
        if (!live) return;
        if (outcome.ok) {
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

  const change = (next: Deck): void => setDeck(next);

  const main = mainDeckSize(deck);
  const summary = mainSummary(deck, poolIndex);
  const colors = mainDeckColors(deck, poolIndex);
  const basics = deck.basics.reduce((n, e) => n + e.count, 0);

  return (
    <div className="deck-editor" data-testid="deck-editor" data-mode={mode} ref={host}>
      <section className="deck-editor__bar lobby__card">
        <div className="deck-editor__counts">
          {mode === 'limited' ? (
            <>
              <span
                className={main >= LIMITED_MIN_MAIN_DECK_SIZE ? 'deck-editor__n' : 'deck-editor__n deck-editor__n--short'}
                data-testid="main-count"
              >
                {main}
              </span>
              <span className="deck-editor__of">
                in the maindeck, {LIMITED_MIN_MAIN_DECK_SIZE} minimum — {main - basics} drafted, {basics} basic
              </span>
              <span className="deck-editor__n deck-editor__n--quiet" data-testid="side-count">
                {sideboardSize(deck)}
              </span>
              <span className="deck-editor__of">left in the sideboard</span>
            </>
          ) : (
            <>
              <span className="deck-editor__n" data-testid="main-count">
                {deck.main.reduce((n, e) => n + e.count, 0)}
              </span>
              <span className="deck-editor__of">in the main</span>
              <span className="deck-editor__n deck-editor__n--quiet" data-testid="side-count">
                {deck.sideboard.reduce((n, e) => n + e.count, 0)}
              </span>
              <span className="deck-editor__of">in the side, {pool.length} total</span>
            </>
          )}
          <DeckColors colors={colors} label={`maindeck colours: ${colors.join(' ') || 'colourless'}`} />
        </div>
        {mode === 'limited' && (
          <p className="lobby__note" data-testid="main-summary">
            {summary.creatures} creatures · {summary.spells} other spells · {summary.lands} lands. Coloured pips:{' '}
            {(['W', 'U', 'B', 'R', 'G'] as const)
              .filter((c) => summary.pips[c] > 0)
              .map((c) => `${summary.pips[c]} ${c}`)
              .join(', ') || 'none'}
            .
          </p>
        )}

        {allowBasics && (
          <div className="deck-editor__basics" data-testid="basics">
            <h2 className="deck-editor__h2">Basic lands</h2>
            {BASIC_LAND_NAMES.map((name) => {
              const request = basicLand(name);
              const key = cardKey(request);
              const count = deck.basics.find((e) => cardKey(e.card) === key)?.count ?? 0;
              return (
                <span key={name} className="deck-editor__basic" data-testid={`basic-${name}`}>
                  <ManaPip token={BASIC_PIP[name] ?? 'C'} />
                  <span className="deck-editor__basic-name">{name}</span>
                  <button
                    type="button"
                    aria-label={`one fewer ${name}`}
                    data-testid={`basic-${name}-less`}
                    disabled={count === 0}
                    onClick={() => change(setBasicLand(deck, request, Math.max(0, count - 1)))}
                  >
                    −
                  </button>
                  <span className="deck-editor__basic-n" data-testid={`basic-${name}-count`}>
                    {count}
                  </span>
                  <button
                    type="button"
                    aria-label={`one more ${name}`}
                    data-testid={`basic-${name}-more`}
                    onClick={() => change(setBasicLand(deck, request, count + 1))}
                  >
                    +
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {mode === 'limited' ? (
          <ServerVerdict verdict={verdict} error={checkError} />
        ) : (
          <SideboardVerdict problems={sideboardProblems} />
        )}
        {onSave !== undefined && <SaveStatus state={saveState} issues={saveIssues} />}
      </section>

      <div className="deck-editor__piles">
        <section className="deck-editor__pile">
          <h2 className="deck-editor__h2">
            {mode === 'limited' ? 'Maindeck' : 'Main'} <span className="deck-editor__pile-n">{mainTiles.length}</span>
          </h2>
          <div className="deck-editor__curve" data-testid="main-grid">
            {byManaValue(mainTiles).map(([mv, bucket]) => (
              <div key={mv} className="deck-editor__bucket" data-testid="curve-bucket" data-mv={mv}>
                <h3 className="deck-editor__bucket-title">
                  {mv} <span className="deck-editor__bucket-n">({bucket.length})</span>
                </h3>
                <div className="deck-editor__bucket-cards">
                  {bucket.map((tile) => (
                    <CardTile key={tile.key} card={tile.face} onPick={() => change(moveToSideboard(deck, tile.request))} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="deck-editor__pile">
          <h2 className="deck-editor__h2">
            {mode === 'limited' ? 'Sideboard — your drafted pool' : 'Side'}{' '}
            <span className="deck-editor__pile-n">{sideTiles.length}</span>
          </h2>
          <div className="deck-editor__filters" role="group" aria-label="Filter by colour">
            {[...COLORS, 'C' as const].map((c) => (
              <button
                key={c}
                type="button"
                className="deck-editor__filter"
                data-testid={`filter-${c}`}
                aria-pressed={activeColors.has(c)}
                onClick={() => toggleColor(c)}
              >
                {c === 'C' ? 'C' : <ManaPip token={c} />}
              </button>
            ))}
          </div>
          <div className="deck-editor__grid" data-testid="side-grid">
            {sideTiles
              .filter((tile) => matchesFilter(tile, activeColors))
              .map((tile) => (
                <CardTile key={tile.key} card={tile.face} onPick={() => change(moveToMain(deck, tile.request))} />
              ))}
          </div>
        </section>
      </div>

      {mode === 'limited' && (
        <section className="lobby__card" data-testid="play-panel">
          <button type="button" className="lobby__go" data-testid="play-deck" onClick={() => onPlay?.()}>
            Play
          </button>
        </section>
      )}

      <div className="deck-editor__zoom" data-board-zoom="" />
    </div>
  );
}

function SaveStatus({ state, issues }: { state: 'idle' | 'saving' | 'saved' | 'error'; issues: string[] }) {
  if (state === 'idle') return null;
  if (state === 'saving') {
    return (
      <p className="lobby__note" data-testid="save-status">
        Saving…
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p className="lobby__error" role="alert" data-testid="save-status">
        Could not save: {issues.join(', ')}
      </p>
    );
  }
  return (
    <p className="lobby__note" data-testid="save-status">
      Saved.
    </p>
  );
}

function SideboardVerdict({ problems }: { problems: string[] }) {
  if (problems.length === 0) {
    return (
      <p className="lobby__note" data-testid="sideboard-problems-ok">
        Every card is in your 75.
      </p>
    );
  }
  return (
    <ul className="deck-editor__problems" data-testid="sideboard-problems">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

function ServerVerdict({ verdict, error }: { verdict: Verdict | null; error: string | null }) {
  if (error !== null) {
    return (
      <p className="lobby__error" role="alert" data-testid="deck-verdict-error">
        Could not check the deck: {error}
      </p>
    );
  }
  if (verdict === null) {
    return (
      <p className="lobby__note" data-testid="deck-verdict-pending">
        Checking with the server…
      </p>
    );
  }
  return (
    <div className={verdict.legal ? 'tables__legal' : 'tables__illegal'} data-testid="deck-verdict">
      <p>
        {verdict.legal
          ? `The server says: legal against ${verdict.rulesName}.`
          : `The server says: not legal against ${verdict.rulesName} — ${verdict.issues.length} ${verdict.issues.length === 1 ? 'problem' : 'problems'}:`}
      </p>
      {verdict.issues.length > 0 && (
        <ul className="tables__issues">
          {verdict.issues.map((issue, i) => (
            <li key={i}>
              {issue.cardName !== null && <strong className="tables__card">{issue.cardName}</strong>}
              {issue.cardName !== null && ' — '}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
