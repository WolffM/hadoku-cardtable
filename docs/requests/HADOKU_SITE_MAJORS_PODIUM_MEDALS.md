# Request to hadoku_site: Majors, the leaderboard podium, and avatar medals

**From:** hadoku-cardtable
**Status:** request / not yet agreed — filed as WolffM/hadoku_site#507
**Board row:** wave 86 in `docs/planning/workstreams.md` (queued since 2026-10-30; this is its first write-up)
**Asking for:** tournaments in the game-stats store, a Major flag set only with the admin key, a
"last Major" podium for game-stats-ui's leaderboard, and medals that travel with the resolved avatar.
**Cardtable's own half:** reporting finished tournaments, and drawing the medal. Both are listed at the end.

---

## What the operator asked for

From the operator's planning dump for the first public release, 2026-10-30, verbatim:

> 1g. i need a way to display a full width banner inside the leaderboard on top showing the pedestal for
> the last 'Major' tournament. also need a way to classify tournaments as 'Majors'. for now just make it so
> any tournament can be marked via adminkey only.
>
> 1e. a small decoration that can be activated on top of an avatar showing a gold/silver/bronze medal
> awarded to major tournament winners.

The first public release opens with a big tournament, and that tournament is the first Major.

## Where things stand

- **Tournaments never reach the store.** Cardtable reports each finished *match* through
  `recordMatch` (`games/magic/server/src/stats/reporter.ts`, a `MatchReport` from `@wolffm/prefs-client/games`).
  A tournament, meaning a pod or a constructed Swiss with its final standings, is kept only in
  cardtable's own JSON file, capped at 500 (`games/magic/server/src/room/tournaments.ts`). That file feeds the
  stats popout's Tournaments tab (`apps/ui/src/stats/Tournaments.tsx`). Nothing in hadoku_site knows a
  tournament happened.
- **Nothing anywhere has a Major, podium or medal concept.** I searched cardtable, hadoku_site,
  watchparty and games-host for medal, podium, pedestal and Major on 2026-11-01 and found none.
  The "medallions" in cardtable are planeswalker emblems on an avatar, which are unrelated.
- **The avatar layer this builds on is live.** `0d92c6db5` and the commits after it give one
  `ResolvedAvatar` per user (`packages/prefs-client/src/avatar-contract.ts`), and
  `POST /api/v1/_avatar/resolve` lets a game server resolve a roomful of users at once.
  A medal should travel with the avatar, so every app that draws an avatar can draw the medal without
  a second lookup.
- **The leaderboard is yours.** It is `GET /api/v1/_games/:gameId/leaderboard`
  (`workers/prefs-api/src/routes/games.ts`), drawn by `packages/game-stats-ui`.

## What we're asking for

### 1. Tournaments in the store

`POST /api/v1/_games/:gameId/tournaments`, service tier, idempotent on `tournamentId` like `recordMatch`
is on `matchId`:

```ts
interface TournamentReport {
	tournamentId: string;     // cardtable's `<roomId>-<startedAt>`; give it its own pattern if MATCH_ID_PATTERN is too tight
	name: string;             // the room's name at the end
	mode?: string;            // e.g. 'draft' | 'constructed', for filtering
	startedAt: number;
	endedAt: number;
	rounds: number;
	closed: boolean;          // closed by its owner before the last round finished
	placings: Array<{
		userKey?: string;     // absent for an AI entrant
		kind: 'user' | 'bot';
		displayName?: string;
		place: number;        // 1-based; always a strict order, never a tie
		wins: number; losses: number; draws: number;
	}>;
}
```

Cardtable guarantees `place` is a strict order: its tiebreakers end in a deterministic decider, so a
tournament always has exactly one first, second and third (`docs/planning/waves84-88-2026-10-31.md`, settled item 1).

A read that cardtable's Tournaments tab can switch to later is welcome but not needed now:
`GET /api/v1/_games/:gameId/tournaments?limit=`.

### 2. The Major flag, admin key only

`POST /api/v1/admin/games/:gameId/tournaments/:tournamentId/major` with `{ major: boolean }`, behind the
same admin gate as `/api/v1/admin/*`. The operator asked for "admin key only for now", so there's no UI
and no tier below admin. It is reversible: unmarking a tournament takes its medals away.

**Only a finished tournament (`closed: false`) can be a Major.** Refuse the flag on one its owner
closed early.

### 3. The podium for the leaderboard

`GET /api/v1/_games/:gameId/majors/latest` returns the most recent Major by `endedAt`, or `null`:

```ts
interface MajorPodium {
	tournamentId: string;
	name: string;
	endedAt: number;
	podium: Array<{ place: 1 | 2 | 3; name: string; avatar: ResolvedAvatar; record: string }>; // "3-0-0"
}
```

game-stats-ui draws it as a **full-width banner at the top of the leaderboard**: the three on a pedestal,
first in the middle and raised. With no Major yet, there's no banner and no empty space. A bot never
takes a place on the podium. A Major with a bot in the top three shows the humans who placed, at their
real places.

### 4. Medals on the avatar

A user holds a medal for each top-three finish in a Major: gold for 1st, silver for 2nd, bronze for 3rd.
The operator said the decoration "can be activated", so **the user chooses whether to show it, and
which one**:

- `ResolvedAvatar` gains `medal?: { tier: 'gold' | 'silver' | 'bronze'; tournamentId: string; name: string }`,
  present only when the user has switched one on. `POST /_avatar/resolve` returns it with no extra call.
- `AvatarSettings` gains `medals: Array<{ tier; tournamentId; name; endedAt }>` (everything they hold)
  and `shownMedal: string | null` (a `tournamentId`).
- `PUT /api/v1/_avatar` accepts `shownMedal` (one they hold, or `null`).
- **Default:** a newly won medal is switched on automatically when the user isn't showing one yet, so
  winners see it without hunting for a setting. A user who has turned medals off stays off.
- The avatar settings panel gets a row listing the medals with a toggle. No explanatory text: the
  medal icons are the affordance.

Unmarking a Major, or erasing an account, removes its medals and clears `shownMedal` when it pointed at
one.

## What cardtable does (our side, not yours)

1. **Report each finished tournament** with `TournamentReport`, through the same fire-and-forget, retry,
   never-throw reporter that sends matches, at the point that records it today
   (`onTournament` in `apps/server/src/index.ts`). AI entrants go in as `kind: 'bot'`. We'll also
   backfill what's in `tournaments.json` once, so the first Major can be marked even if it ends before
   this ships.
2. **Draw the medal** on every avatar cardtable renders (seats, the table card, the Victory dialog,
   standings) once `ResolvedAvatar.medal` exists: a small medal in the avatar's corner, in the theme's
   colours. If watchparty's shared avatar component draws it first, we use theirs.

We need from you: the endpoints in §1–§4 (paths and shapes are proposals; change them freely), and the
final shapes sent back to hadoku-cardtable once they're fixed, as `HADOKU_SITE_MAJORS_PODIUM_MEDALS_REPLY.md`
or on the issue.

## Open questions for the operator

- Does a medal expire or get replaced? The proposal keeps every medal forever; the user picks which to show.
- One podium per game, or one across all games? The proposal is per game (cardtable's leaderboard
  shows cardtable's last Major).
