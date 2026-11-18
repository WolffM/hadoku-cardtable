/*
 * The series: the result screen (shape 4 + shape 5), the sideboard step between its games, and the
 * way into the next one.
 *
 * Moved out of `LiveBoard.tsx` whole (wave 122 §F, the hold table: this is the ONE file `LiveBoard.tsx`
 * held by wave 121 lane B still needs, imported back) — no behaviour changed in the move itself.
 * `gameOutcome`, `GameOutcome`, `lostPlayers`, the sound-timing helpers (`afterTheHits`, `fromTheBoard`,
 * `EXIT_ROLES`, `END_ROLES`) and `useGameEnded`/`useAfterTheBoard`/`END_UNSHOWN_MS` stayed behind: every
 * one of those is also read by `LiveBoard`'s own top-level body (the board's sound pipeline, `resultShown`),
 * not only by what moved here. `lostPlayers` is exported from `LiveBoard.tsx` for exactly this file to
 * import back.
 *
 * ## The next game opens only on a press
 *
 * `GameResultScreen` never calls `openNewMatch` on its own: once the room's table names a newer
 * match (`next`), this screen stops showing the sideboard editor and shows {@link SeriesEnterNext}
 * instead — the same summary `TableCard` draws ("Return to game"), except it STAYS, with a press
 * ("Enter game") that is the only caller of `openNewMatch`. `magic-room-ui.tsx`'s and
 * `TablePage.tsx`'s own auto-navigate effects (`followMatchOnce`) are narrowed the same way, so
 * neither screen jumps in by itself once a table has been seen `sideboarding`.
 *
 * ## The lobby's sideboard step is this same screen
 *
 * `screens/TableSideboard.tsx` (the room's own entry, reached via `TablePage`'s "Sideboard" link)
 * renders {@link SeriesSideboardPanel} / {@link SeriesEnterNext} directly — the SAME components
 * this file's own sideboard branch draws, factored out here so both callers share one markup
 * rather than each wrapping `SideboardStep` in their own.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { magicGame, type DraftCard } from '@hadoku/shared';
import type { RoomTable as SharedRoomTable } from '@hadoku/shared';
import { type EndedBy } from '@hadoku/forge-wire';
import { parseDck } from '@hadoku/carddata/dck';
import { CONSTRUCTED_LIMITS, LIMITED_MIN_MAIN_DECK_SIZE, deckFromDeckFile, type Deck } from '@hadoku/deck';

import { navigate } from '@hadoku/game-ui/screens/route.ts';
import { roomsClient, type RoomView } from '../../../rooms/api.ts';
import { roomFeed } from '@hadoku/game-ui/rooms/feed.ts';
import { latestReads } from '../../../rooms/latest.ts';
import { tablesClient, type RoomTable, type SeatChoice, type StartOutcome, type TablesClient } from '../../../screens/tables.ts';
import { DeckEditor, type ReadyState } from '../../../deck/DeckEditor.tsx';
import { deckStoreClient } from '../../../deck/deckStore.ts';
import { dckTextOf } from '../../../draft/deckFromPool.ts';
import { libraryDeckText, namedCardPool } from '../../../deck/build.ts';
import { useNamedArt } from '../../../screens/libraryPeek.ts';
import { ActionButton } from '@hadoku/game-ui/components/ActionButton.tsx';
import { Avatar } from '@hadoku/game-ui/components/Avatar.tsx';
import { PlayerName } from '@hadoku/game-ui/room/look.tsx';
import { opponentOf, viewerOf, type BoardPlayer, type BoardView } from '../../adapter.ts';
import { poisonOf, POISON_TO_LOSE } from '../../Board.tsx';
import { CheckMark } from '../../marks.tsx';
import { openNewMatch } from '../matchStart.ts';
import { gameOutcome, lostPlayers, type GameOutcome } from '../LiveBoard.tsx';
import type { LiveMatch } from '../match.ts';

/** The ways the board alone can tell a game ended, for a notice that does not say. */
export type GameEndReason = 'life' | 'poison' | 'decking' | 'concede';

/** Forge's `GameLossReason` names, each as the rule that ended the game. */
const LOSS_WORDS: Readonly<Partial<Record<string, (source: string | undefined) => string>>> = {
  LifeReachedZero: () => 'life total reached 0',
  Poisoned: () => '10 or more poison counters',
  Milled: () => 'had to draw from an empty library',
  Conceded: () => 'conceded',
  SpellEffect: (source) => (source === undefined ? 'lost to an effect' : `lost to ${source}`),
  OpponentWon: (source) => (source === undefined ? 'an opponent won' : `an opponent won with ${source}`),
  CommanderDamage: () => '21 or more commander damage',
  IntentionalDraw: () => 'agreed to a draw',
};

const BOARD_REASON: Readonly<Record<GameEndReason, string>> = {
  life: 'LifeReachedZero',
  poison: 'Poisoned',
  decking: 'Milled',
  concede: 'Conceded',
};

