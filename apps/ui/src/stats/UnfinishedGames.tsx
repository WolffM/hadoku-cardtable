/*
 * The viewer's unfinished games, on Your profile: every game they walked away from that the
 * server parked (`games/magic/server/src/play/parked.ts`), newest first, each one picked up again from
 * here. The operator, 2026-11-02: *"resuming parked games, i would expect that to happen from a
 * player's match history. resuming then means creating a new room and reconstructing the game from
 * snapshot."* Resume makes that room and goes into it; a game the other player already picked up
 * is joined in theirs. The match history beside it lists finished rated games only, so these live
 * in their own list. Nothing is drawn while the viewer has none.
 */

import { useEffect, useState } from 'react';
import { z } from 'zod';

import { apiUrl, bodyOf, getJson, sendJson, serverMessage, type Fetch } from '../http.ts';
import { navigate } from '../screens/route.ts';

const ParkedGameSchema = z.object({
  matchId: z.string(),
  room: z.string(),
  format: z.string(),
  turn: z.number().int(),
  parkedAt: z.string(),
  seats: z.array(z.object({ name: z.string(), deck: z.string().nullable(), ai: z.boolean(), you: z.boolean() })),
  resumed: z.object({ roomId: z.string(), tableId: z.string() }).nullable(),
});
export type ParkedGame = z.infer<typeof ParkedGameSchema>;

/** Where a resume goes: the table its game is played at. */
export interface ResumedAt {
  roomId: string;
  tableId: string;
}

export async function fetchParked(fetchImpl?: Fetch): Promise<ParkedGame[]> {
  const res = await getJson(apiUrl('play/parked'), fetchImpl);
  if (!res.ok) throw new Error(`Could not load your unfinished games (${res.status}).`);
  const body = (await res.json()) as { games?: unknown };
  return Array.isArray(body.games) ? body.games.flatMap((g) => ParkedGameSchema.safeParse(g).data ?? []) : [];
}

export async function resumeParked(matchId: string, fetchImpl?: Fetch): Promise<ResumedAt> {
  const res = await sendJson(apiUrl(`play/parked/${encodeURIComponent(matchId)}/resume`), 'POST', {}, fetchImpl);
  const body = await bodyOf(res);
  const at = z.object({ roomId: z.string(), tableId: z.string() }).safeParse(body);
  if (!res.ok || !at.success) throw new Error(serverMessage(body, res.status));
  return at.data;
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function UnfinishedGame({ game, resume }: { game: ParkedGame; resume: (matchId: string) => Promise<ResumedAt> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = game.seats.filter((s) => !s.you);
  const go = (): void => {
    setBusy(true);
    setError(null);
    resume(game.matchId).then(
      (at) => navigate({ kind: 'room', roomId: at.roomId, tableId: at.tableId }),
      (err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <li className="ct-unfinished__game" data-testid="unfinished-game">
      <div className="ct-unfinished__what">
        <span className="ct-unfinished__who">{`vs ${others.map((s) => s.name).join(', ')}`}</span>
        <span className="ct-unfinished__detail">
          {`${game.format} · Turn ${game.turn} · `}
          <time dateTime={game.parkedAt}>{WHEN.format(new Date(game.parkedAt))}</time>
        </span>
      </div>
      <button type="button" className="lobby__go ct-unfinished__go" data-action={game.resumed === null ? 'resume' : 'join'} data-testid="unfinished-resume" disabled={busy} onClick={go}>
        {game.resumed === null ? 'Resume' : 'Join'}
      </button>
      {error !== null && (
        <p className="ct-error ct-unfinished__error" role="alert" data-testid="unfinished-error">
          {error}
        </p>
      )}
    </li>
  );
}

export function UnfinishedGames({
  load = fetchParked,
  resume = resumeParked,
}: {
  load?: (() => Promise<ParkedGame[]>) | undefined;
  resume?: (matchId: string) => Promise<ResumedAt>;
}) {
  const [games, setGames] = useState<ParkedGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((g) => live && setGames(g))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [load]);

  if (error !== null) {
    return (
      <p className="ct-error" role="alert" data-testid="unfinished-load-error">
        {error}
      </p>
    );
  }
  if (games === null || games.length === 0) return null;
  return (
    <section className="gs-card ct-unfinished" data-testid="unfinished" aria-labelledby="ct-unfinished-title">
      {/* The page's other cards are `@wolffm/game-stats-ui`'s; this one wears their classes, and is gone when there is nothing in it. */}
      <div className="gs-card__head">
        <h2 id="ct-unfinished-title" className="gs-card__title">
          Unfinished games
        </h2>
      </div>
      <div className="gs-card__body">
        <ul className="ct-unfinished__list">
          {games.map((game) => (
            <UnfinishedGame key={game.matchId} game={game} resume={resume} />
          ))}
        </ul>
      </div>
    </section>
  );
}
