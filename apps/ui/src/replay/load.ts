/*
 * A replay made ready before anyone sees it. A replay is a file, not a connection, so nothing on a
 * replay surface ever reads "Connecting…": the recording is fetched, its first moment folded, and
 * every face on that board decoded before the board is shown (the operator, 2026-10-28: *"ideally the
 * user doesn't have to sit through the loading"*). The rest of the match's art warms behind it.
 *
 * The front page asks for the newest replay when it boots ({@link latestReplay}), once per page; a
 * replay's body is immutable and the server says so, so a second visit reads it from the browser's
 * cache.
 */

import type { BoardCard, BoardView } from '../play/adapter.ts';
import { preloadMatchArt } from '../play/live/art-preload.ts';
import { subscribe } from '../play/live/match.ts';
import { artReady, cardImageUrl } from '../draft/cardImage.ts';
import { createReplayPlayer, type ReplayPlayer } from './player.ts';
import type { Fetch } from '../http.ts';
import { fetchLatestReplay, fetchReplay, reportReplayTrouble, type ReplayData } from './transport.ts';

/** Every face `view` draws: both hands, every zone, the stack's sources. */
function facesOf(view: BoardView): (string | undefined)[] {
  const cards: (BoardCard | null)[] = view.players.flatMap((p) => [...(p.hand ?? []), ...(p.handShown ?? []), ...p.battlefield, ...p.graveyard, ...p.exile, ...(p.command ?? [])]);
  return [...cards.map((c) => (c === null || c.hidden === true ? undefined : c.card.scryfallId)), ...view.stack.map((s) => s.sourceCard?.scryfallId)];
}

/** Resolves once every one of `urls` is decoded (or has failed: a card with no art draws its text tile). */
function decoded(urls: readonly string[]): Promise<void> {
  return Promise.all(urls.map((url) => new Promise<void>((resolve) => artReady(url, resolve) && resolve()))).then(() => undefined);
}

/**
 * A player over `data`, its first moment drawn with every face decoded. The rest of the match's art
 * (`header.art`, both decks) starts warming once that is done.
 */
export async function readyPlayer(data: ReplayData, options: { loop?: boolean } = {}): Promise<ReplayPlayer> {
  const player = createReplayPlayer(data, options);
  // A board that says it is in trouble on a replay is a bug in the recording or the player: the server hears it once.
  let reported = false;
  subscribe(player.match, () => {
    if (reported || player.match.lastError === null) return;
    reported = true;
    reportReplayTrouble('player-error', data.header.matchId, {
      error: player.match.lastError,
      at: player.clock.positionMs(),
    });
  });
  const view = player.match.view;
  const urls = view === null ? [] : facesOf(view).map((id) => cardImageUrl(id));
  await decoded([...new Set(urls.filter((url): url is string => url !== null))]);
  preloadMatchArt(data.header.matchId, {
    matchId: data.header.matchId,
    cards: [...data.header.art],
  });
  return player;
}

let latest: Promise<ReplayData | null> | null = null;

/**
 * The newest replay's recording, fetched once per page (a test's own `fetchImpl` fetches afresh).
 * `null`: there is none to show, or it could not be loaded, which is reported, never drawn.
 */
export function latestReplay(fetchImpl?: Fetch): Promise<ReplayData | null> {
  const load = (): Promise<ReplayData | null> =>
    fetchLatestReplay(fetchImpl)
      .then((listing) => (listing === null ? null : fetchReplay(listing.matchId, fetchImpl)))
      .catch((err: unknown) => {
        reportReplayTrouble('load-failed', null, { error: err instanceof Error ? err.message : String(err) }, fetchImpl);
        return null;
      });
  if (fetchImpl !== undefined) return load();
  latest ??= load();
  return latest;
}