/** Why THIS player lost, read off facts already on their `BoardPlayer`. Exported for its own test. */
export function reasonLost(player: BoardPlayer): GameEndReason {
  if (player.life <= 0) return 'life';
  if (poisonOf(player) >= POISON_TO_LOSE) return 'poison';
  if (player.libraryCount === 0) return 'decking';
  return 'concede';
}

/** Why the server ended a game itself (`LiveMatch.endedBy`), as the result screen says it. */
const ENDED_BY_WORDS: Readonly<Record<EndedBy, string>> = {
  'time-limit': 'The game ran for 8 hours and ended in a draw',
};

/**
 * One sentence per loser (almost always one; a double-loss draw gets both), or the server's own
 * reason for a game it ended. `null` when nobody lost and the game ended by itself.
 */
export function endingSentence(match: LiveMatch, view: BoardView): string | null {
  if (match.endedBy !== null) return ENDED_BY_WORDS[match.endedBy];
  const losers = lostPlayers(match, view);
  if (losers.length === 0) return null;
  return losers
    .map((p) => {
      const loss = match.lost?.get(p.id);
      // A clock that ran out ends the game as the server's concede for that seat (`Match.flag`).
      if (match.clockByPlayerId?.get(p.id)?.ms === 0) return `${p.name} — Out of Time`;
      const words = LOSS_WORDS[loss?.reason ?? BOARD_REASON[reasonLost(p)]];
      return words === undefined ? p.name : `${p.name} — ${words(loss?.source)}`;
    })
    .join(' · ');
}

const OUTCOME_TITLE: Readonly<Record<GameOutcome, string>> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
};

/**
 * A player's face, for the result screen. Not `Board.tsx`'s `PlayerFace`
 * (unexported, and drawn for a different job — a clickable target with a life
 * badge): the same `Avatar`, sized by `live.css`.
 *
 * `rematch`: this player has pressed Rematch — a check over their face.
 */
function ResultFace({ player, rematch }: { player: BoardPlayer; rematch: boolean }) {
  return (
    <div className="live__result-face" data-testid="game-result-face" data-you={player.isViewer} data-lost={player.hasLost || undefined}>
      <span className="live__result-portrait">
        <Avatar id={player.avatarId} look={player.look} fallback="mark" className="live__result-avatar" fallbackClassName="live__result-avatar" />
        {rematch && (
          <span className="live__result-check" data-testid="game-result-check" role="img" aria-label="Rematch">
            <CheckMark className="live__result-tick" />
          </span>
        )}
      </span>
      <PlayerName name={player.name} face={{ id: player.avatarId, look: player.look }} className="live__result-name" />
    </div>
  );
}

/** Who has pressed Rematch, and what pressing it can do now. */
export interface Rematch {
  /** I have pressed it. */
  mine: boolean;
  /** The other player has pressed it. */
  theirs: boolean;
  /** The other player is waiting on me: my button is highlighted. */
  highlight: boolean;
  /**
   * There is someone to rematch: a player still at the table, or the bot in a
   * game played alone. False until the table answers, and once the other
   * player has left.
   */
  possible: boolean;
  /** Both have pressed: the new match is to be asked for. */
  agreed: boolean;
}

/**
 * The table's next game, once its players have agreed: against the AI the one
 * player's Ready is the agreement. The result screen and the pod room's own
 * sideboard step (`screens/TableSideboard.tsx`) both ask; the server joins
 * two asks for one table into one start.
 */
export function startNextGame(tables: TablesClient, roomId: string, tableId: string | undefined, solo: boolean): Promise<StartOutcome> {
  const start = solo ? tables.startVsBot : tables.startRoom;
  return tableId === undefined ? start(roomId) : start(roomId, tableId);
}

/**
 * Read off the room's table. A Rematch press is the table's own Ready
 * (`POST …/ready`), so this is the same fact the room screen starts a match on.
 * `alone` is latched from the table's first answer: a game against the bot has
 * one player at the table from the start, a human game two until one leaves.
 */
export function rematchOf(table: RoomTable | null, alone: boolean): Rematch {
  const me = table?.players.find((p) => p.you);
  const other = table?.players.find((p) => !p.you);
  const mine = me?.ready === true;
  const theirs = other?.ready === true;
  return {
    mine,
    theirs,
    highlight: theirs && !mine,
    possible: me !== undefined && (alone || other !== undefined),
    agreed: mine && theirs,
  };
}

/** How long the result screen waits for its table and room to agree before it shows anyway. */
export const RESULT_SETTLE_MS = 4_000;

/** The viewer's own held choice at this table — the editor's starting point. */
export function myChoice(table: RoomTable | null): SeatChoice | null {
  return table?.players.find((p) => p.you)?.deck?.choice ?? null;
}

