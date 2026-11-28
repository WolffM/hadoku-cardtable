# Tournament runbook (Sunday 2026-11-29)

Who can fix things: the room's **leader**, and anyone the edge names **wife** or **admin** (an
*operator*), in any room, without being its leader, a player or even a member. Friend and member
cannot. Everything below is the **⋯ on a live match** in the room's bracket (`#/room/<id>`), or a
**seat chip's button** in the lobby before the seats lock. Every press, done or refused, is an
`admin-act` server event naming who did it and their tier:

```sh
K=$(node -p "require('./.devvault.local.json').key")
curl -s -A "Mozilla/5.0 hadoku-agent" -H "X-User-Key: $K" \
  "https://hadoku.me/health/api/service-events?service=cardtable&since=2026-11-29T00:00:00Z" | grep admin-act
```

An operator who is not in the room joins it first (open the link). **In the lobby, entering seats
you: press Stand** before anyone readies, or you lock in as an entrant.

## Before the pod

- **A few minutes before Start draft, open the pod room's settings and choose its pool** (or choose it
  again). That runs the pool's card check in the pool JVM, which pages it back in. On prod that JVM
  has had over a gigabyte swapped out (measured 2026-11-28), and the first call it serves can take
  longer than its 30 s bound. Start draft is that first call otherwise: it deals every round's
  boosters.
- **Start draft answers "could not deal the realistic round(s)…"**: press it again. The pool JVM is
  paged in by then, and nothing was dealt.

## Read a match first: softlock or slow player?

⋯ on the match opens on how it stands: **Turn N**, one row a seat (the seat whose turn it is bold;
a name in the danger colour has left), what Forge waits on that seat for (`declareBlockers`,
`chooseCards`…) with how long it has waited, that seat's **⏱ clock**, and **↻** how long since the
table last moved.

- **Slow player:** the wait is on a seat that is here, and its ⏱ is running down. Leave it: at
  zero the clock loses them the game by itself.
- **Softlock:** a long wait, ↻ climbing, and the player says they cannot act (nothing to click,
  or clicks do nothing). Go to *Softlock*.
- The server log has the rest: `grep <matchId> ~/.pm2/logs/cardtable-out*.log | grep -E 'openAsks|ask-forwarded|act-unanswered'`.

## The emergencies

| Emergency | Fix |
| --- | --- |
| **A player's screen shows nothing to do, but the game doesn't move** (seen after a server restart: Forge waits on a question the screen never got) | ⋯ → **Re-send asks**: Forge sends every question it is waiting on again, and the server sends each seat everything it holds for it. Nothing in the game changes. Open ⋯ again: a question Forge waited on that the seat had never been shown is named on that seat's row in the danger colour, so you can see that was the cause. Still stuck: **Restart turn** below. |
| **Softlock** (a game will not move) | ⋯ → **Restart turn**: the game goes back to the start of the current turn on a new JVM, same match, nobody's clock rewound. The board is back once that JVM has booted: about 10 s, up to a minute on a busy host (the server's own bound on a start). Refused when that turn cannot be restored exactly (it names what, e.g. `token`): then **Reset game** (the same game again from its start, the series score stands) or, if the players agree who would have won, **Game to ‹player›**. The game before a restart is kept as its own replay, linked under the state rows (`#/replay/<matchId>-e1`). |
| **No-show before the lock** (sat down, never readies, so the field never locks) | The seat chip's **Bot** (the AI takes the seat; the field is fixed once everyone left is ready) or **Remove** (seat freed for someone else). An empty seat: **Close** it. |
| **A drafter stops picking mid-draft** (closed the tab; the pod waits on them) | Someone who **leaves the room** is picked for by the draft bot at once. Still in the room but gone: from the console below, `api('draft/pick-for', { memberId: ID })`: the draft bot picks for their seat now and at every pick until they reconnect to the draft (or `{ memberId: ID, on: false }`). Or turn the pick timer on for everyone: `api('draft/timer', { on: true, speed: 1 })` (speed 0.25–4; higher is faster), and a gone seat's pick falls to the bot when its time runs out. |
| **No-show after the lock** | ⋯ → **Match to ‹opponent›** (this match only; they are paired again next round), or **DQ ‹player›** (this match lost and every later pairing of theirs a bye for its opponent; they stay in the standings, marked). |
| **Disconnect mid-match** | Wait out the rejoin grace (their name turns the danger colour when they are gone). Back: they reopen the table link and press **Return to game**. Not back: **Match to ‹opponent›**, or **DQ** if they are gone for the day. |
| **Wrong result, this round still playing** | ⋯ → **Match to ‹right player›**: a finished match of the current round is corrected in place; the standings follow. One game wrong in a match still going: **Game to ‹player›** for the game in play, or **Replay match** (0–0 again, no result). |
| **Wrong result, round already paired past** | Refused in the room ("that round is over"). After the event: `npx tsx games/magic/server/src/cli/tournaments.ts show <id> --site prod`, then `set …` without `--write` (dry run), check it, then again with `--write`. Never hand-edit `tournaments.json`. |
| **A match crashed** (board says the game ended, the table still says playing) | ⋯ → **Restart turn** (failover from the turn's snapshot); no snapshot: it restarts the game. Nothing in play: **Reset game** and the players re-enter from the table page. |
| **The leader left** | An operator's seat chip **Make leader** on someone in the room; until then an operator has every leader tool anyway. |
| **Server restart** (pm2 restart, a deploy) | **Deploy or restart cardtable only between rounds.** A restart mid-round freezes every board until the new server has taken back every match, finished games still in their 10-minute grace included; no player is back before the last one. About 5–6 s for a Sunday round of 6–8 tables; longer the more has been played and the more finished games are in their grace (measured on PPE 2026-11-28 with the open-ask fix live: 18 matches, ~38k lines, all back by 8.3 s; 42 matches under soak load, ~114k lines, 26.3 s). Then each game resumes exactly where it was; rooms and brackets persist. A game that could not be adopted lets its table go with no result: the players reopen the table link and the same game starts again, the score standing. Prod changes only through `release.yml`; do not cut a release mid-event. |
| **Whole room wrong** (not a tournament yet) | The leader's **Reset** beside Close in the room (an operator: `api('tables/reset', {})` below). A tournament under way can only be closed. |

## A claw fails mid-match (failover)

Matches run on the claws (claw-8, claw-9, then claw-10; hokon only in an emergency). When one stops
answering, its matches move by themselves. Nobody needs to press anything for the common cases.
Measured on scratch claws, 2026-11-28 (`scripts/stress/hosting/failover.spec.ts` and tourney-blb's
`12p claws` field):

| What broke | Discord says | How long the board is frozen | Where the game comes back |
| --- | --- | --- | --- |
| A claw's agent dies or its link goes silent | 🚨 **Failover: claw-N** — moved K: m-… → claw-M (restored at the start of turn T) | ~9 s (the 10 s heartbeat window) | the **start of the current turn**, on another claw |
| A match's JVM dies | 🚨 **Failover** as above | under 1 s | start of the current turn, another claw |
| The server froze for >10 s (hokon busy) | 🔁 **Fenced: claw-N** — "this server was silent, not the claw" | as long as the freeze, plus <1 s | start of the current turn, usually the same claw |
| The server restarted (deploy, pm2) or crashed | nothing, or the deploy | a few seconds; "Reconnecting…" | **exactly where it was** (nothing is rewound) |
| A claw's disk filled | nothing | none | the game goes on |

**What a player sees.** The board stops answering for those seconds, then comes back by itself
**without reloading the page**: the same match, the same opponent, the clock where it was. After a
failover or a fence the game is **back at the start of the turn** it was in: a land played this turn
is back in hand, a spell cast this turn is back in hand and its mana untapped, an attack is undone,
and whoever was active draws the same card again. The page does not say so: tell the players at that
table, if they ask, *"the server moved your game; it went back to the start of the turn, play the
turn again."* Nothing is lost from earlier turns (life, counters, tokens, Auras and Equipment,
graveyards, exile, library order).