/**
 * THIS match's own table, in a room that may hold several (a pod). Matched
 * by `matchId` while the game is live, or by `series.games[].matchId` once it
 * has ended — `recordGameResult` clears `table.matchId` the instant a game is
 * recorded (wave 72 §P's eager series), so by the time this screen is even
 * drawn the table it belongs to no longer says so directly. Falls back to
 * `tables[0]` only when neither matches (a constructed 1v1 room never has a
 * second table to confuse this with; the fallback is for a room this screen
 * has not yet read, not for a real ambiguity).
 */
export function findMyTable(room: RoomView | null, matchId: string): SharedRoomTable | null {
  if (room === null) return null;
  const found = room.tables.find((t) => t.matchId === matchId || t.series.games.some((g) => g.matchId === matchId));
  return found ?? room.tables[0] ?? null;
}

/**
 * The player's current 75, as `.dck` text. The wire only ever hands this
 * screen a REFERENCE to a library pick (`choice.deck.library`, an id), never
 * the deck's own lines, so that half resolves through the catalogue
 * (`GET /tables/decks`) and `libraryDeckText` — the same two-step `DeckScreen`
 * and the room's own picker already take. A drafted pick already carries its
 * text directly.
 */
async function my75Text(choice: SeatChoice, tables: TablesClient): Promise<string | null> {
  const ref = choice.deck;
  if ('dck' in ref) return ref.dck;
  const decks = await tables.decks();
  const found = decks.find((d) => d.id === ref.library);
  return found === undefined ? null : libraryDeckText(found.name, found.main, found.sideboard);
}

/**
 * What the sideboard step draws from — my 75 and, for a drafted deck, the
 * drafted pool — read BEFORE the step is shown, so it opens whole rather than
 * as a loading box that turns into an editor. `undefined` while either is
 * still being read; `null` choice reads nothing.
 */
export function useSideboardInputs(
  choice: SeatChoice | null,
  tables: TablesClient,
): { text: string | null; draftPool: DraftCard[] | null } | undefined {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (choice === null) return;
    let live = true;
    my75Text(choice, tables).then((t) => {
      if (live) setText(t);
    });
    return () => {
      live = false;
    };
  }, [choice, tables]);

  const draftId = choice !== null && choice.rules.kind === 'draft' ? choice.rules.draftId : null;
  const [draftPool, setDraftPool] = useState<DraftCard[] | null | undefined>(undefined);
  useEffect(() => {
    if (draftId === null) return;
    let live = true;
    deckStoreClient()
      .mine(draftId)
      .then(
        (mine) => {
          if (live) setDraftPool(mine?.pool ?? null);
        },
        () => {
          if (live) setDraftPool(null);
        },
      );
    return () => {
      live = false;
    };
  }, [draftId]);

  if (choice === null || text === undefined || (draftId !== null && draftPool === undefined)) return undefined;
  return { text, draftPool: draftPool ?? null };
}

/**
 * The sideboard step between two games of a series (wave 72 §Q.4):
 * `DeckEditor` in `sideboard` mode over the player's own 75 — the drafted
 * pool, or a library deck's main plus `[Sideboard]`, resolved by
 * {@link my75Text} either way into the SAME `.dck` text `DeckEditor`'s own
 * `savedDeck` load already knows how to open. It takes the whole match box,
 * not a dialog: it is the same editor a build uses, piles and all.
 *
 * **Faces:** a drafted 75 draws from the drafter's own pool
 * (`GET /api/drafts/:podId/mine`, the cards with their type lines and costs);
 * a library 75, or a pool that read fails, degrades to `namedCardPool` — a
 * cost per name from the browser's own table and art as the server names it, the same path
 * `ConstructedScreen.tsx`'s deck peek draws a library card through.
 *
 * **The floor:** a drafted deck's is 40, and basics are free (the server's
 * own sideboard check excludes them on a drafted pool). A constructed 75 has
 * no counters, and its floor is its own opening main deck, up to 60 — the
 * step only re-splits, so it can never ask for more than the deck began with.
 *
 * **Ready is the editor's own way onward**, offered once the deck is at its
 * floor, and it submits the split the editor hands it: `PUT …/deck`, then
 * `ready(true)`. A refusal (the server's 75 check, or the start gate) shows
 * as its own sentence above the editor.
 */
export function SideboardStep({
  roomId,
  tableId,
  tables,
  choice,
  inputs,
}: {
  roomId: string;
  /** This match's own table (`GameResultScreen`'s `findMyTable`) — a pod's table 2+, never `tables[0]` by default. */
  tableId: string | undefined;
  tables: TablesClient;
  choice: SeatChoice;
  /** Read by `GameResultScreen` before it shows anything (`useSideboardInputs`). */
  inputs: { text: string | null; draftPool: DraftCard[] | null };
}) {
  const { text, draftPool } = inputs;
  const draftId = choice.rules.kind === 'draft' ? choice.rules.draftId : null;

  const parsed = useMemo(() => (typeof text === 'string' ? deckFromDeckFile(parseDck(text)) : null), [text]);
  const namedArt = useNamedArt();
  const pool = useMemo(
    () => draftPool ?? (parsed === null ? [] : namedCardPool([...parsed.main, ...parsed.sideboard].map((e) => e.card))),
    [draftPool, parsed, namedArt],
  );
  const [readyState, setReadyState] = useState<ReadyState>('idle');
  const [refusal, setRefusal] = useState<string | null>(null);

  if (text === null || parsed === null) {
    return (
      <p className="ct-error live__error" role="alert" data-testid="sideboard-unavailable">
        Could not find your deck to sideboard.
      </p>
    );
  }

  const onReady = (deck: Deck): void => {
    setReadyState('busy');
    setRefusal(null);
    const refuse = (reason: string): void => {
      setReadyState('idle');
      setRefusal(reason);
    };
    const onFailure = (err: unknown): void => refuse(err instanceof Error ? err.message : String(err));
    const deckBody = { dck: dckTextOf(deck) };
    (tableId === undefined ? tables.loadDeck(roomId, deckBody) : tables.loadDeck(roomId, deckBody, tableId)).then((loaded) => {
      if (!loaded.ok) {
        refuse(loaded.error);
        return;
      }
      (tableId === undefined ? tables.ready(roomId, true) : tables.ready(roomId, true, tableId)).then((answer) => {
        if (answer.ok) setReadyState('ready');
        else refuse(answer.error);
      }, onFailure);
    }, onFailure);
  };

  const openingMain = parsed.main.reduce((n, e) => n + e.count, 0);
  return (
    <section className="sideboard-step" data-testid="sideboard-step">
      {refusal !== null && (
        <p className="ct-error live__error" role="alert" data-testid="sideboard-refusal">
          {refusal}
        </p>
      )}
      <DeckEditor
        mode="sideboard"
        draftId={roomId}
        pool={pool}
        savedDeck={text}
        allowBasics={draftId !== null}
        minMain={draftId !== null ? LIMITED_MIN_MAIN_DECK_SIZE : Math.min(CONSTRUCTED_LIMITS.minMainDeckSize, openingMain)}
        onReady={onReady}
        readyState={readyState}
      />
    </section>
  );
}

/**
 * The ONE sideboard-step wrapper: `GameResultScreen`'s own "Next" branch and
 * `TableSideboard.tsx` (the room lobby's "Sideboard" link) both draw THIS, not a lookalike each —
 * same classes, same markup, so a screenshot diff of the two paths has nothing left to find in the
 * panel itself. `title` is each caller's own (an outcome's name here, a plain "Sideboard" label
 * there); `exits` are the same from both (`useMatchExits`): the lobby path draws the panel alone in
 * the match's frame, with no room chrome around it, so it needs its own way off as much as the
 * in-game one does.
 */
export function SeriesSideboardPanel({
  roomId,
  tableId,
  tables,
  choice,
  inputs,
  title,
  dataResult,
  refusal,
  exits,
  titleId,
}: {
  roomId: string;
  tableId: string | undefined;
  tables: TablesClient;
  choice: SeatChoice;
  inputs: { text: string | null; draftPool: DraftCard[] | null } | undefined;
  title: string;
  dataResult?: GameOutcome;
  refusal: string | null;
  exits?: ReactNode;
  titleId: string;
}) {
  return (
    <section className="board__over board__over--sideboard" data-testid="game-result" data-result={dataResult} role="dialog" aria-labelledby={titleId}>
      <div className="live__sideboard ct-panel">
        <div className="live__sideboard-head">
          <h2 className="confirm__title" id={titleId}>
            {title}
          </h2>
          {refusal !== null && (
            <p className="ct-error live__error" role="alert">
              {refusal}
            </p>
          )}
          <span className="live__sideboard-spacer" />
          {exits}
        </div>
        {inputs !== undefined && <SideboardStep roomId={roomId} tableId={tableId} tables={tables} choice={choice} inputs={inputs} />}
      </div>
    </section>
  );
}

/**
 * The screen a next game stays on until it is pressed into. `onEnter` is the only caller of
 * `openNewMatch`; nothing here, or in `GameResultScreen`/`TableSideboard`, calls it on its own.
 */
export function SeriesEnterNext({
  title,
  faces,
  onEnter,
  exits,
  titleId,
}: {
  title: string;
  faces?: ReactNode;
  onEnter: () => void;
  exits?: ReactNode;
  titleId: string;
}) {
  return (
    <section className="board__over" data-testid="game-result" role="dialog" aria-labelledby={titleId}>
      <div className="confirm live__result">
        <h2 className="confirm__title" id={titleId}>
          {title}
        </h2>
        {faces !== undefined && <div className="live__result-faces">{faces}</div>}
        <div className="confirm__actions answers">
          <button type="button" className="button" data-highlight="true" data-testid="game-result-enter" onClick={onEnter}>
            Enter game
          </button>
          {exits}
        </div>
      </div>
    </section>
  );
}