**What the admin does:**

1. **Nothing, if the table is moving again.** Open ⋯ on the match: **Turn N** and ↻ ticking over
   means it recovered. The pairing's result is recorded when the game ends, as usual.
2. **A player says their screen is stuck after the move:** ⋯ → **Re-send asks** first, then
   **Restart turn** (see *The emergencies*). The page never needs a reload; if a player reloaded
   anyway, they reopen the table link and press **Return to game**.
3. **🚨 Match lost** (no claw and no backstop could take it), or the board says the game ended while
   the table still says playing: ⋯ → **Restart turn**; refused or no snapshot → **Reset game** (the same
   game from its start, the series score stands). Never award a result nobody played out unless both
   players agree (**Game to ‹player›**).
4. **A player sees "Play here instead?" on the only tab they have open** (seen once, right after a
   server restart, on a player whose game had been re-attached): they press **Yes**; it takes the room
   back to that tab and nothing is lost.
5. **The same claw keeps failing:** it is already quarantined (no new matches) until it passes a
   canary. Nothing to do on Sunday; note the alert times for the operator.

**What can be lost in a turn-start restore**, in Bloomburrow terms: this turn's plays (above), an
"until end of turn" effect, and anything on the stack. ⚠ On pin 706507109 an **Offspring token copy**
comes back as a plain 1/1 body without the copied creature's abilities (the turn's snapshot names it
`token`); fixed by fork 83886be5 once that pin is deployed. Until then, if a failover hits a table
with an Offspring token on the board, the players may agree to treat the token as having its
abilities, or use **Reset game**.

## API equivalents (when the page will not load)

From the browser console on `hadoku.me/cardtable/`, signed in as an operator:

```js
const api = (p, body) => fetch(`/cardtable/api/rooms/${ROOM}/${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
await api('admin/live');                                  // every match of the round, as it stands
await api(`tables/${TABLE}/unstick`, {});                 // Re-send asks: { seats: [{ seat, forge: [what Forge waits on], shown: [what the seat had] }] }
await api(`tables/${TABLE}/restore`, {});                 // Restart turn
await api(`tables/${TABLE}/reset`, {});                   // Reset game
await api(`tables/${TABLE}/award`, { seat: 0 });          // Game to table seat 0
await api(`tables/${TABLE}/award`, { seat: 1, match: true }); // Match to table seat 1
await api(`tables/${TABLE}/replay`, {});                  // Replay match
await api('pod/dq', { memberId: ID });                    // DQ
await api('draft/pick-for', { memberId: ID });            // mid-draft: the bot picks for them until they're back
await api('draft/timer', { on: true, speed: 1 });         // mid-draft: the pick timer on
await api('tables/reset', {});                            // Reset room (no tournament under way)
await api('seats/bot', { seat: 3 });                      // before the lock: the AI takes seat 3
await api('seats/remove', { memberId: ID });              // before the lock: stand them up
```

`seat` is the **table** seat (`admin/live`'s `players` order), not the pairing's.