/**
 * The two ways off a match that is over: Back to room, and Main menu (which leaves the room). The
 * result screen, the ended notice and the lobby's sideboard step (`TableSideboard.tsx`) all end in them.
 */
export function useMatchExits(roomId: string | null): { leaving: boolean; onBackToRoom: () => void; exits: ReactNode } {
  const [leaving, setLeaving] = useState(false);
  // The room itself (the operator, 2026-10-23: back in the room mid-series, "a small box that lets me return"
  // to the table, not the sideboard step there); the table's page is one press from it.
  const onBackToRoom = (): void => {
    if (roomId !== null) navigate({ kind: 'room', roomId });
  };
  const onMainMenu = (): void => {
    setLeaving(true);
    const left: Promise<unknown> = roomId === null ? Promise.resolve() : roomsClient().leave(roomId);
    void left.finally(() => navigate({ kind: 'lobby' }));
  };
  const exits = (
    <>
      <button type="button" className="button" data-testid="game-result-room" disabled={roomId === null || leaving} onClick={onBackToRoom}>
        Back to room
      </button>
      <button type="button" className="button" data-testid="game-result-menu" disabled={leaving} onClick={onMainMenu}>
        Main menu
      </button>
    </>
  );
  return { leaving, onBackToRoom, exits };
}

/**
 * A match that ended with no game result — its JVM died, the server is stopping, anything that ends
 * it from outside the game: the server's own words over the board, and the ways off it. Every such
 * ending reaches the screen as the one notice (`LiveMatch.ended`), so this is the one screen for all
 * of them. Drawn like the result screen, which a game that did finish gets instead.
 */
export function MatchEndedNotice({ ended, roomId }: { ended: { title: string; message: string }; roomId: string | null }) {
  const titleId = useId();
  const { exits } = useMatchExits(roomId);
  return (
    <section className="board__over" data-testid="match-ended" role="alertdialog" aria-labelledby={titleId}>
      <div className="confirm live__result">
        <h2 className="confirm__title" id={titleId}>
          {ended.title}
        </h2>
        <p className="confirm__message live__result-ending">{ended.message}</p>
        <div className="confirm__actions answers">{exits}</div>
      </div>
    </section>
  );
}

/**
 * The result screen itself (shape 4 + shape 5): drawn over the board — which
 * stays visible behind it, per the brief — when `view.gameOver`.
 *
 * **Rematch** is an agreement, not a jump (the operator, 2026-10-10: *"only
 * when both players have rematch clicked should it launch into a new game"*).
 * Pressing it readies you at the room's table — the same Ready the room screen
 * starts a match on, with the decks both players still hold there — and
 * pressing it again stands you down. This screen reads the table whenever the
 * room changes (`@hadoku/game-ui/rooms/feed.ts`), draws a check over each face whose player is
 * ready, and highlights the button of the
 * player the other is waiting on. Once both are ready either screen asks for
 * the match (`startRoom`; the server answers one match to both). **Neither screen
 * jumps in on its own any more**: once the room's table names the new
 * match this screen draws {@link SeriesEnterNext} instead, and ONLY a press
 * there calls `openNewMatch`. In a game played alone against the bot there is
 * nobody to wait for, so Rematch still reaches the SAME enter-to-play screen at once.
 *
 * **Back to room** opens the room's own screen and changes nothing at its
 * table: you stay a member, seated with the deck you played and not ready, so
 * the other screen's Rematch still has you to agree with — readying in the room
 * is the same Ready.
 *
 * **Main menu** leaves the room (`roomsClient().leave`, lane R shape 5) and
 * THEN goes to the lobby — in that order, `finally`, so a leave that fails
 * still lands the player somewhere rather than stranding them on a result
 * screen for a room that may already be gone. Leaving takes your seat at the
 * table with you, so the other screen's next read loses your check and its
 * highlight, and its Rematch has nobody left to agree with.
 *
 * Without a known room (`roomId === null` — a `#/match/<id>` link from
 * elsewhere, a match no room started, or a server that could not be reached;
 * see `MatchScreen.tsx`'s own comment on the same fact), there is no table to
 * ready at: Rematch and Back to room are
 * disabled and Main menu goes straight to the lobby.
 *
 * **Series on screen.** Every Constructed series starts as Bo1, and the
 * Rematch agreement is what converts it to Bo3 and MOVES the table to
 * `sideboarding` (`lobby.ts`'s `beginSideboarding`, from `done`); a Bo3
 * reaches `sideboarding` on its own, the instant an undecided game ends
 * (`recordGameResult`). Either way `showSideboard` tracks `phase ===
 * 'sideboarding'` alone, so the sideboard step appears with no second press.
 * Between the games of a series that does not sideboard (`between`, a
 * Gauntlet) the button reads `Next game`, and the next game is set up in the
 * room (a Gauntlet's secret choice of decks), so it opens the room as Back to
 * room does and readies nothing: the room starts that game once it is set up
 * (the operator, 2026-10-21: *"when players select 'Next Game' it should take
 * them back to the deck picker"*). **In a pod room there is no Rematch at
 * all** (`room.pod !== null`), nor once a Gauntlet is decided — Back to room already opens the pod
 * (`#/room/<id>` renders `PodScreen` for a draft room), so there is nothing
 * else for this button to do.
 */
export function GameResultScreen({ match, roomId }: { match: LiveMatch; roomId: string | null }) {
  const view = match.view!;
  const outcome = gameOutcome(match)!;
  const viewer = viewerOf(view);
  const opponent = opponentOf(view);
  const ending = endingSentence(match, view);
  const titleId = useId();
  const { leaving, onBackToRoom, exits } = useMatchExits(roomId);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [table, setTable] = useState<RoomTable | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [alone, setAlone] = useState<boolean | null>(null);
  const [tables] = useState(tablesClient);
  /** A start is in flight: not asked again on every read. */
  const asked = useRef(false);
  const rematch = rematchOf(table, alone === true);

  /**
   * THIS match's own table (wave 71 §D's wire shape, via `@hadoku/shared`) —
   * for `series.phase` and `pod`,
   * none of which `./tables.ts`'s own `RoomTable` (`table`, above) carries,
   * and — in a pod — for the table id every `tables.ts` call below now
   * passes, so a pod player's table 2+ is never addressed as `tables[0]`.
   * See {@link findMyTable}.
   */
  const myTable = findMyTable(room, match.matchId);
  const tableId = myTable?.id;
  const phase = myTable?.series.phase ?? null;
  /**
   * No Rematch in a pod (wave 72 §Q.3), a pod of one against the AI included:
   * Back to room opens the pod, whose rounds decide who plays whom, and whose
   * standings follow the last game. A Rematch there started a new series at a
   * finished table, for ever (the operator, 2026-10-19: *"it seems like it just
   * lets me keep clicking 'next game' forever"*).
   */
  const inPod = room !== null && magicGame(room).pod !== null;
  /**
   * A Gauntlet is never rematched: between its games the button is Next game,
   * and once it is decided the next Gauntlet is set up in the room (the
   * operator, 2026-10-21: *"when match is finished don't show 'rematch' button"*).
   */
  const rematchable = !inPod && (room === null || magicGame(room).mode !== 'gauntlet');
  /**
   * A room change (mode, pool) since this game interrupted its series: the
   * table is back to a fresh `seating` series without it (ruling 14). Its
   * players stay seated (AF344), so a Rematch would play the new rules on
   * decks that were dropped.
   */
  const interrupted =
    myTable !== null && myTable.series.phase === 'seating' && myTable.matchId !== match.matchId && !myTable.series.games.some((g) => g.matchId === match.matchId);
  /**
   * The table id the reads below address — a ref, not state, because the
   * table-scoped read inside the SAME refresh cycle that learns it has to
   * use what THIS cycle just learned, not last render's.
   */
  const myTableIdRef = useRef<string | undefined>(undefined);

  /**
   * What the table looked like at the last room read — so the next one is
   * skipped unless something actually moved. `aa-polling.spec.ts`'s idle
   * budget (`e2e/aa-polling.spec.ts`, "idle result screen reads the room at
   * most a few times a minute") was written for a screen that read ONE
   * thing per `roomFeed` tick (the table); reading the ROOM too on every
   * tick doubled it. `ready`/`matchId`/`locked`/`phase` are exactly the
   * fields a change worth re-checking the room for would also move — an
   * agreement, a game starting or ending, the table moving into
   * `sideboarding`. `phase` is not optional here: the agreement that begins
   * sideboarding spends both Readys, so a screen that never saw the other
   * press reads the same flags before and after it. A
   * genuinely idle tick (the fallback timer firing with nothing changed)
   * reads this SAME signature and skips the room — the idle case the spec
   * measures never pays the extra read.
   */
  const lastTableSignature = useRef<string | null>(null);

  /** The last room read, for the next tick to compare the table against. */
  const roomRef = useRef<RoomView | null>(null);
  /** A room read has answered — a room, or the server's 404 for one it will not admit to. */
  const [roomAnswered, setRoomAnswered] = useState(false);
  /** The table's reads and this screen's own Rematch writes of it, latest-wins (`../../rooms/latest.ts`). */
  const [tableReads] = useState(latestReads);
  useEffect(() => {
    if (roomId === null) return;
    let live = true;
    // This screen writes no room, so a room read is kept or dropped.
    const roomReads = latestReads();
    /** False when a newer room read overtook this one: that one decides, and the tick that sent this stops. */
    const refreshRoom = (): Promise<boolean> => {
      const landed = roomReads.read();
      return roomsClient()
        .get(roomId)
        .then(
          (answer) => {
            if (!live || landed() !== 'keep') return false;
            setRoomAnswered(true);
            if (answer === null) return true;
            roomRef.current = answer;
            setRoom(answer);
            myTableIdRef.current = findMyTable(answer, match.matchId)?.id;
            return true;
          },
          () => {
            if (!live || landed() !== 'keep') return false;
            setRoomAnswered(true);
            return true;
          },
        );
    };
    const tick = async (): Promise<void> => {
      // The room first, once: it says which of the room's tables is this
      // match's. A table read without it is the room's FIRST table — in a pod,
      // one nobody plays at.
      if (roomRef.current === null && !(await refreshRoom())) return;
      const landed = tableReads.read();
      const answer = await tables.table(roomId, myTableIdRef.current).catch(() => null);
      if (!live) return;
      const verdict = landed();
      if (verdict === 'drop') return;
      if (verdict === 'reread') {
        void tick();
        return;
      }
      // Unreachable for a moment: the last answer stays on screen and the next read asks again.
      if (answer === null || !answer.ok) return;
      setTable(answer.table);
      setAlone((was) => was ?? answer.table.players.length === 1);
      const signature = JSON.stringify({
        matchId: answer.table.room.matchId,
        locked: answer.table.room.locked,
        phase: answer.table.room.phase,
        players: answer.table.players.map((p) => ({ ready: p.ready, legal: p.deck?.legal })),
      });
      // The room again when the table moved, or when the last room read is
      // behind it: read before the game was recorded, it still says `playing`
      // while the table is `sideboarding` — and the sideboard step never opened
      // (w72-pod, claw run 39207516746; the operator's own pod, 2026-10-19).
      const behind = roomRef.current !== null && findMyTable(roomRef.current, match.matchId)?.series.phase !== answer.table.room.phase;
      if (signature !== lastTableSignature.current || behind) {
        lastTableSignature.current = signature;
        await refreshRoom();
      }
    };
    const stopFollowing = roomFeed().follow({ room: roomId }, () => void tick());
    return () => {
      live = false;
      stopFollowing();
    };
  }, [roomId, tables, tableReads, match.matchId]);

  /**
   * Nothing is drawn until what it would show is settled (the operator,
   * 2026-10-19: *"never show UI until its ready"* — a Rematch that flashed and
   * turned into something else): the table read, and a room read that has
   * answered and, when it found the room, agrees with the table on this
   * table's phase. A server that never lets them agree still gets the screen,
   * late, rather than none.
   */
  const showSideboard = phase === 'sideboarding';
  // By content: every table read is a fresh object, and the 75 is read once per choice, not once per read.
  const choiceKey = showSideboard ? JSON.stringify(myChoice(table)) : null;
  const sideboardChoice = useMemo(() => (choiceKey === null ? null : (JSON.parse(choiceKey) as SeatChoice | null)), [choiceKey]);
  const sideboardInputs = useSideboardInputs(sideboardChoice, tables);
  const settled =
    roomId === null ||
    (table !== null &&
      roomAnswered &&
      (myTable == null || myTable.series.phase === table.room.phase) &&
      // The sideboard step opens whole: its 75 (and drafted pool) already read.
      (!showSideboard || myChoice(table) === null || sideboardInputs !== undefined));
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setWaitedOut(true), RESULT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);
  // Only the first showing waits: once up, the screen stays up while a later
  // read catches the room up, rather than vanishing and coming back.
  const shownOnce = useRef(false);
  if (settled || waitedOut) shownOnce.current = true;

  /**
   * The next game's id, the instant it is known — from THIS screen's own ask ({@link started}, set
   * synchronously off its answer, never waiting on a fresh room read), or from the room's next table
   * read, for the screen that did NOT ask (`next`, same fact `table?.room.matchId` always was). Either
   * way the screen does not act on it by itself: see {@link SeriesEnterNext} below.
   */
  const [readyMatchId, setReadyMatchId] = useState<string | null>(null);
  const next = readyMatchId ?? table?.room.matchId ?? null;

  const refused = (error: string): void => {
    asked.current = false;
    setBusy(false);
    setRefusal(error);
  };
  const started = (answer: StartOutcome): void => {
    // `openNewMatch` is not called here: only the player's own press on
    // `SeriesEnterNext` does, once it has a next game id — this screen's own, right away, or the
    // next table read's, for whichever screen did not ask.
    if (answer.ok) setReadyMatchId(answer.matchId);
    else refused(answer.error);
  };
  const unreachable = (err: unknown): void => refused(err instanceof Error ? err.message : String(err));

  // Against the AI there is nobody to agree with: my sideboard step's Ready
  // is the whole agreement, and the next game is the bot's.
  const soloNext = alone === true && rematch.mine && phase === 'sideboarding';
  useEffect(() => {
    if ((!rematch.agreed && !soloNext) || roomId === null || asked.current) return;
    asked.current = true;
    startNextGame(tables, roomId, tableId, soloNext).then(started, unreachable);
  }, [rematch.agreed, soloNext, roomId, tables, tableId]);

  const onRematch = (): void => {
    if (roomId === null) return;
    setRefusal(null);
    setBusy(true);
    // The agreement (`beginSideboarding`'s own door, server-side). Once every
    // seat has pressed it a finished Bo1 converts and the table moves to
    // `sideboarding`, and the sideboard step below appears on its own the
    // moment `phase` says so — no second press. Against the AI the one press
    // is the agreement: a series that did not convert reaches the bot's next game at once.
    const ready = alone === true || !rematch.mine;
    tables.ready(roomId, ready, tableId, ready ? { rematch: true } : undefined).then((answer) => {
      if (!answer.ok) {
        setBusy(false);
        setRefusal(answer.error);
        return;
      }
      tableReads.wrote();
      setTable(answer.table);
      if (alone !== true || answer.table.room.phase === 'sideboarding') {
        setBusy(false);
        return;
      }
      asked.current = true;
      tables.startVsBot(roomId, tableId, { rematch: true }).then(started, unreachable);
    }, unreachable);
  };

  /** The next game is set up in the room, not agreed here (`between`). */
  const nextInRoom = phase === 'between';

  const choice = myChoice(table);
  /**
   * The outcome is shown first, and Next opens the sideboard step — the
   * operator, 2026-10-19: *"victory screen should show when winning a match in
   * pod. it seems to immediately go into sideboarding. let's let the player
   * click 'next' which takes them to side-boarding."*
   */
  const [nextPressed, setNextPressed] = useState(false);

  if (!shownOnce.current) return null;

  /**
   * The next game exists (the sideboard's Ready agreed, or a solo Rematch against the AI) —
   * this screen stays here with the faces it already has and a single press onward, rather than
   * jumping in by itself.
   */
  if (next !== null && next !== match.matchId) {
    return (
      <SeriesEnterNext
        titleId={titleId}
        title={OUTCOME_TITLE[outcome]}
        faces={
          <>
            {viewer !== undefined && <ResultFace player={viewer} rematch />}
            {opponent !== undefined && <ResultFace player={opponent} rematch />}
          </>
        }
        onEnter={() => openNewMatch(next)}
        exits={exits}
      />
    );
  }

  // Between games the result gives way to the sideboard step, which takes
  // the whole match box: the outcome shrinks to a line above the editor.
  if (showSideboard && nextPressed && roomId !== null && choice !== null) {
    return (
      <SeriesSideboardPanel
        titleId={titleId}
        roomId={roomId}
        tableId={tableId}
        tables={tables}
        choice={choice}
        inputs={sideboardInputs}
        title={OUTCOME_TITLE[outcome]}
        dataResult={outcome}
        refusal={refusal}
        exits={exits}
      />
    );
  }

  return (
    <section className="board__over" data-testid="game-result" data-result={outcome} role="dialog" aria-labelledby={titleId}>
      <div className="confirm live__result">
        <h2 className="confirm__title" id={titleId}>
          {OUTCOME_TITLE[outcome]}
        </h2>
        {ending !== null && <p className="confirm__message live__result-ending">{ending}</p>}
        <div className="live__result-faces">
          {viewer !== undefined && <ResultFace player={viewer} rematch={rematch.mine} />}
          {opponent !== undefined && <ResultFace player={opponent} rematch={rematch.theirs} />}
        </div>
        {refusal !== null && (
          <p className="ct-error live__error" role="alert">
            {refusal}
          </p>
        )}
        <div className="confirm__actions answers">
          {showSideboard && roomId !== null && choice !== null && (
            <button type="button" className="button" data-testid="game-result-next" data-highlight="true" disabled={leaving} onClick={() => setNextPressed(true)}>
              Next
            </button>
          )}
          {!showSideboard && (nextInRoom ? !inPod : rematchable) && (
            <ActionButton
              action={nextInRoom ? 'next-game' : rematch.mine ? 'rematch-withdraw' : 'rematch'}
              className="button"
              data-testid="game-result-rematch"
              aria-pressed={nextInRoom ? undefined : rematch.mine}
              data-highlight={nextInRoom || rematch.highlight ? 'true' : undefined}
              disabled={nextInRoom ? roomId === null || leaving : !rematch.possible || interrupted || busy || leaving}
              onPress={nextInRoom ? onBackToRoom : onRematch}
            >
              {nextInRoom ? 'Next game' : 'Rematch'}
            </ActionButton>
          )}
          {exits}
        </div>
      </div>
    </section>
  );
}
